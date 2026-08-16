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
} from "./config.ts";
import { runPython } from "./utils/python.ts";
import { t, getLang, setLang } from "./locale.ts";

interface Settings {
  apiKey?: string;
  apiBaseUrl?: string;
  model?: string;
  thinkingLevel?: string;
  language?: "auto" | "zh" | "en";
  ttsEnabled?: boolean;
  sttEnabled?: boolean;
  ttsAuto?: boolean;
  workspaceId?: string;
  ttsApiKey?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: string;
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
      "[demoMode] 已启用：跳过 settings.json 写入 + 跳过真实音色克隆调用。",
      "[demoMode] enabled: skip settings.json write + skip real voice cloning calls.",
    )));
    console.log(chalk.gray(t(`  [verbose] settings.json demoMode = ${JSON.stringify(existing.demoMode)} (类型 ${typeof existing.demoMode})`, `  [verbose] settings.json demoMode = ${JSON.stringify(existing.demoMode)} (type ${typeof existing.demoMode})`)));
    console.log(chalk.gray(t(`  [verbose] Step 3 将执行: pip3.13 install -r "${join(PROJECT_ROOT, "requirements.txt")}"`, `  [verbose] Step 3 will run: pip3.13 install -r "${join(PROJECT_ROOT, "requirements.txt")}"`)));
    console.log(chalk.gray(t("  [verbose] Step 4 将模拟 4s 等待并生成占位 voice_id，不调用 voice_clone.py", "  [verbose] Step 4 will simulate a 4s wait and produce a placeholder voice_id, without calling voice_clone.py")));
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
    // Step 2: 阿里云百炼 (TTS/STT) API Key
    // ============================================================
    console.log(chalk.bold.cyan(t("\nStep 2: 阿里云百炼 (TTS/STT) Configuration\n", "\nStep 2: Alibaba Cloud Bailian (TTS/STT) Configuration\n")));
    console.log(chalk.cyan(t("  阿里云有免费额度，请放心使用。", "  Alibaba Cloud offers a free quota, feel free to use it.")));
    console.log(chalk.cyan(t("  获取 API Key: https://help.aliyun.com/zh/model-studio/get-api-key\n", "  Get API Key: https://help.aliyun.com/zh/model-studio/get-api-key\n")));

    const existingTtsKey = existing.ttsApiKey || "";
    const ttsKeyPrompt = existingTtsKey
      ? t("  百炼 API Key [*** (keep existing)]: ", "  Bailian API Key [*** (keep existing)]: ")
      : t("  百炼 API Key: ", "  Bailian API Key: ");
    const ttsKeyInput = await ask(ttsKeyPrompt);
    const ttsApiKey = ttsKeyInput || existingTtsKey;

    // ============================================================
    // Step 3: Install Python Dependencies
    // ============================================================
    console.log(chalk.bold.cyan("\nStep 3: Install Python Dependencies\n"));

    const requirementsFile = join(PROJECT_ROOT, "requirements.txt");
    const pipCmd = demoMode
      ? `pip3.13 install -r "${requirementsFile}"`
      : `${pythonPath} -m pip install -r "${requirementsFile}"`;
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
    // Step 4: Automatic Voice Cloning
    // ============================================================
    console.log(chalk.bold.cyan("\nStep 4: Voice Cloning\n"));

    let ttsVoice = existing.ttsVoice || "";

    if (demoMode) {
      // demoMode: skip the real python/voice_clone.py call entirely. Wait 4s
      // and emit a synthetic success so the user can showcase the full flow.
      await new Promise((r) => setTimeout(r, 4000));
      ttsVoice = `demo-voice-${Date.now()}`;
      console.log(
        chalk.green(
          verbose
            ? t(`  ✓ 音色克隆成功（voice_id: ${ttsVoice}）`, `  ✓ Voice cloning succeeded (voice_id: ${ttsVoice})`)
            : t("  ✓ 音色克隆成功", "  ✓ Voice cloning succeeded"),
        ),
      );
    } else if (!ttsApiKey) {
      console.log(chalk.yellow(t("  跳过音色克隆：未提供百炼 API Key。", "  Skipping voice cloning: no Bailian API Key provided.")));
      console.log(chalk.gray(t("  重新运行 arona setup 并填写百炼 API Key 以配置音色。", "  Re-run arona setup and fill in the Bailian API Key to configure the voice.")));
    } else if (!depsOk) {
      console.log(chalk.yellow(t("  跳过音色克隆：Python 依赖未安装成功。", "  Skipping voice cloning: Python dependencies were not installed successfully.")));
      console.log(chalk.gray(t("  请先解决依赖安装问题，再重新运行 arona setup。", "  Resolve the dependency installation issue, then re-run arona setup.")));
    } else {
      // Check dashscope package (safety fallback even after pip install)
      let dashscopeOk = false;
      try {
        execSync(`${pythonPath} -c "import dashscope"`, { stdio: "pipe" });
        dashscopeOk = true;
      } catch {
        console.log(chalk.yellow(t("  dashscope 包仍不可用。跳过音色克隆。", "  The dashscope package is still unavailable. Skipping voice cloning.")));
        console.log(chalk.gray(t(`  运行 ${pythonPath} -m pip install dashscope 后重新执行 arona setup。`, `  Run ${pythonPath} -m pip install dashscope and re-run arona setup.`)));
      }

      if (dashscopeOk) {
        const voiceMp3 = join(PROJECT_ROOT, "assets", "blue-archive", "voice.mp3");
        if (!existsSync(voiceMp3)) {
          console.log(chalk.yellow(t(`  未找到 voice.mp3（${voiceMp3}）。跳过音色克隆。`, `  voice.mp3 not found (${voiceMp3}). Skipping voice cloning.`)));
        } else {
          console.log(chalk.cyan(t("  正在克隆音色（可能需要 1-2 分钟）...", "  Cloning voice (may take 1-2 minutes)...")));

          try {
            const result = await runPython(
              "voice_clone.py",
              [],
              undefined,
              {
                QWEN_TTS_API_KEY: ttsApiKey,
                QWEN_TTS_MODEL: existing.ttsModel || "qwen-audio-3.0-tts-plus",
                ARONA_VOICE_AUDIO: voiceMp3,
                ARONA_VOICE_PREFIX: "arona",
              },
              300000, // 5 min timeout
            );

            const parsed = JSON.parse(result);
            if (parsed.voice_id) {
              ttsVoice = parsed.voice_id;
              if (verbose) {
                console.log(chalk.green(t(`  ✓ 音色克隆成功（voice_id: ${ttsVoice}）`, `  ✓ Voice cloning succeeded (voice_id: ${ttsVoice})`)));
              } else {
                console.log(chalk.green(t("  ✓ 音色克隆成功", "  ✓ Voice cloning succeeded")));
              }
            } else if (parsed.error) {
              console.log(chalk.red(t(`  ✗ 音色克隆失败：${parsed.error}`, `  ✗ Voice cloning failed: ${parsed.error}`)));
              console.log(chalk.gray(t("  稍后可重新运行 arona setup 重试。", "  You can re-run arona setup later to retry.")));
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.red(t(`  ✗ 音色克隆失败：${msg}`, `  ✗ Voice cloning failed: ${msg}`)));
            console.log(chalk.gray(t("  稍后可重新运行 arona setup 重试。", "  You can re-run arona setup later to retry.")));
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
        ttsEnabled: existing.ttsEnabled ?? true,
        sttEnabled: existing.sttEnabled ?? true,
        ttsAuto: existing.ttsAuto ?? true,
        workspaceId: existing.workspaceId || "",
        ttsApiKey: ttsApiKey,
        ttsModel: existing.ttsModel || "qwen-audio-3.0-tts-plus",
        ttsVoice: ttsVoice,
        ttsFormat: existing.ttsFormat || "mp3",
        ttsSampleRate: existing.ttsSampleRate || 22050,
        sttApiKey: ttsApiKey, // Same key for TTS and STT
        sttModel: existing.sttModel || "qwen-audio-3.0-asr-flash-streaming",
        sttFormat: existing.sttFormat || "pcm",
        sttSampleRate: existing.sttSampleRate || 16000,
        cuaApiKey: existing.cuaApiKey || "",
        pythonPath: pythonPath,
        mcpServers: existing.mcpServers || {},
      };

      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");

      console.log(chalk.green(t(`\n✓ 配置已保存到 ${SETTINGS_FILE}`, `\n✓ Configuration saved to ${SETTINGS_FILE}`)));
    }
    console.log(chalk.cyan(t("  运行 arona 启动 Agent。\n", "  Run arona to start the Agent.\n")));
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(chalk.red(t(`Setup error: ${err instanceof Error ? err.message : err}`, `Setup error: ${err instanceof Error ? err.message : err}`)));
  process.exit(1);
});
