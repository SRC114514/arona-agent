// 嘴型目视图库 + lip-sync 档位断言 harness。
// 逐嘴型渲染（setMouthOverride）+ capturePage 截图，生成自包含 HTML 供目视标定
//   closed/part/open 映射；随后自动断言档位切换（setMouthLevel → part/open/closed 还原）。
// 用法：env -u ELECTRON_RUN_AS_NODE ARONA_AGENT=arona ./node_modules/.bin/electron --no-sandbox pet/tools/mouth_capture.cjs
// 产物：/tmp/<agent>_mouths/ 下 PNG + gallery.html
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const PET = path.join(__dirname, "..");
const { AGENTS } = require(path.join(PET, "agents.cjs"));

const agentId = process.env.ARONA_AGENT && AGENTS[process.env.ARONA_AGENT] ? process.env.ARONA_AGENT : "arona";
const AGENT = AGENTS[agentId];
const OUT = `/tmp/${agentId}_mouths`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
let failures = 0;

// watchdog：嘴型 ~13 个 × 0.5s + 档位断言，120s 强制退出
setTimeout(() => { console.log("FATAL watchdog timeout"); app.exit(3); }, 120000);

const seenPngs = [];

async function cap(tag) {
  if (!win || win.isDestroyed()) return;
  let png = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    win.webContents.invalidate();
    await sleep(attempt === 1 ? 150 : 500);
    const img = await win.webContents.capturePage();
    png = img.toPNG();
    if (!seenPngs.some((b) => b.equals(png))) break; // 与所有历史帧都不同 → 新鲜
    console.log("STALE", tag, "attempt", attempt, "-> retry");
  }
  seenPngs.push(png);
  fs.writeFileSync(path.join(OUT, tag + ".png"), png);
  console.log("CAP", tag);
}

function dataUri(file) {
  return "data:image/png;base64," + fs.readFileSync(path.join(OUT, file)).toString("base64");
}

function cellHtml(cap, file) {
  const q = JSON.stringify(cap);
  return `<div class="cell" onclick='zoom(${q}, this.querySelector("img").src)'><img src="${dataUri(file)}"><div class="cap">${cap}</div></div>`;
}

function writeSheet(title, cells) {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${agentId} 嘴型目视</title>
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
</style></head>
<body>
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
        // 等 gallery.js 的 init 完成（SpineLayer 骨架就绪）：__gallery 就绪 = init().catch 已跑完
        if (await win.webContents.executeJavaScript("typeof window.__gallery === 'object' && typeof window.__gallery.show === 'function'")) break;
      } catch {}
      if (Date.now() - t0 > 15000) { console.log("FATAL init timeout"); app.exit(3); return; }
      await sleep(200);
    }
    console.log("READY", agentId, "mouth.slot =", AGENT.mouth ? AGENT.mouth.slot : "(无 mouth 配置)");

    // 无嘴槽角色（shiroko/hoshino）：直接退出
    if (!AGENT.mouth) {
      console.log("SKIP agent has no mouth config");
      app.exit(0);
      return;
    }
    const slot = AGENT.mouth.slot;
    const options = await win.webContents.executeJavaScript("window.SpineLayer.getMouthOptions()");
    console.log("MOUTH OPTIONS:", options.join(", "));

    // ---- 逐嘴型渲染（图库）+ 断言 ----
    const cells = [];
    for (const name of options) {
      await win.webContents.executeJavaScript(`window.SpineLayer.setMouthOverride(${JSON.stringify(name)})`);
      await sleep(150);
      const cur = await win.webContents.executeJavaScript(`window.SpineLayer.getSlotAttachment(${JSON.stringify(slot)})`);
      if (cur !== name) {
        console.log("CHECK mouth", name, "FAIL slot=" + cur);
        failures++;
      }
      await cap("m_" + name);
      cells.push(cellHtml(name, "m_" + name + ".png"));
    }
    // ---- 结束标定：释放 override → 自动模式接管；语音归零后嘴回中性嘴 ----
    // 先给非零电平激活自动包络，再释放 override，最后归零电平模拟说话结束。
    await win.webContents.executeJavaScript("window.SpineLayer.setMouthLevel(0.5)");
    await sleep(300);
    await win.webContents.executeJavaScript("window.SpineLayer.setMouthOverride(null)");
    await sleep(150);
    const autoActive = await win.webContents.executeJavaScript(`window.SpineLayer.getSlotAttachment(${JSON.stringify(slot)})`);
    if (autoActive !== AGENT.mouth.open) {
      console.log("CHECK auto(override释放后接管) FAIL slot=" + autoActive + " != " + AGENT.mouth.open);
      failures++;
    } else {
      console.log("CHECK auto(override释放后接管) OK -> " + autoActive);
    }
    await win.webContents.executeJavaScript("window.SpineLayer.setMouthLevel(0)");
    await sleep(600);
    const restored = await win.webContents.executeJavaScript(`window.SpineLayer.getSlotAttachment(${JSON.stringify(slot)})`);
    if (restored !== AGENT.mouth.closed) {
      console.log("CHECK restore FAIL slot=" + restored + " != " + AGENT.mouth.closed);
      failures++;
    } else {
      console.log("CHECK restore OK -> " + restored);
    }

    // ---- lip-sync 档位自动断言：微张 / 大张 / 静音还原 ----
    const expectMouth = async (label, level, want, settleMs) => {
      await win.webContents.executeJavaScript(`window.SpineLayer.setMouthLevel(${level})`);
      await sleep(settleMs);
      const cur = await win.webContents.executeJavaScript(`window.SpineLayer.getSlotAttachment(${JSON.stringify(slot)})`);
      if (cur !== want) {
        console.log("CHECK " + label + " FAIL slot=" + cur + " != " + want);
        failures++;
      } else {
        console.log("CHECK " + label + " OK -> " + cur);
      }
    };
    await expectMouth("part(0.14)", 0.14, AGENT.mouth.part, 500);
    await expectMouth("open(0.5)", 0.5, AGENT.mouth.open, 500);
    await expectMouth("closed(0)", 0, AGENT.mouth.closed, 600);

    writeSheet(`${agentId} 嘴型（mouth.slot=${slot}；当前映射 closed=${AGENT.mouth.closed} part=${AGENT.mouth.part} open=${AGENT.mouth.open}）— 点击图片放大，确认开度后回填 agents.cjs`, cells);
    console.log(failures === 0 ? "ALL OK" : failures + " FAILURES");
    console.log("DONE →", OUT, "(open gallery.html)");
    app.exit(failures === 0 ? 0 : 2);
  });
});
