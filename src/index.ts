import { initAgent } from "./agent.ts";
import { Repl } from "./repl.ts";
import { resetConversationFlag, loadSession } from "./memory.ts";
import { startPet } from "./pet.ts";
import { config, settingsExist } from "./config.ts";
import { t } from "./locale.ts";
import chalk from "chalk";

async function main() {
  // Require settings.json — if missing, tell user to run arona setup
  if (!settingsExist()) {
    console.log(chalk.yellow(t("未找到配置文件。", "Config file not found.")));
    console.log(chalk.cyan(t("请先运行 arona setup 进行初始化配置。", "Please run arona setup to initialize first.")));
    process.exit(1);
  }

  // Check for required environment
  if (!config.apiKey) {
    console.log(chalk.yellow(t("警告：未找到 LLM API Key。", "Warning: LLM API Key not found.")));
    console.log(chalk.cyan(t("请运行 arona setup 进行配置。", "Please run arona setup to configure.")));
    console.log();
  }

  if (config.noVoice) {
    console.log(chalk.cyan(t("语音功能已禁用（--no-voice）。", "Voice features disabled (--no-voice).")));
  }

  // Initialize agent
  console.log(chalk.cyan(t("正在初始化 ARONA...", "Initializing ARONA...")));

  let { session, modelRuntime, loader } = await initAgent();

  // 启动桌宠（异步不阻塞 REPL；失败时降级为纯 CLI）
  void startPet();

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
