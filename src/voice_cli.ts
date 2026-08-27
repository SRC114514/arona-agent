// arona voice add [<角色名>] 命令。
// - TTS Provider = aliyun：读 settings.json 的百炼 Key，克隆该角色音色（写入 voices.json#aliyun）；已有音色则询问是否重新克隆。
// - TTS Provider = gpt-sovits：配置该角色（或 TUI 多选角色）的专属权重文件与参考音频
//   （gptWeightsPath / sovitsWeightsPath / refAudioPath / promptText），写入 voices.json#gpt-sovits，与百炼音色共存。
// - 不带参数：进入 TUI 多选，仅补全所选角色的配置。
// 独立进程入口（由 bin/arona.mjs 在 args[0]==="voice" 时 spawn），不依赖 REPL。

import * as readline from "readline";
import { existsSync, readFileSync } from "fs";
import chalk from "chalk";
import { SETTINGS_FILE, verbose } from "./config.ts";
import { AGENT_IDS, getAgentLabel, type AgentId } from "./agent_registry.ts";
import { cloneVoice, hasVoice, setVoiceId, DEMO_PRECLONED_AGENTS, getGptSovitsVoice, setGptSovitsVoice } from "./voices.ts";
import { multiSelect, lockExisting } from "./tui_select.ts";
import { t } from "./locale.ts";

function readSettings(): { ttsApiKey: string; ttsModel: string; ttsProvider: string } {
  let ttsApiKey = "";
  let ttsModel = "qwen-audio-3.0-tts-plus";
  let ttsProvider = "aliyun";
  try {
    if (existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as { ttsApiKey?: unknown; ttsModel?: unknown; ttsProvider?: unknown };
      if (typeof s.ttsApiKey === "string") ttsApiKey = s.ttsApiKey;
      if (typeof s.ttsModel === "string" && s.ttsModel) ttsModel = s.ttsModel;
      if (typeof s.ttsProvider === "string" && s.ttsProvider) ttsProvider = s.ttsProvider;
    }
  } catch {
    // settings.json 损坏/缺失：走下方缺 Key 报错
  }
  return { ttsApiKey, ttsModel, ttsProvider };
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

/**
 * 配置 GPT-SoVITS 每角色音色（gptWeightsPath/sovitsWeightsPath/refAudioPath/promptText）。
 * 写 voices.json#gpt-sovits（read-modify-write，与 voices.json#aliyun 的百炼音色共存）。
 * 带角色名 = 只配置该角色；无参 = TUI 多选（原已配置角色默认 [*]，取消勾选 = 删除其配置）。
 * 演示模式：TUI 默认显示所有角色都为未克隆，记录的路径信息直接丢弃、不写 voices.json。
 */
async function configureGptSovitsVoice(name: string | undefined, demoMode: boolean): Promise<void> {
  const targets: AgentId[] = [];
  if (name) {
    if (!isValidAgentId(name)) {
      console.log(chalk.red(t(
        `未知角色 "${name}"。可用角色：${AGENT_IDS.join("、")}`,
        `Unknown character "${name}". Available: ${AGENT_IDS.join(", ")}`,
      )));
      process.exit(1);
    }
    targets.push(name);
  } else {
    // 已配置者经 lockExisting 锁定为已克隆。
    // 演示模式：硬编码全未克隆。
    const configured: AgentId[] = demoMode ? [] : AGENT_IDS.filter((id) => getGptSovitsVoice(id));
    const options = lockExisting(
      AGENT_IDS.map((id) => ({
        id,
        label: configured.includes(id) ? `${getAgentLabel(id)}${t("（已克隆）", " (cloned)")}` : getAgentLabel(id),
      })),
      configured,
    );
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
      console.log(chalk.cyan(t("已取消。", "Cancelled.")));
      return;
    }
    targets.push(...AGENT_IDS.filter((id) => selected.has(id)));
  }

  if (targets.length === 0) {
    console.log(chalk.cyan(t("未选择任何角色。", "No character selected.")));
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    console.log();
    rl.close();
    process.exit(130);
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer.trim()));
    });

  for (const id of targets) {
    const prev = getGptSovitsVoice(id) || {};
    console.log(chalk.bold.cyan(t(
      `\n  ${getAgentLabel(id)} GPT-SoVITS 音色配置\n`,
      `\n  ${getAgentLabel(id)} GPT-SoVITS voice config\n`,
    )));
    // GPT/SoVITS 权重必填：无既有值默认 [ N/A ]，空输入黄色提示后重新询问。
    const prevCkpt = prev.gptWeightsPath || "";
    let ckpt = prevCkpt;
    for (;;) {
      const ckptInput = (await ask(t(
        ckpt ? `    GPT 权重 .ckpt 路径 [${ckpt}]: ` : "    GPT 权重 .ckpt 路径 [ N/A ]: ",
        ckpt ? `    GPT weights .ckpt path [${ckpt}]: ` : "    GPT weights .ckpt path [ N/A ]: ",
      ))).trim();
      if (ckptInput) { ckpt = ckptInput; break; }
      if (prevCkpt) break;
      console.log(chalk.yellow(t("    请输入路径！", "    Please enter a path!")));
    }
    const prevPth = prev.sovitsWeightsPath || "";
    let pth = prevPth;
    for (;;) {
      const pthInput = (await ask(t(
        pth ? `    SoVITS 权重 .pth 路径 [${pth}]: ` : "    SoVITS 权重 .pth 路径 [ N/A ]: ",
        pth ? `    SoVITS weights .pth path [${pth}]: ` : "    SoVITS weights .pth path [ N/A ]: ",
      ))).trim();
      if (pthInput) { pth = pthInput; break; }
      if (prevPth) break;
      console.log(chalk.yellow(t("    请输入路径！", "    Please enter a path!")));
    }
    const prevRef = prev.refAudioPath || "";
    const ref = (await ask(t(
      prevRef ? `    示例音频 ref_audio_path [${prevRef}]: ` : "    示例音频 ref_audio_path [本地路径或URL]: ",
      prevRef ? `    Reference audio ref_audio_path [${prevRef}]: ` : "    Reference audio ref_audio_path [local path or URL]: ",
    ))) || prevRef;
    const prevText = prev.promptText || "";
    const text = (await ask(t(
      prevText
        ? `    示例音频文字内容 prompt_text [${prevText}]: `
        : `    示例音频文字内容 prompt_text [assets/blue-archive/${id}/voice_text.txt]: `,
      prevText
        ? `    Reference audio text prompt_text [${prevText}]: `
        : `    Reference audio text prompt_text [assets/blue-archive/${id}/voice_text.txt]: `,
    ))) || prevText;
    // 每角色音色写 voices.json#gpt-sovits（与百炼 voice_id 共存，不写 settings.json）
    // 演示模式：路径信息直接丢弃，不写 voices.json。
    if (!demoMode) {
      setGptSovitsVoice(id, { gptWeightsPath: ckpt, sovitsWeightsPath: pth, refAudioPath: ref, promptText: text });
    }
  }
  rl.close();

  console.log(chalk.green(t(
    "  ✓ GPT-SoVITS 音色配置已保存（voices.json#gpt-sovits）。运行中的会话需重启后生效。",
    "  ✓ GPT-SoVITS voice config saved (voices.json#gpt-sovits). Restart the running session to apply.",
  )));
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
      `正在克隆 ${getAgentLabel(agent)} 的音色...`,
      `Cloning ${getAgentLabel(agent)}'s voice...`,
    )));
    await new Promise((r) => setTimeout(r, 5000));
    console.log(chalk.green(t(
      `✓ ${getAgentLabel(agent)} 音色克隆成功`,
      `✓ ${getAgentLabel(agent)} voice cloned`,
    )));
    return true;
  }
  console.log(chalk.cyan(t(
    `正在克隆 ${getAgentLabel(agent)} 的音色...`,
    `Cloning ${getAgentLabel(agent)}'s voice...`,
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

  const { ttsApiKey, ttsModel, ttsProvider } = readSettings();
  const demoMode = readDemoMode();
  const name = args[1];

  // GPT-SoVITS：配置每角色专属权重/参考音频（写 voices.json#gpt-sovits，与百炼音色共存）。
  if (ttsProvider === "gpt-sovits") {
    await configureGptSovitsVoice(name, demoMode);
    return;
  }
  if (ttsProvider !== "aliyun") {
    console.log(chalk.yellow(t(
      `当前 TTS Provider 为 ${ttsProvider}：arona voice add 仅支持 aliyun 与 gpt-sovits。`,
      `Current TTS Provider is ${ttsProvider}: arona voice add only supports aliyun and gpt-sovits.`,
    )));
    process.exit(1);
  }
  if (!demoMode && !ttsApiKey) {
    console.log(chalk.red(t(
      "未找到百炼 API Key（settings.json 的 ttsApiKey）。请先运行 arona setup 配置。",
      "Bailian API Key not found (settings.json ttsApiKey). Run `arona setup` first.",
    )));
    process.exit(1);
  }

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
  // 演示模式：Arona/Plana/Shiroko/Hoshino 显示为已克隆，其余显示为未克隆。
  const clonedIds = demoMode ? DEMO_PRECLONED_AGENTS : AGENT_IDS.filter((id) => hasVoice(id));
  const options = lockExisting(
    AGENT_IDS.map((id) => ({
      id,
      label: clonedIds.includes(id) ? `${getAgentLabel(id)}${t("（已克隆）", " (cloned)")}` : getAgentLabel(id),
    })),
    clonedIds,
  );
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
