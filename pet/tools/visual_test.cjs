// 视觉复现 harness：复刻桌宠真实运行时（同 spine_layer.js/renderer.js），合成光标 + 情绪指令时间线 + 定时截屏
// 用法：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox pet/tools/visual_test.cjs
// 产物：/tmp/petcap_<标签>_<ms>.png（capturePage）+ stdout 打印每帧 renderer 内部状态（CAP 行）与断言结果（CHECK 行）
// 断言模型（情绪 = track4 数字预设）：
//   - 每情绪：track4 = 预设名 + 特征 slot attachment（光环族/嘴型/Eye_Cover）符合期望
//   - 情绪→reset：track4 摘除后 halo 回 halo_normal_00、Mouse_01 回 setup（验 V6 清理路径）
//   - 眨眼：track5 截获；闭眼预设期间 SpineLayer.blink() 返回 false（互斥断言）
//   - 摸头：合成摇动手势 → track0=Pat_01_A、patting=true；离开头部回 Idle（不变）
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const PET = path.join(__dirname, "..");
const { AGENTS } = require(path.join(PET, "agents.cjs"));

// 测试角色：ARONA_AGENT 环境变量（缺省 arona）。时间线/断言按 Arona 定标，
// plana 仅保证加载/渲染链路可用（slot 期望值未普查，勿在此断言 plana 表情细节）。
const AGENT_ID = process.env.ARONA_AGENT && AGENTS[process.env.ARONA_AGENT] ? process.env.ARONA_AGENT : "arona";
const AGENT = AGENTS[AGENT_ID];

let win;

// 指令时间线：t 秒时向渲染层发送情绪/重置指令；offs 覆盖默认截屏偏移
// expect：落定后（+400ms）执行的断言（track4/slot attachment 期望值）
const TIMELINE = [
  // —— 情绪进/出 + 瞬时切换 ——
  { t: 2.0, type: "emotion", name: "enjoy", tag: "enjoy",
    expect: { track4: "13", coverL: "L_Eye_Cover_01", halo: "halo_normal_00", mouse: "Mouse_01", gaze: false } },
  { t: 3.0, type: "emotion", name: "smile", tag: "smile",
    expect: { track4: "99", coverL: "L_Eye_Cover_01", halo: "halo_normal_00", mouse: "Mouse_01", gaze: false } },
  { t: 4.0, type: "reset", tag: "enjoyBack",
    expect: { track4: null, coverL: null, halo: "halo_normal_00", mouse: "Mouse_01", gaze: true } },
  { t: 5.0, type: "emotion", name: "love", tag: "love",
    expect: { track4: "11", coverL: "L_Eye_Cover_01", halo: "halo_love_00", gaze: false } },
  { t: 5.4, type: "reset", tag: "loveBack",
    expect: { track4: null, halo: "halo_normal_00", coverL: null, gaze: true } },
  // —— 禁跟随预设：angry(05)/jealous(07) 睁眼但 gaze=false ——
  { t: 5.9, type: "emotion", name: "angry", tag: "angry",
    expect: { track4: "05", halo: "halo_angry", mouse: "Mouse_06", gaze: false } },
  { t: 6.4, type: "reset", tag: "angryBack",
    expect: { track4: null, halo: "halo_normal_00", gaze: true } },
  // —— 说话/疑惑（track4 预设 + 特征 slot）——
  { t: 7.0, type: "emotion", name: "saying", tag: "saying", offs: [100, 300, 700],
    expect: { track4: "20", mouse: "Mouse_02", halo: "halo_normal_00", gaze: true } },
  { t: 8.2, type: "reset", tag: "sayingBack", offs: [100, 300, 700],
    expect: { track4: null, mouse: "Mouse_01", gaze: true } },
  { t: 9.6, type: "emotion", name: "doubt", tag: "doubt", offs: [100, 300, 700],
    expect: { track4: "27", coverL: "L_Eye_Cover_02", halo: "halo_depressed2_00", shadow: "Face_Shadow_01", mouse: "Mouse_11", gaze: false } },
  { t: 10.2, type: "reset", tag: "doubtBack", offs: [100, 300, 700],
    expect: { track4: null, halo: "halo_normal_00", shadow: null, coverL: null, gaze: true } },
  { t: 10.8, type: "emotion", name: "jealous", tag: "jealous", offs: [100, 300],
    expect: { track4: "07", halo: "halo_depressed2_00", shadow: "Face_Shadow_01", gaze: false } },
  { t: 11.4, type: "reset", tag: "jealousBack",
    expect: { track4: null, halo: "halo_normal_00", shadow: null, gaze: true } },
  // —— 中途改写目标：12.2 进 saying，+150ms 改 smile，落定后 preset 应为 smile ——
  { t: 12.2, type: "emotion", name: "saying", tag: "midIrqA", offs: [100] },
  { t: 12.35, type: "emotion", name: "smile", tag: "midIrqB", offs: [400, 900],
    expect: { track4: "99", mouse: "Mouse_01", gaze: false } },
  // —— 回 spine 稳定态，给眨眼/摸头留出窗口 ——
  { t: 14.0, type: "reset", tag: "finalBack",
    expect: { track4: null, halo: "halo_normal_00", mouse: "Mouse_01", gaze: true } },
  // —— 摸头：合成摇动手势（头部区域）→ 锁窗 + Pat + 头部跟随；16.9 光标离开头部 → 结束摸头 ——
  { t: 16.0, type: "pat", tag: "pat", offs: [200, 600] },
  { t: 16.9, type: "patExit", tag: "patExit", offs: [200, 600] },
];
// 每条指令后 +50/+150/+400ms 截屏；带 offs 的步骤用覆盖
const CAP_OFFSETS = [50, 150, 400];

// 空闲验收超时（眨眼截获等待上限）
const IDLE_WATCH_TIMEOUT_MS = 45000;

const CAP_JS = `JSON.stringify({
  spine: window.SpineLayer.getState(),
  slots: {
    halo: window.SpineLayer.getSlotAttachment("halo_normal_00"),
    mouse: window.SpineLayer.getSlotAttachment("Mouse_01"),
    coverL: window.SpineLayer.getSlotAttachment("L_Eye_Cover_01"),
    shadow: window.SpineLayer.getSlotAttachment("Face_Shadow_01"),
    sweat: window.SpineLayer.getSlotAttachment("Sweat_01"),
  },
  anims: document.getAnimations().length
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

// 落定断言：读 getState + slot attachment，对照 expect 逐项输出 CHECK
function check(tag, ms, expect) {
  setTimeout(async () => {
    if (!win || win.isDestroyed()) return;
    try {
      const st = JSON.parse(await win.webContents.executeJavaScript(
        `JSON.stringify({ spine: window.SpineLayer.getState(), slots: {
          halo: window.SpineLayer.getSlotAttachment("halo_normal_00"),
          mouse: window.SpineLayer.getSlotAttachment("Mouse_01"),
          coverL: window.SpineLayer.getSlotAttachment("L_Eye_Cover_01"),
          shadow: window.SpineLayer.getSlotAttachment("Face_Shadow_01"),
          sweat: window.SpineLayer.getSlotAttachment("Sweat_01") } })`
      ));
      const fails = [];
      if (expect.track4 !== undefined && st.spine.track4 !== expect.track4)
        fails.push(`track4=${st.spine.track4} != ${expect.track4}`);
      if (expect.preset !== undefined && st.spine.preset !== expect.preset)
        fails.push(`preset=${st.spine.preset} != ${expect.preset}`);
      if (expect.gaze !== undefined && st.spine.gaze !== expect.gaze)
        fails.push(`gaze=${st.spine.gaze} != ${expect.gaze}`);
      for (const k of ["halo", "mouse", "coverL", "shadow", "sweat"]) {
        if (expect[k] !== undefined && st.slots[k] !== expect[k])
          fails.push(`${k}=${st.slots[k]} != ${expect[k]}`);
      }
      console.log("CHECK", tag, fails.length ? "FAIL " + fails.join("; ") : "OK");
    } catch (e) {
      console.log("CHECK", tag, "ERR", e.message);
    }
  }, ms);
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
    width: 480,
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
  // isMain:false：回归只测摸头路径，明确禁用 dizzy 检测，合成手势不受新逻辑干扰
  ipcMain.handle("pet:get-agent-config", () => ({ id: AGENT_ID, isMain: false, ...AGENT }));
  ipcMain.on("pet:drag", () => {});
  ipcMain.on("pet:dragend", () => {});
  ipcMain.on("pet:shake", () => {});
  ipcMain.on("pet:dizzy", () => {});
  // 忽略真实鼠标输入：测试期间用户鼠标划过窗口会触发真实 mousemove，干扰合成手势
  // （合成事件走 document.dispatchEvent，不受影响）
  win.webContents.on("console-message", (event) => console.log("[R]", event && event.message));
  win.webContents.on("did-finish-load", () => win.setIgnoreMouseEvents(true));
  win.loadFile(path.join(PET, "renderer", "index.html"), { search: "idledebug&agent=" + AGENT_ID });
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
          // 光标离开头部区域（90px 缓冲外）→ 结束摸头，窗口仍锁定
          await win.webContents.executeJavaScript(
            `document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, clientY: 400, screenX: 300, screenY: 400, bubbles: true }))`
          );
        }
      }, step.t * 1000);
      for (const off of step.offs || CAP_OFFSETS) cap(step.tag, step.t * 1000 + off);
      if (step.expect) check(step.tag, step.t * 1000 + 400, step.expect);
    }

    // 眨眼互斥断言：
    //   t=2.6s（enjoy=13 闭眼预设中）blink() 必须返回 false
    //   t=7.6s（saying=02 睁眼预设中）blink() 必须返回 true
    // 注意：只截获不退出——时间线后面的步骤还要跑，收尾由 FINAL 定时器负责。
    let gotBlink = false;
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript("window.SpineLayer.blink()");
        console.log("CHECK blinkClosed(enjoy) ", r === false ? "OK" : "FAIL got " + r);
      } catch (e) { console.log("CHECK blinkClosed ERR", e.message); }
    }, 2600);
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript("window.SpineLayer.blink()");
        console.log("CHECK blinkOpen(saying) ", r === true ? "OK" : "FAIL got " + r);
      } catch (e) { console.log("CHECK blinkOpen ERR", e.message); }
    }, 7600);

    // 眨眼截获：轮询 spine.track5 === "Eye_Close_01"（idledebug 下 1~2s 一次，睁眼窗口期可中），命中即截闭眼中间帧。
    const idleTimer = setInterval(async () => {
      if (!win || win.isDestroyed()) return;
      try {
        const st = JSON.parse(await win.webContents.executeJavaScript(
          `JSON.stringify({ t5: window.SpineLayer.getState().track5 })`
        ));
        const elapsed = Date.now() - t0;
        if (!gotBlink && st.t5 === "Eye_Close_01") {
          gotBlink = true;
          console.log("IDLE blink caught at", elapsed, "ms");
          await capNow("idleBlink", elapsed);
          setTimeout(() => void capNow("idleBlink_mid", elapsed + 60), 60); // 闭眼中间帧（Eye_Close_01 0.03~0.10s 为闭眼段）
          clearInterval(idleTimer);
        }
      } catch {}
    }, 40);
    // 收尾：时间线全部跑完（patExit 落定后）打印收尾状态并退出
    setTimeout(async () => {
      try {
        const dbg = await win.webContents.executeJavaScript(CAP_JS);
        console.log("FINAL", dbg);
      } catch {}
      clearInterval(timer);
      app.quit();
    }, 19500);
    setTimeout(() => { clearInterval(timer); clearInterval(idleTimer); app.quit(); }, IDLE_WATCH_TIMEOUT_MS);
  });
});
app.on("window-all-closed", () => app.quit());
