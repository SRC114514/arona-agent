// 视觉复现 harness：复刻桌宠真实运行时（同 renderer.js/eye_track.js/视频），合成光标 + 情绪指令时间线 + 定时截屏
// 用法：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox pet/tools/visual_test.cjs
// 产物：/tmp/petcap_<标签>_<ms>.png（capturePage）+ stdout 打印每帧 renderer 内部状态（CAP 行）
// 检查点：过渡中间帧角色区无桌面透出（无残影）、无黑帧、瞳孔不闪；结束后 getAnimations()===0
// 介导验收：saying/doubt 走 clip（CAP 行 clip 字段非空）；介导中途改写 pendingTarget 落定到最新目标
// 空闲验收：?idledebug 缩短间隔，轮询 clipPhase 截获眨眼（idle:blink）与皱眉（idle:frown，含末帧停留）
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const PET = path.join(__dirname, "..");
const { EMOTIONS } = require(path.join(PET, "emotions.cjs"));

let win;

// 指令时间线：t 秒时向渲染层发送情绪/重置指令；offs 覆盖默认截屏偏移
const TIMELINE = [
  // —— 回归：原 5 步纯溶解 + 中断语义 ——
  { t: 2.0, type: "emotion", name: "enjoy", tag: "v2e" },   // video → emotion
  { t: 3.0, type: "emotion", name: "smile", tag: "e2e" },   // emotion → emotion
  { t: 4.0, type: "reset", tag: "e2v" },                    // emotion → video
  { t: 5.0, type: "emotion", name: "love", tag: "irqA" },   // 中断：5.1s 反向回播
  { t: 5.1, type: "reset", tag: "irqB" },
  // —— 介导过渡（clip 350/300ms + 溶解 200ms）：+100 clip 中 / +300 clip 尾 / +700 落定 ——
  { t: 7.0, type: "emotion", name: "saying", tag: "medSay", offs: [100, 300, 700] },     // LookEnd_A 倒放
  { t: 8.2, type: "reset", tag: "medSayBack", offs: [100, 300, 700] },                   // LookEnd_A 正放
  { t: 9.6, type: "emotion", name: "doubt", tag: "medDoubt", offs: [100, 300, 700] },    // LookEnd_M 正放
  { t: 10.8, type: "reset", tag: "doubtBack" },                                          // 无路由 → 纯溶解
  // —— 介导中途改写 pendingTarget：12.2 进 saying clip，+150ms 改 smile，落定后 cur 应为 smile ——
  { t: 12.2, type: "emotion", name: "saying", tag: "medIrqA", offs: [100] },
  { t: 12.35, type: "emotion", name: "smile", tag: "medIrqB", offs: [400, 900] },
  // —— 回 video 稳定态，给空闲小动作留出触发窗口（frown 5~7s + 循环边界等待 ≤3.2s）——
  { t: 14.0, type: "reset", tag: "finalBack" },
];
// 每条指令后 +50/+150/+400ms 截屏（过渡中 / 过渡尾 / 落定后）；介导步骤用 offs 覆盖
const CAP_OFFSETS = [50, 150, 400];

// 空闲小动作截获：轮询 clipPhase，命中即截屏（frown 加截末帧停留段）
const IDLE_WATCH_TIMEOUT_MS = 45000;

const CAP_JS = `JSON.stringify({
  t: +vid.currentTime.toFixed(2),
  vidShown: vid.style.display !== "none", vidPaused: vid.paused,
  cur: sideTarget(cur),
  inflight: inflight ? { to: inflight.target, dir: inflight.direction, committed: inflight.committed } : null,
  clip: clipPhase ? clipPhase.kind : null,
  clipShown: getComputedStyle(clipEl).display !== "none",
  anims: document.getAnimations().length,
  eyeShown: eyeCanvas.style.display !== "none",
  off: { x: +eyeOff.x.toFixed(1), y: +eyeOff.y.toFixed(1) },
  ready: eyeReady
})`;

async function capNow(tag, ms) {
  if (!win || win.isDestroyed()) return;
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(`/tmp/petcap_${tag}_${ms}.png`, img.toPNG());
    const dbg = await win.webContents.executeJavaScript(CAP_JS);
    console.log("CAP", tag, ms, dbg);
  } catch (e) {
    console.log("CAP", tag, ms, "ERR", e.message);
  }
}

function cap(tag, ms) {
  setTimeout(() => void capNow(tag, ms), ms);
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 320,
    height: 674,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(PET, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  ipcMain.handle("pet:get-emotions", () => EMOTIONS);
  ipcMain.on("pet:drag", () => {});
  ipcMain.on("pet:dragend", () => {});
  ipcMain.on("pet:shake", () => {});
  win.loadFile(path.join(PET, "renderer", "index.html"), { search: "idledebug" });
  win.webContents.on("did-finish-load", () => {
    const t0 = Date.now();
    // 光标注入：0~2.5s 固定左侧远处（稳定最大左偏），之后绕窗口转圈
    const timer = setInterval(() => {
      if (!win || win.isDestroyed()) return;
      const t = (Date.now() - t0) / 1000;
      if (t < 2.5) win.webContents.send("pet:cursor", -100, 150);
      else win.webContents.send("pet:cursor", 160 + 200 * Math.cos(t * 3), 200 + 150 * Math.sin(t * 3));
    }, 16);
    for (const step of TIMELINE) {
      setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        if (step.type === "emotion") win.webContents.send("pet:emotion", step.name);
        else win.webContents.send("pet:reset");
      }, step.t * 1000);
      for (const off of step.offs || CAP_OFFSETS) cap(step.tag, step.t * 1000 + off);
    }
    // 空闲小动作截获：轮询 clipPhase，命中 blink 即截屏（皱眉已从空闲动作移除）
    let gotBlink = false;
    const idleTimer = setInterval(async () => {
      if (!win || win.isDestroyed()) return;
      try {
        const st = JSON.parse(await win.webContents.executeJavaScript(
          `JSON.stringify({ kind: clipPhase ? clipPhase.kind : null, shown: getComputedStyle(clipEl).display !== "none" })`
        ));
        const elapsed = Date.now() - t0;
        if (st.kind === "idle:blink" && st.shown && !gotBlink) {
          gotBlink = true;
          console.log("IDLE blink caught at", elapsed, "ms");
          await capNow("idleBlink", elapsed);
          setTimeout(() => void capNow("idleBlink_exit", Date.now() - t0), 600); // 切回 normal 后（验对准）
          clearInterval(idleTimer);
          setTimeout(() => { clearInterval(timer); app.quit(); }, 1200);
        }
      } catch {}
    }, 50);
    setTimeout(() => { clearInterval(timer); clearInterval(idleTimer); app.quit(); }, IDLE_WATCH_TIMEOUT_MS);
  });
});
app.on("window-all-closed", () => app.quit());
