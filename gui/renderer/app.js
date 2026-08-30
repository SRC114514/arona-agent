// ARONA GUI 渲染层主逻辑：###GUI### 协议 → DOM（侧栏会话列表 / 斜杠菜单 / 消息流 / 麦克风 / 弹窗）
// 全局错误陷阱：未捕获异常打进 console.error（经 main.cjs 以 [gui:render:3] 转发终端）——
// 定位"页面加载正常但 .page 保持 hidden → 白屏"时 app.js 中途崩溃的情况
window.addEventListener("error", (e) => {
  console.error("[app.js] window error:", e.message, e.filename + ":" + e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[app.js] unhandled rejection:", e.reason);
});

(function () {
  console.log("[app.js] boot");
  const $ = (sel) => document.querySelector(sel);
  const api = window.guiAPI;
  const chat = $("#chat");
  const input = $("#input");
  const menuEl = $("#slash-menu");
  const sessionListEl = $("#session-list");
  // 欢迎页模板：#welcome 位于 #chat 内，chat.innerHTML 清屏会将其销毁，清空时需重新注入
  const welcomeTemplate = $("#welcome").outerHTML;

  // macOS hiddenInset：给交通灯让位（CSS body.mac 规则）
  if (/Mac/.test(navigator.userAgent)) document.body.classList.add("mac");

  const AGENT_LABELS = {
    arona: "阿洛娜", plana: "普拉娜", shiroko: "砂狼白子", hoshino: "小鸟游星野",
    hanako: "浦和花子", koharu: "下江小春", kei: "天童凯伊", aris: "天童爱丽丝",
    millennium: "千禧年学员", justice: "正义实现部成员",
  };

  let commands = [];
  let state = null;
  // 编码子代理执行过程（resume 时下发，按主会话 create_subagent 的 toolCallId 关联）
  let codingRunsByCall = new Map();
  const menu = { open: false, items: [], index: 0 };
  let currentMsg = null;
  let sessionsData = { currentPath: null, currentWorkspace: "", homeDir: "", knownWorkspaces: [], sessions: [] };
  // 工作区分组展示状态（key = 工作区路径，"" = 未分组旧会话）：
  // wsCollapsed 折叠的组；wsShown 各组展开显示的条数（默认 WS_PAGE 条）
  const WS_PAGE = 5;
  const wsCollapsed = new Set();
  const wsShown = new Map();
  // 「移动到工作区」弹窗里点了「选择其他文件夹…」：暂存目标会话，
  // 原生目录框回传（ws_folder_picked）时按此分流为 move_session 而非 set_workspace
  let moveTargetSession = null;
  // 已上报过的活动工作区（null = 尚未收到首个 sessions 事件；用于区分「切换」与「首次推送」）
  let activeWsSeen = null;
  let settingsModalOpen = false;
  let settingsInfoEl = null;
  // 录音中手动停止（再点麦克风）：stt_result 空串时静默（不发"未检测到语音"）
  let micCancelExpected = false;
  // 会话多选模式
  let multiSelect = false;
  const multiSelected = new Set();
  // 删除确认框回调
  let confirmOkCb = null;

  // ── 工具 ──────────────────────────────────────
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inlineFmt(s) {
    let html = esc(s);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/^#{1,4}\s+(.+)$/gm, "<strong>$1</strong>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\n/g, "<br>");
    return html;
  }
  // Markdown 渲染：优先 marked（GFM 表格/标题/列表，breaks 保留换行）。
  // marked 不做净化：解析后对 DOM 做白名单式清理（删 script/iframe、on* 属性、javascript: 链接）；
  // vendor 脚本缺失时退回轻量正则渲染。
  const mdParse = (() => {
    try {
      const m = window.marked;
      if (m && typeof m.parse !== "function") return null;
      return (t) => {
        const box = document.createElement("div");
        box.innerHTML = m.parse(t, { breaks: true, gfm: true, async: false });
        for (const el of box.querySelectorAll("script, iframe, object, embed, style")) el.remove();
        for (const el of box.querySelectorAll("*")) {
          for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith("on")) el.removeAttribute(attr.name);
            else if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
          }
        }
        return box.innerHTML;
      };
    } catch { return null; }
  })();

  /** 富文本渲染：Markdown → HTML（回复正文、工具输出共用）。
   *  例外：完整 HTML 文档（read index.html 等）不交给 marked——marked 会把源码透传成
   *  真实 DOM（script 被净化、meta/link 不可见、空 div），视觉上整块空白；按源码块显示。 */
  function richRender(el, text) {
    const src = String(text);
    if (/^\s*(<!DOCTYPE\s+html|<html[\s>])/i.test(src)) {
      el.innerHTML = "";
      const pre = document.createElement("pre");
      pre.textContent = src;
      el.appendChild(pre);
      return;
    }
    if (mdParse) {
      // 不做预转义：&/< 的转义交给 marked，防注入由 mdParse 的 DOM 净化负责（否则实体被二次转义）
      el.innerHTML = mdParse(src);
      return;
    }
    el.innerHTML = "";
    const parts = src.split("```");
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const pre = document.createElement("pre");
        pre.textContent = part.replace(/^\w*\n/, "");
        el.appendChild(pre);
      } else if (part) {
        const div = document.createElement("div");
        div.innerHTML = inlineFmt(part);
        el.appendChild(div);
      }
    });
  }
  function nearBottom() {
    return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  }
  function scrollBottom(force) {
    if (force || nearBottom()) chat.scrollTop = chat.scrollHeight;
  }
  /** 会话时间 → 相对时间（"5天"式）。 */
  function relTime(iso) {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "";
    const diff = Date.now() - t;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min}分钟`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}小时`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day}天`;
    const d = new Date(t);
    const now = new Date();
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }
  /** 会话是否已开始（欢迎页 ↔ 聊天流切换）。 */
  function setConversationStarted(started) {
    document.body.classList.toggle("has-msg", started);
  }

  // ── 工作区分组 ────────────────────────────────
  /** 工作区显示名：取目录名；家目录「用户目录」；根目录 /；空值 = 旧会话未记录工作区（「未分组」）。 */
  function wsLabel(ws) {
    if (!ws) return "未分组";
    if (ws === "/") return "/";
    if (sessionsData.homeDir && ws === sessionsData.homeDir) return "用户目录";
    const base = String(ws).replace(/\/+$/, "").split("/").pop();
    return base || ws;
  }
  /** 按工作区分组：组内/组间按最新会话时间倒序；未分组恒排最后。与后端 workspace.ts 同构。 */
  function groupSessions(sessions) {
    const byKey = new Map();
    for (const s of sessions) {
      const k = s.workspace || "";
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(s);
    }
    const groups = [...byKey.entries()].map(([workspace, list]) => {
      list.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
      return { workspace: workspace || null, label: wsLabel(workspace), sessions: list };
    });
    groups.sort((a, b) => {
      if (!a.workspace) return 1;
      if (!b.workspace) return -1;
      return String(b.sessions[0]?.timestamp || "").localeCompare(String(a.sessions[0]?.timestamp || ""));
    });
    return groups;
  }

  // ── SVG 图标库（stroke 风格；工具行 / 思考块共用，须先于 THINK_SVG 初始化）──
  const ICONS = {
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    pencil: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    brain: '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>',
    task: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    chev: '<polyline points="6 9 12 15 18 9"/>',
  };
  function svgIcon(name, size) {
    const s = size || 13;
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.wrench}</svg>`;
  }

  // ── 消息渲染 ──────────────────────────────────
  const TOAST_MS = 2000;   // 停留时长
  const TOAST_FADE_MS = 300; // 淡出过渡

  /** 提示 toast：固定悬浮于底部居中，堆叠显示，2s 后淡出移除（不进入聊天流，避免挤动布局）。 */
  function statusLine(text, level) {
    const div = document.createElement("div");
    div.className = "status-line" + (level ? " " + level : "");
    div.textContent = text;
    $("#toasts").appendChild(div);
    setTimeout(() => {
      div.classList.add("fade");
      setTimeout(() => div.remove(), TOAST_FADE_MS);
    }, TOAST_MS);
  }

  // ── 玻璃浮层开关：入场靠 CSS glass-in（display 切换自动触发），退场先播 .glass-out 再置 hidden ──
  const GLASS_OUT_MS = 200;
  function glassHide(el, onDone) {
    if (el.classList.contains("hidden")) { onDone?.(); return; }
    el.classList.add("glass-out");
    setTimeout(() => {
      el.classList.add("hidden");
      el.classList.remove("glass-out");
      onDone?.();
    }, GLASS_OUT_MS);
  }
  /** 立即清除退场态（打开前调用，避免快速关-开时残留 glass-out 压住入场动画）。 */
  function glassClear(el) {
    el.classList.remove("glass-out");
  }

  function addUserMsg(text) {
    setConversationStarted(true);
    turnBlocks = new Map(); // 用户发言开启新一轮：清空角色块复用表
    const wrap = document.createElement("div");
    wrap.className = "msg-user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    wrap.appendChild(bubble);
    chat.appendChild(wrap);
    scrollBottom(true);
  }

  // 当前轮次各角色是否已开块：再次发言时新建「续写块」（不带说话人标签，保持时间顺序）
  let turnBlocks = new Map();

  function startAssistant(agentId) {
    setConversationStarted(true);
    const cont = turnBlocks.has(agentId);
    turnBlocks.set(agentId, true);
    const wrap = document.createElement("div");
    wrap.className = "msg-assistant" + (cont ? " cont" : "");
    wrap.dataset.agent = agentId; // 编码子代理视觉区分用
    if (!cont) {
      const speaker = document.createElement("div");
      speaker.className = "msg-speaker";
      speaker.textContent = (AGENT_LABELS[agentId] || "ARONA") + "：";
      wrap.appendChild(speaker);
    }
    const thinkEl = document.createElement("div");
    thinkEl.className = "msg-thinking hidden";
    const bodyEl = document.createElement("div");
    bodyEl.className = "msg-body";
    wrap.appendChild(thinkEl);
    wrap.appendChild(bodyEl);
    chat.appendChild(wrap);
    currentMsg = {
      root: wrap, bodyEl, thinkEl, agentId,
      thinkHead: null, thinkBody: null, thinkStart: 0, thinkDone: false,
      thinkText: "", curText: "", lastToolEl: null,
    };
  }

  // ── 思考块：SVG 脑图标 + 「思考 · 持续了 N 秒」 + 全量内容（固定高度内部滚动）──
  const THINK_SVG = svgIcon("brain");
  const CHEV_SVG = svgIcon("chev");
  function buildThinkHead(withDuration) {
    const head = document.createElement("div");
    head.className = "think-head";
    head.innerHTML = `<span class="think-icon">${THINK_SVG}</span><span>思考</span>`
      + (withDuration ? '<span class="think-dur"></span>' : "")
      + `<span class="think-chev">${CHEV_SVG}</span>`;
    return head;
  }
  function ensureThinkBlock(msg) {
    if (msg.thinkHead) return;
    const head = buildThinkHead(true);
    const body = document.createElement("div");
    body.className = "think-body";
    msg.thinkEl.appendChild(head);
    msg.thinkEl.appendChild(body);
    msg.thinkEl.classList.remove("hidden");
    // 思考输出中不折叠；点击头部（图标/文字/箭头）手动折叠或展开
    head.addEventListener("click", () => msg.thinkEl.classList.toggle("collapsed"));
    msg.thinkHead = head;
    msg.thinkBody = body;
    msg.thinkStart = Date.now();
  }
  function thinkDurText(msg) {
    return `· 持续了 ${Math.max(1, Math.round((Date.now() - msg.thinkStart) / 1000))} 秒`;
  }
  /** 思考计时定格 + 默认折叠（首个正文 delta 或 message_end 时调用；新一轮思考会重新展开）。 */
  function endThinkTiming(msg) {
    if (!msg || !msg.thinkHead || msg.thinkDone) return;
    msg.thinkDone = true;
    const dur = msg.thinkHead.querySelector(".think-dur");
    if (dur) dur.textContent = thinkDurText(msg);
    msg.thinkEl.classList.add("collapsed");
  }

  function appendTextDelta(delta) {
    if (!currentMsg) startAssistant(state ? state.mainAgent : "arona");
    endThinkTiming(currentMsg);
    currentMsg.curText += delta;
    currentMsg.bodyEl.textContent = currentMsg.curText;
    scrollBottom();
  }

  function appendThinkingDelta(delta) {
    if (!currentMsg) startAssistant(state ? state.mainAgent : "arona");
    // 新一轮思考（此前已定格折叠）：重新展开并重置计时
    if (currentMsg.thinkDone && currentMsg.thinkHead) {
      currentMsg.thinkDone = false;
      currentMsg.thinkStart = Date.now();
      currentMsg.thinkEl.classList.remove("collapsed");
    }
    ensureThinkBlock(currentMsg);
    currentMsg.thinkText += delta;
    // GUI 不截断思考内容：全量写入，框体固定高度、内部滚动跟随底部
    currentMsg.thinkBody.textContent = currentMsg.thinkText;
    currentMsg.thinkBody.scrollTop = currentMsg.thinkBody.scrollHeight;
    if (!currentMsg.thinkDone) {
      const dur = currentMsg.thinkHead.querySelector(".think-dur");
      if (dur) dur.textContent = thinkDurText(currentMsg);
    }
    scrollBottom();
  }

  function finishAssistant() {
    if (currentMsg) endThinkTiming(currentMsg);
    if (currentMsg && currentMsg.curText) {
      richRender(currentMsg.bodyEl, currentMsg.curText);
    }
    currentMsg = null;
    scrollBottom();
  }

  // ── 工具调用行：SVG 图标 + 中文标签 + 详情（文件徽章 / 命令截断），未识别工具走扳手兜底 ──
  function argText(input, keys) {
    if (!input || typeof input !== "object") return "";
    for (const k of keys) if (typeof input[k] === "string" && input[k]) return input[k];
    return "";
  }
  const FILE_KEYS = ["file_path", "filePath", "path", "file", "filename", "notebook_path"];
  const EXT_BADGE_CLS = { JS: "js", MJS: "js", CJS: "js", JSX: "js", TS: "ts", TSX: "ts", PY: "py", MD: "md", HTML: "html", CSS: "css", JSON: "js", SH: "sh", YML: "sh", YAML: "sh" };

  // 已知自定义工具：精确名优先匹配，避免被下方类别正则误吞（如 create_subagent → 写入）
  const TOOL_EXACT = {
    create_subagent: { icon: "task", label: "子代理" },
    save_memory: { icon: "box", label: "记忆" },
    load_skills: { icon: "box", label: "技能" },
    change_emotion: { icon: "task", label: "情绪" },
    keep_silent: { icon: "box", label: "静默" },
    read_docs: { icon: "eye", label: "文档" },
    transcribe: { icon: "globe", label: "转写" },
  };

  /** 工具名 → { 图标, 中文标签 }。精确名 → 类别正则按序匹配；未来新工具落到 wrench 兜底（显示原始名）。 */
  function toolMeta(toolName) {
    const n = String(toolName || "");
    if (TOOL_EXACT[n]) return TOOL_EXACT[n];
    if (/^(bash|shell|terminal|exec|run_command|command)/i.test(n)) return { icon: "terminal", label: "终端" };
    if (/(edit|patch|apply|str_replace|multi_?edit)/i.test(n)) return { icon: "pencil", label: "编辑" };
    if (/^(write|save|insert|add)(_|$)/i.test(n)) return { icon: "pencil", label: "写入" };
    if (/^(read|view|open|cat|load)(_|$)/i.test(n)) return { icon: "eye", label: "读取" };
    if (/^(web_|tavily|fetch|http|url|browse)/i.test(n)) return { icon: "globe", label: "网络" };
    if (/(grep|glob|search|find|list_?dir)/i.test(n)) return { icon: "search", label: "搜索" };
    if (/^computer_/i.test(n)) return { icon: "monitor", label: "屏幕" };
    if (/(todo|task|plan)/i.test(n)) return { icon: "task", label: "任务" };
    if (/^mcp__/i.test(n)) return { icon: "box", label: n.slice(5).split("__").join(" · ") };
    return { icon: "wrench", label: n };
  }

  /** 工具入参 → 详情 HTML（内部已转义）。文件类：扩展名徽章 + 文件名 + 目录；其余：mono 单行截断。 */
  function toolDetailHTML(toolName, input) {
    const n = String(toolName || "");
    const isFileTool = /(edit|patch|apply|str_replace|multi_?edit)/i.test(n) || /^(write|save|insert|add|read|view|open|cat|load)(_|$)/i.test(n);
    const file = isFileTool ? argText(input, FILE_KEYS) : "";
    if (file) {
      const i = file.lastIndexOf("/");
      const name = i >= 0 ? file.slice(i + 1) : file;
      const dir = i >= 0 ? file.slice(0, i + 1) : "";
      const ext = (name.split(".").pop() || "").toUpperCase();
      const badge = name.includes(".") && ext.length <= 5
        ? `<span class="t-badge ext-${EXT_BADGE_CLS[ext] || "other"}">${esc(ext.slice(0, 4))}</span>`
        : "";
      return `${badge}<span class="t-file">${esc(name)}</span>${dir ? `<span class="t-dir">${esc(dir)}</span>` : ""}`;
    }
    let text = "";
    if (/^(bash|shell|terminal|exec|run_command|command)/i.test(n)) text = argText(input, ["command", "cmd", "script"]);
    else if (/^(web_|tavily|fetch|http|url|browse)/i.test(n)) text = argText(input, ["url", "query"]);
    else if (/(grep|glob|search|find|list_?dir)/i.test(n)) text = argText(input, ["pattern", "query", "regex", "path", "directory"]);
    else if (/^computer_/i.test(n)) text = argText(input, ["action", "text", "key"]);
    else if (/^(create_subagent|save_memory|load_skills|read_docs|transcribe)$/i.test(n)) text = argText(input, ["task", "description", "name", "content", "skill", "skills", "query", "paths"]);
    else if (input && typeof input === "object") {
      try { const s = JSON.stringify(input); text = s === "{}" ? "" : s; } catch { text = ""; }
    } else if (typeof input === "string") {
      text = input;
    }
    text = String(text).replace(/\s+/g, " ").trim();
    return text ? `<span class="t-detail">${esc(text.slice(0, 120))}</span>` : "";
  }

  /** 编码子代理执行过程 → 独立角色块（与实时输出同构：思考折叠块 / 工具行 / 报告正文）。 */
  function renderCodingRunBlock(run) {
    const wrap = document.createElement("div");
    wrap.className = "msg-assistant";
    wrap.dataset.agent = run.agent || "";
    const speaker = document.createElement("div");
    speaker.className = "msg-speaker";
    speaker.textContent = (AGENT_LABELS[run.agent] || run.agent) + "：";
    wrap.appendChild(speaker);
    const subPending = [];
    for (const m of run.messages || []) {
      if (m.role === "user") continue; // 任务描述已在上方 create_subagent 行的参数里
      if (m.role === "assistant") {
        for (const b of m.content || []) {
          if (b.type === "thinking") {
            const thinkEl = document.createElement("div");
            thinkEl.className = "msg-thinking collapsed"; // 历史思考：默认折叠
            const head = buildThinkHead(false);
            const body = document.createElement("div");
            body.className = "think-body";
            body.textContent = String(b.thinking || "");
            head.addEventListener("click", () => thinkEl.classList.toggle("collapsed"));
            thinkEl.appendChild(head);
            thinkEl.appendChild(body);
            wrap.appendChild(thinkEl);
          } else if (b.type === "toolCall") {
            const row = renderToolRow(b.name || "", b.arguments);
            wrap.appendChild(row);
            subPending.push(row);
          } else if (b.type === "text") {
            const bodyEl = document.createElement("div");
            bodyEl.className = "msg-body";
            richRender(bodyEl, b.text || "");
            wrap.appendChild(bodyEl);
          }
        }
      } else if (m.role === "toolResult") {
        let i = subPending.findIndex((r) => r.dataset.tool === (m.toolName || ""));
        if (i < 0 && subPending.length) i = 0;
        if (i >= 0) {
          const row = subPending.splice(i, 1)[0];
          setToolStatus(row, m.isError);
          setToolOutput(row, m.content);
        }
      }
    }
    chat.appendChild(wrap);
  }

  function renderToolRow(toolName, input) {
    const row = document.createElement("div");
    row.className = "msg-tool";
    row.dataset.tool = String(toolName || "");
    const meta = toolMeta(toolName);
    // 完整调用参数（展开显示；默认折叠）
    let argsJson = "";
    try {
      argsJson = input == null ? "" : typeof input === "object" ? JSON.stringify(input, null, 2) : String(input);
      if (argsJson === "{}") argsJson = "";
    } catch { argsJson = ""; }
    const detailParts = [];
    if (argsJson) detailParts.push(`<div class="t-sec">输入</div><div class="t-args">${esc(argsJson)}</div>`);
    row.innerHTML = `<div class="t-row">`
      + `<span class="t-icon">${svgIcon(meta.icon, 16)}</span><span class="t-label">${esc(meta.label)}</span>`
      + toolDetailHTML(toolName, input)
      + (argsJson ? `<span class="t-chev">${CHEV_SVG}</span>` : "")
      + '<span class="t-status run"></span>'
      + `</div>`
      + (detailParts.length ? `<div class="t-detail-full">${detailParts.join("")}</div>` : "");
    if (detailParts.length) {
      row.classList.add("has-detail");
      row.addEventListener("click", () => row.classList.toggle("open"));
      // 在参数面板内选择文本时不触发折叠
      row.querySelector(".t-detail-full").addEventListener("click", (e) => e.stopPropagation());
    }
    return row;
  }

  function setToolStatus(row, isError) {
    const st = row.querySelector(".t-status");
    if (st) st.className = "t-status " + (isError ? "err" : "ok");
  }

  // 进行中的工具行队列：start/end 按 FIFO 配对（子代理嵌套执行时也不会错位）
  const pendingToolRows = [];

  /** 工具执行结果 → 可展示文本（string / {content:[{type:"text"}]} / 其他对象 JSON 化）。超长截断。 */
  function toolOutputText(result) {
    let text = "";
    if (result == null) return "";
    if (typeof result === "string") text = result;
    else if (Array.isArray(result)) {
      text = result.map((b) => (b && b.type === "text" ? b.text || "" : "")).join("\n");
      if (!text.trim()) {
        try { text = JSON.stringify(result, null, 2); } catch { text = ""; }
      }
    } else if (typeof result === "object") {
      if (Array.isArray(result.content)) text = toolOutputText(result.content);
      else {
        try { text = JSON.stringify(result, null, 2); } catch { text = ""; }
      }
    } else text = String(result);
    text = String(text);
    const MAX_OUT = 20000;
    if (text.length > MAX_OUT) text = text.slice(0, MAX_OUT) + "\n…（输出过长，已截断）";
    return text.trim() ? text : "";
  }

  /** 把工具输出写入行的展开面板（Markdown 渲染）；首次写入时补齐展开交互。 */
  function setToolOutput(row, result) {
    const text = toolOutputText(result);
    if (!text) return;
    let panel = row.querySelector(".t-detail-full");
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "t-detail-full";
      row.appendChild(panel);
    }
    let wrap = panel.querySelector(".t-out-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "t-out-wrap";
      const sec = document.createElement("div");
      sec.className = "t-sec";
      sec.textContent = "输出";
      const body = document.createElement("div");
      body.className = "t-out";
      wrap.appendChild(sec);
      wrap.appendChild(body);
      panel.appendChild(wrap);
    }
    const body = wrap.querySelector(".t-out");
    body.innerHTML = "";
    richRender(body, text);
    if (!row.classList.contains("has-detail")) {
      row.classList.add("has-detail");
      row.addEventListener("click", () => row.classList.toggle("open"));
      row.querySelector(".t-detail-full").addEventListener("click", (e) => e.stopPropagation());
      const chev = document.createElement("span");
      chev.className = "t-chev";
      chev.innerHTML = CHEV_SVG;
      row.querySelector(".t-status").before(chev);
    }
  }

  function toolStart(agentId, ev) {
    // 工具行归属事件所属角色（编码子代理的工具不得落入主 Agent 的块）
    if (!currentMsg || currentMsg.agentId !== agentId) startAssistant(agentId);
    // 兼容两种事件载荷：session 事件用 input，扩展事件用 args
    const row = renderToolRow(ev.toolName, ev.input ?? ev.args);
    currentMsg.root.appendChild(row);
    currentMsg.lastToolEl = row;
    pendingToolRows.push(row);
    scrollBottom();
  }

  function toolEnd(ev) {
    const row = pendingToolRows.shift();
    if (!row) return;
    setToolStatus(row, ev.isError);
    setToolOutput(row, ev.result); // Bash 输出等执行结果并入展开面板
  }

  // ── 历史回放（resume）────────────────────────────
  function renderHistory(messages) {
    chat.innerHTML = "";
    // 空历史（新会话）→ 重新注入欢迎页，并清空子代理过程关联
    if (!messages.length) {
      chat.innerHTML = welcomeTemplate;
      codingRunsByCall = new Map();
    }
    setConversationStarted(messages.length > 0);
    const pendingTools = []; // 未收到结果的工具行，toolResult 按名称 FIFO 回填状态
    const turnSeen = new Map(); // 本轮已发言的角色：再次出现时用续写块（不带标签），保持时间顺序
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
        if (text) addUserMsg(text);
        turnSeen.clear();
      } else if (msg.role === "assistant") {
        const content = msg.content || [];
        const speakerKey = msg.speaker || "__main__";
        const cont = turnSeen.has(speakerKey);
        turnSeen.set(speakerKey, true);
        const speakerLabel = AGENT_LABELS[msg.speaker] || (state ? AGENT_LABELS[state.mainAgent] : null) || "ARONA";
        const wrap = document.createElement("div");
        wrap.className = "msg-assistant" + (cont ? " cont" : "");
        wrap.dataset.agent = msg.speaker || ""; // 编码子代理视觉区分用
        if (!cont) {
          const speaker = document.createElement("div");
          speaker.className = "msg-speaker";
          speaker.textContent = speakerLabel + "：";
          wrap.appendChild(speaker);
        }
        chat.appendChild(wrap); // 先挂载：消息内遇到 create_subagent 时，子代理块才能插在其后
        for (const tb of content.filter((b) => b.type === "thinking")) {
          const thinkEl = document.createElement("div");
          thinkEl.className = "msg-thinking collapsed"; // 历史思考已完成：默认折叠
          const head = buildThinkHead(false);
          const body = document.createElement("div");
          body.className = "think-body";
          // GUI 不截断：全量内容，框体固定高度内部滚动
          body.textContent = String(tb.thinking || "");
          head.addEventListener("click", () => thinkEl.classList.toggle("collapsed"));
          thinkEl.appendChild(head);
          thinkEl.appendChild(body);
          wrap.appendChild(thinkEl);
        }
        const bodyEl = document.createElement("div");
        bodyEl.className = "msg-body";
        const text = content.filter((b) => b.type === "text").map((b) => b.text || "").join("");
        if (text) richRender(bodyEl, text);
        wrap.appendChild(bodyEl);
        for (const tc of content.filter((b) => b.type === "toolCall")) {
          const row = renderToolRow(tc.name || "", tc.arguments);
          wrap.appendChild(row);
          pendingTools.push(row);
          // 编码子代理：过程渲染为独立角色块（插在调用行之后，与实时输出同构）
          const run = codingRunsByCall.get(tc.id);
          if (run && /^create_subagent$/i.test(tc.name || "")) {
            renderCodingRunBlock(run);
          }
        }
      } else if (msg.role === "toolResult") {
        let i = pendingTools.findIndex((r) => r.dataset.tool === (msg.toolName || ""));
        if (i < 0 && pendingTools.length) i = 0;
        if (i >= 0) {
          const row = pendingTools.splice(i, 1)[0];
          setToolStatus(row, msg.isError);
          setToolOutput(row, msg.content); // 回放：toolResult 文本作为工具输出
        }
      }
    }
    scrollBottom(true);
  }

  // ── 状态 ──────────────────────────────────────
  function applyState(s) {
    state = s;
    // 录音中不禁用：再点一次 = 取消识别（stt_stop）
    $("#btn-mic").disabled = s.noVoice || !s.sttEnabled;
    $("#btn-send").classList.toggle("hidden", s.processing);
    $("#btn-stop").classList.toggle("hidden", !s.processing);
    $("#btn-mic").classList.toggle("recording", s.recording);
    input.disabled = false;
    if (settingsModalOpen) refreshSettingsModal();
  }

  // ── 侧栏会话列表（工作区嵌套会话分组）──────────
  /** 单条会话行（点击 resume；右键重命名/删除/多选；多选模式为勾选行）。 */
  function buildSessionRow(s) {
    const row = document.createElement("button");
    row.className = "session-item" + (s.path === sessionsData.currentPath ? " current" : "");
    row.title = multiSelect ? "" : s.preview;
    if (multiSelect) {
      row.classList.toggle("selected", multiSelected.has(s.path));
      const check = document.createElement("span");
      check.className = "sess-check";
      check.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      row.appendChild(check);
    }
    const title = document.createElement("span");
    title.className = "s-title";
    title.textContent = s.preview || "(untitled)";
    const time = document.createElement("span");
    time.className = "s-time";
    time.textContent = relTime(s.timestamp);
    row.appendChild(title);
    row.appendChild(time);
    if (multiSelect) {
      row.addEventListener("click", () => {
        if (multiSelected.has(s.path)) multiSelected.delete(s.path);
        else multiSelected.add(s.path);
        row.classList.toggle("selected", multiSelected.has(s.path));
        updateMultiBar();
      });
    } else {
      row.addEventListener("click", () => api.send({ type: "resume_session", path: s.path }));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, [
          { label: "重命名", onClick: () => openRenameModal(s) },
          { label: "移动到工作区", onClick: () => openMoveWsModal(s) },
          { label: "删除", danger: true, onClick: () => confirmDeleteSessions([s]) },
          { label: "多选", onClick: () => setMultiSelect(true) },
        ]);
      });
    }
    return row;
  }

  function renderSessions() {
    sessionListEl.innerHTML = "";
    sessionListEl.classList.toggle("multi", multiSelect);
    if (!sessionsData.sessions.length) {
      const empty = document.createElement("div");
      empty.className = "session-empty";
      empty.textContent = "暂无历史会话";
      sessionListEl.appendChild(empty);
      updateMultiBar();
      return;
    }
    const groups = groupSessions(sessionsData.sessions);
    // 当前会话所在组始终展开（组头折叠状态由用户点击驱动）
    const curGroup = groups.find((g) => g.sessions.some((s) => s.path === sessionsData.currentPath));
    if (curGroup) wsCollapsed.delete(curGroup.workspace || "");
    for (const g of groups) {
      const key = g.workspace || "";
      const collapsed = wsCollapsed.has(key);
      const groupEl = document.createElement("div");
      groupEl.className = "ws-group" + (collapsed ? " collapsed" : "");
      groupEl.dataset.ws = key;

      // 组头：文件夹图标 + 工作区名 + 数量 + 折叠箭头（多选模式下仅展示）
      const head = document.createElement(multiSelect ? "div" : "button");
      head.className = "ws-head";
      head.title = g.workspace || "";
      head.innerHTML = `<span class="ws-folder">${svgIcon("folder", 14)}</span>`
        + `<span class="ws-name">${esc(g.label)}</span>`
        + `<span class="ws-count">${g.sessions.length}</span>`
        + `<span class="ws-chev">${CHEV_SVG}</span>`;
      if (!multiSelect) {
        head.addEventListener("click", () => {
          // 只切状态类：collapse-body 的 grid 过渡自动播放（不重建 DOM，重建会跳过动画）
          const next = !wsCollapsed.has(key);
          if (next) wsCollapsed.add(key);
          else wsCollapsed.delete(key);
          groupEl.classList.toggle("collapsed", next);
          body.classList.toggle("collapsed", next);
        });
      }
      groupEl.appendChild(head);

      // 组体：collapse-body 工具类包裹（折叠/展开过渡动画，见 style.css 工具类说明）
      const body = document.createElement("div");
      body.className = "collapse-body" + (collapsed ? " collapsed" : "");
      const bodyInner = document.createElement("div");
      bodyInner.className = "collapse-inner ws-body";

      const shown = Math.min(wsShown.get(key) ?? WS_PAGE, g.sessions.length);
      for (const s of g.sessions.slice(0, shown)) bodyInner.appendChild(buildSessionRow(s));
      if (shown < g.sessions.length) {
        const more = document.createElement("button");
        more.className = "ws-more";
        more.textContent = `显示更多（${g.sessions.length - shown}）`;
        more.addEventListener("click", () => {
          wsShown.set(key, shown + WS_PAGE);
          renderSessions();
        });
        bodyInner.appendChild(more);
      } else if (shown > WS_PAGE) {
        const less = document.createElement("button");
        less.className = "ws-more";
        less.textContent = "收起";
        less.addEventListener("click", () => {
          wsShown.delete(key);
          renderSessions();
        });
        bodyInner.appendChild(less);
      }
      body.appendChild(bodyInner);
      groupEl.appendChild(body);
      sessionListEl.appendChild(groupEl);
    }
    updateMultiBar();
  }

  // ── 会话多选模式 ──────────────────────────────
  function setMultiSelect(on) {
    multiSelect = on;
    multiSelected.clear();
    document.body.classList.toggle("multi-select", on);
    renderSessions();
  }

  function updateMultiBar() {
    const bar = $("#session-mode-bar");
    bar.classList.toggle("hidden", !multiSelect);
    if (multiSelect) {
      const n = multiSelected.size;
      $("#btn-multi-delete").textContent = n ? `一键删除（${n}）` : "一键删除";
    }
  }

  /** 删除确认（单删/多删共用）：毛玻璃警告框，层级仅次于 toast。 */
  function confirmDeleteSessions(sessions) {
    const text = sessions.length === 1
      ? `确定删除「${sessions[0].preview || "(untitled)"}」？删除后不可恢复。`
      : `确定删除选中的 ${sessions.length} 个会话？删除后不可恢复。`;
    openConfirm(text, () => {
      for (const s of sessions) api.send({ type: "delete_session", path: s.path });
      if (multiSelect) setMultiSelect(false);
    });
  }

  function openConfirm(text, onOk) {
    $("#confirm-text").textContent = text;
    confirmOkCb = onOk;
    glassClear($("#confirm-backdrop"));
    glassClear($("#confirm-box"));
    $("#confirm-backdrop").classList.remove("hidden");
  }
  function closeConfirm() {
    glassHide($("#confirm-backdrop"), () => glassClear($("#confirm-box")));
    confirmOkCb = null;
  }
  $("#confirm-cancel").addEventListener("click", closeConfirm);
  $("#confirm-ok").addEventListener("click", () => {
    const cb = confirmOkCb;
    closeConfirm();
    cb?.();
  });
  $("#confirm-backdrop").addEventListener("pointerdown", (e) => {
    if (e.target === $("#confirm-backdrop")) closeConfirm();
  });
  $("#btn-multi-cancel").addEventListener("click", () => setMultiSelect(false));
  $("#btn-multi-delete").addEventListener("click", () => {
    const targets = sessionsData.sessions.filter((s) => multiSelected.has(s.path));
    if (targets.length) confirmDeleteSessions(targets);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeConfirm();
      closeContextMenu();
      closeWsMenu();
      if (multiSelect) setMultiSelect(false);
    }
  });

  // ── 右键菜单 ──────────────────────────────────
  function openContextMenu(x, y, items) {
    closeContextMenu();
    const menu = document.createElement("div");
    menu.id = "context-menu";
    for (const item of items) {
      const btn = document.createElement("button");
      btn.className = "ctx-item" + (item.danger ? " danger" : "");
      btn.textContent = item.label;
      btn.addEventListener("click", () => {
        closeContextMenu();
        item.onClick();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    // 先挂载再量尺寸，避免越出窗口
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
  }
  function closeContextMenu() {
    const menu = document.getElementById("context-menu");
    if (!menu || menu.classList.contains("glass-out")) return;
    menu.classList.add("glass-out");
    setTimeout(() => menu.remove(), GLASS_OUT_MS);
  }
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest?.("#context-menu")) closeContextMenu();
  });
  window.addEventListener("blur", closeContextMenu);

  function openRenameModal(s) {
    const div = document.createElement("div");
    const inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.className = "rename-input";
    inputEl.value = s.preview || "";
    inputEl.maxLength = 50;
    div.appendChild(inputEl);
    const footer = document.createElement("div");
    const ok = document.createElement("button");
    ok.className = "btn-primary";
    ok.textContent = "确认";
    const submit = () => {
      const title = inputEl.value.trim();
      if (title) api.send({ type: "rename_session", path: s.path, title });
      closeModal();
    };
    ok.addEventListener("click", submit);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    footer.appendChild(ok);
    openModal("重命名会话", div, footer);
    inputEl.focus();
    inputEl.select();
  }

  /** 移动会话到工作区：列已知工作区 + 「选择其他文件夹…」（原生目录框，ws_folder_picked 分流）。 */
  function openMoveWsModal(s) {
    const items = (sessionsData.knownWorkspaces || []).map((ws) => ({
      label: wsLabel(ws),
      meta: ws,
      onPick: () => api.send({ type: "move_session", path: s.path, workspace: ws }),
    }));
    items.push({
      label: "选择其他文件夹…",
      meta: "",
      onPick: () => {
        moveTargetSession = s.path;
        api.send({ type: "pick_workspace_folder" });
      },
    });
    openModal("移动到工作区", pickList(items, (i) => i.meta || ""));
  }

  // ── 斜杠菜单（combobox：Enter 只补全不执行）─────
  function menuRefresh() {
    const v = input.value;
    if (!v.startsWith("/")) { menuClose(); return; }
    const firstToken = v.split(/\s/)[0].slice(1);
    menu.items = commands.filter((c) => {
      if (!firstToken) return true;
      return c.name.startsWith(firstToken) || c.aliases.some((a) => a.startsWith(firstToken));
    });
    if (menu.items.length === 0) { menuClose(); return; }
    menu.open = true;
    menu.index = Math.min(menu.index, menu.items.length - 1);
    glassClear(menuEl);
    menuEl.classList.remove("hidden");
    menuEl.innerHTML = "";
    menu.items.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "slash-item" + (i === menu.index ? " highlight" : "");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = "/" + c.name;
      const desc = document.createElement("span");
      desc.className = "desc";
      desc.textContent = c.description;
      item.appendChild(name);
      item.appendChild(desc);
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        menu.index = i;
        menuComplete();
      });
      menuEl.appendChild(item);
    });
  }
  function menuClose() {
    menu.open = false;
    menu.index = 0;
    glassHide(menuEl);
  }
  function menuMove(dir) {
    if (!menu.open) return;
    menu.index = (menu.index + dir + menu.items.length) % menu.items.length;
    menuRefresh();
    const el = menuEl.children[menu.index];
    if (el) el.scrollIntoView({ block: "nearest" });
  }
  function menuComplete() {
    if (!menu.open) return;
    const c = menu.items[menu.index];
    if (!c) { menuClose(); return; }
    input.value = "/" + c.name + " ";
    menuClose();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  // ── 发送 ──────────────────────────────────────
  /** 空消息 / 纯空格：发送按钮禁用（灰色）。 */
  function updateSendState() {
    $("#btn-send").disabled = !input.value.trim();
  }

  function send() {
    const text = input.value.trim();
    if (!text || (state && state.processing)) return;
    addUserMsg(text);
    api.send({ type: "input", text });
    input.value = "";
    autoGrow();
    updateSendState();
    menuClose();
  }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  input.addEventListener("input", () => {
    autoGrow();
    menuRefresh();
    updateSendState();
  });
  input.addEventListener("keydown", (e) => {
    if (menu.open) {
      if (e.key === "ArrowUp") { e.preventDefault(); menuMove(-1); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); menuMove(1); return; }
      if (e.key === "Enter") { e.preventDefault(); menuComplete(); return; }
      if (e.key === "Tab") { e.preventDefault(); return; }
      if (e.key === "Escape") { e.preventDefault(); menuClose(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape" && state && state.processing) {
      api.send({ type: "abort" });
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (menu.open && !menuEl.contains(e.target)) menuClose();
  });

  $("#btn-send").addEventListener("click", send);
  $("#btn-stop").addEventListener("click", () => api.send({ type: "abort" }));
  $("#btn-mic").addEventListener("click", () => {
    if (state && (state.noVoice || !state.sttEnabled)) return;
    if (state && state.recording) {
      // 录音中再点一次：取消识别
      micCancelExpected = true;
      api.send({ type: "stt_stop" });
      return;
    }
    api.send({ type: "stt_start" });
  });

  // ── 侧栏 ──────────────────────────────────────
  $("#btn-new").addEventListener("click", () => api.send({ type: "command", name: "new" }));
  $("#btn-collapse").addEventListener("click", () => {
    document.body.classList.add("sb-collapsed");
    document.body.classList.remove("sb-expanded");
    $("#btn-collapse").classList.add("hidden");
    $("#btn-expand").classList.remove("hidden");
  });
  $("#btn-expand").addEventListener("click", () => {
    document.body.classList.remove("sb-collapsed");
    document.body.classList.add("sb-expanded");
    $("#btn-expand").classList.add("hidden");
    $("#btn-collapse").classList.remove("hidden");
  });
  $("#btn-settings").addEventListener("click", openSettingsModal);

  // ── 欢迎页工作区选择器（初始页输入框左下角，麦克风左侧）──
  $("#ws-picker-icon").innerHTML = svgIcon("folder", 14);
  $("#ws-picker-chev").innerHTML = CHEV_SVG;

  /** 同步选择器文案：当前工作区名（GUI 后端启动目录）。 */
  function updateWsPicker() {
    $("#ws-picker-label").textContent = sessionsData.currentWorkspace
      ? wsLabel(sessionsData.currentWorkspace)
      : "会话";
    $("#ws-picker").title = sessionsData.currentWorkspace || "";
  }

  /** 侧栏定位展开某工作区分组：全量显示并滚动到组头（下拉「显示更多」/ 组头点击联动）。 */
  function revealGroupInSidebar(key) {
    wsCollapsed.delete(key);
    wsShown.set(key, Infinity);
    document.body.classList.remove("sb-collapsed");
    document.body.classList.add("sb-expanded");
    $("#btn-expand").classList.add("hidden");
    $("#btn-collapse").classList.remove("hidden");
    renderSessions();
    sessionListEl.querySelector(`.ws-group[data-ws="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "start" });
  }

  function buildWsMenu() {
    const menu = $("#ws-menu");
    menu.innerHTML = "";
    // 各工作区的会话数（knownWorkspaces 可能含无会话的历史选择项）
    const countByWs = new Map();
    for (const s of sessionsData.sessions) {
      const k = s.workspace || "";
      countByWs.set(k, (countByWs.get(k) || 0) + 1);
    }

    // 工作区列表（settings 选择历史 ∪ 会话推导，后端已合并去重；当前项高亮）
    for (const ws of sessionsData.knownWorkspaces || []) {
      const row = document.createElement("button");
      row.className = "ws-all" + (ws === sessionsData.currentWorkspace ? " current" : "");
      row.title = ws;
      row.innerHTML = `<span class="ws-folder">${svgIcon("folder", 14)}</span>`
        + `<span class="ws-name">${esc(wsLabel(ws))}</span>`
        + (countByWs.has(ws) ? `<span class="ws-count">${countByWs.get(ws)}</span>` : "");
      row.addEventListener("click", () => {
        closeWsMenu();
        api.send({ type: "set_workspace", path: ws });
      });
      menu.appendChild(row);
    }

    if (!(sessionsData.knownWorkspaces || []).length) {
      const empty = document.createElement("div");
      empty.className = "ws-empty";
      empty.textContent = "暂无工作区";
      menu.appendChild(empty);
    }

    // 选择其他位置的文件夹：Electron 原生目录对话框（main.cjs 弹出后经 ws_folder_picked 回传）
    const pick = document.createElement("button");
    pick.className = "ws-all ws-pick";
    pick.innerHTML = `<span class="ws-folder">${svgIcon("folder", 14)}</span><span class="ws-name">选择本地文件夹…</span>`;
    pick.addEventListener("click", () => {
      moveTargetSession = null;
      closeWsMenu();
      api.send({ type: "pick_workspace_folder" });
    });
    menu.appendChild(pick);
  }

  function toggleWsMenu() {
    const menu = $("#ws-menu");
    if (menu.classList.contains("hidden")) {
      buildWsMenu();
      glassClear(menu);
      menu.classList.remove("hidden");
      $("#ws-picker").classList.add("open");
    } else {
      closeWsMenu();
    }
  }
  function closeWsMenu() {
    const menu = $("#ws-menu");
    if (menu.classList.contains("hidden")) return;
    glassHide(menu);
    $("#ws-picker").classList.remove("open");
  }
  $("#ws-picker").addEventListener("click", toggleWsMenu);
  document.addEventListener("pointerdown", (e) => {
    const menu = $("#ws-menu");
    if (!menu.classList.contains("hidden")
      && !menu.contains(e.target) && !$("#ws-picker").contains(e.target)) {
      closeWsMenu();
    }
  });

  // ── 弹窗 ──────────────────────────────────────
  function openModal(title, bodyNode, footerNode) {
    $("#modal-title-text").textContent = title;
    const body = $("#modal-body");
    body.innerHTML = "";
    body.appendChild(bodyNode);
    const footer = $("#modal-footer");
    footer.innerHTML = "";
    if (footerNode) {
      footer.classList.remove("hidden");
      footer.appendChild(footerNode);
    } else {
      footer.classList.add("hidden");
    }
    glassClear($("#modal-backdrop"));
    glassClear($("#modal"));
    $("#modal-backdrop").classList.remove("hidden");
  }
  function closeModal() {
    glassHide($("#modal-backdrop"));
    settingsModalOpen = false;
    settingsInfoEl = null;
  }
  $("#modal-close").addEventListener("click", closeModal);
  $("#modal-backdrop").addEventListener("pointerdown", (e) => {
    if (e.target === $("#modal-backdrop")) closeModal();
  });

  function pickList(items, formatMeta) {
    const div = document.createElement("div");
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "pick-item";
      const label = document.createElement("span");
      label.textContent = item.label;
      row.appendChild(label);
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = formatMeta ? formatMeta(item) : "";
      row.appendChild(meta);
      row.addEventListener("click", () => {
        item.onPick();
        closeModal();
      });
      div.appendChild(row);
    });
    return div;
  }

  // ── 设置弹窗（状态信息 + 显示/语音开关）──────────
  function openSettingsModal() {
    settingsModalOpen = true;
    openModal("设置", buildSettingsBody());
  }

  function buildSettingsBody() {
    const div = document.createElement("div");

    const info = document.createElement("div");
    div.appendChild(info);
    settingsInfoEl = info;
    fillSettingsInfo(info);

    const toggleSpecs = [
      { id: "tg-tts", label: "TTS 语音播报", get: () => !!(state && state.ttsEnabled), set: () => api.send({ type: "command", name: "tts" }) },
      { id: "tg-stt", label: "STT 语音输入", get: () => !!(state && state.sttEnabled), set: () => api.send({ type: "command", name: "stt" }) },
    ];
    for (const spec of toggleSpecs) {
      const row = document.createElement("label");
      row.className = "set-toggle";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = spec.label;
      const sw = document.createElement("span");
      sw.className = "switch";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.id = spec.id;
      box.checked = spec.get();
      box.addEventListener("change", () => spec.set(box.checked));
      const slider = document.createElement("span");
      slider.className = "slider";
      sw.appendChild(box);
      sw.appendChild(slider);
      row.appendChild(label);
      row.appendChild(sw);
      div.appendChild(row);
    }

    // 角色分区：数据经 list_agents → agents 事件异步填充
    const agentsSection = document.createElement("div");
    agentsSection.id = "settings-agents";
    const agentsTitle = document.createElement("div");
    agentsTitle.className = "set-section-title";
    agentsTitle.textContent = "角色";
    div.appendChild(agentsTitle);
    div.appendChild(agentsSection);
    api.send({ type: "list_agents" });
    return div;
  }

  /** 把 agents 数据渲染进设置弹窗：蓝色胶囊按钮，主 Agent 单选（启用一个即取消另一个）、子 Agent 多选，点击即时生效。 */
  function fillSettingsAgents(msg) {
    const section = document.getElementById("settings-agents");
    if (!section) return;
    section.innerHTML = "";
    const selectedMain = { value: msg.currentMain };
    const selectedSubs = new Set(msg.currentSubs);
    const apply = () => api.send({ type: "change_agent", main: selectedMain.value, subs: [...selectedSubs] });

    const mainLabel = document.createElement("div");
    mainLabel.className = "set-sub-label";
    mainLabel.textContent = "主 Agent（单选）";
    section.appendChild(mainLabel);
    const mainRow = document.createElement("div");
    mainRow.className = "pill-row";
    msg.main.forEach((id) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill-btn";
      btn.dataset.id = id;
      btn.textContent = AGENT_LABELS[id] || id;
      btn.classList.toggle("active", id === msg.currentMain);
      btn.addEventListener("click", () => {
        if (selectedMain.value === id) return;
        selectedMain.value = id;
        mainRow.querySelectorAll(".pill-btn").forEach((b) => b.classList.toggle("active", b.dataset.id === id));
        apply();
      });
      mainRow.appendChild(btn);
    });
    section.appendChild(mainRow);

    const subLabel = document.createElement("div");
    subLabel.className = "set-sub-label";
    subLabel.textContent = "子 Agent（可多选）";
    section.appendChild(subLabel);
    const subRow = document.createElement("div");
    subRow.className = "pill-row";
    msg.subs.forEach((id) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill-btn";
      btn.textContent = AGENT_LABELS[id] || id;
      btn.classList.toggle("active", selectedSubs.has(id));
      btn.addEventListener("click", () => {
        if (selectedSubs.has(id)) selectedSubs.delete(id);
        else selectedSubs.add(id);
        btn.classList.toggle("active", selectedSubs.has(id));
        apply();
      });
      subRow.appendChild(btn);
    });
    section.appendChild(subRow);
  }

  function fillSettingsInfo(info) {
    info.innerHTML = "";
    if (!state) return;
    const subs = (state.subAgents || []).map((id) => AGENT_LABELS[id] || id).join("、") || "无";
    const rows = [
      ["模型", state.model],
      ["主 Agent", state.mainAgentLabel],
      ["子 Agent", subs],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "set-row";
      const l = document.createElement("span");
      l.className = "label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "value";
      v.textContent = value;
      v.title = value;
      row.appendChild(l);
      row.appendChild(v);
      info.appendChild(row);
    }
  }

  /** 状态刷新后同步设置弹窗（弹窗开着时）。 */
  function refreshSettingsModal() {
    if (!settingsInfoEl || !settingsInfoEl.isConnected) return;
    fillSettingsInfo(settingsInfoEl);
    const sync = (id, val) => {
      const box = document.getElementById(id);
      if (box) box.checked = val;
    };
    sync("tg-tts", !!(state && state.ttsEnabled));
    sync("tg-stt", !!(state && state.sttEnabled));
  }

  function openSkillsModal(skills) {
    if (!skills.length) {
      statusLine("未找到技能。请在 ~/.arona/skills/<名称>/SKILL.md 中放置。", "warn");
      return;
    }
    const items = skills.map((s) => ({
      label: s.name,
      meta: s.description,
      onPick: () => api.send({ type: "invoke_skill", name: s.name }),
    }));
    openModal("技能", pickList(items, (i) => i.meta));
  }

  function openMcpModal(servers) {
    if (!servers.length) {
      statusLine("未连接任何 MCP 服务器。在 settings.json 中配置（mcpServers）。", "warn");
      return;
    }
    const items = servers.map((s) => ({
      label: s.name,
      meta: s.tools.join("、") || "（无工具）",
      onPick: () => {},
    }));
    const list = pickList(items, (i) => i.meta);
    list.querySelectorAll(".pick-item").forEach((row) => { row.classList.add("disabled"); });
    openModal("MCP 服务器", list);
  }

  // ── Agent 事件 ──────────────────────────────────
  function handleAgentEvent(agentId, ev) {
    switch (ev.type) {
      case "message_start":
        startAssistant(agentId);
        break;
      case "message_update": {
        const ae = ev.assistantMessageEvent;
        if (!ae) break;
        if (ae.type === "text_delta") appendTextDelta(ae.delta);
        else if (ae.type === "thinking_delta") appendThinkingDelta(ae.delta);
        break;
      }
      case "message_end":
        finishAssistant();
        break;
      case "tool_execution_start":
        toolStart(agentId, ev);
        break;
      case "tool_execution_end":
        toolEnd(ev);
        break;
      case "compaction_start":
        statusLine("压缩上下文…");
        break;
      case "compaction_end":
        if (ev.aborted) statusLine("压缩已取消", "warn");
        else if (ev.errorMessage) statusLine("压缩失败", "error");
        else statusLine("压缩完成", "success");
        break;
      case "auto_retry_start":
        statusLine("重试中…", "warn");
        break;
    }
  }

  // ── 协议分发 ──────────────────────────────────
  api.on((msg) => {
    if (msg.type === "mode") console.log("[app.js] mode ->", msg.mode); // 白屏排查：确认事件到达渲染层
    switch (msg.type) {
      case "mode":
        $("#main-page").classList.toggle("hidden", msg.mode !== "main");
        $("#setup-page").classList.toggle("hidden", msg.mode !== "setup");
        break;
      case "ready":
        applyState(msg.state);
        break;
      case "commands":
        commands = msg.commands;
        break;
      case "agent_event":
        handleAgentEvent(msg.agentId, msg.event);
        break;
      case "notice":
        statusLine(msg.text, msg.level === "info" ? "" : msg.level);
        break;
      case "sessions": {
        const prevWs = sessionsData.currentWorkspace;
        sessionsData = {
          currentPath: msg.currentPath,
          currentWorkspace: msg.currentWorkspace || "",
          homeDir: msg.homeDir || "",
          knownWorkspaces: msg.knownWorkspaces || [],
          sessions: msg.sessions || [],
        };
        renderSessions();
        updateWsPicker();
        // 工作区被切换（选择器操作后端确认回推）：侧栏展开定位到新工作区分组
        if (activeWsSeen !== null && prevWs !== sessionsData.currentWorkspace) {
          revealGroupInSidebar(sessionsData.currentWorkspace);
        }
        activeWsSeen = sessionsData.currentWorkspace;
        break;
      }
      case "ws_folder_picked":
        // 原生目录框回传：移动会话弹窗发起 → move_session；选择器发起 → set_workspace
        if (moveTargetSession) {
          api.send({ type: "move_session", path: moveTargetSession, workspace: msg.path });
          moveTargetSession = null;
        } else {
          api.send({ type: "set_workspace", path: msg.path });
        }
        break;
      case "skills":
        openSkillsModal(msg.skills);
        break;
      case "agents":
        // 仅当设置弹窗开着时填充角色区；弹窗已关（如快速关闭后回复才到）直接丢弃，
        // 不再走旧版勾选框弹窗（openAgentsModal 已删除）
        if (settingsModalOpen) fillSettingsAgents(msg);
        break;
      case "mcp_servers":
        openMcpModal(msg.servers);
        break;
      case "history":
        renderHistory(msg.messages);
        break;
      case "coding_runs":
        codingRunsByCall = new Map((msg.runs || []).map((r) => [r.toolCallId, r]));
        break;
      case "stt_state":
        if (state) applyState({ ...state, recording: msg.recording });
        break;
      case "stt_result":
        if (msg.text) {
          input.value += (input.value ? " " : "") + msg.text;
          autoGrow();
          updateSendState();
          input.focus();
        } else if (micCancelExpected) {
          // 用户主动取消：静默
        } else {
          statusLine("未检测到语音。", "warn");
        }
        micCancelExpected = false;
        break;
      default:
        // setup_* 事件交由 setup.js 处理
        if (window.SetupUI && window.SetupUI.handle) window.SetupUI.handle(msg);
    }
  });

  updateSendState(); // 初始为空输入：发送按钮置灰
  console.log("[app.js] listener ready"); // 白屏排查：走到此处 = app.js 完整执行、api.on 已注册
})();
