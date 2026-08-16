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
 * Speak text using Qwen TTS (阿里云百炼) via Python subprocess.
 */
export async function speak(text: string): Promise<void> {
  if (!ttsEnabled || !text.trim()) return;
  if (!config.ttsApiKey) {
    console.warn("TTS: QWEN_TTS_API_KEY not configured");
    return;
  }

  const cleanText = stripMarkdown(text);
  if (!cleanText) return;

  try {
    await runPython("tts.py", [], cleanText, {
      QWEN_WORKSPACE_ID: config.workspaceId,
      QWEN_TTS_API_KEY: config.ttsApiKey,
      QWEN_TTS_MODEL: config.ttsModel,
      QWEN_TTS_VOICE: config.ttsVoice,
      QWEN_TTS_FORMAT: config.ttsFormat,
      QWEN_TTS_SAMPLE_RATE: String(config.ttsSampleRate),
    }, 30000);
  } catch (err) {
    console.warn(`TTS error: ${err instanceof Error ? err.message : err}`);
  }
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
