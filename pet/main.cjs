// ARONA 桌宠 Electron 主进程
// 与主 Agent 进程通过 stdin/stdout JSON lines 通信（协议行前缀 ###PET### 过滤 Electron 日志）
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { AGENTS } = require("./agents.cjs");

// Windows 透明无边框窗口在部分显卡驱动下会触发渲染进程崩溃；禁 GPU 硬件加速（须在 app ready 前调用）。
// 注意：不能用 app.disableHardwareAcceleration()——Electron 43 里它会顺带 --disable-software-rasterizer，
// 把软件 WebGL 一并堵死（实测 getGPUFeatureStatus().webgl === "disabled_off"，Spine 直接白屏）。
// 改用细粒度 flag：disable-gpu 只禁硬件 GPU（保留"防透明窗口崩溃"的初衷），
// enable-unsafe-swiftshader 放行 SwiftShader 软件 WebGL（仍失败则 spine_layer 自动降级 Canvas 2D，见 §B12）。
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
}

// 当前桌宠角色：ARONA_AGENT 环境变量（src/pet.ts 注入），非法/缺省回退 arona
const AGENT_ID = process.env.ARONA_AGENT && AGENTS[process.env.ARONA_AGENT] ? process.env.ARONA_AGENT : "arona";
const AGENT = AGENTS[AGENT_ID];

const PREFIX = "###PET###";
const POS_FILE = path.join(os.homedir(), ".arona", "pet.json");

// --verbose（src/pet.ts 注入 ARONA_PET_VERBOSE=1 + --enable-logging）：
// 主进程详细日志走 stderr 原样转发回终端，用于锁定 Windows 白屏等"进程活着但无画面"问题。
const VERBOSE = process.env.ARONA_PET_VERBOSE === "1";
function vlog(...args) {
  if (VERBOSE) console.error("[pet:verbose]", ...args);
}

let win = null;
let fxWin = null; // 全屏透明特效窗口（点击/拖尾），覆盖所有显示器、鼠标穿透

function send(msg) {
  try {
    process.stdout.write(PREFIX + JSON.stringify(msg) + "\n");
  } catch {
    // stdout 已关闭，忽略
  }
}

// ---- 位置记忆 ----
function loadPosition() {
  try {
    const data = JSON.parse(fs.readFileSync(POS_FILE, "utf-8"));
    if (Number.isFinite(data.x) && Number.isFinite(data.y)) {
      // 屏幕边界检查：记忆坐标须落在任一显示器 bounds 内（中心点判定），否则视为失效。
      // 防分辨率变化 / Mac→Win 迁移 / 负坐标导致窗口创建在屏幕外"看似没显示"。
      const W = 320, H = 674; // 与 createWindow 尺寸一致
      for (const d of screen.getAllDisplays()) {
        const { x, y, width, height } = d.bounds;
        const cx = data.x + W / 2, cy = data.y + H / 2;
        if (cx >= x && cx <= x + width && cy >= y && cy <= y + height) return data;
      }
    }
  } catch {
    // 无记录或损坏，忽略
  }
  return null;
}

function savePosition(x, y) {
  try {
    fs.mkdirSync(path.dirname(POS_FILE), { recursive: true });
    fs.writeFileSync(POS_FILE, JSON.stringify({ x, y }));
  } catch {
    // 写入失败不影响功能
  }
}

// ---- 窗口 ----
function createWindow() {
  win = new BrowserWindow({
    width: 320,
    height: 674, // 与视频比例一致（1010x2128 ≈ 1:2.107），角色填满窗口、无黑边
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false, // 不抢终端焦点
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  const pos = loadPosition();
  if (pos) win.setPosition(pos.x, pos.y);
  vlog("window created", JSON.stringify({ pos, alwaysOnTop: win.isAlwaysOnTop(), visible: win.isVisible(), bounds: win.getBounds() }));

  // PET_PAGE=spinetest → 加载 Spine 调试页（默认仍 index.html，零风险）
  const page = process.env.PET_PAGE === "spinetest" ? "spinetest.html" : "index.html";
  // ?agent=<id>：渲染层（spine_layer.js/renderer.js）据此读取对应角色配置
  const url = path.join(__dirname, "renderer", page);
  win.loadFile(url, { search: "agent=" + AGENT_ID });
  vlog("loadFile", url, "?agent=" + AGENT_ID);
  if (process.env.PET_PAGE) {
    // 调试页：附带 devtools 便于人工查看 console / 网络加载
    win.webContents.openDevTools({ mode: "detach" });
  }
  win.webContents.on("did-finish-load", () => {
    vlog("did-finish-load", win.webContents.getURL());
    send({ type: "ready" });
  });
  // 页面加载失败（资源 404 / file:// 路径错 / 加载被拦）：必然白屏，任何模式都要转发
  win.webContents.on("did-fail-load", (_e, code, desc, url2, isMain) => {
    if (!isMain) return;
    console.error(`[pet:render] did-fail-load code=${code} desc=${desc} url=${url2}`);
  });
  // renderer console 转发到 stderr（src/pet.ts 已打印 [pet] 前缀）：页面 JS 错误默认静默
  // （不进 stderr），Windows 白屏等故障全靠它定位。Electron 43 规范签名为单事件对象：
  // event.{message, level, lineNumber, sourceId}（老双参数签名会打 deprecation 警告）。
  win.webContents.on("console-message", (event) => {
    const msg = typeof event.message === "string" ? event.message : "";
    if (!msg) return;
    const line = event.lineNumber ? `:${event.lineNumber}` : "";
    // verbose：带 level（0=verbose 1=info 2=warning 3=error）+ 来源文件
    if (VERBOSE) {
      const src = event.sourceId ? ` (${event.sourceId}${line})` : "";
      console.error(`[pet:render:${event.level ?? "?"}]${src} ${msg}`);
    } else {
      console.error(`[pet:render]${line} ${msg}`);
    }
  });
  // 渲染进程崩溃上报（Windows 透明窗口崩溃的主因；reason/exitCode 可精确定位）
  win.webContents.on("render-process-gone", (_e, details) => {
    send({ type: "crash", kind: "render", reason: details.reason, exitCode: details.exitCode, url: win.webContents.getURL() });
    vlog("render-process-gone", JSON.stringify(details));
  });
  // 窗口关闭诊断（verbose）：window-all-closed 会因任一窗口被系统/驱动关闭而触发，导致 code 0 退出
  win.on("closed", () => vlog("win closed"));
  startCursorTracking();
}

// ---- 全屏特效窗口（点击/拖尾铺满整个屏幕） ----
// 覆盖所有显示器的并集 bounds；透明、鼠标穿透（setIgnoreMouseEvents），
// 层级高于桌宠（screen-saver + 1），这样拖尾能盖在角色之上跨屏延伸。
function getAllDisplaysBounds() {
  const ds = screen.getAllDisplays();
  if (!ds.length) return screen.getPrimaryDisplay().bounds;
  let x = Infinity, y = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const d of ds) {
    x = Math.min(x, d.bounds.x);
    y = Math.min(y, d.bounds.y);
    x2 = Math.max(x2, d.bounds.x + d.bounds.width);
    y2 = Math.max(y2, d.bounds.y + d.bounds.height);
  }
  return { x, y, width: x2 - x, height: y2 - y };
}

function createFxWindow() {
  const b = getAllDisplaysBounds();
  fxWin = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  fxWin.setAlwaysOnTop(true, "screen-saver", 1); // 高于桌宠窗口的 screen-saver
  fxWin.setIgnoreMouseEvents(true); // 鼠标穿透，不拦任何点击
  if (process.platform === "darwin") {
    fxWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  fxWin.loadFile(path.join(__dirname, "renderer", "fx.html"));
  fxWin.on("closed", () => vlog("fxWin closed"));
  vlog("fx window created", JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
}

// ---- 特效坐标转发：桌宠窗口(全局 DIP) → 特效窗口(本地 CSS px) ----
// screenX/screenY 是相对主显示器原点的全局 DIP，减去 fxWin 左上角即得本地坐标。
function relayFx(channel, sx, sy) {
  if (!fxWin || fxWin.isDestroyed()) return;
  const [wx, wy] = fxWin.getPosition();
  fxWin.webContents.send(channel, sx - wx, sy - wy);
}

ipcMain.on("pet:fx-down", (_e, sx, sy) => relayFx("fx:down", sx, sy));
ipcMain.on("pet:fx-move", (_e, sx, sy) => relayFx("fx:move", sx, sy));
ipcMain.on("pet:fx-up", () => {
  if (fxWin && !fxWin.isDestroyed()) fxWin.webContents.send("fx:up");
});

// ---- 全局光标轮询（~60Hz，DIP 坐标系内运算，供渲染层瞳孔跟随） ----
// 总是发送（不跟踪情绪状态），主进程保持无状态；renderer 自行判断是否激活
const CURSOR_POLL_MS = 16;
let cursorTimer = null;
let lastCursor = { x: NaN, y: NaN };

function startCursorTracking() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();      // 全局 DIP
    const [wx, wy] = win.getPosition();           // 窗口 DIP，同源可直接相减
    const x = p.x - wx;
    const y = p.y - wy;                           // 窗口本地 CSS px（可在窗口外，注视效果所需）
    if (Math.abs(x - lastCursor.x) < 1 && Math.abs(y - lastCursor.y) < 1) return; // 静止节流
    lastCursor = { x, y };
    win.webContents.send("pet:cursor", x, y);
  }, CURSOR_POLL_MS);
}

// ---- 拖动 IPC（16ms 节流） ----
let dragPending = null;
let dragTimer = null;

ipcMain.on("pet:drag", (_e, dx, dy) => {
  if (!win) return;
  dragPending = {
    x: (dragPending?.x ?? win.getPosition()[0]) + dx,
    y: (dragPending?.y ?? win.getPosition()[1]) + dy,
  };
  if (!dragTimer) {
    dragTimer = setTimeout(() => {
      dragTimer = null;
      if (dragPending && win) {
        win.setPosition(Math.round(dragPending.x), Math.round(dragPending.y));
        dragPending = null;
      }
    }, 16);
  }
});

ipcMain.on("pet:dragend", () => {
  if (!win) return;
  if (dragTimer) {
    clearTimeout(dragTimer);
    dragTimer = null;
  }
  if (dragPending) {
    win.setPosition(Math.round(dragPending.x), Math.round(dragPending.y));
    dragPending = null;
  }
  const [x, y] = win.getPosition();
  savePosition(x, y);
  send({ type: "moved", x, y });
});

ipcMain.on("pet:shake", () => send({ type: "shake" }));

ipcMain.handle("pet:get-agent-config", () => ({ id: AGENT_ID, ...AGENT }));

// ---- stdin 协议 ----
let buffer = "";

function handleMessage(msg) {
  if (!win) return;
  vlog("stdin msg", JSON.stringify(msg));
  switch (msg.type) {
    case "set_emotion":
      if (AGENT.emotions[msg.name]) {
        win.webContents.send("pet:emotion", msg.name);
      } else {
        send({ type: "error", message: `unknown emotion: ${msg.name}` });
      }
      break;
    case "reset":
      win.webContents.send("pet:reset");
      break;
    case "quit":
      app.quit();
      break;
  }
}

process.stdin.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      handleMessage(JSON.parse(trimmed));
    } catch {
      // 非 JSON 行，忽略
    }
  }
});

process.stdin.on("end", () => {
  // Windows：stdin 会提前 EOF（GUI 子系统 + 父进程 stdio 链），直接 app.quit() 会把刚启动、
  // 尚未 did-finish-load 的桌宠误杀（症状：code 0 静默退出、窗口闪一下不见）。
  // 桌宠退出由父进程（src/pet.ts）的 quit 指令 + SIGTERM 兜底驱动，不依赖 stdin EOF。
  // 其他平台：stdin EOF 可靠表示父进程退出，跟随退出防孤儿进程。
  vlog("stdin END", process.platform === "win32" ? "(ignored on win32)" : "(quit)");
  if (process.platform !== "win32") app.quit();
});

app.whenReady().then(() => {
  if (VERBOSE) {
    // GPU 功能状态：确认 webgl/webgl2 是 hardware/software/disabled（Windows 白屏排查关键）
    try {
      vlog("GPU feature status:", JSON.stringify(app.getGPUFeatureStatus()));
    } catch (e) {
      vlog("getGPUFeatureStatus failed:", e.message);
    }
    vlog("platform:", process.platform, "electron:", process.versions.electron, "chrome:", process.versions.chrome);
    vlog("displays:", JSON.stringify(screen.getAllDisplays().map((d) => d.bounds)));
  }
  createWindow();
  createFxWindow();
});

app.on("window-all-closed", () => {
  vlog("window-all-closed → app.quit()");
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
  app.quit();
});

// 退出链路诊断（verbose）：定位"进程 code 0 退出但无 did-finish-load"的退出源
app.on("before-quit", () => vlog("before-quit"));
app.on("will-quit", () => vlog("will-quit"));

// ---- 崩溃日志：GPU/utility 子进程崩溃 + 主进程 JS 异常（配合 src/pet.ts 的 crash 处理定位问题） ----
app.on("child-process-gone", (_e, details) => {
  send({ type: "crash", kind: details.type || "child", reason: details.reason, exitCode: details.exitCode });
  vlog("child-process-gone", JSON.stringify(details));
});
process.on("uncaughtException", (err) => {
  console.error("[pet:crash] uncaughtException:", err && err.stack ? err.stack : err);
  process.exit(1); // 主进程状态已不可靠，退出让父进程按崩溃路径重启
});
process.on("unhandledRejection", (reason) => {
  console.error("[pet:crash] unhandledRejection:", reason);
});
