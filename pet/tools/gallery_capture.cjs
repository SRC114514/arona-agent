// 表情目视图库截图 harness：逐预设/逐情绪渲染（落定末帧）+ capturePage + 生成目视页
// 用法（预设模式，22 个数字表情）：
//   env -u ELECTRON_RUN_AS_NODE ARONA_AGENT=plana ./node_modules/.bin/electron --no-sandbox pet/tools/gallery_capture.cjs
// 用法（情绪确认模式，按 agents.cjs 映射渲染 17 个情绪，水印 = "情绪名 → 预设"）：
//   GALLERY_MODE=emotions ARONA_AGENT=plana ...同上...
// 产物：/tmp/<agent>_emotions/（预设）或 /tmp/<agent>_emotion_map/（情绪）下 PNG + gallery.html
// 断言：每帧截图前校验 track4 已就位（防止"截到 Idle 基底脸"——B7 规则 4）
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const PET = path.join(__dirname, "..");
const { AGENTS } = require(path.join(PET, "agents.cjs"));

const agentId = process.env.ARONA_AGENT && AGENTS[process.env.ARONA_AGENT] ? process.env.ARONA_AGENT : "arona";
const AGENT = AGENTS[agentId];
const MODE = process.env.GALLERY_MODE === "emotions" ? "emotions" : "presets";
// 数字预设普查（CLAUDE.md B5）：plana = 00~20 + 99（22 个）；arona = 00~32 + 99（34 个）
const PRESETS = AGENT.id === "plana"
  ? [...Array.from({ length: 21 }, (_, i) => String(i).padStart(2, "0")), "99"]
  : [...Array.from({ length: 33 }, (_, i) => String(i).padStart(2, "0")), "99"];
// 情绪确认模式：17 个情绪名 → 其映射预设（顺序 = agents.cjs 定义顺序）
const EMOTIONS = Object.entries(AGENT.emotions);
const OUT = MODE === "emotions" ? `/tmp/${agentId}_emotion_map` : `/tmp/${agentId}_emotions`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
let failures = 0;
const SIGNATURES = new Map(); // 附件签名 → 预设编号（互不相同断言用）

// watchdog：全流程 ~22 × 3.6s + 新鲜度重试余量，220s 强制退出
setTimeout(() => { console.log("FATAL watchdog timeout"); app.exit(3); }, 220000);

// 已捕获 PNG 字节列表：新鲜度守卫（透明窗口上 capturePage 会间歇性返回合成器过期纹理，
// 表现为截图与某张历史帧完全相同——曾导致 06 重复、08 缺失的编号↔脸错位）
const seenPngs = [];

async function cap(tag) {
  if (!win || win.isDestroyed()) return;
  let png = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    win.webContents.invalidate(); // 强制合成器全量重绘后再截
    await sleep(attempt === 1 ? 200 : 600);
    const img = await win.webContents.capturePage();
    png = img.toPNG();
    if (!seenPngs.some((b) => b.equals(png))) break; // 与所有历史帧都不同 → 新鲜
    console.log("STALE", tag, "attempt", attempt, "-> retry");
  }
  const dup = seenPngs.some((b) => b.equals(png));
  if (dup) console.log("WARN", tag, "仍与某历史帧完全相同（若附件签名独立，则是两预设视觉相同，非过期帧）");
  seenPngs.push(png);
  fs.writeFileSync(path.join(OUT, tag + ".png"), png);
  console.log("CAP", tag, dup ? "(dup)" : "(fresh)");
}

/** PNG → data URI（自包含 HTML：图片全部内嵌，单文件可随意移动/另存，换文件名即防缓存） */
function dataUri(file) {
  return "data:image/png;base64," + fs.readFileSync(path.join(OUT, file)).toString("base64");
}

/** 单元格：图片内嵌 + 点击放大（缩略图太小分不清嘴/眉差异，lightbox 看原尺寸 2× DPR 图） */
function cellHtml(cap, file) {
  const q = JSON.stringify(cap);
  return `<div class="cell" onclick='zoom(${q}, this.querySelector("img").src)'><img src="${dataUri(file)}"><div class="cap">${cap}</div></div>`;
}

/**
 * 目视 contact sheet（自包含单文件 HTML，任何浏览器可直接打开）：
 * - 图片 base64 内嵌（无相对路径依赖、无 file:// 旧缓存复用问题）
 * - 点击图片全屏放大（标题随动）
 * - binder 非空时（预设模式）附"映射重绑面板"：17 情绪 × 下拉选预设（默认 = 当前映射），
 *   一键生成 emotions 映射文本并复制，用户直接粘贴回对话，避免手抄错号
 */
function writeSheet({ title, cells, binder }) {
  const binderBlock = binder
    ? `<div id="binder">
  <h2>重新绑定映射：为每个情绪选一个预设编号（下拉默认 = 当前映射，只改你要改的）</h2>
  <div id="rows"></div>
  <button class="btn" onclick="genMap()">生成映射文本（并复制）</button>
  <span id="copyhint" style="margin-left:10px;font-size:12px;color:#8f8"></span>
  <textarea id="out" readonly spellcheck="false"></textarea>
</div>
<script>
const PRESETS = ${JSON.stringify(PRESETS)};
const CURRENT = ${JSON.stringify(Object.fromEntries(binder))};
const rows = document.getElementById('rows');
for (const name of Object.keys(CURRENT)) {
  const wrap = document.createElement('div');
  const lab = document.createElement('label');
  lab.textContent = name + ' ';
  const sel = document.createElement('select');
  sel.dataset.e = name;
  for (const p of PRESETS) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    if (p === CURRENT[name]) opt.selected = true;
    sel.appendChild(opt);
  }
  wrap.appendChild(lab);
  wrap.appendChild(sel);
  rows.appendChild(wrap);
}
function genMap() {
  const lines = Object.keys(CURRENT).map(
    (name) => '  ' + name + ': "' + document.querySelector('select[data-e="' + name + '"]').value + '",',
  );
  const out = document.getElementById('out');
  out.value = 'emotions = {\\n' + lines.join('\\n') + '\\n}';
  out.style.display = 'block';
  out.focus();
  out.select();
  try {
    document.execCommand('copy');
    document.getElementById('copyhint').textContent = '已复制，直接粘贴给 Agent 即可';
  } catch (e) {}
}
</script>`
    : "";
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${agentId} 表情目视</title>
<style>
  body { background:#1a1a1a; color:#eee; font-family: Menlo, Consolas, monospace; padding: 20px; }
  h1 { font-size: 18px; }
  .grid { display:flex; flex-wrap:wrap; gap:16px; margin-top:16px; }
  .cell { background:#2a2a2a; border:1px solid #444; border-radius:6px; padding:8px; text-align:center; cursor:zoom-in; }
  .cell img { width:280px; height:590px; display:block; }
  .cap { margin-top:6px; font-size:15px; font-weight:bold; color:#9fd3ff; }
  #lightbox { display:none; position:fixed; inset:0; background:rgba(0,0,0,.93); z-index:10; cursor:zoom-out; text-align:center; }
  #lightbox .cap { font-size:24px; margin-top:12px; }
  #lightbox img { max-width:96vw; max-height:88vh; }
  #binder { position:sticky; top:0; z-index:5; background:#111; border:1px solid #444; border-radius:8px; padding:12px 18px; }
  #binder h2 { font-size:14px; margin:0 0 10px; }
  #rows { display:flex; flex-wrap:wrap; gap:6px 18px; }
  #rows label { font-size:13px; }
  #rows select { font:inherit; font-size:13px; background:#2a2a2a; color:#eee; border:1px solid #555; border-radius:4px; padding:2px 6px; }
  .btn { margin-top:10px; font:inherit; background:#2f6fb0; color:#fff; border:none; border-radius:4px; padding:6px 14px; cursor:pointer; }
  #out { display:none; width:100%; box-sizing:border-box; margin-top:10px; height:120px; background:#222; color:#9f9; font:13px Menlo, Consolas, monospace; border:1px solid #555; }
</style></head>
<body>
${binderBlock}
<h1>${title}</h1>
<div class="grid">\n${cells}\n</div>
<div id="lightbox" onclick="this.style.display='none'"><div class="cap" id="lb-cap"></div><img id="lb-img" alt=""></div>
<script>
function zoom(cap, src) {
  document.getElementById('lb-cap').textContent = cap;
  document.getElementById('lb-img').src = src;
  document.getElementById('lightbox').style.display = 'block';
}
</script>
</body></html>`;
  fs.writeFileSync(path.join(OUT, "gallery.html"), html);
}

app.whenReady().then(() => {
  fs.mkdirSync(OUT, { recursive: true });
  win = new BrowserWindow({
    width: 320, height: 674, transparent: true, frame: false, show: true,
    // 窗口被遮挡/后台时 rAF 与 DOM 合成会被节流 → capturePage 拿到过期纹理；关闭节流
    webPreferences: { preload: path.join(PET, "preload.cjs"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on("console-message", (_e, _a, b) => console.log("[R]", b));
  ipcMain.handle("pet:get-agent-config", () => ({ id: agentId, ...AGENT }));
  ipcMain.on("pet:drag", () => {});
  ipcMain.on("pet:dragend", () => {});
  ipcMain.on("pet:shake", () => {});
  win.loadFile(path.join(PET, "renderer", "gallery.html"), { search: "agent=" + agentId });

  win.webContents.on("did-finish-load", async () => {
    const t0 = Date.now();
    while (true) {
      try {
        // ⚠️ 不能用 !== null：__gallery 未赋值时是 undefined（undefined !== null 为 true）
        if (await win.webContents.executeJavaScript("typeof window.__gallery === 'object' && typeof window.__gallery.show === 'function'")) break;
      } catch {}
      if (Date.now() - t0 > 15000) { console.log("FATAL init timeout"); app.exit(3); return; }
      await sleep(200);
    }
    console.log("READY", agentId, "mode:", MODE, "items:", MODE === "emotions" ? EMOTIONS.length : PRESETS.length);

    if (MODE === "emotions") {
      // 情绪确认模式：水印 = "情绪名 → 预设编号"，文件名 = <情绪名>_settled.png
      for (const [name, preset] of EMOTIONS) {
        try {
          await win.webContents.executeJavaScript(`window.__gallery.showEmotion(${JSON.stringify(name)}, ${JSON.stringify(preset)})`);
        } catch (e) {
          console.log("CHECK emotion", name, "FAIL exec:", e.message);
          failures++;
          continue;
        }
        await sleep(120);
        const st = JSON.parse(await win.webContents.executeJavaScript("JSON.stringify(window.SpineLayer.getState())"));
        if (st.track4 !== preset) {
          console.log("CHECK emotion", name, "FAIL track4=" + st.track4 + " != " + preset);
          failures++;
        }
        await sleep(3600); // 等 3.333s 动画落定到末帧
        await cap(name + "_settled");
      }
      const cells = EMOTIONS.map(([name, preset]) =>
        cellHtml(`${name} → preset ${preset}`, name + "_settled.png"),
      ).join("\n");
      writeSheet({ title: `${agentId} 情绪映射确认（settled 末帧，共 ${EMOTIONS.length} 个）`, cells, binder: null });
      console.log(failures === 0 ? "ALL OK" : failures + " FAILURES");
      console.log("DONE →", OUT, "(open gallery.html)");
      app.exit(failures === 0 ? 0 : 2);
      return;
    }

    // 参考帧：Idle_01 基底（track0 常驻循环，不动 track4）
    await sleep(800);
    await cap("idle_base");

    for (const p of PRESETS) {
      try {
        await win.webContents.executeJavaScript(`window.__gallery.show(${JSON.stringify(p)})`);
      } catch (e) {
        console.log("CHECK preset", p, "FAIL exec:", e.message);
        failures++;
        continue;
      }
      await sleep(120);
      // B7 规则 4：截图前验证 track4 已就位（像素会骗人，状态不会）
      const st = JSON.parse(await win.webContents.executeJavaScript("JSON.stringify(window.SpineLayer.getState())"));
      if (st.track4 !== p) {
        console.log("CHECK preset", p, "FAIL track4=" + st.track4);
        failures++;
      }
      // 附件签名断言：22 预设签名必须互不相同（B5 普查）；碰撞 = 预设未生效
      const sig = await win.webContents.executeJavaScript("window.SpineLayer.getAttachmentSignature()");
      if (SIGNATURES.has(sig)) {
        console.log("CHECK preset", p, "FAIL 附件签名与 preset " + SIGNATURES.get(sig) + " 碰撞");
        failures++;
      } else {
        SIGNATURES.set(sig, p);
      }
      await sleep(3600); // 等 3.333s 动画落定到末帧
      await cap("p" + p + "_settled");
    }

    // 目视 contact sheet（自包含单文件，附映射重绑面板）
    const cells = [
      cellHtml("Idle_01 基底", "idle_base.png"),
      ...PRESETS.map((p) => cellHtml("preset " + p, "p" + p + "_settled.png")),
    ].join("\n");
    writeSheet({
      title: `${agentId} 数字情绪预设（settled 末帧，共 ${PRESETS.length} 个）— 点击图片放大；顶部面板重绑映射`,
      cells,
      binder: EMOTIONS,
    });
    console.log(failures === 0 ? "ALL OK" : failures + " FAILURES");
    console.log("DONE →", OUT, "(open gallery.html)");
    app.exit(failures === 0 ? 0 : 2);
  });
});
