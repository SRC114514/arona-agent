// region→mesh 网格化：把 json 资产里的 RegionAttachment 替换为显式网格 MeshAttachment，
// 使其可被 gen_sway 注入 deform（region 无顶点不可形变）。
// 用法：node pet/tools/meshify_region.cjs <agentId> <slot> <att> [--cols 6] [--rows 10]
// 前置：先跑 skel_to_json.cjs 导出 json（本脚本只改 json，不动 skel）。
// 几何：网格覆盖 region 的 local 四边形（x±w/2, y±h/2，仅支持 rotation=0）；
//       regionUVs = region 本地归一化坐标（0~1），updateUVs 自动映射页纹理（rotate region 亦然）。
// 幂等：重复执行覆盖同一 attachment。
"use strict";

const fs = require("fs");
const path = require("path");
const { loadAgent, spine } = require("./spine_node.cjs");

function main() {
  const args = process.argv.slice(2).filter((x) => !x.startsWith("--"));
  const opt = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    return v !== undefined && !Number.isNaN(Number(v)) ? Number(v) : dflt;
  };
  const [id, slotName, attName] = args;
  if (!id || !slotName || !attName) {
    console.error("用法: node pet/tools/meshify_region.cjs <agentId> <slot> <att> [--cols 6] [--rows 10]");
    process.exit(2);
  }
  const cols = opt("cols", 6);
  const rows = opt("rows", 10);

  const { skelData, base } = loadAgent(id);
  const skin = skelData.defaultSkin || skelData.skins[0];
  const sIdx = skelData.slots.findIndex((s) => s.name === slotName);
  if (sIdx < 0) throw new Error(`slot 不存在: ${slotName}`);
  const att = skin.getAttachment(sIdx, attName);
  if (!att || att.constructor.name !== "RegionAttachment")
    throw new Error(`${slotName}/${attName} 不是 region attachment`);
  if (Math.abs(att.rotation) > 1e-6)
    throw new Error(`region rotation=${att.rotation} ≠ 0，网格化未覆盖旋转补偿`);

  const x0 = att.x - att.width / 2, x1 = att.x + att.width / 2;
  const y0 = att.y - att.height / 2, y1 = att.y + att.height / 2;

  // 网格顶点（行优先）+ regionUVs（region 本地归一化）
  // ⚠️ degrees=90（atlas rotate:true）region 的 regionUVs = (fx, 1-fy)，非旋转 = (fx, fy)。
  //    推导（对照 RegionAttachment.setRegion rotate 分支的真实角点映射 LL=(u2,v2)/UL=(u,v2)/UR=(u,v)/LR=(u2,v)
  //    ——注意源码里 uvs[0]/[1] 是最后赋值的，勿按阅读顺序记——
  //    与 MeshAttachment.updateUVs case 90（pageU=u+uv.y·W'、pageV=v+(1-uv.x)·H'）联立解得。
  const rotated = !!(att.region && att.region.rotate);
  const vertices = [];
  const uvs = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const fx = cols === 1 ? 0.5 : i / (cols - 1);
      const fy = rows === 1 ? 0.5 : j / (rows - 1);
      vertices.push(+(x0 + fx * (x1 - x0)).toFixed(4), +(y0 + fy * (y1 - y0)).toFixed(4));
      if (rotated) uvs.push(+fx.toFixed(6), +(1 - fy).toFixed(6));
      else uvs.push(+fx.toFixed(6), +fy.toFixed(6));
    }
  }
  // 三角形（每格 2 个，绕向一致）
  const triangles = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = j * cols + i + 1;
      const c = (j + 1) * cols + i, d = (j + 1) * cols + i + 1;
      triangles.push(a, b, c, b, d, c);
    }
  }
  const hull = 2 * cols + 2 * rows - 4; // 周界顶点数

  // 替换 json 中的 attachment（保留 name/path/color/width/height）
  const jsonPath = path.join(base, `${id}_spr.json`);
  const root = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const jsonSkin = (root.skins.find((s) => s.name === "default") || root.skins[0]).attachments;
  const old = jsonSkin[slotName] && jsonSkin[slotName][attName];
  if (!old || old.type !== "region")
    throw new Error(`json 里 ${slotName}/${attName} 不是 region（已是 mesh 则无需重复网格化）`);
  jsonSkin[slotName][attName] = {
    type: "mesh",
    name: old.name,
    path: old.path,
    color: old.color,
    width: old.width,
    height: old.height,
    uvs,
    vertices,
    triangles,
    hull,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(root, null, 1));

  // sanity：SkeletonJson 读回，mesh updateUVs 成功且顶点/UV 数量匹配
  const { loader } = loadAgent(id);
  const dataB = new spine.SkeletonJson(loader).readSkeletonData(root);
  const skinB = dataB.defaultSkin;
  const attB = skinB.getAttachment(sIdx, attName);
  if (attB.constructor.name !== "MeshAttachment") throw new Error("读回后不是 mesh");
  if (attB.vertices.length !== vertices.length || attB.uvs.length !== uvs.length)
    throw new Error("读回顶点/UV 数量不匹配");
  const sizeKb = (fs.statSync(jsonPath).size / 1024).toFixed(1);
  console.log(`[${id}] ${slotName}/${attName}: region → ${cols}×${rows} mesh（${cols * rows} 顶点 / ${triangles.length / 3} 三角形 / hull=${hull}）`);
  console.log(`      bounds=(${x0.toFixed(1)},${y0.toFixed(1)})~(${x1.toFixed(1)},${y1.toFixed(1)})，读回 sanity OK`);
  console.log(`[${id}] 已写回 ${path.relative(process.cwd(), jsonPath)} (${sizeKb} KB)`);
}

main();
