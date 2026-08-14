// 视觉复现 harness：复刻桌宠真实运行时（同 spine_layer.js/renderer.js），合成光标 + 情绪指令时间线 + 定时截屏
// 用法：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox pet/tools/visual_test.cjs
// 产物：/tmp/petcap_<标签>_<ms>.png（capturePage）+ stdout 打印每帧 renderer 内部状态（CAP 行）
// 检查点：过渡中间帧角色区无桌面透出（无残影）、无黑帧；结束后 getAnimations()===0
// 介导验收：saying/doubt 的 track0 切到 Look_01_A/M（CAP 行 spine.track0）；回基底走 LookEnd 后接 Idle_01
// 摸头验收：合成头部摇动手势 → track0=Dev_Pat_01_M、patting=true、headRot 跟随光标；离开头部区域回 Idle
// 眨眼验收：?idledebug 缩短间隔，轮询 spine.track1 非空截获闭眼中间帧
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const PET = path.join(__dirname, "..");
const { EMOTIONS } = require(path.join(PET, "emotions.cjs"));

let win;

// 指令时间线：t 秒时向渲染层发送情绪/重置指令；offs 覆盖默认截屏偏移
const TIMELINE = [
  // —— 回归：原 5 步纯溶解 + 中断语义 ——
  { t: 2.0, type: "emotion", name: "enjoy", tag: "v2e" },   // spine → emotion（enjoy 带 Pat_01_A 介导姿态）
  { t: 3.0, type: "emotion", name: "smile", tag: "e2e" },   // emotion → emotion
  { t: 4.0, type: "reset", tag: "e2v" },                    // emotion → spine
  { t: 5.0, type: "emotion", name: "love", tag: "irqA" },   // 中断：5.1s 反向回播
  { t: 5.1, type: "reset", tag: "irqB" },
  // —— 介导过渡：saying enter=Look_01_A / exit=LookEnd_01_A；doubt enter=Look_01_M / exit=LookEnd_01_M ——
  { t: 7.0, type: "emotion", name: "saying", tag: "medSay", offs: [100, 300, 700] },
  { t: 8.2, type: "reset", tag: "medSayBack", offs: [100, 300, 700] },
  { t: 9.6, type: "emotion", name: "doubt", tag: "medDoubt", offs: [100, 300, 700] },
  { t: 10.8, type: "reset", tag: "doubtBack", offs: [100, 300, 700] },
  // —— 介导中途改写目标：12.2 进 saying，+150ms 改 smile，落定后 cur 应为 smile ——
  { t: 12.2, type: "emotion", name: "saying", tag: "medIrqA", offs: [100] },
  { t: 12.35, type: "emotion", name: "smile", tag: "medIrqB", offs: [400, 900] },
  // —— 回 spine 稳定态，给眨眼/摸头留出窗口 ——
  { t: 14.0, type: "reset", tag: "finalBack" },
  // —— 摸头：合成摇动手势（头部区域）→ 锁窗 + Pat + 头部跟随；16.9 光标离开头部 → 结束摸头 ——
  { t: 16.0, type: "pat", tag: "pat", offs: [200, 600] },
  { t: 16.9, type: "patExit", tag: "patExit", offs: [200, 600] },
];
// 每条指令后 +50/+150/+400ms 截屏（过渡中 / 过渡尾 / 落定后）；介导步骤用 offs 覆盖
const CAP_OFFSETS = [50, 150, 400];

// 空闲验收超时（眨眼截获等待上限）
const IDLE_WATCH_TIMEOUT_MS = 45000;

const CAP_JS = `JSON.stringify({
  cur: sideTarget(cur),
  inflight: inflight ? { to: inflight.target, dir: inflight.direction, committed: inflight.committed } : null,
  spine: window.SpineLayer.getState(),
  anims: document.getAnimations().length,
  emoA: getComputedStyle(document.getElementById("emoA")).display,
  emoB: getComputedStyle(document.getElementById("emoB")).display
})`;

async function capNow(tag, ms) {
  if (!win || win.isDestroyed()) return;
  try {
    // 先读状态再截图：眨眼/闭眼等瞬时状态不会在截图时刻已过期
    const dbg = await win.webContents.executeJavaScript(CAP_JS);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(`/tmp/petcap_${tag}_${ms}.png`, img.toPNG());
    console.log("CAP", tag, ms, dbg);
  } catch (e) {
    console.log("CAP", tag, ms, "ERR", e.message);
  }
}

function cap(tag, ms) {
  setTimeout(() => void capNow(tag, ms), ms);
}

// 摸头手势合成：mousedown 于头部中心 → 左右交替 mousemove（≥3 次换向）→ 光标固定偏右
async function synthPat(downX, downY, shakeAmp) {
  const seq = [];
  for (let i = 0; i < 7; i++) seq.push(downX + (i % 2 === 0 ? -1 : 1) * shakeAmp);
  await win.webContents.executeJavaScript(
    `document.dispatchEvent(new MouseEvent("mousedown", { clientX: ${downX}, clientY: ${downY}, screenX: ${downX}, screenY: ${downY}, bubbles: true }))`
  );
  for (const x of seq) {
    await win.webContents.executeJavaScript(
      `document.dispatchEvent(new MouseEvent("mousemove", { clientX: ${x}, clientY: ${downY}, screenX: ${x}, screenY: ${downY}, bubbles: true }))`
    );
    await new Promise((r) => setTimeout(r, 60));
  }
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
  // 忽略真实鼠标输入：测试期间用户鼠标划过窗口会触发真实 mousemove，干扰合成手势
  // （合成事件走 document.dispatchEvent，不受影响）
  win.webContents.on("console-message", (e, a, b) => console.log("[R]", (a && typeof a === "object" ? a.message : b)));
  win.webContents.on("did-finish-load", () => win.setIgnoreMouseEvents(true));
  win.loadFile(path.join(PET, "renderer", "index.html"), { search: "idledebug" });
  win.webContents.on("did-finish-load", async () => {
    // 等 Spine 基底就绪后再起时间线
    const tReady = Date.now();
    while (!win || !win.isDestroyed()) {
      try {
        const ok = await win.webContents.executeJavaScript("window.SpineLayer && window.SpineLayer.getState().track0 === 'Idle_01'");
        if (ok) break;
      } catch {}
      if (Date.now() - tReady > 15000) {
        console.log("FATAL spine init timeout");
        app.quit();
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const t0 = Date.now();
    console.log("READY after", Date.now() - tReady, "ms");

    // 光标注入：0~15.9s 绕窗口转圈（空闲注视用）；摸头窗口期 16.0~16.9s 固定偏右（头部跟随可断言）
    const timer = setInterval(() => {
      if (!win || win.isDestroyed()) return;
      const t = (Date.now() - t0) / 1000;
      if (t < 15.9) win.webContents.send("pet:cursor", 160 + 200 * Math.cos(t * 3), 200 + 150 * Math.sin(t * 3));
      else if (t < 17.5) win.webContents.send("pet:cursor", 300, 80); // 头部右侧远处 → 头部右转
    }, 16);

    for (const step of TIMELINE) {
      setTimeout(async () => {
        if (!win || win.isDestroyed()) return;
        if (step.type === "emotion") win.webContents.send("pet:emotion", step.name);
        else if (step.type === "reset") win.webContents.send("pet:reset");
        else if (step.type === "pat") {
          // 头部区域（窗口比例 26%-78% x，6%-29% y）中心
          await synthPat(160, 90, 25);
        } else if (step.type === "patExit") {
          // 光标离开头部区域（任意方向 16px 缓冲）→ 结束摸头，窗口仍锁定
          await win.webContents.executeJavaScript(
            `document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, clientY: 400, screenX: 300, screenY: 400, bubbles: true }))`
          );
        }
      }, step.t * 1000);
      for (const off of step.offs || CAP_OFFSETS) cap(step.tag, step.t * 1000 + off);
    }

    // 眨眼截获：轮询 spine.track1 === "Eye_Close_01"（idledebug 下 1~2s 一次），命中即截闭眼中间帧。
    // 注意：只截获不退出——时间线后面的介导/摸头步骤还要跑，收尾由 FINAL 定时器负责。
    let gotBlink = false;
    const idleTimer = setInterval(async () => {
      if (!win || win.isDestroyed()) return;
      try {
        const st = JSON.parse(await win.webContents.executeJavaScript(
          `JSON.stringify({ t1: window.SpineLayer.getState().track1, cur: sideTarget(cur) })`
        ));
        const elapsed = Date.now() - t0;
        if (!gotBlink && st.t1 === "Eye_Close_01" && st.cur === "spine") {
          gotBlink = true;
          console.log("IDLE blink caught at", elapsed, "ms");
          await capNow("idleBlink", elapsed);
          setTimeout(() => void capNow("idleBlink_mid", elapsed + 60), 60); // 闭眼中间帧（Eye_Close_01 0.03~0.10s 为闭眼段）
          clearInterval(idleTimer);
        }
      } catch {}
    }, 40);
    // 收尾：时间线全部跑完（patExit 落定后）打印动画泄漏检查并退出
    setTimeout(async () => {
      const anims = await win.webContents.executeJavaScript("document.getAnimations().length");
      console.log("FINAL anims:", anims);
      clearInterval(timer);
      app.quit();
    }, 19500);
    setTimeout(() => { clearInterval(timer); clearInterval(idleTimer); app.quit(); }, IDLE_WATCH_TIMEOUT_MS);
  });
});
app.on("window-all-closed", () => app.quit());
