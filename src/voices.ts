// 每角色独立音色注册表（声音复刻 voice_id）。
// 存储到 ~/.arona/voices.json（不塞进 settings.json——多角色 voice_id 放一个字段不现实）。
// 结构：{ "arona": "<voice_id>", "plana": "<voice_id>" }
// 运行时 TTS 按当前主 Agent 的 voice_id 判定：无音色 → 强制静音（见 voice.ts）。

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ARONA_DIR, SETTINGS_FILE, PROJECT_ROOT } from "./config.ts";
import { AGENT_IDS, type AgentId } from "./agent_registry.ts";
import { runPython } from "./utils/python.ts";

export const VOICES_FILE = join(ARONA_DIR, "voices.json");

/** 每个角色的音色源文件路径（声音复刻上传的音频） */
export const VOICE_AUDIO: Record<AgentId, string> = {
  arona: join(PROJECT_ROOT, "assets", "blue-archive", "arona", "voice.mp3"),
  plana: join(PROJECT_ROOT, "assets", "blue-archive", "plana", "voice.mp3"),
  shiroko: join(PROJECT_ROOT, "assets", "blue-archive", "shiroko", "voice.mp3"),
  hoshino: join(PROJECT_ROOT, "assets", "blue-archive", "hoshino", "voice.mp3"),
};

function loadVoices(): Record<string, string> {
  if (!existsSync(VOICES_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(VOICES_FILE, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * 读取指定角色的 voice_id。
 * 优先 voices.json；arona 缺省时回退读旧 settings.json#ttsVoice（向后兼容存量用户）。
 */
export function getVoiceId(agent: AgentId): string {
  const voices = loadVoices();
  const v = voices[agent];
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

/** 指定角色是否已克隆音色。 */
export function hasVoice(agent: AgentId): boolean {
  return getVoiceId(agent) !== "";
}

/** 写回指定角色的 voice_id（read-modify-write，保留其它角色）。 */
export function setVoiceId(agent: AgentId, voiceId: string): void {
  const voices = loadVoices();
  voices[agent] = voiceId;
  writeFileSync(VOICES_FILE, JSON.stringify(voices, null, 2) + "\n");
}

/** 尚缺音色的全部角色列表（主 Agent + 子 Agent）。 */
export function getMissingAgents(): AgentId[] {
  return AGENT_IDS.filter((id) => !hasVoice(id));
}

/**
 * 克隆指定角色的音色，返回 voice_id。
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
 * 旧格式迁移：settings.json 直接存 voice_id（单角色时代）→ voices.json 新格式。
 * 动作：settings.json#ttsVoice 非空且 voices.json 尚无 arona → 写入 voices.json.arona；
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
    let changed = false;
    if (typeof voices.arona !== "string" || !voices.arona) {
      voices.arona = legacy;
      changed = true;
    }
    if (changed) {
      writeFileSync(VOICES_FILE, JSON.stringify(voices, null, 2) + "\n");
    }
    delete settings.ttsVoice;
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // 迁移失败静默：不影响启动，getVoiceId 的 legacy 回退仍能读到旧字段
  }
}

// 模块加载时执行一次：任何入口（arona / arona setup / arona voice add / 未来一切命令）
// 只要加载本模块就自动完成旧格式 → voices.json 迁移。setup / voice add 读 voices.json 之前
// 迁移已就位。
migrateLegacyVoice();
