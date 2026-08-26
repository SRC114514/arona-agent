import { initAgent } from "./agent.ts";
import { Repl } from "./repl.ts";
import { resetConversationFlag, loadSession } from "./memory.ts";
import { startPet } from "./pet.ts";
import { config, settingsExist } from "./config.ts";
import { preloadGptSovitsLocal } from "./tts_provider.ts";
import { syncSkillsFromAgentsDir } from "./skills.ts";
import { t } from "./locale.ts";
import chalk from "chalk";

async function main() {
  if (!settingsExist()) {
    console.log(chalk.yellow(t("未找到配置文件，请运行 arona setup 初始化。", "Config file not found. Run `arona setup` to initialize.")));
    process.exit(1);
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
