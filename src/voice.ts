import { runPython } from "./utils/python.ts";
import { config } from "./config.ts";

let ttsEnabled = config.noVoice ? false : config.ttsEnabled;
let sttEnabled = config.noVoice ? false : config.sttEnabled;

export function isTtsEnabled(): boolean {
  return ttsEnabled;
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
