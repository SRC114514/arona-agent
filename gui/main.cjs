// ARONA GUI Electron 主进程：单窗口，与 Node 后端父进程经 stdin/stdout JSON lines 通信
// （协议行前缀 ###GUI### 过滤 Electron 日志；与桌宠桥同模式）。
const { app, BrowserWindow, Menu, ipcMain, nativeImage, dialog } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// Windows：GUI 是纯 HTML/CSS（无 WebGL），默认硬件加速下页面加载/脚本均正常但不 paint（白屏，
// 无 did-fail-load / render-process-gone / renderer 报错）——本机硬件 GPU 合成路径有问题，禁 GPU 走
// 软件渲染（桌宠同款已验证配置）。ARONA_GUI_GPU=1 可强制恢复硬件加速用于排障对比。
if (process.platform === "win32" && process.env.ARONA_GUI_GPU !== "1") {
  app.commandLine.appendSwitch("disable-gpu");
}
// 桌宠（pet/main.cjs）与本 GUI 是两个 Electron 进程，默认共用 userData（%APPDATA%/arona-agent）会
// 竞争磁盘缓存锁（日志表现：Unable to move the cache 0x5 / Gpu Cache Creation failed / DIPS SQLite
// 初始化失败），ready 前按进程隔离。
app.setPath("userData", path.join(app.getPath("appData"), "arona-agent-gui"));

const APP_TITLE = "Arona Agent";
const DEMO_CAPTURE_PATH = path.join(os.tmpdir(), "arona_gui_demo.png");
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
    if (VERBOSE) console.error("[gui:verbose] forward", msg.type);
    win.webContents.send("gui-event", msg);
  } else {
    if (VERBOSE) console.error("[gui:verbose] buffer", msg.type, "(rendererReady=" + rendererReady + ")");
    pending.push(msg);
  }
}

function flushPending() {
  if (!win || win.isDestroyed()) return;
  if (VERBOSE && pending.length) console.error("[gui:verbose] flush " + pending.length + " buffered events");
  while (pending.length) {
    win.webContents.send("gui-event", pending.shift());
  }
}

// ARONA_GUI_SMOKE=1：loadFile 后周期探测 DOM（每 2s，最长 30s）——页面可见性 / preload / 渲染层脚本，
// 结果打 SMOKE_RESULT 行；一旦有页面揭示（或超时）打 SMOKE_UI 详情后退出。
// 周期重试的原因：后端 startMain（initAgent 等）可能远超 8s，单次探测会把"启动慢"误判成"事件未送达"。
function smokeProbe() {
  const js = '(function(){var p=document.querySelectorAll(".page:not(.hidden)");'
    + 'return JSON.stringify({visible:p.length?p[0].id:null,'
    + 'api:!!(window.guiAPI&&window.guiAPI.send&&window.guiAPI.on),'
    + 'setup:!!(window.SetupUI&&window.SetupUI.handle)});})()';
  const started = Date.now();
  const timer = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(timer); return; }
    win.webContents.executeJavaScript(js)
      // stderr 会被 backend 转发到终端（stdout 被 ###GUI### 协议解析占用）
      .then((r) => {
        console.error("SMOKE_RESULT " + r);
        if (JSON.parse(r).visible || Date.now() - started >= 30000) {
          clearInterval(timer);
          smokeProbeUI();
        }
      })
      .catch((e) => { console.error("SMOKE_ERROR " + e); clearInterval(timer); smokeProbeUI(); });
  }, 2000);
}

function smokeProbeUI() {
  const js = `(function(){
    var p=document.querySelectorAll(".page:not(.hidden)");
    var logo=document.querySelector(".wl-logo");
    var input=document.getElementById("input");
    var menu=document.getElementById("slash-menu");
    var names=[];
    if(input&&menu){
      input.value="/"; input.dispatchEvent(new Event("input"));
      menu.querySelectorAll(".slash-item .name").forEach(function(n){names.push(n.textContent);});
      input.value=""; input.dispatchEvent(new Event("input"));
    }
    var probe=document.createElement("div"); probe.className="msg-tool";
    probe.innerHTML='<span class="t-icon"></span><span class="t-label">终端</span><span class="t-status run"></span>';
    document.body.appendChild(probe);
    var cs=getComputedStyle(probe);
    var out={visible:p.length?p[0].id:null,
      logo:logo?{loaded:logo.naturalWidth>0,h:logo.clientHeight}:null,
      welcome:!!document.getElementById("welcome"),
      chatKids:document.getElementById("chat")?document.getElementById("chat").children.length:-1,
      bg:getComputedStyle(document.body).backgroundColor,
      menu:names,
      toolDisplay:cs.display,toolFlex:cs.alignItems};
    probe.remove();
    return JSON.stringify(out);})()`;
  setTimeout(() => {
    win.webContents.executeJavaScript(js)
      .then((r) => { console.error("SMOKE_UI " + r); app.quit(); })
      .catch((e) => { console.error("SMOKE_UI_ERROR " + e); app.quit(); });
  }, 8000);
}

// ARONA_GUI_DEMO=1：不调用 LLM，向前端注入一段脚本化 agent_event 序列（思考 / 工具行 /
// 编码子代理实时过程 / 总结文本），预览渲染效果；结束时 capturePage 截图到系统临时目录（os.tmpdir()，跨平台）。
function demoScenario() {
  const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send("gui-event", m); };
  const ev = (agentId, type, extra = {}) => send({ type: "agent_event", agentId, event: { type, ...extra } });
  const delta = (agentId, kind, text) => ev(agentId, "message_update", { assistantMessageEvent: { type: kind, delta: text } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return (async () => {
    // —— 回放测试：ARONA_GUI_DEMO_SESSION=<会话路径> 时读取真实会话 + coding sidecar 注入前端 ——
    const sessPath = process.env.ARONA_GUI_DEMO_SESSION;
    if (sessPath) {
      try {
        const sidecar = sessPath.replace(/\.jsonl$/, ".coding.jsonl");
        const runs = [];
        if (fs.existsSync(sidecar)) {
          for (const line of fs.readFileSync(sidecar, "utf-8").split("\n")) {
            if (!line.trim()) continue;
            const p = JSON.parse(line);
            if (p.type !== "arona-coding-log") runs.push(p);
          }
        }
        send({ type: "coding_runs", runs });
        // 用 marked 官方 hooks 记录 parse 入参 + 调用栈（定位报告文本的渲染路径）
        await win.webContents.executeJavaScript(
          'window.__mdCalls=[]; window.marked.use({hooks:{preprocess:function(t){'
          + 'if(String(t).indexOf("入口")>=0){window.__mdCalls.push(String(t).slice(0,40)+"\\nSTACK:"+new Error().stack.split("\\n").slice(1,5).join(" | "));}'
          + 'return t;}}}); true',
        ).catch(() => {});
        const messages = fs.readFileSync(sessPath, "utf-8").split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l))
          .filter((m) => m.type !== "arona-session" && m.role);
        send({ type: "history", messages });
        console.error("DEMO_SESSION_REPLAY " + sessPath + " runs=" + runs.length);
        await sleep(2000);
        // 滚动到报告中第一个 Markdown 表格附近（文本 "2.1 入口"），预览表格渲染
        await win.webContents.executeJavaScript(
          'var els=Array.from(document.querySelectorAll(".msg-body h2,.msg-body h3,.msg-body h4,.msg-body p,.msg-body strong"));'
          + 'var t=els.find(function(e){return e.textContent.indexOf("2.1")>=0;});'
          + 'if(t) t.scrollIntoView({block:"start"}); true',
        ).catch(() => {});
        await sleep(300);
        const check = await win.webContents.executeJavaScript(
          '(function(){var out=window.marked.parse("| `a` | 挂载 `<App />` 到 `#root` |",{breaks:true,gfm:true,async:false});'
          + 'return JSON.stringify(String(out).slice(0,300));})()',
        ).catch((e) => "CHECK_ERROR " + e);
        console.error("DEMO_CHECK " + check);
        const calls = await win.webContents.executeJavaScript('JSON.stringify(window.__mdCalls)').catch((e) => "ERR");
        console.error("DEMO_MDCALLS " + calls);
        // 自动展开第一条 Bash 工具行，预览输入 + 输出（Markdown 渲染）效果
        await win.webContents.executeJavaScript(
          'var r=document.querySelector(".msg-tool[data-tool=\\"bash\\"]"); if(r) r.classList.add("open"); true',
        ).catch(() => {});
        await sleep(300);
        const imgTop = await win.webContents.capturePage();
        fs.writeFileSync(DEMO_CAPTURE_PATH, imgTop.toPNG());
        console.error("DEMO_CAPTURE " + DEMO_CAPTURE_PATH);
        return;
      } catch (e) {
        console.error("DEMO_SESSION_ERROR " + e);
      }
    }

    // —— 主 Agent：思考 + 派出编码子代理 ——
    ev("arona", "message_start");
    for (const chunk of ["用户想让我看看项目结构。", "这个任务适合派 millennium 去探索，", "我先设置情绪，然后调用 create_subagent。"]) {
      delta("arona", "thinking_delta", chunk);
      await sleep(260);
    }
    ev("arona", "message_end");
    ev("arona", "tool_execution_start", { toolName: "change_emotion", input: { emotion: "curious" } });
    await sleep(400);
    ev("arona", "tool_execution_end", { isError: false, result: "已切换情绪为 curious" });
    ev("arona", "tool_execution_start", { toolName: "create_subagent", input: { task: "探索 /Users/sunrongchen/Desktop/Projects/m2_her_webui 这个项目的源码结构。简要列出：1. 主要目录结构 2. 核心文件及其职责 3. 关键技术栈", agent: "millennium" } });

    // —— 编码子代理 millennium：实时过程（思考 / 工具调用 / 报告文本）——
    await sleep(500);
    ev("millennium", "message_start");
    for (const chunk of ["收到探索任务。", "先看顶层目录，再深入 src/。"]) {
      delta("millennium", "thinking_delta", chunk);
      await sleep(240);
    }
    ev("millennium", "message_end");
    ev("millennium", "tool_execution_start", { toolName: "bash", input: { command: "ls src/ && find src -name '*.tsx' | head -20" } });
    await sleep(600);
    ev("millennium", "tool_execution_end", {
      isError: false,
      result: "App.tsx\ncomponents/\n  ChatInput.tsx\n  MessageBubble.tsx\ncontext/\n  ChatContext.tsx\n  SettingsContext.tsx\n\n共 **20** 个 `.tsx` 文件，全部位于 `src/` 下的二级目录中。",
    });
    ev("millennium", "tool_execution_start", { toolName: "read", input: { file_path: "src/App.tsx" } });
    await sleep(500);
    ev("millennium", "tool_execution_end", { isError: false, result: "import React from 'react';\nimport ChatContext from './context/ChatContext';\n\nexport default function App() {\n  return <ChatContext.Provider>…</ChatContext.Provider>;\n}" });
    ev("millennium", "tool_execution_start", { toolName: "web_search", input: { query: "React 18 release notes" } });
    await sleep(500);
    ev("millennium", "tool_execution_end", { isError: false, result: "React 18.3.1 稳定版；并发特性默认可用。" });
    ev("millennium", "message_start");
    for (const chunk of ["探索完成。这是一个 React 18 + Vite + Tailwind 的纯前端调试台，", "25 个文件约 3500 行，状态管理用 Context + localStorage，无第三方状态库。"]) {
      delta("millennium", "text_delta", chunk);
      await sleep(240);
    }
    ev("millennium", "message_end");

    // —— 主 Agent：收回结果并总结（同轮次复用说话人标签）——
    ev("arona", "tool_execution_end", { isError: false, result: "子Agent任务完成，最终报告已返回。" });
    ev("arona", "message_start");
    for (const chunk of ["子Agent报告收到啦~ 给 Sensei 划个重点：\n\n", "**项目本质**：纯前端 React SPA，无后端，状态全靠 Context + localStorage。\n\n", "下次需要深挖代码，直接叫它就行~"]) {
      delta("arona", "text_delta", chunk);
      await sleep(240);
    }
    ev("arona", "message_end");
    send({
      type: "ready",
      state: {
        model: "demo", mainAgent: "arona", mainAgentLabel: "阿洛娜", subAgents: [],
        ttsEnabled: false, sttEnabled: false, noVoice: true,
        processing: false, recording: false, currentSessionPath: null,
      },
    });

    await sleep(600);
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(DEMO_CAPTURE_PATH, img.toPNG());
      console.error("DEMO_CAPTURE " + DEMO_CAPTURE_PATH);
    } catch (e) {
      console.error("DEMO_CAPTURE_ERROR " + e);
    }
  })();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: APP_TITLE,
    backgroundColor: "#f6f7f9",
    // hiddenInset/trafficLightPosition 是 macOS 专用（Windows 忽略 titleBarStyle，标准边框 + 无菜单）
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } }
      : {}),
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
    if (VERBOSE) console.error("[gui:verbose] did-finish-load, pending=" + pending.length);
    flushPending();
    if (process.env.ARONA_GUI_SMOKE === "1") smokeProbe();
    if (process.env.ARONA_GUI_DEMO === "1") setTimeout(demoScenario, 2000);
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("closed", () => { win = null; rendererReady = false; });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[gui] did-fail-load ${code} ${desc} ${url}`);
  });
  // renderer console → stderr：GUI 白屏等"进程活着但无画面"问题时可见。error 级无条件转发，
  // 其余仅 VERBOSE（Electron 43 规范签名为单事件对象 event.{message,level,lineNumber}，与桌宠同）
  win.webContents.on("console-message", (event) => {
    const msg = typeof event.message === "string" ? event.message : "";
    if (!msg) return;
    if (VERBOSE || event.level === 3) {
      const line = event.lineNumber ? `:${event.lineNumber}` : "";
      console.error(`[gui:render:${event.level ?? "?"}]${line} ${msg}`);
    }
  });
  if (VERBOSE) win.webContents.openDevTools({ mode: "detach" });
}

// renderer → backend
ipcMain.on("gui-send", (_event, msg) => {
  // 工作区目录选择：Electron 原生对话框只能由本进程弹（contextIsolation，渲染层无 Node），
  // 结果回给渲染层（ws_folder_picked），由渲染层决定驱动后端 set_workspace 还是 move_session
  if (msg && msg.type === "pick_workspace_folder") {
    pickWorkspaceFolder();
    return;
  }
  send(msg);
});

async function pickWorkspaceFolder() {
  try {
    const result = await dialog.showOpenDialog(win, {
      title: "选择工作区文件夹",
      properties: ["openDirectory"],
    });
    const picked = result.canceled ? null : (result.filePaths || [])[0];
    if (picked && win && !win.isDestroyed()) {
      win.webContents.send("gui-event", { type: "ws_folder_picked", path: picked });
    }
  } catch (e) {
    console.error("[gui] pick folder failed:", e);
  }
}

// backend → renderer（行缓冲解析；Windows 下此路不通——GUI 子系统 Electron 的 stdin 数据不可达，
// 见下方 HTTP 通道。保留作非 Windows 平台的备用通道）
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

// 本地 HTTP 通道（backend → GUI 主方向）：Windows 下 Electron 子进程 stdin 完全不可达（hello 握手
// 证明进程与 stdout 均正常、数据仍不到达），事件改走 127.0.0.1 随机端口 + 随机 token（随 hello 行
// 告知 backend，防本机其他进程伪造）。stdout（GUI → backend）方向不受影响，继续走 ###GUI### 行。
const HTTP_TOKEN = crypto.randomBytes(16).toString("hex");
let helloSent = false;
function sendHello(httpPort) {
  if (helloSent) return;
  helloSent = true;
  send({ type: "hello", httpPort: httpPort || 0, token: httpPort ? HTTP_TOKEN : "" });
}
const httpServer = http.createServer((req, res) => {
  if (req.method !== "POST" || req.headers["x-arona-token"] !== HTTP_TOKEN) {
    res.writeHead(403);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(204);
    res.end();
    try {
      forward(JSON.parse(body));
    } catch {
      // 非 JSON，忽略
    }
  });
});
httpServer.on("error", (e) => {
  console.error("[gui] http server error:", e.message, "→ 退回 stdin 通道");
  sendHello(0); // HTTP 起不来也要发 hello（不带端口，backend 退回 stdin 写入）
});
httpServer.listen(0, "127.0.0.1", () => {
  sendHello(httpServer.address().port);
});

// 窗口全关：先发 exit 请求让后端走完整清理，再退出（延迟让协议行先 flush）
app.on("window-all-closed", () => {
  send({ type: "exit" });
  setTimeout(() => app.quit(), 200);
});

app.whenReady().then(() => {
  // Windows 上默认应用菜单（File/Edit/View/Window）画进窗口顶部，GUI 用不到 → 移除
  //（须在 ready 后调用；Ctrl+C/V 等编辑快捷键是原生行为不受影响，仅去掉 Reload/DevTools 默认键）
  if (process.platform === "win32") Menu.setApplicationMenu(null);
  // macOS 开发模式下 Dock 图标默认是 Electron 图标，用 LOGO 替换（打包后由应用 bundle 提供）
  if (process.platform === "darwin" && app.dock) {
    const icon = nativeImage.createFromPath(ICON_PATH);
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }
  if (VERBOSE) {
    // GPU 功能状态：Windows 白屏排查关键（disable-gpu 下预期 gpu_compositing=disabled_software 且可正常上屏）
    try {
      console.error("[gui:verbose] GPU feature status:", JSON.stringify(app.getGPUFeatureStatus()));
    } catch (e) {
      console.error("[gui:verbose] getGPUFeatureStatus failed:", e.message);
    }
    console.error("[gui:verbose] platform:", process.platform, "electron:", process.versions.electron, "chrome:", process.versions.chrome);
  }
  createWindow();
});

app.on("render-process-gone", (_e, details) => {
  console.error(`[gui] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
});
