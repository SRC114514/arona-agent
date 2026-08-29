// ARONA GUI setup 向导页：表单 → setup_submit；进度经 setup_log / setup_clone_progress 事件回显
(function () {
  const $ = (sel) => document.querySelector(sel);
  const api = window.guiAPI;
  const body = $("#setup-body");
  const logEl = $("#setup-log");

  let agents = []; // [{id,label}]
  const cloneStatus = new Map(); // id → status
  let submitting = false;

  function field(labelText, inputEl, tip) {
    const fieldDiv = document.createElement("div");
    fieldDiv.className = "field";
    const label = document.createElement("label");
    label.textContent = labelText;
    fieldDiv.appendChild(label);
    fieldDiv.appendChild(inputEl);
    if (tip) {
      const tipEl = document.createElement("div");
      tipEl.style.cssText = "font-size:11.5px;color:var(--text-dim);margin-top:3px;";
      tipEl.textContent = tip;
      fieldDiv.appendChild(tipEl);
    }
    return fieldDiv;
  }
  function textInput(value, type) {
    const input = document.createElement("input");
    input.type = type || "text";
    input.value = value || "";
    return input;
  }
  function selectInput(options, value) {
    const sel = document.createElement("select");
    options.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      sel.appendChild(opt);
    });
    sel.value = value ?? options[0];
    return sel;
  }

  // ── 表单构建 ──────────────────────────────────
  function build() {
    body.innerHTML = "";

    // 语言
    const langSel = selectInput(["auto", "zh", "en"], "auto");
    langSel.id = "f-lang";
    const step0 = document.createElement("div");
    step0.className = "setup-step";
    step0.innerHTML = "<h2>语言 / Language</h2>";
    step0.appendChild(field("UI 语言", langSel));
    body.appendChild(step0);

    // LLM
    const step1 = document.createElement("div");
    step1.className = "setup-step";
    step1.innerHTML = "<h2>LLM</h2>";
    const baseUrl = textInput(""); baseUrl.id = "f-baseurl";
    const apiKey = textInput("", "password"); apiKey.id = "f-apikey";
    const model = textInput("openai/gpt-4o"); model.id = "f-model";
    step1.appendChild(field("Base URL", baseUrl));
    step1.appendChild(field("API Key", apiKey));
    step1.appendChild(field("模型", model));
    body.appendChild(step1);

    // Python
    const step2 = document.createElement("div");
    step2.className = "setup-step";
    step2.innerHTML = "<h2>Python</h2>";
    const py = textInput("python3"); py.id = "f-python";
    step2.appendChild(field("Python 路径", py, "需要 Python 3.12 或 3.13"));
    body.appendChild(step2);

    // 语音
    const step3 = document.createElement("div");
    step3.className = "setup-step";
    step3.innerHTML = "<h2>语音</h2>";
    const providerSel = selectInput(["aliyun", "gpt-sovits"], "aliyun");
    providerSel.id = "f-provider";
    step3.appendChild(field("TTS Provider", providerSel));

    // aliyun 面板
    const aliyunPanel = document.createElement("div");
    aliyunPanel.id = "panel-aliyun";
    const ttsKey = textInput("", "password"); ttsKey.id = "f-ttskey";
    aliyunPanel.appendChild(field("百炼 API Key", ttsKey, "TTS 与 STT 共用；获取：https://help.aliyun.com/zh/model-studio/get-api-key"));
    const cloneWrap = document.createElement("div");
    cloneWrap.className = "check-row";
    cloneWrap.id = "clone-agents";
    aliyunPanel.appendChild(cloneWrap);
    const cloneStatusDiv = document.createElement("div");
    cloneStatusDiv.id = "clone-status";
    aliyunPanel.appendChild(cloneStatusDiv);
    step3.appendChild(aliyunPanel);

    // gpt-sovits 面板
    const gsPanel = document.createElement("div");
    gsPanel.id = "panel-gs";
    gsPanel.classList.add("hidden");
    const modeSel = selectInput(["cloud", "local"], "cloud");
    modeSel.id = "f-gs-mode";
    gsPanel.appendChild(field("部署方式", modeSel));

    const cloudFields = document.createElement("div");
    cloudFields.id = "gs-cloud";
    const gsKey = textInput("", "password"); gsKey.id = "f-gs-key";
    cloudFields.appendChild(field("云端 API Key（可选）", gsKey));
    gsPanel.appendChild(cloudFields);

    const localFields = document.createElement("div");
    localFields.id = "gs-local";
    localFields.classList.add("hidden");
    const gsScript = textInput(""); gsScript.id = "f-gs-script";
    const gsPy = textInput(""); gsPy.id = "f-gs-py";
    const gsDevice = selectInput(["cuda", "cpu", "mps"], "cuda"); gsDevice.id = "f-gs-device";
    const gsBert = textInput(""); gsBert.id = "f-gs-bert";
    const gsHubert = textInput(""); gsHubert.id = "f-gs-hubert";
    const gsVersion = selectInput(["v2", "v2Pro", "v3", "v4"], "v2"); gsVersion.id = "f-gs-version";
    const gsDeps = document.createElement("input"); gsDeps.type = "checkbox"; gsDeps.id = "f-gs-deps"; gsDeps.checked = true;
    localFields.appendChild(field("api_v2.py 路径（留空=手动启动）", gsScript));
    localFields.appendChild(field("GPT-SoVITS Python 路径", gsPy));
    localFields.appendChild(field("推理设备", gsDevice));
    localFields.appendChild(field("BERT 模型目录", gsBert, "chinese-roberta-wwm-ext-large"));
    localFields.appendChild(field("CNHubert 模型目录", gsHubert, "chinese-hubert-base"));
    localFields.appendChild(field("模型版本", gsVersion));
    const depsLabel = document.createElement("label");
    depsLabel.style.cssText = "display:flex;align-items:center;gap:5px;cursor:pointer;";
    depsLabel.appendChild(gsDeps);
    depsLabel.appendChild(document.createTextNode("安装 GPT-SoVITS 依赖"));
    localFields.appendChild(depsLabel);
    gsPanel.appendChild(localFields);

    const gsBaseUrl = textInput("http://127.0.0.1:9880"); gsBaseUrl.id = "f-gs-baseurl";
    const gsTextLang = selectInput(["auto", "zh", "en", "ja", "yue", "ko"], "auto"); gsTextLang.id = "f-gs-textlang";
    gsPanel.appendChild(field("API 地址", gsBaseUrl));
    gsPanel.appendChild(field("文本语言 text_lang", gsTextLang));

    const gsVoicesWrap = document.createElement("div");
    gsVoicesWrap.id = "gs-voices";
    gsPanel.appendChild(gsVoicesWrap);
    step3.appendChild(gsPanel);

    providerSel.addEventListener("change", () => {
      aliyunPanel.classList.toggle("hidden", providerSel.value !== "aliyun");
      gsPanel.classList.toggle("hidden", providerSel.value !== "gpt-sovits");
    });
    modeSel.addEventListener("change", () => {
      cloudFields.classList.toggle("hidden", modeSel.value !== "cloud");
      localFields.classList.toggle("hidden", modeSel.value !== "local");
    });
    body.appendChild(step3);
  }

  function buildAgentLists() {
    const cloneWrap = $("#clone-agents");
    const gsVoices = $("#gs-voices");
    if (!cloneWrap || !gsVoices) return;
    cloneWrap.innerHTML = "";
    gsVoices.innerHTML = "";
    agents.forEach(({ id, label }) => {
      // aliyun 克隆多选
      const l = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.cloneId = id;
      l.appendChild(box);
      l.appendChild(document.createTextNode(label));
      cloneWrap.appendChild(l);

      // gpt-sovits 每角色配置
      const agentBlock = document.createElement("div");
      agentBlock.style.marginBottom = "6px";
      const head = document.createElement("label");
      head.style.cssText = "display:flex;align-items:center;gap:5px;cursor:pointer;";
      const enable = document.createElement("input");
      enable.type = "checkbox";
      enable.dataset.gsId = id;
      head.appendChild(enable);
      head.appendChild(document.createTextNode(label));
      agentBlock.appendChild(head);

      const cfg = document.createElement("div");
      cfg.className = "agent-config hidden";
      const ckpt = textInput(""); ckpt.dataset.gsField = `${id}:ckpt`;
      const pth = textInput(""); pth.dataset.gsField = `${id}:pth`;
      const ref = textInput(""); ref.dataset.gsField = `${id}:ref`;
      const ptext = textInput(""); ptext.dataset.gsField = `${id}:text`;
      cfg.appendChild(field("GPT 权重 .ckpt 路径", ckpt));
      cfg.appendChild(field("SoVITS 权重 .pth 路径", pth));
      cfg.appendChild(field("示例音频 ref_audio_path", ref));
      cfg.appendChild(field("示例音频文字内容 prompt_text", ptext));
      agentBlock.appendChild(cfg);
      enable.addEventListener("change", () => cfg.classList.toggle("hidden", !enable.checked));
      gsVoices.appendChild(agentBlock);
    });
  }

  function renderCloneStatus() {
    const div = $("#clone-status");
    if (!div) return;
    div.innerHTML = "";
    for (const [id, info] of cloneStatus) {
      const agent = agents.find((a) => a.id === id);
      const row = document.createElement("div");
      row.className = "clone-status " + info.status;
      const label = agent ? agent.label : id;
      row.textContent = info.status === "done"
        ? `✓ ${label}${info.message ? "：" + info.message : ""}`
        : info.status === "failed"
          ? `✗ ${label}${info.message ? "：" + info.message : ""}`
          : `正在克隆 ${label}…`;
      div.appendChild(row);
    }
  }

  function log(line) {
    logEl.textContent += line + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ── 提交 ──────────────────────────────────────
  function submit() {
    if (submitting) return;
    submitting = true;
    $("#setup-submit").disabled = true;

    const form = {
      language: $("#f-lang").value,
      apiBaseUrl: $("#f-baseurl").value.trim(),
      apiKey: $("#f-apikey").value.trim(),
      model: $("#f-model").value.trim(),
      pythonPath: $("#f-python").value.trim(),
      ttsProvider: $("#f-provider").value,
      ttsApiKey: $("#f-ttskey").value.trim(),
      cloneAgents: [...document.querySelectorAll("#clone-agents input[data-clone-id]:checked")].map((el) => el.dataset.cloneId),
      gptSovits: {
        mode: $("#f-gs-mode").value,
        apiKey: $("#f-gs-key").value.trim(),
        apiScriptPath: $("#f-gs-script").value.trim(),
        pythonPath: $("#f-gs-py").value.trim(),
        device: $("#f-gs-device").value,
        bertPath: $("#f-gs-bert").value.trim(),
        cnhubertPath: $("#f-gs-hubert").value.trim(),
        baseUrl: $("#f-gs-baseurl").value.trim(),
        textLang: $("#f-gs-textlang").value,
        modelVersion: $("#f-gs-version").value,
        installDeps: $("#f-gs-deps").checked,
        voices: {},
      },
    };
    document.querySelectorAll("#gs-voices input[data-gs-id]:checked").forEach((enable) => {
      const id = enable.dataset.gsId;
      const get = (f) => document.querySelector(`#gs-voices input[data-gs-field="${id}:${f}"]`)?.value.trim() || "";
      form.gptSovits.voices[id] = {
        gptWeightsPath: get("ckpt"),
        sovitsWeightsPath: get("pth"),
        refAudioPath: get("ref"),
        promptText: get("text"),
      };
    });

    log("正在配置…");
    api.send({ type: "setup_submit", form });
  }

  $("#setup-submit").addEventListener("click", submit);
  $("#setup-cancel").addEventListener("click", () => api.send({ type: "exit" }));

  build();

  // ── 协议事件（app.js default 分支转发）─────────
  window.SetupUI = {
    handle(msg) {
      switch (msg.type) {
        case "setup_info":
          agents = msg.agents;
          buildAgentLists();
          break;
        case "setup_log":
          log(msg.line);
          break;
        case "setup_clone_progress":
          cloneStatus.set(msg.agent, { status: msg.status, message: msg.message });
          renderCloneStatus();
          break;
        case "setup_done":
          log("配置完成，正在启动 ARONA…");
          break;
      }
    },
  };
})();
