// 每角色音色注册表（多 Provider 共存）。
// 存储到 ~/.arona/voices.json（不塞进 settings.json——多角色多 provider 音色放一个字段不现实）。
//
// 结构（aliyun 与 gpt-sovits 两个命名空间互不覆盖）：
// {
//   "aliyun":    { "arona": "<voice_id>", "plana": "<voice_id>" },   // 百炼声音复刻 voice_id
//   "gpt-sovits":{ "arona": { gptWeightsPath, sovitsWeightsPath, refAudioPath, promptText }, ... }
// }
//
// 兼容：旧扁平格式 {"arona": "<voice_id>"} 在模块加载时自动迁移进 aliyun 命名空间；
// 旧 settings.json#ttsConfig["gpt-sovits"].voices 也会迁移进 gpt-sovits 命名空间并移除 settings 里的 voices。
// 运行时 TTS 按当前主 Agent 与 provider 判定：无音色 → 强制静音（见 voice.ts）。

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ARONA_DIR, SETTINGS_FILE, PROJECT_ROOT } from "./config.ts";
import { AGENT_IDS, type AgentId } from "./agent_registry.ts";
import { runPython } from "./utils/python.ts";

export const VOICES_FILE = join(ARONA_DIR, "voices.json");

/** 每角色 GPT-SoVITS 音色配置（voices.json#gpt-sovits 条目；源类型定义在 voices.ts 避免与 tts_provider 循环依赖）。 */
export interface GptSovitsVoiceConfig {
  /** GPT 权重 .ckpt 路径；空 = 不切换，用服务端已加载模型 */
  gptWeightsPath?: string;
  /** SoVITS 权重 .pth 路径；空 = 不切换 */
  sovitsWeightsPath?: string;
  /** 示例音频：本地文件路径 或 http(s) URL；cloud 模式本地文件会自动上传阿里云 OSS 换长期 URL */
  refAudioPath?: string;
  /** 示例音频文字（prompt_text）：字面量 / 本地 txt 文件路径 / URL；文件与 URL 内容自动合并多行为一行 */
  promptText?: string;
}

/** 每个角色的音色源文件路径（声音复刻上传的音频）。编码子Agent（millennium/justice）无语音素材，置空串。 */
export const VOICE_AUDIO: Record<AgentId, string> = {
  arona: join(PROJECT_ROOT, "assets", "blue-archive", "arona", "voice.mp3"),
  plana: join(PROJECT_ROOT, "assets", "blue-archive", "plana", "voice.mp3"),
  shiroko: join(PROJECT_ROOT, "assets", "blue-archive", "shiroko", "voice.mp3"),
  hoshino: join(PROJECT_ROOT, "assets", "blue-archive", "hoshino", "voice.mp3"),
  hanako: join(PROJECT_ROOT, "assets", "blue-archive", "hanako", "voice.mp3"),
  koharu: join(PROJECT_ROOT, "assets", "blue-archive", "koharu", "voice.mp3"),
  kei: join(PROJECT_ROOT, "assets", "blue-archive", "kei", "voice.mp3"),
  aris: join(PROJECT_ROOT, "assets", "blue-archive", "aris", "voice.mp3"),
  millennium: "",
  justice: "",
};

/**
 * 每个角色的 GPT-SoVITS 默认示例音频路径（角色素材目录下 voice_sovits.mp3）。
 * local 模式未显式配置 refAudioPath 时无条件使用此文件。
 * 注意：与 voice.mp3（百炼克隆素材）解耦，GPT-SoVITS 推荐独立短示例音频以获得稳定音色。
 */
export const VOICE_SOVITS_AUDIO: Record<AgentId, string> = {
  arona: join(PROJECT_ROOT, "assets", "blue-archive", "arona", "voice_sovits.mp3"),
  plana: join(PROJECT_ROOT, "assets", "blue-archive", "plana", "voice_sovits.mp3"),
  shiroko: join(PROJECT_ROOT, "assets", "blue-archive", "shiroko", "voice_sovits.mp3"),
  hoshino: join(PROJECT_ROOT, "assets", "blue-archive", "hoshino", "voice_sovits.mp3"),
  hanako: join(PROJECT_ROOT, "assets", "blue-archive", "hanako", "voice_sovits.mp3"),
  koharu: join(PROJECT_ROOT, "assets", "blue-archive", "koharu", "voice_sovits.mp3"),
  kei: join(PROJECT_ROOT, "assets", "blue-archive", "kei", "voice_sovits.mp3"),
  aris: join(PROJECT_ROOT, "assets", "blue-archive", "aris", "voice_sovits.mp3"),
  millennium: "",
  justice: "",
};

function loadVoices(): Record<string, unknown> {
  if (!existsSync(VOICES_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(VOICES_FILE, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** 读取 aliyun 命名空间（含旧扁平格式的顶层 agent→voice_id 兜底）。 */
function loadAliyunVoices(): Record<string, unknown> {
  const voices = loadVoices();
  const ns = voices.aliyun && typeof voices.aliyun === "object" && !Array.isArray(voices.aliyun)
    ? (voices.aliyun as Record<string, unknown>)
    : {};
  const out: Record<string, unknown> = { ...ns };
  // 迁移前/损坏时兜底：顶层 agent→string 视作旧扁平百炼条目
  for (const [k, v] of Object.entries(voices)) {
    if (k === "aliyun" || k === "gpt-sovits") continue;
    if (typeof v === "string" && v && out[k] === undefined) out[k] = v;
  }
  return out;
}

function writeVoices(voices: Record<string, unknown>): void {
  writeFileSync(VOICES_FILE, JSON.stringify(voices, null, 2) + "\n");
}

/**
 * 读取指定角色的百炼 voice_id。
 * 优先 voices.json#aliyun；arona 缺省时回退读旧 settings.json#ttsVoice（向后兼容存量用户）。
 */
export function getVoiceId(agent: AgentId): string {
  const aliyun = loadAliyunVoices();
  const v = aliyun[agent];
  if (typeof v === "string" && v) return v;

  if (agent === "arona") {
    try {
      if (existsSync(SETTINGS_FILE)) {
        const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as { ttsVoice?: unknown };
        if (typeof s.ttsVoice === "string" && s.ttsVoice) return s.ttsVoice;
      }
    } catch {
      // settings.json 损坏/不可读：忽略
    }
  }
  return "";
}

/** 指定角色是否已克隆百炼音色。 */
export function hasVoice(agent: AgentId): boolean {
  return getVoiceId(agent) !== "";
}

/** 写回指定角色的百炼 voice_id（read-modify-write，保留其它角色与 gpt-sovits 命名空间）。 */
export function setVoiceId(agent: AgentId, voiceId: string): void {
  const voices = loadVoices();
  const aliyun = loadAliyunVoices();
  aliyun[agent] = voiceId;
  voices.aliyun = aliyun;
  writeVoices(voices);
}

/**
 * 读取指定角色的 GPT-SoVITS 音色配置（voices.json#gpt-sovits）；无配置返回 undefined。
 * 读取时把缺失的字符串字段规整为 ""（与 normalizeGptSovitsConfig 一致）。
 */
export function getGptSovitsVoice(agent: AgentId): GptSovitsVoiceConfig | undefined {
  const voices = loadVoices();
  const gs = voices["gpt-sovits"];
  if (!gs || typeof gs !== "object" || Array.isArray(gs)) return undefined;
  const c = (gs as Record<string, unknown>)[agent];
  if (!c || typeof c !== "object" || Array.isArray(c)) return undefined;
  const v = c as Record<string, unknown>;
  return {
    gptWeightsPath: typeof v.gptWeightsPath === "string" ? v.gptWeightsPath : "",
    sovitsWeightsPath: typeof v.sovitsWeightsPath === "string" ? v.sovitsWeightsPath : "",
    refAudioPath: typeof v.refAudioPath === "string" ? v.refAudioPath : "",
    promptText: typeof v.promptText === "string" ? v.promptText : "",
  };
}

/** 写回指定角色的 GPT-SoVITS 音色配置（read-modify-write，保留 aliyun 命名空间）。 */
export function setGptSovitsVoice(agent: AgentId, cfg: GptSovitsVoiceConfig): void {
  const voices = loadVoices();
  const gs =
    voices["gpt-sovits"] && typeof voices["gpt-sovits"] === "object" && !Array.isArray(voices["gpt-sovits"])
      ? { ...(voices["gpt-sovits"] as Record<string, unknown>) }
      : {};
  gs[agent] = {
    gptWeightsPath: cfg.gptWeightsPath || "",
    sovitsWeightsPath: cfg.sovitsWeightsPath || "",
    refAudioPath: cfg.refAudioPath || "",
    promptText: cfg.promptText || "",
  };
  voices["gpt-sovits"] = gs;
  writeVoices(voices);
}

/** 删除指定角色的 GPT-SoVITS 音色配置（幂等；空命名空间自动清理）。 */
export function deleteGptSovitsVoice(agent: AgentId): void {
  const voices = loadVoices();
  const gs =
    voices["gpt-sovits"] && typeof voices["gpt-sovits"] === "object" && !Array.isArray(voices["gpt-sovits"])
      ? { ...(voices["gpt-sovits"] as Record<string, unknown>) }
      : {};
  if (gs[agent] === undefined) return;
  delete gs[agent];
  if (Object.keys(gs).length === 0) delete voices["gpt-sovits"];
  else voices["gpt-sovits"] = gs;
  writeVoices(voices);
}

/** 尚缺百炼音色的全部角色列表（主 Agent + 子 Agent）。 */
export function getMissingAgents(): AgentId[] {
  return AGENT_IDS.filter((id) => !hasVoice(id));
}

/**
 * 演示模式（settings.json#demoMode === true）下，aliyun 分支 TUI 预标记为"已克隆"并锁定的角色。
 * setup.ts 与 voice_cli.ts 共用此表（配合 tui_select.lockExisting），保证两个命令的演示行为一致（其余角色视为未克隆）。
 */
export const DEMO_PRECLONED_AGENTS: readonly AgentId[] = ["arona", "plana", "shiroko", "hoshino"];

/**
 * 克隆指定角色的百炼音色，返回 voice_id。
 * 复用 python/voice_clone.py：ARONA_VOICE_AUDIO + ARONA_VOICE_PREFIX 指定音频与角色前缀。
 */
export async function cloneVoice(agent: AgentId, apiKey: string, model: string): Promise<string> {
  const out = await runPython(
    "voice_clone.py",
    [],
    undefined,
    {
      QWEN_TTS_API_KEY: apiKey,
      QWEN_TTS_MODEL: model,
      ARONA_VOICE_AUDIO: VOICE_AUDIO[agent],
      ARONA_VOICE_PREFIX: agent,
    },
    360000, // 6 min：python 侧轮询等待上限 5min + upload/create 耗时，Node 预算必须大于
            // python 侧总耗时，否则服务端克隆已成功但本地先判超时（上传文件也不会被清理）
  );

  let parsed: { voice_id?: string; error?: string };
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`invalid voice_clone output: ${out}`);
  }
  if (parsed.voice_id) return parsed.voice_id;
  throw new Error(parsed.error || "voice_clone returned no voice_id");
}

/**
 * 旧格式迁移①：settings.json 直接存 voice_id（单角色时代）→ voices.json#aliyun。
 * 动作：settings.json#ttsVoice 非空且 voices.json#aliyun 尚无 arona → 写入 voices.json#aliyun.arona；
 * 然后删除 settings.json#ttsVoice 完成清理（避免每次启动重复检测）。
 * 幂等：无旧字段直接返回。失败静默（getVoiceId 的 legacy 回退仍兜底）。
 */
function migrateLegacyVoice(): void {
  try {
    if (!existsSync(SETTINGS_FILE)) return;
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Record<string, unknown>;
    const legacy = settings.ttsVoice;
    if (typeof legacy !== "string" || !legacy) return;

    const voices = loadVoices();
    const aliyun = loadAliyunVoices();
    if (typeof aliyun.arona !== "string" || !aliyun.arona) {
      aliyun.arona = legacy;
      voices.aliyun = aliyun;
      writeVoices(voices);
    }
    delete settings.ttsVoice;
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // 迁移失败静默：不影响启动，getVoiceId 的 legacy 回退仍能读到旧字段
  }
}

/**
 * 旧格式迁移②：扁平 {"arona": "<voice_id>"} → 命名空间 {"aliyun": {"arona": "<voice_id>"}}。
 * 顶层 agent→string 条目收进 aliyun 命名空间；gpt-sovits 命名空间原样保留。幂等（已命名空间化时不写）。
 */
function migrateVoicesFormat(): void {
  const voices = loadVoices();
  // 顶层 agent→string 条目 = 旧扁平百炼格式
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(voices)) {
    if (k === "aliyun" || k === "gpt-sovits") continue;
    if (typeof v === "string" && v) flat[k] = v;
  }
  if (Object.keys(flat).length === 0) return; // 已迁移或无内容 → 不写

  const aliyun =
    voices.aliyun && typeof voices.aliyun === "object" && !Array.isArray(voices.aliyun)
      ? { ...(voices.aliyun as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(flat)) {
    if (aliyun[k] === undefined) aliyun[k] = v;
    delete voices[k];
  }
  voices.aliyun = aliyun;
  writeVoices(voices);
}

/**
 * 旧格式迁移③：settings.json#ttsConfig["gpt-sovits"].voices → voices.json#gpt-sovits。
 * 已存在于 voices.json#gpt-sovits 的角色不覆盖；迁移后从 settings.json 移除 voices（保留 provider 级配置）。幂等。
 */
function migrateGptSovitsFromSettings(): void {
  try {
    if (!existsSync(SETTINGS_FILE)) return;
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as {
      ttsConfig?: { "gpt-sovits"?: Record<string, unknown> };
    };
    const gpt = settings.ttsConfig?.["gpt-sovits"];
    const oldVoices = gpt && typeof gpt === "object" ? (gpt.voices as Record<string, unknown> | undefined) : undefined;
    if (!oldVoices || typeof oldVoices !== "object" || Array.isArray(oldVoices)) return;

    const voices = loadVoices();
    const gs =
      voices["gpt-sovits"] && typeof voices["gpt-sovits"] === "object" && !Array.isArray(voices["gpt-sovits"])
        ? { ...(voices["gpt-sovits"] as Record<string, unknown>) }
        : {};
    let changed = false;
    for (const [agent, cfg] of Object.entries(oldVoices)) {
      if (gs[agent] === undefined && cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
        gs[agent] = cfg;
        changed = true;
      }
    }
    if (changed) {
      voices["gpt-sovits"] = gs;
      writeVoices(voices);
    }

    // 从 settings.json 移除 voices（仅当该键存在才回写，避免无谓重写）
    if (gpt && typeof gpt === "object" && "voices" in gpt) {
      delete gpt.voices;
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
    }
  } catch {
    // 迁移失败静默：运行时 getGptSovitsVoice 无回退，但迁移在模块加载即执行，异常仅影响手工残留配置
  }
}

// 模块加载时执行一次：任何入口（arona / arona setup / arona voice add / 未来一切命令）
// 只要加载本模块就自动完成旧格式迁移。顺序：先扁平→命名空间，再 settings.ttsVoice，再 settings gpt-sovits.voices。
migrateVoicesFormat();
migrateLegacyVoice();
migrateGptSovitsFromSettings();
