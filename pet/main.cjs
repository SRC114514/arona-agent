// ARONA 桌宠 Electron 主进程
// 与主 Agent 进程通过 stdin/stdout JSON lines 通信（协议行前缀 ###PET### 过滤 Electron 日志）
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { AGENTS } = require("./agents.cjs");

// 当前桌宠角色：ARONA_AGENT 环境变量（src/pet.ts 注入），非法/缺省回退 arona
const AGENT_ID = process.env.ARONA_AGENT && AGENTS[process.env.ARONA_AGENT] ? process.env.ARONA_AGENT : "arona";
const AGENT = AGENTS[AGENT_ID];

const PREFIX = "###PET###";
const POS_FILE = path.join(os.homedir(), ".arona", "pet.json");

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
    if (Number.isFinite(data.x) && Number.isFinite(data.y)) return data;
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

  // PET_PAGE=spinetest → 加载 Spine 调试页（默认仍 index.html，零风险）
  const page = process.env.PET_PAGE === "spinetest" ? "spinetest.html" : "index.html";
  // ?agent=<id>：渲染层（spine_layer.js/renderer.js）据此读取对应角色配置
  win.loadFile(path.join(__dirname, "renderer", page), { search: "agent=" + AGENT_ID });
  if (process.env.PET_PAGE) {
    // 调试页：附带 devtools 便于人工查看 console / 网络加载
    win.webContents.openDevTools({ mode: "detach" });
  }
  win.webContents.on("did-finish-load", () => send({ type: "ready" }));
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

process.stdin.on("end", () => app.quit());

app.whenReady().then(() => {
  createWindow();
  createFxWindow();
});

app.on("window-all-closed", () => {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
  app.quit();
});
