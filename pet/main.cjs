// ARONA 桌宠 Electron 主进程
// 与主 Agent 进程通过 stdin/stdout JSON lines 通信（协议行前缀 ###PET### 过滤 Electron 日志）
// 支持多角色同屏：ARONA_AGENT = 主 Agent，ARONA_SUB_AGENTS = 逗号分隔的子 Agent 列表；
// 每个角色一个 BrowserWindow，共享一个全屏特效窗。
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

// 角色选择：主 Agent + 子 Agent 列表
const MAIN_AGENT_ID = process.env.ARONA_AGENT && AGENTS[process.env.ARONA_AGENT] ? process.env.ARONA_AGENT : "arona";
const SUB_AGENT_IDS = (process.env.ARONA_SUB_AGENTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s && AGENTS[s]);
const AGENT_IDS = [MAIN_AGENT_ID, ...SUB_AGENT_IDS];

const PREFIX = "###PET###";
const POS_FILE = path.join(os.homedir(), ".arona", "pet.json");
const WIN_W = 320; // 窗口 = Spine 角色渲染区本体（收窄以避免透明区域拦截点击造成误触；角色尺寸不变）
const WIN_H = 674;
const SUB_OFFSET_X = 340; // 子窗口默认横向错开（略大于 WIN_W）
const SUB_OFFSET_Y = 40;

// --verbose（src/pet.ts 注入 ARONA_PET_VERBOSE=1 + --enable-logging）：
// 主进程详细日志走 stderr 原样转发回终端，用于锁定 Windows 白屏等"进程活着但无画面"问题。
const VERBOSE = process.env.ARONA_PET_VERBOSE === "1";
function vlog(...args) {
  if (VERBOSE) console.error("[pet:verbose]", ...args);
}

/** agentId -> BrowserWindow；主 Agent 始终在列表首位 */
const petWins = new Map();
let fxWin = null; // 全屏透明特效窗口（点击/拖尾），覆盖所有显示器、鼠标穿透

function send(msg) {
  try {
    process.stdout.write(PREFIX + JSON.stringify(msg) + "\n");
  } catch {
    // stdout 已关闭，忽略
  }
}

// ---- 位置记忆（多角色格式：{ [agentId]: { x, y } }；兼容旧 { x, y } → arona） ----
function loadPositions() {
  try {
    const data = JSON.parse(fs.readFileSync(POS_FILE, "utf-8"));
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {
    // 无记录或损坏，忽略
  }
  return {};
}

function loadPosition(agentId) {
  const data = loadPositions();
  let pos = data[agentId];
  // 旧版单角色格式兼容迁移：{x,y} 视为 arona 的位置
  if (!pos && agentId === MAIN_AGENT_ID && Number.isFinite(data.x) && Number.isFinite(data.y)) {
    pos = { x: data.x, y: data.y };
  }
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
  // 屏幕边界检查：记忆坐标须落在任一显示器 bounds 内（中心点判定），否则视为失效。
  // 防分辨率变化 / Mac→Win 迁移 / 负坐标导致窗口创建在屏幕外"看似没显示"。
  const W = WIN_W, H = WIN_H;
  for (const d of screen.getAllDisplays()) {
    const { x, y, width, height } = d.bounds;
    const cx = pos.x + W / 2, cy = pos.y + H / 2;
    if (cx >= x && cx <= x + width && cy >= y && cy <= y + height) return pos;
  }
  return null;
}

function savePosition(agentId, x, y) {
  try {
    const data = loadPositions();
    // 旧版 {x,y} 迁移：一旦保存新格式，就不再有顶层 x/y
    delete data.x;
    delete data.y;
    data[agentId] = { x, y };
    fs.mkdirSync(path.dirname(POS_FILE), { recursive: true });
    fs.writeFileSync(POS_FILE, JSON.stringify(data, null, 2));
  } catch {
    // 写入失败不影响功能
  }
}

// ---- 窗口 ----
function defaultPosition(index) {
  if (index === 0) return null;
  // 找不到记忆坐标时使用相对主显示器的默认错开位（macOS 菜单栏下方安全区起步）
  const primary = screen.getPrimaryDisplay().bounds;
  return {
    x: primary.x + 40 + SUB_OFFSET_X * (index - 1),
    y: primary.y + 80 + SUB_OFFSET_Y * (index - 1),
  };
}

function createPetWindow(agentId, index) {
  const agent = AGENTS[agentId];
  const bw = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
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
  bw.setAlwaysOnTop(true, "screen-saver");
  if (process.platform === "darwin") {
    bw.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  const pos = loadPosition(agentId) || defaultPosition(index);
  if (pos) bw.setPosition(pos.x, pos.y);
  vlog("window created", JSON.stringify({ agentId, pos, alwaysOnTop: bw.isAlwaysOnTop(), visible: bw.isVisible(), bounds: bw.getBounds() }));

  // PET_PAGE=spinetest → 加载 Spine 调试页（默认仍 index.html，零风险）
  const page = process.env.PET_PAGE === "spinetest" ? "spinetest.html" : "index.html";
  // ?agent=<id>：渲染层（spine_layer.js/renderer.js）据此读取对应角色配置
  const url = path.join(__dirname, "renderer", page);
  bw.loadFile(url, { search: "agent=" + agentId });
  vlog("loadFile", url, "?agent=" + agentId);
  if (process.env.PET_PAGE) {
    // 调试页：附带 devtools 便于人工查看 console / 网络加载
    bw.webContents.openDevTools({ mode: "detach" });
  }
  bw.webContents.on("did-finish-load", () => {
    vlog("did-finish-load", bw.webContents.getURL());
    send({ type: "ready", agent: agentId });
  });
  // ---- GL 驱动消息缓冲 / 报错解锁 ----
  // Windows SwiftShader 下 Chromium 把 GL 驱动性能提示（如
  // "GPU stall due to ReadPixels"，Chromium gl_utils.cc 的 Performance 级消息）
  // 作为 console 消息打到渲染进程。非 verbose 时是纯噪音——平时静默缓冲；
  // 一旦程序真报错（error 级 console / did-fail-load / render-process-gone），
  // 补打缓冲行并解锁后续不过滤，保住排障信息。VERBOSE 全量输出不走此逻辑。
  const GL_DRIVER_MSG = "GL Driver Message";
  let glDroppedBuf = []; // 被过滤的 GL 驱动消息（环形，上限 20）
  let glUnlocked = false; // 报错后不再过滤
  const unlockGlLogs = () => {
    if (glUnlocked) return;
    glUnlocked = true;
    if (glDroppedBuf.length) {
      for (const m of glDroppedBuf) console.error(`[pet:render:${agentId}] ${m}`);
      glDroppedBuf = [];
    }
  };
  // 页面加载失败（资源 404 / file:// 路径错 / 加载被拦）：必然白屏，任何模式都要转发
  bw.webContents.on("did-fail-load", (_e, code, desc, url2, isMain) => {
    if (!isMain) return;
    unlockGlLogs();
    console.error(`[pet:render] did-fail-load agent=${agentId} code=${code} desc=${desc} url=${url2}`);
  });
  // renderer console 转发到 stderr（src/pet.ts 已打印 [pet] 前缀）：页面 JS 错误默认静默
  // （不进 stderr），Windows 白屏等故障全靠它定位。Electron 43 规范签名为单事件对象：
  // event.{message, level, lineNumber, sourceId}（老双参数签名会打 deprecation 警告）。
  bw.webContents.on("console-message", (event) => {
    const msg = typeof event.message === "string" ? event.message : "";
    if (!msg) return;
    const line = event.lineNumber ? `:${event.lineNumber}` : "";
    if (VERBOSE) {
      const src = event.sourceId ? ` (${event.sourceId}${line})` : "";
      console.error(`[pet:render:${event.level ?? "?"}:${agentId}]${src} ${msg}`);
      return;
    }
    // 非 verbose：严格判断——GL 驱动性能提示平时静默，仅报错后放行
    if (event.level === 3) {
      unlockGlLogs(); // 报错：补打被缓冲的 GL 消息，之后不再过滤
      console.error(`[pet:render:${agentId}]${line} ${msg}`);
      return;
    }
    if (!glUnlocked && msg.includes(GL_DRIVER_MSG)) {
      if (glDroppedBuf.length >= 20) glDroppedBuf.shift();
      glDroppedBuf.push(msg);
      return;
    }
    console.error(`[pet:render:${agentId}]${line} ${msg}`);
  });
  // 渲染进程崩溃上报（Windows 透明窗口崩溃的主因；reason/exitCode 可精确定位）
  bw.webContents.on("render-process-gone", (_e, details) => {
    unlockGlLogs();
    send({ type: "crash", agent: agentId, kind: "render", reason: details.reason, exitCode: details.exitCode, url: bw.webContents.getURL() });
    vlog("render-process-gone", JSON.stringify({ agentId, ...details }));
  });
  // 窗口关闭诊断（verbose）：window-all-closed 会因任一窗口被系统/驱动关闭而触发，导致 code 0 退出
  bw.on("closed", () => {
    vlog("window closed", agentId);
    petWins.delete(agentId);
  });
  petWins.set(agentId, bw);
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

// ---- 工具：根据 webContents 找所属 agent ----
function agentBySender(sender) {
  for (const [agentId, bw] of petWins) {
    if (bw.webContents === sender) return agentId;
  }
  return MAIN_AGENT_ID;
}

function windowByAgent(agentId) {
  return petWins.get(agentId) || null;
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

// ---- 文字气泡：画在全屏特效窗上（桌宠窗口已收窄为角色本体，不再有气泡区） ----
// 特效窗鼠标穿透（setIgnoreMouseEvents），气泡纯展示不会拦点击；层级高于桌宠。
// 锚点沿用旧窗口内定位的观感：气泡出现在头部右上方、小尾巴指向角色；右侧越出
// 所在显示器时翻到左侧（flip，fx 层镜像小尾巴）。
const BUBBLE_ANCHOR_X = 264;   // 默认：气泡左缘相对桌宠窗口左上角
const BUBBLE_ANCHOR_Y = 90;
const BUBBLE_MAX_W = 220;      // 与 fx 层样式 max-width 一致
const BUBBLE_FLIP_X = -196;    // 翻转：气泡左缘相对桌宠窗口左上角（右缘留 ~24px 缝隙给小尾巴）
const BUBBLE_FLIP_PAD = 12;    // 翻转阈值缓冲：贴屏幕右缘多少 px 内就算溢出

/** 桌宠窗口当前姿态 → 特效窗本地气泡锚点 { x, y, flip }；特效窗/角色窗不可用时返回 null */
function bubbleAnchorLocal(agentId) {
  const bw = windowByAgent(agentId);
  if (!bw || bw.isDestroyed() || !fxWin || fxWin.isDestroyed()) return null;
  const [wx, wy] = bw.getPosition();
  const [fxX, fxY] = fxWin.getPosition();
  let flip = false;
  let gx = wx + BUBBLE_ANCHOR_X;
  try {
    const d = screen.getDisplayNearestPoint({ x: wx, y: wy });
    const rightEdge = d.bounds.x + d.bounds.width;
    if (gx + BUBBLE_MAX_W + BUBBLE_FLIP_PAD > rightEdge) {
      // 右侧放不下 → 翻到角色左侧
      flip = true;
      gx = wx + BUBBLE_FLIP_X;
    }
    gx = Math.max(d.bounds.x + BUBBLE_FLIP_PAD, Math.min(gx, rightEdge - BUBBLE_FLIP_PAD));
    // 垂直方向钳回所在显示器（粗略按气泡最大高度 ~140px 预留）
    const gy = Math.max(d.bounds.y, Math.min(wy + BUBBLE_ANCHOR_Y, d.bounds.y + d.bounds.height - 140));
    return { x: Math.round(gx - fxX), y: Math.round(gy - fy), flip };
  } catch {
    return { x: Math.round(gx - fxX), y: Math.round(wy + BUBBLE_ANCHOR_Y - fxY), flip };
  }
}

/** 把某角色的文字消息转成特效窗上的气泡 show/hide */
function forwardBubble(agentId, kind, data) {
  if (!fxWin || fxWin.isDestroyed()) return;
  if (kind === "tts_end") {
    fxWin.webContents.send("pet:bubble", { agent: agentId, kind: "hide" });
    return;
  }
  if (typeof data !== "string" || !data) return;
  const pos = bubbleAnchorLocal(agentId);
  if (!pos) return;
  fxWin.webContents.send("pet:bubble", { agent: agentId, kind: "show", data, ...pos });
}

/** 拖动中/落位后同步气泡锚点（气泡已显示时 fx 层原地位移，未显示则忽略） */
function syncBubblePosition(agentId) {
  if (!fxWin || fxWin.isDestroyed()) return;
  const pos = bubbleAnchorLocal(agentId);
  if (!pos) return;
  fxWin.webContents.send("pet:bubble", { agent: agentId, kind: "move", ...pos });
}

// ---- 全局光标轮询（~60Hz，DIP 坐标系内运算，供渲染层瞳孔跟随 + 按住期间晃动检测补采样） ----
// 对每个桌宠窗口分别发送窗口本地坐标 + 全局坐标（gx/gy：renderer 按住期间用于晃动检测——
// 光标快速甩动划出窗口时 mousemove 断流，本轮询不断流，轻微出窗仍能采到晃动）
const CURSOR_POLL_MS = 16;
let cursorTimer = null;
const lastCursors = new Map();

function startCursorTracking() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();      // 全局 DIP
    for (const [agentId, bw] of petWins) {
      if (bw.isDestroyed() || !bw.isVisible()) continue;
      const [wx, wy] = bw.getPosition();
      const x = p.x - wx;
      const y = p.y - wy;                         // 窗口本地 CSS px（可在窗口外，注视效果所需）
      const last = lastCursors.get(agentId);
      if (Math.abs(x - (last?.x ?? NaN)) < 1 && Math.abs(y - (last?.y ?? NaN)) < 1) continue; // 静止节流
      lastCursors.set(agentId, { x, y });
      bw.webContents.send("pet:cursor", x, y, p.x, p.y);
    }
  }, CURSOR_POLL_MS);
}

// ---- 拖动 IPC（16ms 节流，按窗口独立） ----
const dragPendingMap = new Map();
const dragTimerMap = new Map();

ipcMain.on("pet:drag", (e, dx, dy) => {
  const agentId = agentBySender(e.sender);
  const bw = windowByAgent(agentId);
  if (!bw) return;
  const prev = dragPendingMap.get(agentId) || { x: bw.getPosition()[0], y: bw.getPosition()[1] };
  const pending = { x: prev.x + dx, y: prev.y + dy };
  dragPendingMap.set(agentId, pending);
  if (!dragTimerMap.has(agentId)) {
    dragTimerMap.set(agentId, setTimeout(() => {
      dragTimerMap.delete(agentId);
      const p = dragPendingMap.get(agentId);
      if (p && windowByAgent(agentId)) {
        windowByAgent(agentId).setPosition(Math.round(p.x), Math.round(p.y));
        dragPendingMap.delete(agentId);
        syncBubblePosition(agentId); // 气泡跟随拖动
      }
    }, 16));
  }
});

ipcMain.on("pet:dragend", (e) => {
  const agentId = agentBySender(e.sender);
  const bw = windowByAgent(agentId);
  if (!bw) return;
  const timer = dragTimerMap.get(agentId);
  if (timer) {
    clearTimeout(timer);
    dragTimerMap.delete(agentId);
  }
  const pending = dragPendingMap.get(agentId);
  if (pending) {
    bw.setPosition(Math.round(pending.x), Math.round(pending.y));
    dragPendingMap.delete(agentId);
  }
  syncBubblePosition(agentId); // 落位后校正气泡锚点（flip 状态也可能变化）
  const [x, y] = bw.getPosition();
  savePosition(agentId, x, y);
  send({ type: "moved", agent: agentId, x, y });
});

ipcMain.on("pet:shake", (e) => send({ type: "shake", agent: agentBySender(e.sender) }));
ipcMain.on("pet:dizzy", (e) => send({ type: "dizzy", agent: agentBySender(e.sender) }));

ipcMain.handle("pet:get-agent-config", (e) => {
  const agentId = agentBySender(e.sender);
  // isMain：renderer 据此让"仅主 Agent 响应"的交互（大幅晃动 dizzy）跳过子窗口
  return { id: agentId, isMain: agentId === MAIN_AGENT_ID, ...AGENTS[agentId] };
});

// ---- stdin 协议 ----
let buffer = "";

function sendToAgent(agentId, channel, payload) {
  const bw = windowByAgent(agentId);
  if (!bw || bw.isDestroyed()) return false;
  bw.webContents.send(channel, payload);
  return true;
}

function handleMessage(msg) {
  vlog("stdin msg", JSON.stringify(msg));
  switch (msg.type) {
    case "set_emotion": {
      const id = msg.agent && AGENTS[msg.agent] ? msg.agent : MAIN_AGENT_ID;
      if (AGENTS[id].emotions[msg.name]) {
        if (!sendToAgent(id, "pet:emotion", msg.name)) send({ type: "error", message: `no window for ${id}` });
      } else {
        send({ type: "error", message: `unknown emotion: ${msg.name}` });
      }
      break;
    }
    case "reset":
      // 所有角色窗口统一恢复默认待机
      for (const [id] of petWins) sendToAgent(id, "pet:reset", null);
      break;
    case "text": {
      const id = msg.agent && AGENTS[msg.agent] ? msg.agent : MAIN_AGENT_ID;
      // 气泡已迁出桌宠窗口（窗口收窄为角色本体），统一渲染在全屏特效窗上
      forwardBubble(id, msg.kind, msg.data);
      break;
    }
    case "tts_level": {
      // TTS 播放中实时音量（RMS 0~1）→ 对应角色窗口嘴型 lip-sync
      const id = msg.agent && AGENTS[msg.agent] ? msg.agent : MAIN_AGENT_ID;
      if (typeof msg.rms === "number") sendToAgent(id, "pet:tts-level", msg.rms);
      break;
    }
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
    vlog("agents:", JSON.stringify(AGENT_IDS));
  }
  AGENT_IDS.forEach((id, i) => createPetWindow(id, i));
  createFxWindow();
  startCursorTracking();
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