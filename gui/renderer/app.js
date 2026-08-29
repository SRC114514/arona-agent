// ARONA GUI 渲染层主逻辑：###GUI### 协议 → DOM（侧栏会话列表 / 斜杠菜单 / 消息流 / 麦克风 / 弹窗）
(function () {
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
  const THINKING_TAIL_LINES = 3; // 与 CLI renderer.ts 一致：只显示思考尾部 N 行

  let commands = [];
  let state = null;
  const display = { thinking: true, toolDetails: true };
  const menu = { open: false, items: [], index: 0 };
  let currentMsg = null;
  let sessionsData = { currentPath: null, sessions: [] };
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
  /** 富文本渲染：``` 围栏 → <pre>，其余段落行内格式。 */
  function richRender(el, text) {
    el.innerHTML = "";
    const parts = String(text).split("```");
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

  function addUserMsg(text) {
    setConversationStarted(true);
    const wrap = document.createElement("div");
    wrap.className = "msg-user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    wrap.appendChild(bubble);
    chat.appendChild(wrap);
    scrollBottom(true);
  }

  function startAssistant(agentId) {
    setConversationStarted(true);
    const wrap = document.createElement("div");
    wrap.className = "msg-assistant";
    const speaker = document.createElement("div");
    speaker.className = "msg-speaker";
    speaker.textContent = (AGENT_LABELS[agentId] || "ARONA") + "：";
    const thinkEl = document.createElement("div");
    thinkEl.className = "msg-thinking";
    const bodyEl = document.createElement("div");
    bodyEl.className = "msg-body";
    wrap.appendChild(speaker);
    wrap.appendChild(thinkEl);
    wrap.appendChild(bodyEl);
    chat.appendChild(wrap);
    currentMsg = { root: wrap, bodyEl, thinkEl, thinkText: "", curText: "", lastToolEl: null };
  }

  function appendTextDelta(delta) {
    if (!currentMsg) startAssistant(state ? state.mainAgent : "arona");
    currentMsg.curText += delta;
    currentMsg.bodyEl.textContent = currentMsg.curText;
    scrollBottom();
  }

  function appendThinkingDelta(delta) {
    if (!currentMsg) startAssistant(state ? state.mainAgent : "arona");
    currentMsg.thinkText += delta;
    const lines = currentMsg.thinkText.replace(/\n+$/, "").split("\n");
    const tail = lines.slice(-THINKING_TAIL_LINES);
    const hidden = lines.length - tail.length;
    let html = "";
    if (hidden > 0) html += `… 已省略 ${hidden} 行\n`;
    html += esc(tail.join("\n"));
    currentMsg.thinkEl.innerHTML = html;
    scrollBottom();
  }

  function finishAssistant() {
    if (currentMsg && currentMsg.curText) {
      richRender(currentMsg.bodyEl, currentMsg.curText);
    }
    currentMsg = null;
    scrollBottom();
  }

  function toolStart(ev) {
    if (!currentMsg) startAssistant(state ? state.mainAgent : "arona");
    const row = document.createElement("div");
    row.className = "msg-tool";
    row.textContent = `→ ${ev.toolName} ${ev.input ? JSON.stringify(ev.input).slice(0, 100) : ""}`;
    currentMsg.root.appendChild(row);
    currentMsg.lastToolEl = row;
    scrollBottom();
  }

  function toolEnd(ev) {
    const row = currentMsg && currentMsg.lastToolEl;
    if (!row) return;
    const span = document.createElement("span");
    span.className = ev.isError ? "err" : "ok";
    span.textContent = ev.isError ? " ✗" : " ✓";
    row.appendChild(span);
  }

  // ── 历史回放（resume）────────────────────────────
  function renderHistory(messages) {
    chat.innerHTML = "";
    // 空历史（新会话）→ 重新注入欢迎页
    if (!messages.length) chat.innerHTML = welcomeTemplate;
    setConversationStarted(messages.length > 0);
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
        if (text) addUserMsg(text);
      } else if (msg.role === "assistant") {
        const content = msg.content || [];
        const speakerLabel = AGENT_LABELS[msg.speaker] || (state ? AGENT_LABELS[state.mainAgent] : null) || "ARONA";
        const wrap = document.createElement("div");
        wrap.className = "msg-assistant";
        const speaker = document.createElement("div");
        speaker.className = "msg-speaker";
        speaker.textContent = speakerLabel + "：";
        wrap.appendChild(speaker);
        for (const tb of content.filter((b) => b.type === "thinking")) {
          const thinkEl = document.createElement("div");
          thinkEl.className = "msg-thinking";
          const lines = String(tb.thinking || "").replace(/\n+$/, "").split("\n");
          const tail = lines.slice(-THINKING_TAIL_LINES);
          const hidden = lines.length - tail.length;
          thinkEl.innerHTML = (hidden > 0 ? `… 已省略 ${hidden} 行\n` : "") + esc(tail.join("\n"));
          wrap.appendChild(thinkEl);
        }
        const bodyEl = document.createElement("div");
        bodyEl.className = "msg-body";
        const text = content.filter((b) => b.type === "text").map((b) => b.text || "").join("");
        if (text) richRender(bodyEl, text);
        wrap.appendChild(bodyEl);
        for (const tc of content.filter((b) => b.type === "toolCall")) {
          const row = document.createElement("div");
          row.className = "msg-tool";
          row.textContent = `→ ${tc.name || ""} ${tc.arguments ? JSON.stringify(tc.arguments).slice(0, 100) : ""}`;
          wrap.appendChild(row);
        }
        chat.appendChild(wrap);
      } else if (msg.role === "toolResult") {
        const row = document.createElement("div");
        row.className = "msg-tool";
        row.textContent = `→ ${msg.toolName || ""} ${msg.isError ? "✗" : "✓"}`;
        chat.appendChild(row);
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

  // ── 侧栏会话列表 ──────────────────────────────
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
    for (const s of sessionsData.sessions) {
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
            { label: "删除", danger: true, onClick: () => confirmDeleteSessions([s]) },
            { label: "多选", onClick: () => setMultiSelect(true) },
          ]);
        });
      }
      sessionListEl.appendChild(row);
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
    $("#confirm-backdrop").classList.remove("hidden");
  }
  function closeConfirm() {
    $("#confirm-backdrop").classList.add("hidden");
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
    document.getElementById("context-menu")?.remove();
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
    menuEl.classList.remove("hidden");
    menuEl.innerHTML = "";
    menu.items.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "slash-item" + (i === menu.index ? " highlight" : "");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = "/" + c.name + (c.aliases.length ? `（/${c.aliases.join(", /")}）` : "");
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
    menuEl.classList.add("hidden");
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
  function send() {
    const text = input.value.trim();
    if (!text || (state && state.processing)) return;
    addUserMsg(text);
    api.send({ type: "input", text });
    input.value = "";
    autoGrow();
    menuClose();
  }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  input.addEventListener("input", () => {
    autoGrow();
    menuRefresh();
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
    $("#modal-backdrop").classList.remove("hidden");
  }
  function closeModal() {
    $("#modal-backdrop").classList.add("hidden");
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
      { id: "tg-thinking", label: "思考块", get: () => display.thinking, set: (v) => api.send({ type: "set_display", thinking: v }) },
      { id: "tg-details", label: "工具详情", get: () => display.toolDetails, set: (v) => api.send({ type: "set_display", toolDetails: v }) },
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
    sync("tg-thinking", display.thinking);
    sync("tg-details", display.toolDetails);
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

  function openAgentsModal(msg) {
    const div = document.createElement("div");
    let selectedMain = msg.currentMain;
    const selectedSubs = new Set(msg.currentSubs);

    const mainTitle = document.createElement("div");
    mainTitle.style.cssText = "font-size:12.5px;color:var(--text-3);margin:4px 0 6px;";
    mainTitle.textContent = "主 Agent（单选）";
    div.appendChild(mainTitle);
    msg.main.forEach((id) => {
      const label = document.createElement("label");
      label.className = "check-row";
      label.style.cssText = "display:flex;align-items:center;gap:5px;padding:4px 0;cursor:pointer;";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "agent-main";
      radio.checked = id === msg.currentMain;
      radio.addEventListener("change", () => { selectedMain = id; });
      label.appendChild(radio);
      label.appendChild(document.createTextNode(AGENT_LABELS[id] || id));
      div.appendChild(label);
    });

    const subTitle = document.createElement("div");
    subTitle.style.cssText = "font-size:12.5px;color:var(--text-3);margin:12px 0 6px;";
    subTitle.textContent = "子 Agent（多选）";
    div.appendChild(subTitle);
    msg.subs.forEach((id) => {
      const label = document.createElement("label");
      label.style.cssText = "display:flex;align-items:center;gap:5px;padding:4px 0;cursor:pointer;";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = msg.currentSubs.includes(id);
      box.addEventListener("change", () => {
        if (box.checked) selectedSubs.add(id);
        else selectedSubs.delete(id);
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(AGENT_LABELS[id] || id));
      div.appendChild(label);
    });

    const footer = document.createElement("div");
    const confirmBtn = document.createElement("button");
    confirmBtn.id = "setup-submit";
    confirmBtn.textContent = "确认";
    confirmBtn.addEventListener("click", () => {
      api.send({ type: "change_agent", main: selectedMain, subs: [...selectedSubs] });
      closeModal();
    });
    footer.appendChild(confirmBtn);

    openModal("切换角色", div, footer);
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
        toolStart(ev);
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
      case "display":
        display.thinking = msg.thinking;
        display.toolDetails = msg.toolDetails;
        if (settingsModalOpen) refreshSettingsModal();
        break;
      case "notice":
        statusLine(msg.text, msg.level === "info" ? "" : msg.level);
        break;
      case "sessions":
        sessionsData = { currentPath: msg.currentPath, sessions: msg.sessions };
        renderSessions();
        break;
      case "skills":
        openSkillsModal(msg.skills);
        break;
      case "agents":
        if (settingsModalOpen) fillSettingsAgents(msg);
        else openAgentsModal(msg);
        break;
      case "mcp_servers":
        openMcpModal(msg.servers);
        break;
      case "history":
        renderHistory(msg.messages);
        break;
      case "stt_state":
        if (state) applyState({ ...state, recording: msg.recording });
        break;
      case "stt_result":
        if (msg.text) {
          input.value += (input.value ? " " : "") + msg.text;
          autoGrow();
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
})();
