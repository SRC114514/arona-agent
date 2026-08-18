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
import { AGENT_IDS, getAgentLabel } from "./agent_registry.ts";
import { VOICE_AUDIO, cloneVoice, setVoiceId, getMissingAgents, hasVoice } from "./voices.ts";
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
  ttsEnabled?: boolean;
  sttEnabled?: boolean;
  /** @deprecated 已合并进 ttsEnabled，仅读兼容（旧配置 ttsAuto:false 仍生效） */
  ttsAuto?: boolean;
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
      "[demoMode] 已启用：跳过 settings.json 写入 + 跳过真实音色克隆调用。",
      "[demoMode] enabled: skip settings.json write + skip real voice cloning calls.",
    )));
    console.log(chalk.gray(t(`  [verbose] settings.json demoMode = ${JSON.stringify(existing.demoMode)} (类型 ${typeof existing.demoMode})`, `  [verbose] settings.json demoMode = ${JSON.stringify(existing.demoMode)} (type ${typeof existing.demoMode})`)));
    console.log(chalk.gray(t(`  [verbose] Step 3 将执行: pip3.13 install -r "${join(PROJECT_ROOT, "requirements.txt")}" -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple`, `  [verbose] Step 3 will run: pip3.13 install -r "${join(PROJECT_ROOT, "requirements.txt")}" -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple`)));
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

  // Ctrl+C（SIGINT）强制退出：不保存任何配置，需重新运行 arona setup 填写。
  // 不监听会走 readline 默认清行继续，最后把半成品写进 settings.json（历史踩坑）。
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

    if (demoMode) {
      // demoMode: skip the real python/voice_clone.py call entirely. Wait 4s
      // and emit a synthetic success so the user can showcase the full flow.
      await new Promise((r) => setTimeout(r, 4000));
      const demoVoice = `demo-voice-${Date.now()}`;
      console.log(
        chalk.green(
          verbose
            ? t(`  ✓ 音色克隆成功（voice_id: ${demoVoice}）`, `  ✓ Voice cloning succeeded (voice_id: ${demoVoice})`)
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
        console.log(chalk.gray(t(`  运行 ${pythonPath} -m pip install dashscope -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple 后重新执行 arona setup。`, `  Run ${pythonPath} -m pip install dashscope -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple and re-run arona setup.`)));
      }

      if (dashscopeOk) {
        // 关闭 readline，让多选 TUI 独占 stdin raw mode（此后不再用 rl.question）。
        rl.close();

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
            t("选择要克隆音色的角色", "Select characters to clone voices"),
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
        ttsEnabled: existing.ttsEnabled ?? existing.ttsAuto ?? true, // ttsAuto 已合并，旧配置兼容
        sttEnabled: existing.sttEnabled ?? true,
        workspaceId: existing.workspaceId || "",
        ttsApiKey: ttsApiKey,
        ttsModel: existing.ttsModel || "qwen-audio-3.0-tts-plus",
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
