// Node 端加载 vendored Spine 3.8 runtime 并解析项目 skel 资产的工具库。
// 仅供 pet/tools/ 下离线脚本使用（inspect / skel_to_json / gen_sway 等），不进渲染链路。
//
// 两个坑：
// 1) vendored spine-webgl.js 是挂全局 `spine` 的 IIFE UMD（非 CommonJS），
//    require() 拿不到导出 —— 用 new Function 包一层 eval，注入沙箱 window/document。
// 2) TextureAtlas 构造时会调 textureLoader 返回对象的 setFilters/setWraps/getImage，
//    纯 Node 下没有真纹理 —— 用假 texture（宽高从 PNG IHDR 头读，保证 atlas 页尺寸正确）。
"use strict";

const fs = require("fs");
const path = require("path");

const PET = path.join(__dirname, "..");
const ASSETS = path.join(PET, "..", "assets", "blue-archive");

const spineSrc = fs.readFileSync(
  path.join(PET, "vendor", "spine", "spine-webgl.js"),
  "utf8"
);

// 4.2 运行时（kei 等源骨骼 4.2.x 角色）：iife bundle 包一层取 window.spine42（扁平导出）。
const spine42Src = fs.readFileSync(
  path.join(PET, "vendor", "spine", "spine-webgl-4.2.js"),
  "utf8"
);

const spine = (() => {
  const sandboxSpine = {};
  const fn = new Function("spine", "window", "document", spineSrc + "\nreturn spine;");
  return fn(sandboxSpine, {}, {});
})();

const spine42 = (() => {
  const win = {};
  const fn = new Function("window", "document", spine42Src);
  fn(win, {});
  return win.spine42;
})();

// 按角色 id 解析 { atlas, skelData, pngSize }。
// 所有角色资源统一在 assets/blue-archive/<id>/spine/ 子目录（与 pet/agents.cjs 一致）。
// 运行时按 agents.cjs 的 spineVersion 选（"4.2" 用 spine42，缺省 3.8）。
// 优先读 <id>_spr.skel 二进制；没有时回退 <id>_spr.json（如 kei：4.2 同版本 JSON，
// 供 gen_sway 注入 deform；aris 等的 json 是 skel_to_json 的 3.8 产物）。
function loadAgent(id) {
  const agentsCjs = require("../agents.cjs");
  const version = agentsCjs.AGENTS[id] && agentsCjs.AGENTS[id].spineVersion;
  const rt = version === "4.2" ? spine42 : spine;
  const base = path.join(ASSETS, id, "spine");
  const atlasFile = `${id}_spr.atlas.txt`;
  const skelFile = `${id}_spr.skel`;
  const jsonFile = `${id}_spr.json`;
  const hasBinary = fs.existsSync(path.join(base, skelFile));
  const atlasName = version === "4.2"
    ? agentsCjs.AGENTS[id].atlasFile
    : atlasFile;
  const atlasPath = path.join(base, atlasName);
  const atlasText = fs.readFileSync(atlasPath, "utf8");
  // png 文件名 = atlas 首行页名（kei 等 4.2 角色用素材原生文件名，非 <id>_spr.png）
  const pngName = atlasText.split("\n").map((l) => l.trim()).find((l) => l && !l.includes(":"));
  const pngBuf = fs.readFileSync(path.join(base, pngName));
  const pngW = pngBuf.readUInt32BE(16);
  const pngH = pngBuf.readUInt32BE(20);

  const fakeTexture = () => ({
    setFilters() {},
    setWraps() {},
    dispose() {},
    getImage: () => ({ width: pngW, height: pngH }),
  });

  const atlas = new rt.TextureAtlas(atlasText, fakeTexture);
  const loader = new rt.AtlasAttachmentLoader(atlas);

  const useJson = !hasBinary && fs.existsSync(path.join(base, jsonFile));
  let skelData;
  if (useJson) {
    const obj = JSON.parse(fs.readFileSync(path.join(base, jsonFile), "utf8"));
    skelData = new rt.SkeletonJson(loader).readSkeletonData(obj);
  } else {
    const buf = fs.readFileSync(path.join(base, skelFile));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    skelData = new rt.SkeletonBinary(loader).readSkeletonData(new Uint8Array(ab));
  }

  return { id, base, atlas, skelData, atlasFile: atlasName, skelFile: useJson ? jsonFile : skelFile, pngW, pngH, loader, fromJson: useJson, runtime: rt };
}

// 从 JSON 文件解析 SkeletonData（round-trip 验证用），atlasLoader 复用 loadAgent 的。
function loadSkelDataFromJson(atlasLoader, jsonPath) {
  const obj = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  return new spine.SkeletonJson(atlasLoader).readSkeletonData(obj);
}

module.exports = { spine, loadAgent, loadSkelDataFromJson };
