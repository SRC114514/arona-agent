// ARONA GUI Electron 主进程：单窗口，与 Node 后端父进程经 stdin/stdout JSON lines 通信
// （协议行前缀 ###GUI### 过滤 Electron 日志；与桌宠桥同模式）。
const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const path = require("path");

const APP_TITLE = "Arona Agent";
const ICON_PATH = path.join(__dirname, "renderer", "assets", "icon.png");

const PREFIX = "###GUI###";
const VERBOSE = process.env.ARONA_GUI_VERBOSE === "1";

function send(msg) {
  try {
    process.stdout.write(PREFIX + JSON.stringify(msg) + "\n");
  } catch {
    // stdout 已关闭，忽略
  }
}

let win = null;
let rendererReady = false;
// backend 在 spawn 后立刻写 mode/ready 行，此时页面尚未 loadFile 完成——
// 直接 send 会静默丢弃，两页 .page 均保持 hidden → 白屏。就绪前入缓冲，did-finish-load 后 flush。
const pending = [];

function forward(msg) {
  if (win && !win.isDestroyed() && rendererReady) {
    win.webContents.send("gui-event", msg);
  } else {
    pending.push(msg);
  }
}

function flushPending() {
  if (!win || win.isDestroyed()) return;
  while (pending.length) {
    win.webContents.send("gui-event", pending.shift());
  }
}

// ARONA_GUI_SMOKE=1：loadFile + flush 后探测 DOM（页面可见性 / preload / 渲染层脚本），
// 结果打 SMOKE_RESULT 行后退出——冒烟验证 mode 事件不丢（无需人工看窗口）。
function smokeProbe() {
  const js = '(function(){var p=document.querySelectorAll(".page:not(.hidden)");'
    + 'return JSON.stringify({visible:p.length?p[0].id:null,'
    + 'api:!!(window.guiAPI&&window.guiAPI.send&&window.guiAPI.on),'
    + 'setup:!!(window.SetupUI&&window.SetupUI.handle)});})()';
  setTimeout(() => {
    win.webContents.executeJavaScript(js)
      // stderr 会被 backend 转发到终端（stdout 被 ###GUI### 协议解析占用）
      .then((r) => { console.error("SMOKE_RESULT " + r); app.quit(); })
      .catch((e) => { console.error("SMOKE_ERROR " + e); app.quit(); });
  }, 300);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: APP_TITLE,
    backgroundColor: "#151517",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 先挂监听再 loadFile：避免加载完成事件在挂监听前触发导致 rendererReady 永不置位
  win.webContents.once("did-finish-load", () => {
    rendererReady = true;
    flushPending();
    if (process.env.ARONA_GUI_SMOKE === "1") smokeProbe();
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("closed", () => { win = null; rendererReady = false; });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[gui] did-fail-load ${code} ${desc} ${url}`);
  });
  if (VERBOSE) win.webContents.openDevTools({ mode: "detach" });
}

// renderer → backend
ipcMain.on("gui-send", (_event, msg) => {
  send(msg);
});

// backend → renderer（行缓冲解析）
let buffer = "";
process.stdin.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(PREFIX)) continue;
    try {
      forward(JSON.parse(trimmed.slice(PREFIX.length)));
    } catch {
      // 非 JSON，忽略
    }
  }
});

// 窗口全关：先发 exit 请求让后端走完整清理，再退出（延迟让协议行先 flush）
app.on("window-all-closed", () => {
  send({ type: "exit" });
  setTimeout(() => app.quit(), 200);
});

app.whenReady().then(() => {
  // macOS 开发模式下 Dock 图标默认是 Electron 图标，用 LOGO 替换（打包后由应用 bundle 提供）
  if (process.platform === "darwin" && app.dock) {
    const icon = nativeImage.createFromPath(ICON_PATH);
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }
  createWindow();
});

app.on("render-process-gone", (_e, details) => {
  console.error(`[gui] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
});
