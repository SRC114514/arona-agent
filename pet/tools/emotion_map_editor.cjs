// 情绪映射一键编辑工具：生成自包含 HTML（预设图库 + 17 情绪行）→ 浏览器调映射 →
// 导出 JSON → --apply 写回 pet/agents.cjs 的 AGENTS[id].emotions（保持 agents.cjs 单一事实源）。
//
// 用法：
//   生成网页：node pet/tools/emotion_map_editor.cjs <agentId> [--refresh]
//     --refresh 强制重新跑 gallery_capture 预设模式（约 1 分钟）；否则复用 /tmp/<id>_emotions/
//     产物：output_emotion_map_<id>.html（项目根目录，自包含 base64 图，双击即可打开）
//   写回映射：node pet/tools/emotion_map_editor.cjs <agentId> --apply <map.json>
//     map.json 形如 {"angry":"06","assured":"03",...}（17 个情绪键，值 = 预设编号字符串）
//     直接整体替换 agents.cjs 中该角色的 emotions 块，其余字节不动
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const AGENTS_CJS = path.join(ROOT, "pet", "agents.cjs");
const { AGENTS } = require(AGENTS_CJS);

const EMOTION_KEYS = [
  "angry", "assured", "curious", "delighted", "desire", "dizzy", "doubt", "dreaming", "enjoy",
  "excited", "jealous", "love", "saying", "scared", "shame", "smile", "tired",
];

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

/** 该角色可用预设（从 skel 动画名推导，与 gallery_capture 一致） */
function getPresets(id) {
  try {
    const { skelData } = require("./spine_node.cjs").loadAgent(id);
    const nums = skelData.animations
      .map((a) => a.name)
      .filter((n) => /^\d+$/.test(n))
      .sort((a, b) => Number(a) - Number(b));
    return nums.concat("99");
  } catch {
    return null;
  }
}

/** 跑 gallery_capture 预设模式生成图库（阻塞等待完成） */
function refreshGallery(id) {
  console.log(`[${id}] 运行 gallery_capture 预设模式（生成 ${id} 预设图库）…`);
  const electron = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ARONA_AGENT = id;
  const r = spawnSync(electron, ["--no-sandbox", path.join(ROOT, "pet", "tools", "gallery_capture.cjs")], {
    cwd: ROOT, env, stdio: "inherit", timeout: 240000,
  });
  if (r.status !== 0) fail(`gallery_capture 失败（exit=${r.status}）`);
}

function ensureGallery(id, refresh) {
  const out = `/tmp/${id}_emotions`;
  const presets = getPresets(id);
  const pngs = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => /^p\d+_settled\.png$/.test(f)) : [];
  const havePresets = new Set(pngs.map((f) => /^p(\d+)_settled\.png$/.exec(f)[1]));
  const needAll = presets && presets.every((p) => havePresets.has(p));
  if (refresh || !needAll) refreshGallery(id);
  return { out, presets: presets || [] };
}

/** 生成自包含 HTML：预设网格（点击指派）+ 17 情绪行 + 导出 JSON */
function renderHtml(id, out, presets) {
  const AGENT = AGENTS[id];
  const current = AGENT.emotions;
  const img = (p) => fs.readFileSync(path.join(out, `p${p}_settled.png`)).toString("base64");
  const imgs = {};
  for (const p of presets) imgs[p] = img(p);

  const cellFor = (p) =>
    `<div class="pcell" data-p="${p}" onclick="assign('${p}')"><img src="data:image/png;base64,${imgs[p]}"><div class="plabel">${p}</div></div>`;

  const rowFor = (e) => `
    <div class="erow ${e === "angry" ? "sel" : ""}" data-e="${e}" onclick="selectE('${e}')">
      <span class="ename">${e}</span>
      <img class="ethumb" id="thumb_${e}" src="data:image/png;base64,${imgs[current[e]]}">
      <select id="sel_${e}" onchange="setE('${e}', this.value)">${presets.map((p) => `<option value="${p}" ${p === current[e] ? "selected" : ""}>${p}</option>`).join("")}</select>
    </div>`;

  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${id} 情绪映射编辑</title>
<style>
  body { margin:0; font-family:-apple-system,"PingFang SC",sans-serif; background:#111318; color:#e8e8ef; }
  .wrap { max-width:1200px; margin:0 auto; padding:20px; }
  h1 { font-size:20px; } h1 small { color:#9aa; font-weight:normal; font-size:13px; }
  .topbar { display:flex; gap:16px; align-items:center; border-bottom:1px solid #2a2d3a; padding-bottom:12px; }
  .btn { background:#3b5bff; border:0; color:#fff; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:14px; }
  .btn:hover { background:#4d6bff; }
  .hint { color:#9aa; font-size:12px; margin-top:8px; line-height:1.6; }
  .cols { display:grid; grid-template-columns: 380px 1fr; gap:24px; margin-top:16px; }
  .grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; }
  .pcell { background:#1b1e29; border:2px solid #2a2d3a; border-radius:8px; padding:6px; cursor:pointer; text-align:center; transition:border-color .15s; }
  .pcell:hover { border-color:#6a8bff; }
  .pcell img { width:100%; background:#000; border-radius:4px; image-rendering:pixelated; }
  .plabel { font-size:13px; margin-top:4px; color:#c8c8dd; }
  .erow { display:flex; align-items:center; gap:10px; background:#171a24; border:2px solid transparent; border-radius:8px; padding:6px 10px; margin-bottom:6px; cursor:pointer; }
  .erow.sel { border-color:#6a8bff; background:#1d2340; }
  .ename { width:110px; font-size:13px; color:#c8c8dd; }
  .ethumb { width:56px; height:56px; object-fit:contain; background:#000; border-radius:4px; }
  .erow select { flex:1; background:#22263a; color:#eee; border:1px solid #3a3f55; border-radius:5px; padding:6px; font-size:13px; }
  pre { background:#0d0f16; border:1px solid #2a2d3a; padding:12px; border-radius:8px; font-size:12px; max-height:140px; overflow:auto; }
  .foot { margin-top:16px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <h1>情绪映射编辑 — <small>${id}（${presets.length} 个预设：${presets.join(" / ")}）</small></h1>
    <button class="btn" onclick="exportJson()">导出 JSON</button>
  </div>
  <div class="hint">
    点击左侧预设缩略图 → 指派给右侧当前选中的情绪行（默认选中第一行）。亦可直接在情绪行下拉切换。<br>
    调好后点「导出 JSON」下载 emotion_map_${id}.json，再执行
    <code>node pet/tools/emotion_map_editor.cjs ${id} --apply emotion_map_${id}.json</code> 写回 agents.cjs。
    注意：当前映射为占位/旧值，请对照图片逐行核对。
  </div>
  <div class="cols">
    <div>
      <div id="selhint" style="font-size:12px;color:#8fa;margin-bottom:8px">当前选中情绪：<b id="cur">angry</b></div>
      <div class="grid">${presets.map(cellFor).join("")}</div>
    </div>
    <div id="rows">${EMOTION_KEYS.map(rowFor).join("")}</div>
  </div>
  <div class="foot">
    <pre id="preview"></pre>
  </div>
</div>
<script>
const PRESETS = ${JSON.stringify(presets)};
const KEYS = ${JSON.stringify(EMOTION_KEYS)};
const map = ${JSON.stringify(current)};
let cur = KEYS[0];
function selectE(e) {
  cur = e;
  document.querySelectorAll(".erow").forEach((r) => r.classList.toggle("sel", r.dataset.e === e));
  document.getElementById("cur").textContent = e;
}
function setE(e, p) { map[e] = p; document.getElementById("thumb_" + e).src = document.querySelector('.pcell[data-p="' + p + '"] img').src; renderPreview(); }
function assign(p) { setE(cur, p); }
function renderPreview() {
  const out = {};
  for (const k of KEYS) out[k] = map[k];
  document.getElementById("preview").textContent = JSON.stringify(out, null, 2);
}
function exportJson() {
  const out = {};
  for (const k of KEYS) out[k] = map[k];
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "emotion_map_${id}.json";
  a.click();
  renderPreview();
}
renderPreview();
</script>
</body>
</html>`;
  const dest = path.join(ROOT, `output_emotion_map_${id}.html`);
  fs.writeFileSync(dest, html);
  console.log(`[${id}] 已生成 ${path.relative(ROOT, dest)}（双击浏览器打开编辑）`);
}

/** 写回 agents.cjs：仅整体替换该角色 const 块内的 emotions 对象，其余字节不动 */
function applyMap(id, mapPath, presets) {
  const keys = EMOTION_KEYS;
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const missing = keys.filter((k) => !(k in map));
  if (missing.length) fail(`映射缺情绪键: ${missing.join(", ")}`);
  if (presets) {
    for (const k of keys) {
      const v = String(map[k]);
      if (!presets.includes(v)) fail(`${k}=${v} 不是 ${id} 的有效预设（可用：${presets.join("/")}）`);
    }
  }
  let src = fs.readFileSync(AGENTS_CJS, "utf8");
  const constName = id.toUpperCase();
  const blockRe = new RegExp(`const ${constName} = \\{`);
  const m = blockRe.exec(src);
  if (!m) fail(`agents.cjs 未找到 const ${constName} 块`);
  // const 块边界
  let depth = 1, i = m.index + m[0].length;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  const block = src.slice(m.index, i + 1);
  const emRe = /emotions:\s*\{/;
  const em = emRe.exec(block);
  if (!em) fail(`${id} 块内未找到 emotions`);
  const braceAt = m.index + em.index + em[0].length - 1; // 'emotions: {' 的 '{' 位置
  let d2 = 1, j = braceAt + 1;
  for (; j < src.length; j++) {
    if (src[j] === "{") d2++;
    else if (src[j] === "}") { d2--; if (d2 === 0) break; }
  }
  const emEnd = j; // 配对 '}' 位置
  const lines = keys.map((k) => `    ${k}: "${map[k]}",`).join("\n");
  const newInner = `\n${lines}\n  `; // 与现有风格一致：键 4 空格缩进，闭合 2 空格
  src = src.slice(0, braceAt) + "{" + newInner + "}" + src.slice(emEnd + 1);
  fs.writeFileSync(AGENTS_CJS, src);
  console.log(`[${id}] 已写回 ${path.relative(ROOT, AGENTS_CJS)} 的 emotions（17 键）`);
  console.log(`       ${keys.map((k) => `${k}=${map[k]}`).join(" ")}`);
}

function main() {
  const args = process.argv.slice(2);
  const id = args.find((x) => !x.startsWith("--"));
  if (!id || !AGENTS[id]) fail("用法: node pet/tools/emotion_map_editor.cjs <agentId> [--refresh | --apply <map.json>]");
  const presets = getPresets(id);
  const applyIdx = args.indexOf("--apply");
  if (applyIdx >= 0) {
    const mapPath = args[applyIdx + 1];
    if (!mapPath) fail("--apply 需要 <map.json> 路径");
    applyMap(id, mapPath, presets);
    return;
  }
  const refresh = args.includes("--refresh");
  const { out, presets: pre } = ensureGallery(id, refresh);
  if (!pre.length) fail(`无法推导 ${id} 的预设列表`);
  renderHtml(id, out, pre);
}

main();