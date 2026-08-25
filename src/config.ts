import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { t, type LanguageSetting } from "./locale.ts";

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

/** 已实现的 TTS Provider。 */
export type TtsProvider = "aliyun" | "gpt-sovits";

export const TTS_PROVIDER_IDS: readonly TtsProvider[] = ["aliyun", "gpt-sovits"];

/** settings.json 中 ttsProvider 的原始值解析：未知/未实现回退 aliyun 并警告一次。 */
function resolveTtsProvider(raw: unknown): TtsProvider {
  if (typeof raw === "string" && (TTS_PROVIDER_IDS as readonly string[]).includes(raw)) {
    return raw as TtsProvider;
  }
  if (typeof raw === "string" && raw) {
    console.warn(t(`[tts] 未知 ttsProvider "${raw}"，已回退 aliyun`, `[tts] unknown ttsProvider "${raw}", falling back to aliyun`));
  }
  return "aliyun";
}

interface AronaConfig {
  // LLM
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  thinkingLevel: string;
  // 上下文窗口（token 数）：用于压缩阈值推导。settings.json 直接填数字（如 1000000），不填默认 1M。
  contextWindow: number;
  // Voice (Qwen / 阿里云百炼 DashScope)
  noVoice: boolean;
  // TTS 后端：aliyun（默认，百炼） | gpt-sovits（本地 api_v2 服务）
  ttsProvider: TtsProvider;
  // 各 Provider 专属配置（键 = provider id）。百炼沿用顶层 ttsApiKey/ttsModel/workspaceId，不入此表。
  ttsConfig: Record<string, unknown>;
  // 百炼业务空间 ID（可选；留空走旧域名 dashscope.aliyuncs.com）
  workspaceId: string;
  ttsApiKey: string;
  ttsModel: string;
  // 系统音色名 或 自定义音色(声音复刻)ID —— 填声音复刻得到的 voice_id 即用自定义音色
  ttsVoice: string;
  ttsSampleRate: number;
  sttApiKey: string;
  sttModel: string;
  sttFormat: string;
  sttSampleRate: number;
  ttsEnabled: boolean;
  sttEnabled: boolean;
  // Cua
  cuaApiKey: string;
  // Tavily（网页搜索；留空走 keyless 共享池，免费限流）
  tavilyApiKey: string;
  // Misc
  pythonPath: string;
  mcpServers: Record<string, McpServerConfig>;
}

interface Settings {
  apiKey?: string;
  apiBaseUrl?: string;
  model?: string;
  thinkingLevel?: string;
  // 上下文窗口（token 数），默认 1M。用于压缩阈值推导，不填 SDK 走模型注册表。
  contextWindow?: number;
  language?: LanguageSetting;
  // 主 Agent（arona | plana）：桌宠形象 + 人格，由 agent_registry.ts 读写
  mainAgent?: string;
  // 启用的子 Agent 列表（shiroko | hoshino），由 agent_registry.ts 读写
  subAgents?: string[];
  ttsEnabled?: boolean;
  sttEnabled?: boolean;
  /** @deprecated 已合并进 ttsEnabled，仅读兼容（旧配置 ttsAuto:false 仍生效） */
  ttsAuto?: boolean;
  /** TTS 后端（aliyun | gpt-sovits） */
  ttsProvider?: string;
  /** 各 Provider 专属配置（键 = provider id；百炼沿用顶层 TTS 字段） */
  ttsConfig?: Record<string, unknown>;
  workspaceId?: string;
  ttsApiKey?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsSampleRate?: number;
  sttApiKey?: string;
  sttModel?: string;
  sttFormat?: string;
  sttSampleRate?: number;
  cuaApiKey?: string;
  // Tavily API Key（可选）：不填则 web_search/web_extract 走 keyless 共享池
  tavilyApiKey?: string;
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
    console.warn(t("settings.json 解析失败，使用默认配置", "Failed to parse settings.json, using defaults"));
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

function loadConfig(): AronaConfig {
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
    contextWindow: typeof s.contextWindow === "number" && s.contextWindow > 0 ? s.contextWindow : 1000000,

    ttsProvider: resolveTtsProvider(s.ttsProvider),
    ttsConfig: s.ttsConfig && typeof s.ttsConfig === "object" && !Array.isArray(s.ttsConfig) ? s.ttsConfig : {},

    noVoice,
    // Skip TTS/STT fields when --no-voice is set
    workspaceId: noVoice ? "" : (s.workspaceId || ""),
    ttsApiKey: noVoice ? "" : (s.ttsApiKey || ""),
    ttsModel: noVoice ? "" : (s.ttsModel || "qwen-audio-3.0-tts-plus"),
    ttsVoice: noVoice ? "" : (s.ttsVoice || ""),
    ttsSampleRate: noVoice ? 22050 : (s.ttsSampleRate || 22050),
    sttApiKey: noVoice ? "" : (s.sttApiKey || ""),
    sttModel: noVoice ? "" : (s.sttModel || "qwen-audio-3.0-asr-flash-streaming"),
    sttFormat: noVoice ? "pcm" : (s.sttFormat || "pcm"),
    sttSampleRate: noVoice ? 16000 : (s.sttSampleRate || 16000),
    // ttsAuto 已合并进 ttsEnabled（旧配置兼容：ttsAuto ?? true）
    ttsEnabled: noVoice ? false : (s.ttsEnabled ?? s.ttsAuto ?? true),
    sttEnabled: noVoice ? false : (s.sttEnabled ?? true),

    cuaApiKey: s.cuaApiKey || "",
    tavilyApiKey: s.tavilyApiKey || "",

    pythonPath: s.pythonPath || (process.platform === "win32" ? "python" : "python3"),
    mcpServers: s.mcpServers || {},
  };
}

export const config = loadConfig();

/**
 * STT 全局热键键名（pynput 命名，供 repl.ts 注入 ARONA_HOTKEY_KEY）：
 * macOS 右 Cmd（pynput 有 Key.cmd_r），Windows/Linux 右 Ctrl（pynput Key.ctrl_r 三平台皆有效）。
 * Windows 没有 Key.cmd_r，默认 cmd_r 在那会是静默失效，故按平台自动选。
 */
export function sttHotkeyKey(): string {
  return process.platform === "darwin" ? "cmd_r" : "ctrl_r";
}

/** STT 全局热键显示名（用户可见，双语简洁）。右 Ctrl 提示一句话即可，不追加文案。 */
export function sttHotkeyLabel(): string {
  return process.platform === "darwin"
    ? t("右 Cmd", "right Cmd")
    : t("右 Ctrl", "right Ctrl");
}
