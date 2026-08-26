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

const spine = (() => {
  const sandboxSpine = {};
  const fn = new Function("spine", "window", "document", spineSrc + "\nreturn spine;");
  return fn(sandboxSpine, {}, {});
})();

// 按角色 id 解析 { atlas, skelData, pngSize }。
// 所有角色资源统一在 assets/blue-archive/<id>/spine/ 子目录（与 pet/agents.cjs 一致）。
function loadAgent(id) {
  const base = path.join(ASSETS, id, "spine");
  const atlasFile = `${id}_spr.atlas.txt`;
  const skelFile = `${id}_spr.skel`;
  const pngFile = `${id}_spr.png`;

  const pngBuf = fs.readFileSync(path.join(base, pngFile));
  const pngW = pngBuf.readUInt32BE(16);
  const pngH = pngBuf.readUInt32BE(20);

  const fakeTexture = () => ({
    setFilters() {},
    setWraps() {},
    dispose() {},
    getImage: () => ({ width: pngW, height: pngH }),
  });

  const atlasText = fs.readFileSync(path.join(base, atlasFile), "utf8");
  const atlas = new spine.TextureAtlas(atlasText, fakeTexture);
  const loader = new spine.AtlasAttachmentLoader(atlas);

  const buf = fs.readFileSync(path.join(base, skelFile));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const skelData = new spine.SkeletonBinary(loader).readSkeletonData(
    new Uint8Array(ab)
  );

  return { id, base, atlas, skelData, atlasFile, skelFile, pngW, pngH, loader };
}

// 从 JSON 文件解析 SkeletonData（round-trip 验证用），atlasLoader 复用 loadAgent 的。
function loadSkelDataFromJson(atlasLoader, jsonPath) {
  const obj = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  return new spine.SkeletonJson(atlasLoader).readSkeletonData(obj);
}

module.exports = { spine, loadAgent, loadSkelDataFromJson };
