import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import type { LanguageSetting } from "./locale.ts";

export const ARONA_DIR = join(homedir(), ".arona");
export const MEMORY_FILE = join(ARONA_DIR, "MEMORY.md");
export const SESSIONS_DIR = join(ARONA_DIR, "sessions");
export const SKILLS_DIR = join(ARONA_DIR, "skills");
export const SETTINGS_FILE = join(ARONA_DIR, "settings.json");
export const PROJECT_ROOT = resolve(import.meta.dirname, "..");
export const PYTHON_DIR = join(PROJECT_ROOT, "python");
export const PET_DIR = join(PROJECT_ROOT, "pet");

// Ensure directories exist
function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}
ensureDir(ARONA_DIR);
ensureDir(SESSIONS_DIR);
ensureDir(SKILLS_DIR);

// Parse --no-voice flag from CLI args
const noVoice = process.argv.includes("--no-voice");

// Parse --verbose flag from CLI args（桌宠/子进程详细日志；Electron 加 --enable-logging 转发 renderer 日志）
export const verbose = process.argv.includes("--verbose");

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** 仅 url 型（Streamable HTTP）server 生效：自定义请求头，如 Authorization */
  headers?: Record<string, string>;
}

export interface AronaConfig {
  // LLM
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  thinkingLevel: string;
  // i18n
  language: LanguageSetting;
  // Voice (Qwen / 阿里云百炼 DashScope)
  noVoice: boolean;
  // 百炼业务空间 ID（可选；留空走旧域名 dashscope.aliyuncs.com）
  workspaceId: string;
  ttsApiKey: string;
  ttsModel: string;
  // 系统音色名 或 自定义音色(声音复刻)ID —— 填声音复刻得到的 voice_id 即用自定义音色
  ttsVoice: string;
  ttsFormat: string;
  ttsSampleRate: number;
  sttApiKey: string;
  sttModel: string;
  sttFormat: string;
  sttSampleRate: number;
  ttsEnabled: boolean;
  sttEnabled: boolean;
  // Cua
  cuaApiKey: string;
  // Misc
  pythonPath: string;
  mcpServers: Record<string, McpServerConfig>;
}

interface Settings {
  apiKey?: string;
  apiBaseUrl?: string;
  model?: string;
  thinkingLevel?: string;
  language?: LanguageSetting;
  // 主 Agent（arona | plana）：桌宠形象 + 人格，由 agent_registry.ts 读写
  mainAgent?: string;
  ttsEnabled?: boolean;
  sttEnabled?: boolean;
  /** @deprecated 已合并进 ttsEnabled，仅读兼容（旧配置 ttsAuto:false 仍生效） */
  ttsAuto?: boolean;
  workspaceId?: string;
  ttsApiKey?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: string;
  ttsSampleRate?: number;
  sttApiKey?: string;
  sttModel?: string;
  sttFormat?: string;
  sttSampleRate?: number;
  cuaApiKey?: string;
  pythonPath?: string;
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Check if ~/.arona/settings.json exists.
 */
export function settingsExist(): boolean {
  return existsSync(SETTINGS_FILE);
}

/**
 * Load settings from ~/.arona/settings.json.
 * Returns {} if the file is missing or unparseable.
 */
function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
  } catch {
    console.warn("Failed to parse settings.json, using defaults");
    return {};
  }
}

// ============================================================
// Model prefix auto-detection
// ============================================================

/**
 * Model name patterns → provider prefix.
 * Checked in order; first match wins. Higher priority than Base URL.
 */
const MODEL_PATTERNS: Array<[RegExp, string]> = [
  [/^gpt[-_]/i, "openai"],
  [/^o[134][-_]/i, "openai"],
  [/^claude[-_]/i, "anthropic"],
  [/^deepseek[-_]/i, "deepseek"],
  [/^gemini[-_]/i, "google"],
  [/^grok[-_]/i, "xai"],
  [/^minimax[-_]/i, "minimax-cn"],
  [/^kimi[-_]/i, "moonshotai-cn"],
  [/^glm[-_]/i, "zai-coding-cn"],
  [/^qwen/i, "qwen-token-plan-cn"],
  [/^mistral[-_]/i, "mistral"],
  [/^codestral[-_]/i, "mistral"],
  [/^devstral[-_]/i, "mistral"],
  [/^mimo[-_]/i, "xiaomi-token-plan-cn"],
  [/^llama[-_]/i, "openrouter"],
];

/**
 * Base URL domain → provider prefix.
 * Checked in order; first match wins. Lower priority than model name.
 */
const URL_DOMAINS: Array<[string, string]> = [
  ["api.openai.com", "openai"],
  ["api.anthropic.com", "anthropic"],
  ["api.deepseek.com", "deepseek"],
  ["generativelanguage.googleapis.com", "google"],
  ["api.x.ai", "xai"],
  ["api.minimax.chat", "minimax-cn"],
  ["api.moonshot.cn", "moonshotai-cn"],
  ["open.bigmodel.cn", "zai-coding-cn"],
  ["dashscope.aliyuncs.com", "qwen-token-plan-cn"],
  ["api.mistral.ai", "mistral"],
  ["openrouter.ai", "openrouter"],
  ["api.groq.com", "groq"],
];

/**
 * Auto-detect the provider prefix for a model name.
 *
 * - If the model already contains "/", return it as-is.
 * - Otherwise, detect from the model name (higher priority), then Base URL.
 * - Defaults to "openai" if nothing matches.
 */
export function resolveModelPrefix(model: string, apiBaseUrl: string): string {
  // Already has a prefix
  if (model.includes("/")) return model;

  // 1. Model name patterns (higher priority)
  for (const [pattern, provider] of MODEL_PATTERNS) {
    if (pattern.test(model)) {
      return `${provider}/${model}`;
    }
  }

  // 2. Base URL domain (lower priority)
  if (apiBaseUrl) {
    const urlLower = apiBaseUrl.toLowerCase();
    for (const [domain, provider] of URL_DOMAINS) {
      if (urlLower.includes(domain)) {
        return `${provider}/${model}`;
      }
    }
  }

  // 3. Default
  return `openai/${model}`;
}

export function loadConfig(): AronaConfig {
  const s = loadSettings();

  const apiKey = s.apiKey || "";
  const apiBaseUrl = s.apiBaseUrl || "";

  // Set OPENAI_BASE_URL for OpenAI-compatible endpoints
  if (apiBaseUrl) {
    process.env.OPENAI_BASE_URL = apiBaseUrl;
  }

  // Auto-detect model prefix
  const rawModel = s.model || "openai/gpt-4o";
  const model = resolveModelPrefix(rawModel, apiBaseUrl);

  return {
    apiKey,
    apiBaseUrl,
    model,
    thinkingLevel: s.thinkingLevel || "medium",
    language: s.language || "auto",

    noVoice,
    // Skip TTS/STT fields when --no-voice is set
    workspaceId: noVoice ? "" : (s.workspaceId || ""),
    ttsApiKey: noVoice ? "" : (s.ttsApiKey || ""),
    ttsModel: noVoice ? "" : (s.ttsModel || "qwen-audio-3.0-tts-plus"),
    ttsVoice: noVoice ? "" : (s.ttsVoice || ""),
    ttsFormat: noVoice ? "pcm" : (s.ttsFormat || "pcm"),
    ttsSampleRate: noVoice ? 22050 : (s.ttsSampleRate || 22050),
    sttApiKey: noVoice ? "" : (s.sttApiKey || ""),
    sttModel: noVoice ? "" : (s.sttModel || "qwen-audio-3.0-asr-flash-streaming"),
    sttFormat: noVoice ? "pcm" : (s.sttFormat || "pcm"),
    sttSampleRate: noVoice ? 16000 : (s.sttSampleRate || 16000),
    // ttsAuto 已合并进 ttsEnabled（旧配置兼容：ttsAuto ?? true）
    ttsEnabled: noVoice ? false : (s.ttsEnabled ?? s.ttsAuto ?? true),
    sttEnabled: noVoice ? false : (s.sttEnabled ?? true),

    cuaApiKey: s.cuaApiKey || "",

    pythonPath: s.pythonPath || (process.platform === "win32" ? "python" : "python3"),
    mcpServers: s.mcpServers || {},
  };
}

export const config = loadConfig();
