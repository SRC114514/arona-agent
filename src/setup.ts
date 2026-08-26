import * as readline from "readline";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import {
  ARONA_DIR,
  SETTINGS_FILE,
  PROJECT_ROOT,
  resolveModelPrefix,
  type TtsProvider,
} from "./config.ts";
import { AGENT_IDS, getAgentLabel, type AgentId } from "./agent_registry.ts";
import { VOICE_AUDIO, cloneVoice, setVoiceId, getMissingAgents, hasVoice, getGptSovitsVoice, setGptSovitsVoice, deleteGptSovitsVoice } from "./voices.ts";
import { normalizeGptSovitsConfig } from "./tts_provider.ts";
import { installGptSovitsDeps } from "./gpt_sovits_local.ts";
import { multiSelect } from "./tui_select.ts";
import { t, getLang, setLang } from "./locale.ts";

interface Settings {
  apiKey?: string;
  apiBaseUrl?: string;
  model?: string;
  thinkingLevel?: string;
  language?: "auto" | "zh" | "en";
  /** 主 Agent（arona | plana）：setup 保存时保留，不能覆盖 /change-agent 的选择 */
  mainAgent?: string;
  /** 子 Agent 列表（见 agent_registry.ts）：setup 保存时保留，不能覆盖 /change-agent 的选择 */
  subAgents?: string[];
  ttsEnabled?: boolean;
  sttEnabled?: boolean;
  /** @deprecated 已合并进 ttsEnabled，仅读兼容（旧配置 ttsAuto:false 仍生效） */
  ttsAuto?: boolean;
  /** TTS 后端（aliyun | gpt-sovits） */
  ttsProvider?: string;
  /** 各 Provider 专属配置（键 = provider id） */
  ttsConfig?: Record<string, unknown>;
  workspaceId?: string;
  ttsApiKey?: string;
  ttsModel?: string;
  ttsSampleRate?: number;
  sttApiKey?: string;
  sttModel?: string;
  sttFormat?: string;
  sttSampleRate?: number;
  cuaApiKey?: string;
  pythonPath?: string;
  mcpServers?: Record<string, unknown>;
  /** 用户手动维护；setup 向导只读不写。true 时启用演示模式。 */
  demoMode?: boolean;
}

function loadExistingSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Check that Python is 3.12 or 3.13 (3.14+ not supported by cua).
 * Returns { ok, version } — version is the full version string.
 */
function checkPythonVersion(pythonPath: string): { ok: boolean; version: string } {
  try {
    const output = execSync(`${pythonPath} --version`, { stdio: "pipe" }).toString().trim();
    const match = output.match(/Python\s+(\d+)\.(\d+)\.(\d+)/);
    if (!match) return { ok: false, version: output || "unknown" };
    const major = parseInt(match[1]);
    const minor = parseInt(match[2]);
    const version = `${major}.${minor}.${match[3]}`;
    if (major === 3 && (minor === 12 || minor === 13)) {
      return { ok: true, version };
    }
    return { ok: false, version };
  } catch {
    return { ok: false, version: "not found" };
  }
}

async function main() {
  const verbose = process.argv.includes("--verbose");

  // Load existing settings first so we can detect demoMode and surface its
  // --verbose confirmation BEFORE any other output (banner, mkdir, etc.).
  const existing = loadExistingSettings();

  // demoMode: user-managed field, never written by the setup wizard itself.
  // Strict === true so any other value (missing / false / "true" / 1) = normal mode.
  // The activation notice + branch details only print under --verbose, so a
  // plain `arona setup` run stays clean even when demoMode is on.
  const demoMode = existing.demoMode === true;
  if (verbose && demoMode) {
    console.log(chalk.yellow(t(
      "[demoMode] 已启用：Step 4 仍显示 TUI 选择界面，但跳过真实音色克隆与 settings.json/voices.json 写入。",
      "[demoMode] enabled: Step 4 still shows the TUI, but skips real voice cloning and settings.json/voices.json writes.",
    )));
    console.log(chalk.gray(t(`  [verbose] settings.json demoMode = ${JSON.stringify(existing.demoMode)} (类型 ${typeof existing.demoMode})`, `  [verbose] settings.json demoMode = ${JSON.stringify(existing.demoMode)} (type ${typeof existing.demoMode})`)));
    console.log(chalk.gray(t(`  [verbose] Step 3 将执行: pip3.13 install -r "${join(PROJECT_ROOT, "requirements.txt")}" -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple`, `  [verbose] Step 3 will run: pip3.13 install -r "${join(PROJECT_ROOT, "requirements.txt")}" -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple`)));
    console.log(chalk.gray(t("  [verbose] Step 4 每个选中角色将模拟 5s 等待后显示成功，不调用 voice_clone.py、不写 voices.json", "  [verbose] Step 4 simulates a 5s wait per selected character then reports success, without calling voice_clone.py or writing voices.json")));
    console.log(chalk.gray(t(`  [verbose] 末尾将跳过写入: ${SETTINGS_FILE}`, `  [verbose] will skip writing at the end: ${SETTINGS_FILE}`)));
  }

  console.log(chalk.bold.cyan("\n=== ARONA Setup ===\n"));

  // Ensure ~/.arona/ exists
  if (!existsSync(ARONA_DIR)) mkdirSync(ARONA_DIR, { recursive: true });

  // ---- Python version check (must be 3.12 or 3.13) ----
  // 优先用 settings 里的 pythonPath；检查失败时静默回退到 "python"（Windows 端通常没有 python3 命令），
  // 回退成功后 settings.json 里的 pythonPath 会写为 "python"。两个都失败才报错。
  let pythonPath = existing.pythonPath || "python3";
  let pyCheck = checkPythonVersion(pythonPath);
  if (!pyCheck.ok) {
    // 静默吞掉报错输出，自动回退到 "python"（不加 "3"，兼容 Windows）
    pythonPath = "python";
    pyCheck = checkPythonVersion(pythonPath);
  }
  if (!pyCheck.ok) {
    const tried = `"${existing.pythonPath || "python3"}" 与 "python"`;
    if (pyCheck.version === "not found") {
      console.log(chalk.red(t(`\n✗ 未找到可用的 Python（已尝试 ${tried}）。`, `\n✗ No usable Python found (tried ${tried}).`)));
      console.log(chalk.cyan(t("  ARONA 需要 Python 3.12 或 3.13（不支持 3.14）。", "  ARONA requires Python 3.12 or 3.13 (3.14 is not supported).")));
      console.log(chalk.gray(t("  请安装 Python 后重新运行 arona setup。", "  Install Python and run arona setup again.")));
    } else {
      console.log(chalk.red(t(`\n✗ Python 版本不兼容：${pyCheck.version}`, `\n✗ Incompatible Python version: ${pyCheck.version}`)));
      console.log(chalk.cyan(t("  ARONA 需要 Python 3.12 或 3.13（不支持 3.14，因 pydantic-core 限制）。", "  ARONA requires Python 3.12 or 3.13 (3.14 not supported due to pydantic-core).")));
      console.log(chalk.gray(t("  请安装正确版本后重新运行 arona setup。", "  Install the correct version and run arona setup again.")));
    }
    process.exit(1);
  }
  console.log(chalk.gray(t(`Python ${pyCheck.version} ✓\n`, `Python ${pyCheck.version} ✓\n`)));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Ctrl+C（SIGINT）强制退出：不保存任何配置，需重新运行 arona setup 填写。
  rl.on("SIGINT", () => {
    console.log(chalk.yellow(t(
      "\n  已取消，配置未保存。请重新运行 arona setup。",
      "\n  Cancelled, configuration not saved. Re-run arona setup.",
    )));
    process.exit(130);
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer.trim()));
    });

  try {
    // ============================================================
    // Step 0: Language / 语言（显示检测结果，可手动指定，写回 settings）
    // ============================================================
    console.log(chalk.bold.cyan(t("\nStep 0: 语言 / Language\n", "\nStep 0: Language / 语言\n")));
    const detected = getLang();
    console.log(chalk.cyan(t(`  检测到系统语言：${detected === "en" ? "英文 (en)" : "中文 (zh)"}`, `  Detected system language: ${detected === "en" ? "English (en)" : "Chinese (zh)"}`)));
    const langInput = (await ask(t(
      "  语言选择 [auto/en/zh]（默认 auto=按系统）：",
      "  Language [auto/en/zh] (default auto = follow system): ",
    ))).toLowerCase();
    let langSetting: "auto" | "zh" | "en" = "auto";
    if (langInput === "en") { langSetting = "en"; setLang("en"); }
    else if (langInput === "zh") { langSetting = "zh"; setLang("zh"); }
    else if (langInput === "auto") { langSetting = "auto"; }
    else {
      // 空输入或其他值：保持自动（当前检测结果）
      langSetting = "auto";
    }
    console.log(chalk.gray(t(
      `  已选择：${langSetting === "en" ? "英文" : langSetting === "zh" ? "中文" : "自动（" + detected + "）"}\n`,
      `  Selected: ${langSetting === "en" ? "English" : langSetting === "zh" ? "Chinese" : "auto (" + detected + ")"}\n`,
    )));

    // ============================================================
    // Step 1: LLM Configuration
    // ============================================================
    console.log(chalk.bold.cyan("Step 1: LLM Configuration\n"));

    const existingBaseUrl = existing.apiBaseUrl || "";
    const baseUrlPrompt = existingBaseUrl
      ? `  Base URL [${existingBaseUrl}]: `
      : `  Base URL: `;
    const apiBaseUrl = await ask(baseUrlPrompt);

    const existingKey = existing.apiKey || "";
    const keyPrompt = existingKey
      ? `  API Key [*** (keep existing)]: `
      : `  API Key: `;
    const apiKeyInput = await ask(keyPrompt);
    const apiKey = apiKeyInput || existingKey;

    const existingModel = existing.model || "openai/gpt-4o";
    const modelInput = await ask(`  Model [${existingModel}]: `);
    const rawModel = modelInput || existingModel;
    const resolvedModel = resolveModelPrefix(rawModel, apiBaseUrl || existingBaseUrl);
    if (resolvedModel !== rawModel) {
      console.log(chalk.gray(`  → Resolved: ${resolvedModel}`));
    }

    // ============================================================
    // Step 2: 语音配置
    // ============================================================
    console.log(chalk.bold.cyan(t("\nStep 2: 语音配置\n", "\nStep 2: Voice Configuration\n")));
    console.log(chalk.cyan(t("  百炼 API Key（可选，用于TTS/STT）", "  Dashscope API Key (optional, for TTS/STT)")));
    console.log(chalk.cyan(t("  获取 API Key: https://help.aliyun.com/zh/model-studio/get-api-key\n", "  Get API Key: https://help.aliyun.com/zh/model-studio/get-api-key\n")));

    const existingTtsKey = existing.ttsApiKey || "";
    const ttsKeyPrompt = existingTtsKey
      ? t("  百炼 API Key [*** (keep existing)]: ", "  Bailian API Key [*** (keep existing, Enter=skip)]: ")
      : t("  百炼 API Key（可选）: ", "  Bailian API Key (optional): ");
    const ttsKeyInput = await ask(ttsKeyPrompt);
    const ttsApiKey = ttsKeyInput || existingTtsKey;

    console.log(chalk.bold.cyan(t("\n  TTS Provider 菜单\n", "\n  TTS Provider Menu\n")));
    const providerOptions = [
      { id: "aliyun", label: t("阿里云百炼（默认）", "Dashscope") },
      { id: "gpt-sovits", label: t("GPT-SoVITS", "GPT-SoVITS") },
    ];
    // 二选一使用 TUI 单选菜单（不要求键盘输入 1/2）
    rl.close();
    const providerSelected = await multiSelect(
      t("选择 TTS Provider", "Select TTS Provider"),
      providerOptions,
      new Set<string>([existing.ttsProvider === "gpt-sovits" ? "gpt-sovits" : "aliyun"]),
      t(
        "  ↑/↓ 切换 · 空格选中 · 回车确认 · Esc 取消",
        "  ↑/↓ move · Space select · Enter confirm · Esc cancel",
      ),
      true, // 单选
    );
    if (providerSelected === null) {
      console.log(chalk.yellow(t("  已取消，配置未保存。请重新运行 arona setup。", "  Cancelled, configuration not saved. Re-run arona setup.")));
      return;
    }
    let ttsProvider: TtsProvider = providerSelected.has("gpt-sovits") ? "gpt-sovits" : "aliyun";

    // GPT-SoVITS 专属配置（仅 provider=gpt-sovits 时收集；保存时保留其它 provider 键）
    let gptSovitsConfig = normalizeGptSovitsConfig(existing.ttsConfig?.["gpt-sovits"]);
    // 每角色音色已迁移到 voices.json#gpt-sovits：settings.json 不保存 voices（含空 {} 也不写）
    delete gptSovitsConfig.voices;
    if (ttsProvider === "gpt-sovits") {
      console.log(chalk.bold.cyan(t("\n  GPT-SoVITS 配置\n", "\n  GPT-SoVITS Configuration\n")));
      // readline 已在上方 TUI 前关闭；为后续 TUI 选择保持 stdin 空闲
      const deployOptions = [
        { id: "cloud", label: t("云端 API（远程服务）", "Cloud API (remote)") },
        { id: "local", label: t("本地模型", "Local model") },
      ];
      const deploySelected = await multiSelect(
        t("选择 GPT-SoVITS 部署方式", "Select GPT-SoVITS deployment mode"),
        deployOptions,
        new Set<string>([gptSovitsConfig.mode]),
        t(
          "  ↑/↓ 切换 · 空格选中 · 回车确认 · Esc 取消",
          "  ↑/↓ move · Space select · Enter confirm · Esc cancel",
        ),
        true, // 单选
      );
      if (deploySelected === null) {
        console.log(chalk.yellow(t("  已取消，配置未保存。请重新运行 arona setup。", "  Cancelled, configuration not saved. Re-run arona setup.")));
        return;
      }
      const mode = deploySelected.has("cloud") ? "cloud" : "local";
      gptSovitsConfig = { ...gptSovitsConfig, mode };

      // 本地部署：模型版本 TUI（v2 / v2 Pro / v3 / v4）
      if (mode === "local") {
        const versionOptions = [
          { id: "v2", label: "v2" },
          { id: "v2Pro", label: t("v2 Pro", "v2 Pro") },
          { id: "v3", label: "v3" },
          { id: "v4", label: "v4" },
        ];
        const versionSelected = await multiSelect(
          t("选择 GPT-SoVITS 模型版本", "Select GPT-SoVITS model version"),
          versionOptions,
          new Set<string>([gptSovitsConfig.modelVersion || "v2"]),
          t(
            "  ↑/↓ 切换 · 空格选中 · 回车确认 · Esc 取消",
            "  ↑/↓ move · Space select · Enter confirm · Esc cancel",
          ),
          true, // 单选
        );
        if (versionSelected === null) {
          console.log(chalk.yellow(t("  已取消，配置未保存。请重新运行 arona setup。", "  Cancelled, configuration not saved. Re-run arona setup.")));
          return;
        }
        const modelVersion = versionSelected.has("v2Pro")
          ? "v2Pro"
          : versionSelected.has("v3")
            ? "v3"
            : versionSelected.has("v4")
              ? "v4"
              : "v2";
        gptSovitsConfig = { ...gptSovitsConfig, modelVersion };
      }

      // 文本输入阶段
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl2.on("SIGINT", () => {
        console.log(chalk.yellow(t(
          "\n  已取消，配置未保存。请重新运行 arona setup。",
          "\n  Cancelled, configuration not saved. Re-run arona setup.",
        )));
        process.exit(130);
      });
      const ask2 = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
          rl2.question(prompt, (answer) => resolve(answer.trim()));
        });

      // 本地模型路径必填 + 存在性校验
      const askPath = async (prompt: string, current: string, label: string): Promise<string> => {
        for (;;) {
          const input = await ask2(prompt);
          const value = input.trim() || current || "";
          if (!value) {
            console.log(chalk.yellow(t(`  ${label} 不能为空。`, `  ${label} cannot be empty.`)));
            continue;
          }
          if (!existsSync(value)) {
            console.log(chalk.yellow(t(`  ⚠ ${label} 不存在，请重新输入：${value}`, `  ⚠ ${label} does not exist, please re-enter: ${value}`)));
            continue;
          }
          return value;
        }
      };

      let apiKey = gptSovitsConfig.apiKey || "";
      let apiScriptPath = gptSovitsConfig.apiScriptPath || "";
      let pythonPathLocal = gptSovitsConfig.pythonPath || "";
      let device = gptSovitsConfig.device || "cuda";
      let bertPath = gptSovitsConfig.bertPath || "";
      let cnhubertPath = gptSovitsConfig.cnhubertPath || "";

      if (mode === "cloud") {
        const apiKeyInput = await ask2(t(
          gptSovitsConfig.apiKey
            ? "  云端 API Key [*** (keep existing)]: "
            : "  云端 API Key（可选）: ",
          gptSovitsConfig.apiKey
            ? "  Cloud API Key [*** (keep existing)]: "
            : "  Cloud API Key (optional): ",
        ));
        apiKey = apiKeyInput || gptSovitsConfig.apiKey || "";
        // 云端模式不携带本地部署字段，避免切换后残留无意义路径。
        apiScriptPath = "";
        pythonPathLocal = "";
        device = "cuda";
        bertPath = "";
        cnhubertPath = "";
        gptSovitsConfig = { ...gptSovitsConfig, modelVersion: "v2" };
      } else {
        apiKey = ""; // 本地模式不使用云端鉴权 Key
        console.log(chalk.cyan(t(
          "  本地部署：请填写 GPT-SoVITS 本地模型路径。",
          "  Local deployment: enter the local model paths.",
        )));
        const apiScriptInput = await ask2(t(
          apiScriptPath
            ? `  api_v2.py 路径 [${apiScriptPath}]（留空=手动启动）: `
            : "  api_v2.py 路径（留空=手动启动）: ",
          apiScriptPath
            ? `  api_v2.py path [${apiScriptPath}] (empty = start manually): `
            : "  api_v2.py path (empty = start manually): ",
        ));
        apiScriptPath = apiScriptInput.trim() || apiScriptPath;
        if (apiScriptPath && !existsSync(apiScriptPath)) {
          console.log(chalk.yellow(t(`  ⚠ api_v2.py 路径不存在：${apiScriptPath}`, `  ⚠ api_v2.py path does not exist: ${apiScriptPath}`)));
        }
        const pythonInput = await ask2(t(
          `  GPT-SoVITS Python 路径 [${pythonPathLocal || pythonPath}]: `,
          `  GPT-SoVITS Python path [${pythonPathLocal || pythonPath}] (empty = use ARONA Python): `,
        ));
        pythonPathLocal = pythonInput.trim() || pythonPathLocal || pythonPath;
        const deviceInput = await ask2(t(
          `  推理设备 device [${device}]（cuda/cpu/mps）: `,
          `  Inference device [${device}] (cuda/cpu/mps): `,
        ));
        device = deviceInput.trim() || device;
        // 只有填写了 api_v2.py（自动启动本地服务）才需要共享预训练模型路径；
        // 每角色专属 .ckpt/.pth 在下方"选择角色后逐个配置"（单角色专属，不在此全局询问）。
        // 留空 = 用户手动启动服务，ARONA 只需 baseUrl + 每角色参考音频/权重，不必强制填模型路径。
        if (apiScriptPath) {
          // 指定了 api_v2.py（自动启动本地服务）→ 提示安装依赖（默认装）：
          // 优先 api_v2.py 同目录 requirements.txt，缺失用项目内置清单/兜底。
          const installDeps = (await ask2(t(
            "  是否安装 GPT-SoVITS 依赖？[Y/n] ",
            "  Install GPT-SoVITS dependencies? [Y/n] ",
          ))).trim().toLowerCase();
          if (installDeps !== "n") {
            const depResult = await installGptSovitsDeps(apiScriptPath, pythonPathLocal, gptSovitsConfig.modelVersion || "v2");
            if (depResult.ok) console.log(chalk.green(depResult.message));
            else console.log(chalk.yellow(depResult.message));
          }
          bertPath = await askPath(t(
            bertPath ? `  BERT 模型目录 [${bertPath}]: ` : "  BERT 模型目录（chinese-roberta-wwm-ext-large）: ",
            bertPath ? `  BERT model dir [${bertPath}]: ` : "  BERT model dir (chinese-roberta-wwm-ext-large): ",
          ), bertPath, t("BERT 模型路径", "BERT model path"));
          cnhubertPath = await askPath(t(
            cnhubertPath ? `  CNHubert 模型目录 [${cnhubertPath}]: ` : "  CNHubert 模型目录（chinese-hubert-base）: ",
            cnhubertPath ? `  CNHubert model dir [${cnhubertPath}]: ` : "  CNHubert model dir (chinese-hubert-base): ",
          ), cnhubertPath, t("CNHubert 模型路径", "CNHubert model path"));
        }
      }

      const baseUrlInput = await ask2(t(
        `  API 地址 [${gptSovitsConfig.baseUrl}]: `,
        `  API baseUrl [${gptSovitsConfig.baseUrl}]: `,
      ));
      const baseUrl = baseUrlInput.trim() || gptSovitsConfig.baseUrl;
      const textLangInput = await ask2(t(
        `  文本语言 text_lang [${gptSovitsConfig.textLang}]（auto/zh/en/ja/yue/ko）: `,
        `  text_lang [${gptSovitsConfig.textLang}] (auto/zh/en/ja/yue/ko): `,
      ));
      const textLang = textLangInput.trim() || gptSovitsConfig.textLang;
      // prompt_lang 不再全局询问：按每角色参考音频文字内容自动判断（走默认素材固定 zh，见 tts_provider.detectPromptLang）
      gptSovitsConfig = {
        ...gptSovitsConfig,
        mode,
        apiKey,
        apiScriptPath,
        pythonPath: pythonPathLocal,
        device,
        bertPath,
        cnhubertPath,
        baseUrl,
        textLang,
      };
      rl2.close();

      // 多选要配置音色的角色：全部可编辑（已配置者默认 [*]，取消勾选 = 删除该角色配置）
      const configured = AGENT_IDS.filter((id) => getGptSovitsVoice(id));
      const options = AGENT_IDS.map((id) => ({ id, label: getAgentLabel(id), locked: false }));
      const selected = await multiSelect(
        t("选择要配置 GPT-SoVITS 音色的角色", "Select characters to configure GPT-SoVITS voices"),
        options,
        new Set<string>(configured),
        t(
          "  ↑/↓ 切换 · 空格选中 [*] · 回车继续 · Esc 取消",
          "  ↑/↓ move · Space select [*] · Enter continue · Esc cancel",
        ),
      );
      if (selected === null) {
        console.log(chalk.yellow(t("  已取消，配置未保存。请重新运行 arona setup。", "  Cancelled, configuration not saved. Re-run arona setup.")));
        return;
      }

      // TUI 已独占 stdin raw mode 并 pause；为后续逐角色提问重建 readline
      const rl3 = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl3.on("SIGINT", () => {
        console.log(chalk.yellow(t(
          "\n  已取消，配置未保存。请重新运行 arona setup。",
          "\n  Cancelled, configuration not saved. Re-run arona setup.",
        )));
        process.exit(130);
      });
      const ask3 = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
          rl3.question(prompt, (answer) => resolve(answer.trim()));
        });

      for (const id of AGENT_IDS) {
        if (!selected.has(id)) continue;
        const prev = getGptSovitsVoice(id) || {};
        console.log(chalk.bold.cyan(t(`\n  ${getAgentLabel(id)} 音色配置\n`, `\n  ${getAgentLabel(id)} voice config\n`)));
        const prevCkpt = prev.gptWeightsPath || "";
        const ckpt = (await ask3(t(
          prevCkpt
            ? `    GPT 权重 .ckpt 路径 [${prevCkpt}]: `
            : "    GPT 权重 .ckpt 路径 [不切换]: ",
          prevCkpt
            ? `    GPT weights .ckpt path [${prevCkpt}]: `
            : "    GPT weights .ckpt path [no switch]: ",
        ))).trim() || prevCkpt;
        const prevPth = prev.sovitsWeightsPath || "";
        const pth = (await ask3(t(
          prevPth
            ? `    SoVITS 权重 .pth 路径 [${prevPth}]: `
            : "    SoVITS 权重 .pth 路径 [不切换]: ",
          prevPth
            ? `    SoVITS weights .pth path [${prevPth}]: `
            : "    SoVITS weights .pth path [no switch]: ",
        ))).trim() || prevPth;
        const prevRef = prev.refAudioPath || "";
        // cloud 模式 ref 必填（无 ref 则该角色 isTtsEnabledFor=false 静音且无解释）；循环重询直至非空
        let ref = prevRef;
        for (;;) {
          const refInput = (await ask3(t(
            prevRef
              ? `    示例音频 ref_audio_path [${prevRef}]: `
              : mode === "cloud"
                ? "    示例音频 ref_audio_path [必填，本地路径(自动上传OSS)或URL]: "
                : "    示例音频 ref_audio_path [assets/blue-archive/<id>/voice.mp3]: ",
            prevRef
              ? `    Reference audio ref_audio_path [${prevRef}]: `
              : mode === "cloud"
                ? "    Reference audio ref_audio_path [required, local path (auto-upload OSS) or URL]: "
                : "    Reference audio ref_audio_path [assets/blue-archive/<id>/voice.mp3]: ",
          ))).trim();
          if (refInput) { ref = refInput; break; }
          if (prevRef) break;
          if (mode !== "cloud") break;
          console.log(chalk.yellow(t(
            `    ref_audio_path 不能为空（云端模式必填）。`,
            `    ref_audio_path cannot be empty (required in cloud mode).`,
          )));
        }
        const prevText = prev.promptText || "";
        const refText = (await ask3(t(
          prevText
            ? `    示例音频文字内容 prompt_text [${prevText}]: `
            : mode === "cloud"
              ? "    示例音频文字内容 prompt_text [必填，文字/本地txt路径/URL]（语言自动判断）: "
              : "    示例音频文字内容 prompt_text [文字/本地txt路径/URL，缺省用 voice_text.txt]（语言自动判断）: ",
          prevText
            ? `    Reference audio text prompt_text [${prevText}]: `
            : mode === "cloud"
              ? "    Reference audio text prompt_text [required, text/local txt path/URL] (lang auto-detected): "
              : "    Reference audio text prompt_text [text/local txt path/URL, default voice_text.txt] (lang auto-detected): ",
        ))).trim() || prevText;
        // 每角色音色写 voices.json#gpt-sovits（与百炼 voice_id 共存，不写 settings.json）
        setGptSovitsVoice(id, { gptWeightsPath: ckpt, sovitsWeightsPath: pth, refAudioPath: ref, promptText: refText });
      }
      // 未勾选的原已配置角色 → 删除其配置（幂等）
      for (const id of AGENT_IDS) {
        if (configured.includes(id) && !selected.has(id)) deleteGptSovitsVoice(id);
      }
      rl3.close();
    }

    // ============================================================
    // Step 3: Install Python Dependencies
    // ============================================================
    console.log(chalk.bold.cyan("\nStep 3: Install Python Dependencies\n"));

    const requirementsFile = join(PROJECT_ROOT, "requirements.txt");
    const pipCmd = demoMode
      ? `pip3.13 install -r "${requirementsFile}" -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple`
      : `${pythonPath} -m pip install -r "${requirementsFile}" -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple`;
    let depsOk = false;
    try {
      execSync(pipCmd, { stdio: "inherit" });
      console.log(chalk.green(t("\n  ✓ Python 依赖安装完成", "\n  ✓ Python dependencies installed")));
      depsOk = true;
    } catch {
      console.log(chalk.red(t("\n  ✗ Python 依赖安装失败", "\n  ✗ Failed to install Python dependencies")));
      console.log(chalk.gray(t(`  请手动运行: ${pipCmd}`, `  Please run manually: ${pipCmd}`)));
    }

    // ============================================================
    // Step 4: Voice Cloning（多角色多选）
    // ============================================================
    console.log(chalk.bold.cyan("\nStep 4: Voice Cloning\n"));

    if (ttsProvider !== "aliyun") {
      console.log(chalk.cyan(t("跳过百炼音色克隆。", "Skipping Bailian voice cloning.")));
      console.log(chalk.gray(
        gptSovitsConfig.mode === "cloud"
          ? t("音色已配置。", "Voices were configured.")
          : t("音色已配置。", "Voices were configured."),
      ));
    } else if (!demoMode && !ttsApiKey) {
      console.log(chalk.yellow(t("  跳过音色克隆：未提供百炼 API Key。", "  Skipping voice cloning: no Bailian API Key provided.")));
      console.log(chalk.gray(t("  重新运行 arona setup 并填写百炼 API Key 以配置音色。", "  Re-run arona setup and fill in the Bailian API Key to configure the voice.")));
    } else if (!demoMode && !depsOk) {
      console.log(chalk.yellow(t("  跳过音色克隆：Python 依赖未安装成功。", "  Skipping voice cloning: Python dependencies were not installed successfully.")));
      console.log(chalk.gray(t("  请先解决依赖安装问题，再重新运行 arona setup。", "  Resolve the dependency installation issue, then re-run arona setup.")));
    } else {
      // 非 demoMode 才检查 dashscope；demoMode 直接进入 TUI 并模拟克隆。
      let dashscopeOk = demoMode;
      if (!demoMode) {
        // Check dashscope package (safety fallback even after pip install)
        try {
          execSync(`${pythonPath} -c "import dashscope"`, { stdio: "pipe" });
          dashscopeOk = true;
        } catch {
          console.log(chalk.yellow(t("  dashscope 包仍不可用。跳过音色克隆。", "  The dashscope package is still unavailable. Skipping voice cloning.")));
          console.log(chalk.gray(t(`  运行 ${pythonPath} -m pip install dashscope -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple 后重新执行 arona setup。`, `  Run ${pythonPath} -m pip install dashscope -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple and re-run arona setup.`)));
        }
      }

      if (dashscopeOk) {
        // 多选 TUI 独占 stdin raw mode（此后不再用 rl.question；rl 已在 TTS Provider TUI 前关闭）。

        // 已有音色的角色锁定 [*]（迁移已在模块加载时完成，此处读到的 voices.json 已是新格式）。
        const missing = getMissingAgents();
        if (missing.length === 0) {
          console.log(chalk.green(t(
            "  所有角色已有音色，无需克隆。如需重新克隆请运行 arona voice add <角色名>。",
            "  All characters already have voices. Use `arona voice add <name>` to re-clone.",
          )));
        } else {
          const options = AGENT_IDS.map((id) => ({
            id,
            label: hasVoice(id) ? `${getAgentLabel(id)}${t("（已克隆）", " (cloned)")}` : getAgentLabel(id),
            locked: hasVoice(id),
          }));
          const selected = await multiSelect(
            t("选择要克隆音色的角色", "Select characters to clone voices."),
            options,
            new Set<string>(), // 已有音色者 locked 强制 [*]，未克隆者默认 [ ]
            t(
              "  ↑/↓ 切换 · 空格选中 [*] · 回车克隆 · Esc 取消",
              "  ↑/↓ move · Space select [*] · Enter clone · Esc cancel",
            ),
          );

          if (selected === null) {
            // Esc / Ctrl+C：放弃整个 setup，不保存配置（半成品配置不能覆写 settings.json）
            console.log(chalk.yellow(t(
              "  已取消，配置未保存。请重新运行 arona setup。",
              "  Cancelled, configuration not saved. Re-run arona setup.",
            )));
            return;
          } else if (selected.size === 0) {
            console.log(chalk.cyan(t("  未选择任何角色，跳过音色克隆（TTS 将保持静音）。", "  No character selected, skipping voice cloning (TTS stays muted).")));
          } else {
            const model = existing.ttsModel || "qwen-audio-3.0-tts-plus";
            for (const id of AGENT_IDS) {
              if (!selected.has(id)) continue;
              const voiceMp3 = VOICE_AUDIO[id];
              if (!existsSync(voiceMp3)) {
                console.log(chalk.yellow(t(`  未找到音色文件（${voiceMp3}），跳过 ${getAgentLabel(id)}。`, `  Voice file not found (${voiceMp3}), skipping ${getAgentLabel(id)}.`)));
                continue;
              }
              if (demoMode) {
                // 演示模式：不调用 voice_clone.py、不写 voices.json，静默 5s 后显示成功。
                console.log(chalk.cyan(t(`  正在克隆 ${getAgentLabel(id)} 的音色...`, `Cloning voice for ${getAgentLabel(id)}...`)));
                await new Promise((r) => setTimeout(r, 5000));
                console.log(chalk.green(t(`  ✓ ${getAgentLabel(id)} 音色克隆成功`, `  ✓ ${getAgentLabel(id)} voice cloned.`)));
                continue;
              }
              console.log(chalk.cyan(t(`  正在克隆 ${getAgentLabel(id)} 的音色（可能需要 1-2 分钟）...`, `  Cloning ${getAgentLabel(id)}'s voice (may take 1-2 minutes)...`)));
              try {
                const voiceId = await cloneVoice(id, ttsApiKey, model);
                setVoiceId(id, voiceId);
                if (verbose) {
                  console.log(chalk.green(t(`  ✓ ${getAgentLabel(id)} 音色克隆成功（voice_id: ${voiceId}）`, `  ✓ ${getAgentLabel(id)} voice cloned (voice_id: ${voiceId})`)));
                } else {
                  console.log(chalk.green(t(`  ✓ ${getAgentLabel(id)} 音色克隆成功`, `  ✓ ${getAgentLabel(id)} voice cloned`)));
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.log(chalk.red(t(`  ✗ ${getAgentLabel(id)} 音色克隆失败：${msg}`, `  ✗ ${getAgentLabel(id)} voice cloning failed: ${msg}`)));
                console.log(chalk.gray(t("  稍后可运行 arona voice add 重试。", "  You can run `arona voice add` later to retry.")));
              }
            }
          }
        }
      }
    }

    // ============================================================
    // Save settings
    // ============================================================
    // demoMode: never write to settings.json. The user owns this field
    // by direct file edit; the wizard only reads it.
    if (!demoMode) {
      const settings: Settings = {
        apiKey: apiKey,
        apiBaseUrl: apiBaseUrl || existingBaseUrl,
        model: resolvedModel,
        thinkingLevel: existing.thinkingLevel || "medium",
        language: langSetting,
        mainAgent: existing.mainAgent || "arona", // 保留 /change-agent 的选择，勿覆盖
        subAgents: existing.subAgents || [], // 保留 /change-agent 的多选，勿覆盖
        ttsEnabled: existing.ttsEnabled ?? existing.ttsAuto ?? true, // ttsAuto 已合并，旧配置兼容
        sttEnabled: existing.sttEnabled ?? true,
        ttsProvider: ttsProvider,
        ttsConfig: {
          ...(existing.ttsConfig || {}),
          ...(ttsProvider === "gpt-sovits" ? { "gpt-sovits": gptSovitsConfig } : {}),
        },
        workspaceId: existing.workspaceId || "",
        ttsApiKey: ttsApiKey,
        ttsModel: existing.ttsModel || "qwen-audio-3.0-tts-plus",
        ttsSampleRate: existing.ttsSampleRate || 22050,
        sttApiKey: ttsApiKey, // 百炼 Key：provider=aliyun 时 TTS+STT；provider=gpt-sovits 时仅 STT
        sttModel: existing.sttModel || "qwen-audio-3.0-asr-flash-streaming",
        sttFormat: existing.sttFormat || "pcm",
        sttSampleRate: existing.sttSampleRate || 16000,
        cuaApiKey: existing.cuaApiKey || "",
        pythonPath: pythonPath,
        mcpServers: existing.mcpServers || {},
        autoLoadSkills: existing.autoLoadSkills ?? true, // 保留手写参数，勿覆盖
      };

      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");

      console.log(chalk.green(t(`\n✓ 配置已保存到 ${SETTINGS_FILE}`, `\n✓ Configuration saved to ${SETTINGS_FILE}`)));
    }
    if (process.env.ARONA_AUTO_SETUP === "1") {
      // 首次运行自动引导（index.ts spawn 传入）：配置完成后主进程直接续跑 REPL
      console.log(chalk.cyan(t("  配置完成，正在启动 ARONA...\n", "  Configuration saved. Starting ARONA...\n")));
    } else {
      console.log(chalk.cyan(t("  运行 arona 启动 Agent。\n", "  Run arona to start the Agent.\n")));
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(chalk.red(t(`Setup error: ${err instanceof Error ? err.message : err}`, `Setup error: ${err instanceof Error ? err.message : err}`)));
  process.exit(1);
});
