// 衣摆微动生成器：向角色的 <id>_spr.json 的 Idle_01 注入衣摆 DeformTimeline。
// 用法：node pet/tools/gen_sway.cjs shiroko [--amp 20] [--keys 12]
// 模式（SWAY_TARGETS[].main.mode）：
//   band  = y 区间带内摆动（Shiroko 百褶裙：腿/手臂钉死，只动裙摆带；带内越低越自由）
//   bottom= mesh 底部向上渐变（仅适用于底缘就是自由端的 mesh）
// 原理（对未加权 mesh，附件顶点在骨本地空间）：
//   - dx = amp·w·sin(2πt/T + φ(x))，φ 随 x 错开制造布料波浪
//   - dy = amp·dyRatio·w·sin(4πt/T)（微弱垂直起伏）
//   - 关键帧 k·T/12（13 帧），首末帧数值相同 → 与 Idle_01 无缝循环
// 注意：JSON deform 的 vertices 语义是"相对 setup 的增量"（loader 会加回 setup）。
// ⚠️ 不要给 tiltSlots 里的 slot（00_default/Hair_Cover/eyeclose）加 deform：
//    computeWorldVertices 在 deform 存在时整体替换 setup 顶点 → 摸头 tilt 顶点修改失效。
// 幂等：重复执行直接覆盖同名 deform timeline，不会叠加。
"use strict";

const fs = require("fs");
const path = require("path");
const { loadAgent } = require("./spine_node.cjs");

// 每角色摆动部位配置。
// Shiroko 实测（2026-08-18 目视+顶点勘察）：黑色百褶裙 y≈950~1260（±535 两外角在 y 1235~1241，
// 中部裙片垂到 y 982~1132）；腿 y<600（8 顶点）、手臂衔接 y>1300 —— 全部钉死。
const SWAY_TARGETS = {
  shiroko: {
    idle: "Idle_01",
    main: {
      slot: "siroko2", att: "siroko", mode: "band",
      bandMin: 950, bandMax: 1260, ampScale: 1, dyRatio: 0.35,
    },
  },
  // Hoshino 身体先经 meshify_region.cjs 网格化（6×10，region y 253~2250）。
  // band 1100~1500 ≈ 黑百褶裙带（背部工具包 y>1500 不动、腿 y<1100 不动）；可用 --band=mn:mx 调。
  hoshino: {
    idle: "Idle_01",
    main: {
      slot: "hoshino", att: "hoshino", mode: "band",
      bandMin: 1100, bandMax: 1500, ampScale: 1, dyRatio: 0.35,
    },
  },
};

function smoothstep(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

function r2(v) {
  return Number.isInteger(v) ? v : Number(v.toFixed(4));
}

function genForTarget(meshAtt, tgt, amp, keys, T) {
  const verts = meshAtt.vertices;
  const n = verts.length / 2;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < verts.length; i += 2) {
    if (verts[i] < minX) minX = verts[i];
    if (verts[i] > maxX) maxX = verts[i];
    if (verts[i + 1] < minY) minY = verts[i + 1];
    if (verts[i + 1] > maxY) maxY = verts[i + 1];
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const mode = tgt.mode || "bottom";
  const bandMin = tgt.bandMin ?? 0;
  const bandMax = tgt.bandMax ?? 0;
  const ampV = amp * (tgt.dyRatio ?? 0.25);
  // 顶点权重（band 模式：带外 0；带内基础 0.35 + 越低（自由端）越强）
  const weight = (vy) => {
    if (mode === "band") {
      if (vy < bandMin || vy > bandMax) return 0;
      return 0.35 + 0.65 * smoothstep((bandMax - vy) / Math.max(1e-6, bandMax - bandMin));
    }
    // bottom：mesh 底(自由端)最大，上 45% 钉死
    const hNorm = (maxY - vy) / spanY;
    return smoothstep((hNorm - 0.45) / 0.55);
  };
  const frames = [];
  for (let k = 0; k <= keys; k++) {
    const t = (k / keys) * T;
    const delta = new Array(verts.length).fill(0);
    for (let v = 0; v < n; v++) {
      const vx = verts[v * 2], vy = verts[v * 2 + 1];
      const w = weight(vy);
      if (w <= 0) continue;
      const nx = (vx - minX) / spanX; // 0~1 左→右
      const phase = (nx - 0.5) * (Math.PI / 1.5); // 横向波浪相位差
      delta[v * 2] = amp * w * Math.sin((2 * Math.PI * t) / T + phase);
      delta[v * 2 + 1] = ampV * w * Math.sin((4 * Math.PI * t) / T);
    }
    frames.push({ time: r2(t), vertices: delta.map(r2) });
  }
  // 首末帧严格相同（无缝循环）
  frames[keys].vertices = frames[0].vertices.slice();
  return frames;
}

function main() {
  const args = process.argv.slice(2);
  const id = args.find((x) => !x.startsWith("--"));
  if (!id || !SWAY_TARGETS[id]) {
    console.error("用法: node pet/tools/gen_sway.cjs <shiroko|hoshino> [--amp 4] [--keys 12] [--band=mn:mx]");
    process.exit(2);
  }
  const cfg = SWAY_TARGETS[id];
  const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined && !Number.isNaN(Number(args[i + 1]))
      ? Number(args[i + 1]) : dflt;
  };
  const amp = opt("amp", 4);
  const keys = opt("keys", 12);

  const { skelData, base } = loadAgent(id);
  const idle = skelData.findAnimation(cfg.idle);
  if (!idle) throw new Error(`找不到动画 ${cfg.idle}`);
  const T = idle.duration;

  // 几何来源 = json 资产里的 mesh vertices（Hoshino 身体经 meshify_region 网格化后 skel 二进制里
  // 没有 mesh；Shiroko 的数值与 skel 一致，统一从 json 读最简单）
  const jsonPath = path.join(base, `${id}_spr.json`);
  const root = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const anim = (root.animations[cfg.idle] ??= {});
  const deform = (anim.deform ??= {});
  const perSkin = (deform["default"] ??= {});
  const jsonSkin = (root.skins.find((s) => s.name === "default") || root.skins[0]).attachments;

  for (let tgt of [cfg.main]) {
    tgt = { ...tgt }; // CLI band 覆盖不污染静态配置
    const bandArg = args.find((a) => a.startsWith("--band="));
    if (bandArg && tgt.mode === "band") {
      const [mn, mx] = bandArg.slice(7).split(":").map(Number);
      if (isFinite(mn) && isFinite(mx)) tgt = { ...tgt, bandMin: mn, bandMax: mx };
    }
    const attMap = jsonSkin[tgt.slot] && jsonSkin[tgt.slot][tgt.att];
    if (!attMap || attMap.type !== "mesh")
      throw new Error(`${tgt.slot}/${tgt.att} 在 json 里不是 mesh（region 需先跑 meshify_region.cjs）`);
    const att = { vertices: attMap.vertices }; // genForTarget 只用 vertices
    const frames = genForTarget(att, tgt, amp * (tgt.ampScale ?? 1), keys, T);
    const perSlot = (perSkin[tgt.slot] ??= {});
    perSlot[tgt.att] = frames;
    // 报告参与摆动的顶点与权重
    const nv = att.vertices.length / 2;
    const parts = [];
    for (let i = 0; i < nv; i++) {
      const vy = att.vertices[i * 2 + 1];
      const vx = att.vertices[i * 2];
      let w = 0;
      if (tgt.mode === "band" && vy >= tgt.bandMin && vy <= tgt.bandMax)
        w = 0.35 + 0.65 * smoothstep((tgt.bandMax - vy) / (tgt.bandMax - tgt.bandMin));
      else if (!tgt.mode) {
        let mnY = Infinity, mxY = -Infinity;
        for (let j = 0; j < nv; j++) {
          const y = att.vertices[j * 2 + 1];
          if (y < mnY) mnY = y;
          if (y > mxY) mxY = y;
        }
        w = smoothstep(((mxY - vy) / Math.max(1e-6, mxY - mnY) - 0.45) / 0.55);
      }
      if (w > 0.01) parts.push(`(x=${vx.toFixed(0)},y=${vy.toFixed(0)},w=${w.toFixed(2)})`);
    }
    console.log(`[${id}] ${cfg.idle}.deform.${tgt.slot}/${tgt.att}: ${frames.length} 帧, T=${T.toFixed(3)}s, amp=${(amp * (tgt.ampScale ?? 1)).toFixed(1)}, dyRatio=${tgt.dyRatio ?? 0.25}, band=${tgt.mode === "band" ? tgt.bandMin + "~" + tgt.bandMax : "n/a"}`);
    console.log(`      摆动顶点(${parts.length}/${nv}): ${parts.join(" ")}`);
  }

  fs.writeFileSync(jsonPath, JSON.stringify(root, null, 1));
  const sizeKb = (fs.statSync(jsonPath).size / 1024).toFixed(1);
  console.log(`[${id}] 已写回 ${path.relative(process.cwd(), jsonPath)} (${sizeKb} KB)`);
}

main();
