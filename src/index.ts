import { spawn } from "node:child_process";
import { join } from "node:path";
import { initAgent } from "./agent.ts";
import { Repl } from "./repl.ts";
import { resetConversationFlag, loadSession } from "./memory.ts";
import { startPet } from "./pet.ts";
import { config, settingsExist, reloadConfig, PROJECT_ROOT } from "./config.ts";
import { preloadGptSovitsLocal } from "./tts_provider.ts";
import { syncSkillsFromAgentsDir } from "./skills.ts";
import { t, refreshLanguage } from "./locale.ts";
import chalk from "chalk";

/**
 * 首次运行引导：以子进程拉起 setup 向导（stdio inherit 复用当前终端交互）。
 * 传 ARONA_AUTO_SETUP=1 让向导末尾提示"正在启动"而非"运行 arona"。setup 在
 * 独立进程写 settings.json，主进程随后 reloadConfig 即可（ESM 缓存无法重建单例）。
 */
function runSetupWizard(): Promise<number> {
  const tsxBin = process.platform === "win32"
    ? join(PROJECT_ROOT, "node_modules", ".bin", "tsx.cmd")
    : join(PROJECT_ROOT, "node_modules", ".bin", "tsx");
  return new Promise((resolve) => {
    const child = spawn(tsxBin, [join(PROJECT_ROOT, "src", "setup.ts"), ...process.argv.slice(2)], {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ARONA_AUTO_SETUP: "1" },
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

async function main() {
  // 首次运行引导：无 settings.json 时直接进入 setup 向导，配置完成后继续 REPL
  if (!settingsExist()) {
    console.log(chalk.yellow(t("未找到配置文件，正在进入初始化向导…", "Config file not found. Starting the setup wizard…")));
    const setupCode = await runSetupWizard();
    if (setupCode !== 0) {
      console.log(chalk.yellow(t("初始化已中止，配置未保存。", "Setup aborted, configuration not saved.")));
      process.exit(setupCode);
    }
    if (!settingsExist()) {
      console.log(chalk.yellow(t("配置未保存，无法启动。请重新运行 arona 完成初始化。", "Configuration was not saved. Re-run arona to initialize.")));
      process.exit(1);
    }
    // setup 在子进程内写配置：就地刷新 config 单例与 UI 语言后继续
    reloadConfig();
    refreshLanguage();
  }

  if (!config.apiKey) {
    console.log(chalk.yellow(t("警告：未找到 LLM API Key，请运行 arona setup 配置。", "Warning: LLM API Key not found. Run `arona setup` to configure.")));
  }

  if (config.noVoice) {
    console.log(chalk.cyan(t("语音功能已禁用（--no-voice）。", "Voice features disabled (--no-voice).")));
  }

  // 补全缺失 Skill（仅补缺，不覆盖用户定制）；autoLoadSkills=false 时跳过
  if (config.autoLoadSkills) {
    const synced = syncSkillsFromAgentsDir();
    if (synced > 0) {
      console.log(chalk.cyan(t(`已同步 ${synced} 个 Skill`, `Synced ${synced} skill(s)`)));
    }
  }

  let { session, modelRuntime, loader } = await initAgent();

  // 首次启动需下载 Electron，须等下载完成再进入 REPL
  await startPet();

  // 后台预热本地 GPT-SoVITS，避免首句合成冷启动等待（fire-and-forget）
  preloadGptSovitsLocal();

  // Handle session resume from command line arg
  // 只加载消息到 session，渲染交给 Repl.start() 处理（确保 logo 在历史记录之前）
  // initialSessionPath 传给 Repl，退出时覆盖保存回原文件而非另存为新文件
  let resumedMessages: any[] | null = null;
  let initialSessionPath: string | null = null;
  const resumeArg = process.argv.find((a) => a.startsWith("--resume="));
  if (resumeArg) {
    const sessionPath = resumeArg.split("=")[1];
    try {
      resumedMessages = loadSession(sessionPath);
      session.agent.state.messages = resumedMessages;
      initialSessionPath = sessionPath;
    } catch (err) {
      console.warn(chalk.yellow(t("恢复会话失败：", "Failed to resume: ") + (err instanceof Error ? err.message : err)));
    }
  }

  // Start REPL
  const repl = new Repl(
    session,
    modelRuntime,
    loader,
    () => {
      // onExit - cleanup is handled in repl
    },
    async () => {
      // onNewSession - dispose old session, recreate, and return it so
      // the Repl can rebind its reference + renderer subscription.
      session.dispose();
      resetConversationFlag();
      return await initAgent();
    },
    resumedMessages,
    initialSessionPath,
  );

  await repl.start();
}

main().catch((err) => {
  console.error(chalk.red(t("致命错误：", "Fatal error: ") + (err instanceof Error ? err.message : err)));
  process.exit(1);
});
