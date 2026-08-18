// arona voice add [<角色名>] 命令。
// - 带角色名：读 settings.json 的百炼 Key，克隆该角色音色；已有音色则询问是否重新克隆。
// - 不带参数：进入与 setup 相同的多选 TUI，仅列未补全音色的角色。
// 独立进程入口（由 bin/arona.mjs 在 args[0]==="voice" 时 spawn），不依赖 REPL。

import * as readline from "readline";
import { existsSync, readFileSync } from "fs";
import chalk from "chalk";
import { SETTINGS_FILE, verbose } from "./config.ts";
import { AGENT_IDS, getAgentLabel, type AgentId } from "./agent_registry.ts";
import { cloneVoice, hasVoice, setVoiceId } from "./voices.ts";
import { multiSelect } from "./tui_select.ts";
import { t } from "./locale.ts";

function readSettings(): { ttsApiKey: string; ttsModel: string } {
  let ttsApiKey = "";
  let ttsModel = "qwen-audio-3.0-tts-plus";
  try {
    if (existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as { ttsApiKey?: unknown; ttsModel?: unknown };
      if (typeof s.ttsApiKey === "string") ttsApiKey = s.ttsApiKey;
      if (typeof s.ttsModel === "string" && s.ttsModel) ttsModel = s.ttsModel;
    }
  } catch {
    // settings.json 损坏/缺失：走下方缺 Key 报错
  }
  return { ttsApiKey, ttsModel };
}

/** 演示模式：settings.json#demoMode === true 时，音色克隆静默跳过（等 5s 不写 voices.json）。 */
function readDemoMode(): boolean {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as { demoMode?: unknown };
      return s.demoMode === true;
    }
  } catch {
    // 损坏/缺失：按非演示模式处理
  }
  return false;
}

function isValidAgentId(id: string): id is AgentId {
  return (AGENT_IDS as readonly string[]).includes(id);
}

function askYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Ctrl+C 视为"不重新克隆"，立即结束询问（否则 readline 默认清行继续等输入，卡在 y/N）
    rl.on("SIGINT", () => {
      console.log();
      rl.close();
      resolve(false);
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y/i.test(answer.trim()));
    });
  });
}

async function cloneOne(agent: AgentId, apiKey: string, model: string, simulate: boolean): Promise<boolean> {
  if (simulate) {
    // 演示模式：打印"正在克隆"与"克隆成功"，但不调用 voice_clone.py、不写 voices.json、无演示模式提示。
    console.log(chalk.cyan(t(
      `正在克隆 ${getAgentLabel(agent)} 的音色（可能需要 1-2 分钟）...`,
      `Cloning ${getAgentLabel(agent)}'s voice (may take 1-2 minutes)...`,
    )));
    await new Promise((r) => setTimeout(r, 5000));
    console.log(chalk.green(t(
      `✓ ${getAgentLabel(agent)} 音色克隆成功`,
      `✓ ${getAgentLabel(agent)} voice cloned`,
    )));
    return true;
  }
  console.log(chalk.cyan(t(
    `正在克隆 ${getAgentLabel(agent)} 的音色（可能需要 1-2 分钟）...`,
    `Cloning ${getAgentLabel(agent)}'s voice (may take 1-2 minutes)...`,
  )));
  try {
    const voiceId = await cloneVoice(agent, apiKey, model);
    setVoiceId(agent, voiceId);
    console.log(chalk.green(t(
      verbose
        ? `✓ ${getAgentLabel(agent)} 音色克隆成功（voice_id: ${voiceId}）`
        : `✓ ${getAgentLabel(agent)} 音色克隆成功`,
      verbose
        ? `✓ ${getAgentLabel(agent)} voice cloned (voice_id: ${voiceId})`
        : `✓ ${getAgentLabel(agent)} voice cloned`,
    )));
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(t(
      `✗ ${getAgentLabel(agent)} 音色克隆失败：${msg}`,
      `✗ ${getAgentLabel(agent)} voice cloning failed: ${msg}`,
    )));
    return false;
  }
}

async function run(argv: string[]): Promise<void> {
  // --verbose 可与角色名同栈传入（`arona voice add --verbose`）：先剔除，避免被当成角色名
  const args = argv.filter((a) => a !== "--verbose");
  const sub = args[0];
  if (sub !== "add") {
    console.log(chalk.yellow(t(
      "用法：arona voice add [<角色名>]",
      "Usage: arona voice add [<character-name>]",
    )));
    process.exit(1);
  }

  const { ttsApiKey, ttsModel } = readSettings();
  const demoMode = readDemoMode();
  if (!demoMode && !ttsApiKey) {
    console.log(chalk.red(t(
      "未找到百炼 API Key（settings.json 的 ttsApiKey）。请先运行 arona setup 配置。",
      "Bailian API Key not found (settings.json ttsApiKey). Run `arona setup` first.",
    )));
    process.exit(1);
  }

  const name = args[1];

  if (name) {
    // 指定单个角色
    if (!isValidAgentId(name)) {
      console.log(chalk.red(t(
        `未知角色 "${name}"。可用角色：${AGENT_IDS.join("、")}`,
        `Unknown character "${name}". Available: ${AGENT_IDS.join(", ")}`,
      )));
      process.exit(1);
    }
    // 演示模式不询问是否重新克隆，直接静默跳过。
    if (!demoMode && hasVoice(name)) {
      const again = await askYesNo(t(
        `角色 ${getAgentLabel(name)} 已存在音色，是否重新克隆？(y/N) `,
        `Character ${getAgentLabel(name)} already has a voice. Re-clone? (y/N) `,
      ));
      if (!again) {
        console.log(chalk.cyan(t("已取消。", "Cancelled.")));
        return;
      }
    }
    await cloneOne(name, ttsApiKey, ttsModel, demoMode);
    return;
  }

  // 无参：TUI 展示全部角色（主 Agent + 子 Agent）。
  // 演示模式：阿洛娜强制显示为已克隆（锁定、不重克隆）；普拉娜/砂狼白子/小鸟游星野强制显示为未克隆（可选）。
  const options = AGENT_IDS.map((id) => {
    if (demoMode && id === "arona") {
      return { id, label: `${getAgentLabel(id)}${t("（已克隆）", " (cloned)")}`, locked: true };
    }
    if (demoMode) {
      return { id, label: getAgentLabel(id), locked: false };
    }
    return {
      id,
      label: hasVoice(id) ? `${getAgentLabel(id)}${t("（已克隆）", " (cloned)")}` : getAgentLabel(id),
      locked: hasVoice(id),
    };
  });
  const initial = new Set<string>();
  const selected = await multiSelect(
    t("选择要补全音色的角色", "Select characters to add voices"),
    options,
    initial,
    t(
      "  ↑/↓ 切换 · 空格选中 [*] · 回车克隆 · Esc 取消",
      "  ↑/↓ move · Space select [*] · Enter clone · Esc cancel",
    ),
  );

  if (selected === null) {
    console.log(chalk.cyan(t("已取消。", "Cancelled.")));
    return;
  }
  if (selected.size === 0) {
    console.log(chalk.cyan(t("未选择任何角色。", "No character selected.")));
    return;
  }

  for (const id of AGENT_IDS) {
    if (!selected.has(id)) continue;
    await cloneOne(id, ttsApiKey, ttsModel, demoMode);
  }
}

run(process.argv.slice(2)).catch((err) => {
  console.error(chalk.red(t(
    `voice add 错误：${err instanceof Error ? err.message : err}`,
    `voice add error: ${err instanceof Error ? err.message : err}`,
  )));
  process.exit(1);
});
