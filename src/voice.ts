import { runPython } from "./utils/python.ts";
import { config } from "./config.ts";
import { getMainAgent, type AgentId } from "./agent_registry.ts";
import { hasVoice } from "./voices.ts";

let ttsEnabled = config.noVoice ? false : config.ttsEnabled;
let sttEnabled = config.noVoice ? false : config.sttEnabled;

/** 指定角色是否已有克隆音色（读 voices.json，arona 缺省回退旧 settings.ttsVoice）。 */
export function hasVoiceFor(agent: AgentId): boolean {
  return hasVoice(agent);
}

/** 当前主 Agent 是否已有克隆音色 */
export function hasCurrentVoice(): boolean {
  return hasVoiceFor(getMainAgent());
}

/** 指定角色在当前全局 TTS 开关下是否可朗读（无音色 → 强制静音，不影响 STT）。 */
export function isTtsEnabledFor(agent: AgentId): boolean {
  if (config.noVoice) return false;
  if (!ttsEnabled) return false;
  if (!hasVoiceFor(agent)) return false;
  return true;
}

export function isTtsEnabled(): boolean {
  return isTtsEnabledFor(getMainAgent());
}

export function setTtsEnabled(enabled: boolean): void {
  if (config.noVoice) return;
  ttsEnabled = enabled;
}

export function isSttEnabled(): boolean {
  return sttEnabled;
}

export function setSttEnabled(enabled: boolean): void {
  if (config.noVoice) return;
  sttEnabled = enabled;
}

/**
 * Strip markdown formatting and code blocks before sending to TTS.
 * （供 tts_stream.ts 实时流式管道复用）
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`[^`]+`/g, "")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Listen for speech via Qwen ASR (阿里云百炼), return transcribed text.
 */
export async function listen(): Promise<string> {
  if (!config.sttApiKey) {
    console.warn("STT: QWEN_STT_API_KEY not configured");
    return "";
  }

  try {
    const text = await runPython("stt.py", [], undefined, {
      QWEN_WORKSPACE_ID: config.workspaceId,
      QWEN_STT_API_KEY: config.sttApiKey,
      QWEN_STT_MODEL: config.sttModel,
      QWEN_STT_FORMAT: config.sttFormat,
      QWEN_STT_SAMPLE_RATE: String(config.sttSampleRate),
    }, 60000);
    return text;
  } catch (err) {
    console.warn(`STT error: ${err instanceof Error ? err.message : err}`);
    return "";
  }
}
