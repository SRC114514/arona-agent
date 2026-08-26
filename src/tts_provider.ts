// TTS Provider 抽象：不同后端实现同一接口，Node 侧据此构造 python/tts_say.py 的一次性合成命令。
//
// 已实现：
//   - aliyun    阿里云百炼非流式 TTS（默认；角色音色 = voices.json#aliyun 克隆 voice_id）
//   - gpt-sovits 云端 API / 本地 GPT-SoVITS api_v2 服务（角色音色 = voices.json#gpt-sovits 里配置的
//                .ckpt/.pth/.refAudioPath/promptText；local 未提供示例音频时回退角色素材 voice.mp3，
//                ref_text 用同目录 voice_text.txt 顶替；cloud 不回退本地素材）
//
// 命令协议：TtsCommand.env 合并进子进程环境；TtsCommand.payload 作为 stdin 单行 JSON 交给
// python/tts_say.py。play 模式不经过 provider（直接播已合成的临时 wav）。

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { config, verbose, type TtsProvider as TtsProviderId } from "./config.ts";
import { t } from "./locale.ts";
import { AGENT_IDS, type AgentId } from "./agent_registry.ts";
import {
  VOICE_SOVITS_AUDIO,
  getVoiceId,
  getGptSovitsVoice,
  type GptSovitsVoiceConfig,
} from "./voices.ts";
import { ensureGptSovitsLocalServer, persistLoadedWeights, recycleOwnedGptSovitsDaemon, touchDaemonLastUsed } from "./gpt_sovits_local.ts";
import {
  ensureOssUrlAlive,
  fetchTextFromUrl,
  invalidateOssUrl,
  isHttpUrl,
  joinPromptLines,
  uploadToOss,
} from "./oss_upload.ts";

/** GPT-SoVITS 模型版本（tts_infer.yaml 的 custom.version 取值）。 */
export type GptSovitsModelVersion = "v2" | "v2Pro" | "v3" | "v4";

// GptSovitsVoiceConfig 类型定义在 voices.ts（避免循环依赖），此处 re-export 供调用方从本模块导入。
export type { GptSovitsVoiceConfig } from "./voices.ts";

/** ttsConfig["gpt-sovits"]：GPT-SoVITS provider 专属配置。 */
export interface GptSovitsConfig {
  /**
   * cloud = 只连接远程 API（无需本地模型路径）；
   * local = 本地部署：可自动启动 api_v2（需 apiScriptPath + 模型路径），或连接用户手动启动的本地服务。
   */
  mode: "cloud" | "local";
  /** api_v2 服务地址，默认 http://127.0.0.1:9880 */
  baseUrl: string;
  /** 云端 API 可选鉴权 Key（有则请求带 Authorization: Bearer） */
  apiKey?: string;
  /** text_lang，默认 auto */
  textLang: string;
  /** prompt_lang，默认 zh */
  promptLang: string;
  /** 每句合成保险丝（毫秒），默认 60000 */
  timeoutMs: number;
  // ---- 本地部署专用 ----
  /** GPT-SoVITS 仓库根目录下的 api_v2.py 绝对路径（用于自动启动本地服务） */
  apiScriptPath?: string;
  /** 启动 api_v2 使用的 Python 可执行文件；空 = ARONA 的 pythonPath */
  pythonPath?: string;
  /** 模型版本，默认 v2 */
  modelVersion?: GptSovitsModelVersion;
  /** GPT 权重 .ckpt 路径 */
  gptModelPath?: string;
  /** SoVITS 权重 .pth 路径 */
  sovitsModelPath?: string;
  /** BERT 模型目录（chinese-roberta-wwm-ext-large） */
  bertPath?: string;
  /** CNHubert 模型目录（chinese-hubert-base） */
  cnhubertPath?: string;
  /** 推理设备，默认 cuda（可 cuda/cpu/mps） */
  device?: string;
  /** 是否半精度，默认 true */
  isHalf?: boolean;
  /**
   * api_v2 是否常驻后台（默认 true）：ARONA 退出不杀进程，下次启动秒连热服务。
   * 设为 false 恢复"退出即回收"。常驻由 detached + 日志文件 + pidfile 支撑。
   */
  keepAlive?: boolean;
  /** @deprecated 每角色音色已迁移到 voices.json#gpt-sovits；此处仅兼容读取 settings.json 旧配置（迁移后为空） */
  voices?: Partial<Record<AgentId, GptSovitsVoiceConfig>>;
}

/** 解析回退后的完整发声参数（发送给 python 前已定型）。 */
export interface ResolvedGptSovitsVoice {
  gptWeightsPath: string;
  sovitsWeightsPath: string;
  refAudioPath: string;
  promptText: string;
  promptLang: string;
  textLang: string;
}

/** 交给 python/tts_say.py 的一次性合成命令。 */
export interface TtsCommand {
  env: Record<string, string>;
  payload: Record<string, unknown>;
}

export interface TtsProvider {
  readonly id: TtsProviderId;
  label(): string;
  /** 该角色在当前 provider 下是否具备可合成音色（无音色 → 强制静音）。 */
  hasVoice(agent: AgentId): boolean;
  /** 构造合成命令（"synth_play" 默认合成+播放；"synth_only" 预合成写临时 wav）。
      异步：GPT-SoVITS 的参考音频本地文件需先上传 OSS、文字文件/URL 需先解析。 */
  buildCommand(agent: AgentId, text: string, mode: "synth_play" | "synth_only"): Promise<TtsCommand>;
  /** 每句合成+播放的时长保险丝（毫秒）。 */
  sentenceTimeoutMs(): number;
  /** GPT-SoVITS 专用：python 侧成功切换权重后回调，更新服务端已加载权重状态。 */
  ackWeights?(evt: { gpt?: string; sovits?: string }): void;
  /** 可选：合成前准备（如自动启动本地 GPT-SoVITS 服务、预上传并校验 OSS 参考音频）。 */
  prepare?(): Promise<void>;
  /** 可选：作废某角色参考音频缓存（参考音频相关错误时由调用方触发，下次合成重新上传）。 */
  markRefInvalid?(agent: AgentId): void;
}

// ------------------------------------------------------------
// GPT-SoVITS
// ------------------------------------------------------------

/** 归并 ttsConfig["gpt-sovits"]：缺省值 + 兼容读取旧 settings voices（已迁移到 voices.json#gpt-sovits）。 */
export function normalizeGptSovitsConfig(raw: unknown): GptSovitsConfig {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const voicesRaw =
    obj.voices && typeof obj.voices === "object" && !Array.isArray(obj.voices)
      ? (obj.voices as Record<string, unknown>)
      : {};
  const voices: Partial<Record<AgentId, GptSovitsVoiceConfig>> = {};
  for (const id of AGENT_IDS) {
    const v = voicesRaw[id];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const vv = v as Record<string, unknown>;
      voices[id] = {
        gptWeightsPath: typeof vv.gptWeightsPath === "string" ? vv.gptWeightsPath : "",
        sovitsWeightsPath: typeof vv.sovitsWeightsPath === "string" ? vv.sovitsWeightsPath : "",
        refAudioPath: typeof vv.refAudioPath === "string" ? vv.refAudioPath : "",
        promptText: typeof vv.promptText === "string" ? vv.promptText : "",
      };
    }
  }
  const modelVersionRaw = typeof obj.modelVersion === "string" ? obj.modelVersion : "";
  const modelVersion: GptSovitsModelVersion =
    modelVersionRaw === "v2Pro" || modelVersionRaw === "v3" || modelVersionRaw === "v4" || modelVersionRaw === "v2"
      ? modelVersionRaw
      : "v2";
  return {
    mode: obj.mode === "cloud" ? "cloud" : "local",
    baseUrl: typeof obj.baseUrl === "string" && obj.baseUrl ? obj.baseUrl : "http://127.0.0.1:9880",
    apiKey: typeof obj.apiKey === "string" ? obj.apiKey : "",
    textLang: typeof obj.textLang === "string" && obj.textLang ? obj.textLang : "auto",
    promptLang: typeof obj.promptLang === "string" && obj.promptLang ? obj.promptLang : "zh",
    timeoutMs: typeof obj.timeoutMs === "number" && obj.timeoutMs > 0 ? obj.timeoutMs : 60000,
    apiScriptPath: typeof obj.apiScriptPath === "string" ? obj.apiScriptPath : "",
    pythonPath: typeof obj.pythonPath === "string" ? obj.pythonPath : "",
    modelVersion,
    gptModelPath: typeof obj.gptModelPath === "string" ? obj.gptModelPath : "",
    sovitsModelPath: typeof obj.sovitsModelPath === "string" ? obj.sovitsModelPath : "",
    bertPath: typeof obj.bertPath === "string" ? obj.bertPath : "",
    cnhubertPath: typeof obj.cnhubertPath === "string" ? obj.cnhubertPath : "",
    device: typeof obj.device === "string" && obj.device ? obj.device : "cuda",
    isHalf: typeof obj.isHalf === "boolean" ? obj.isHalf : false,
    keepAlive: typeof obj.keepAlive === "boolean" ? obj.keepAlive : true,
    voices,
  };
}

/**
 * 参考音频语言（prompt_lang）自动判断：依据文字内容字符集。
 * 走默认素材（voice.mp3 + voice_text.txt）时固定 zh；自定义文字则按内容判断。
 * 空/无法识别 → zh（GPT-SoVITS 默认参考语言）。
 */
export function detectPromptLang(text: string): string {
  const s = (text || "").trim();
  if (!s) return "zh";
  if (/[\u3040-\u30ff]/.test(s)) return "ja"; // 日文假名（先于汉字判定，日语含假名）
  if (/[\uac00-\ud7af]/.test(s)) return "ko"; // 韩文谚文
  if (/[嘅唔喺啲嗰乜嘢嚟咗哋冇畀]/.test(s)) return "yue"; // 粤语特征字
  if (/[\u4e00-\u9fff]/.test(s)) return "zh"; // 汉字
  return "en"; // 其余（拉丁为主）
}

class GptSovitsTtsProvider implements TtsProvider {
  readonly id = "gpt-sovits" as const;

  /** 服务端当前已加载的权重；null = 未知（首次遇到配置权重的角色必须切换一次）。 */
  private loadedGpt: string | null = null;
  private loadedSovits: string | null = null;

  /** 每角色解析结果缓存（ref/prompt 已按 路径/URL 解析定型；URL 长期有效，会话内复用）。 */
  private resolved = new Map<AgentId, ResolvedGptSovitsVoice>();
  /** ref 来源元信息：仅记录"本地文件已上传 OSS"的角色与其源路径（校验/重传用）。 */
  private refOssSource = new Map<AgentId, { sourcePath: string }>();

  constructor(private cfg: GptSovitsConfig) {}

  label(): string {
    return "GPT-SoVITS";
  }

  /** 该角色 GPT-SoVITS 音色配置：优先 voices.json#gpt-sovits（已迁移的权威来源），回退 settings 旧 voices。 */
  private voiceFor(agent: AgentId): GptSovitsVoiceConfig | undefined {
    return getGptSovitsVoice(agent) ?? this.cfg.voices?.[agent];
  }

  hasVoice(agent: AgentId): boolean {
    const v = this.voiceFor(agent);
    if (!v) return false;
    if (this.cfg.mode === "cloud") {
      // 云端：本地路径（将上传 OSS 换 URL）或 URL 都视为有音色，仅空串无音色
      return !!v.refAudioPath?.trim();
    }
    const explicitRef = v.refAudioPath?.trim() || "";
    if (explicitRef && existsSync(explicitRef)) return true;
    // local 未配置/配置缺失 → 一律用角色素材 voice_sovits.mp3（各角色素材均已内置，无需判断存在）
    return true;
  }

  /**
   * 解析参考音频与对应文字（async：云端本地 ref 需上传 OSS、文字文件/URL 需读取/抓取）。
   * 每次请求时解析并缓存（用户之后手动补 voice_text.txt / 换文件无需重启即生效）。
   */
  private async resolveVoice(agent: AgentId): Promise<ResolvedGptSovitsVoice> {
    const v = this.voiceFor(agent);
    const explicitRef = v?.refAudioPath?.trim() || "";
    const bundledAudio = VOICE_SOVITS_AUDIO[agent];
    let refAudioPath: string;
    let usingBundled = false;
    let ossSource: string | null = null; // 仅"本地文件已上传 OSS"时非空（校验/重传用）

    if (this.cfg.mode === "cloud") {
      if (isHttpUrl(explicitRef)) {
        // 已是远端 URL：云端服务端可直接引用
        refAudioPath = explicitRef;
      } else if (existsSync(explicitRef)) {
        // 本地文件 → 上传阿里云 OSS 换取长期 URL（会话内缓存，失效时重传）
        ossSource = explicitRef;
        refAudioPath = await uploadToOss(explicitRef, config.ttsApiKey);
      } else if (!explicitRef) {
        // 云端不回退本地素材（与 hasVoice 判定一致：无 ref 即无音色，正常不会走到这里）
        refAudioPath = "";
      } else {
        throw new Error(t(
          `GPT-SoVITS 参考音频不存在: ${explicitRef}`,
          `GPT-SoVITS ref audio not found: ${explicitRef}`,
        ));
      }
    } else {
      if (explicitRef && !existsSync(explicitRef) && !isHttpUrl(explicitRef)) {
        // 用户填的本地 ref 不存在：回退角色素材（与 hasVoice 判定一致）
        refAudioPath = bundledAudio || explicitRef;
        usingBundled = !!bundledAudio;
      } else if (explicitRef) {
        // 本地路径或 URL 均透传（本地服务端自行解析）
        refAudioPath = explicitRef;
      } else {
        refAudioPath = bundledAudio;
        usingBundled = !!bundledAudio;
      }
    }
    if (ossSource) this.refOssSource.set(agent, { sourcePath: ossSource });
    else this.refOssSource.delete(agent);

    let promptText = v?.promptText?.trim() || "";
    if (usingBundled && !promptText) {
      const infoPath = join(dirname(VOICE_SOVITS_AUDIO[agent]), "voice_text.txt");
      if (existsSync(infoPath)) {
        try {
          promptText = readFileSync(infoPath, "utf-8").trim();
        } catch {
          promptText = "";
        }
      }
    } else if (promptText) {
      if (isHttpUrl(promptText)) {
        promptText = await fetchTextFromUrl(promptText);
      } else if (existsSync(promptText)) {
        try {
          promptText = readFileSync(promptText, "utf-8");
        } catch {
          promptText = "";
        }
      }
      // 其余视为字面量文字
    }
    // 多行合并为一行：行尾缺句末标点按中英文智能补「。」/「.」（单行输入原样返回）
    promptText = joinPromptLines(promptText);

    return {
      gptWeightsPath: v?.gptWeightsPath?.trim() || "",
      sovitsWeightsPath: v?.sovitsWeightsPath?.trim() || "",
      refAudioPath,
      promptText,
      // 参考语言：走默认素材固定 zh；自定义文字按内容自动判断（空→zh）
      promptLang: usingBundled ? "zh" : detectPromptLang(promptText),
      textLang: this.cfg.textLang,
    };
  }

  /** 解析并缓存（幂等）；buildCommand / prepare 共用，返回的 voice 对象可被调用方原地改 URL。 */
  private async ensureResolved(agent: AgentId): Promise<ResolvedGptSovitsVoice> {
    const cached = this.resolved.get(agent);
    if (cached) return cached;
    const voice = await this.resolveVoice(agent);
    this.resolved.set(agent, voice);
    return voice;
  }

  /** 会话内校验一次 OSS URL；失效则重传并刷新缓存（"发现无效→重新走上传流程"）。 */
  private async verifyResolvedRefs(): Promise<void> {
    for (const agent of AGENT_IDS) {
      const src = this.refOssSource.get(agent);
      if (!src) continue;
      const voice = this.resolved.get(agent);
      if (!voice?.refAudioPath) continue;
      try {
        const fresh = await ensureOssUrlAlive(src.sourcePath, voice.refAudioPath, config.ttsApiKey);
        if (fresh !== voice.refAudioPath) voice.refAudioPath = fresh;
      } catch (err) {
        console.warn(t(
          `GPT-SoVITS 参考音频上传/校验失败: ${err instanceof Error ? err.message : String(err)}`,
          `GPT-SoVITS ref audio upload/verify failed: ${err instanceof Error ? err.message : String(err)}`,
        ));
        // 清缓存：下次 buildCommand 重新上传
        this.resolved.delete(agent);
        this.refOssSource.delete(agent);
      }
    }
  }

  async buildCommand(agent: AgentId, text: string, mode: "synth_play" | "synth_only"): Promise<TtsCommand> {
    const voice = await this.ensureResolved(agent);
    const switchGpt = !!voice.gptWeightsPath && voice.gptWeightsPath !== this.loadedGpt;
    const switchSovits = !!voice.sovitsWeightsPath && voice.sovitsWeightsPath !== this.loadedSovits;
    const payload: Record<string, unknown> = {
      provider: "gpt-sovits",
      text,
      baseUrl: this.cfg.baseUrl,
      apiKey: this.cfg.apiKey || "",
      refAudioPath: voice.refAudioPath,
      promptText: voice.promptText,
      promptLang: voice.promptLang,
      textLang: voice.textLang,
      // HTTP 超时 = 保险丝 − 5s：合成挂死时 python 先报真实错误（urlopen 原因），
      // Node 保险丝（这个 provider 的 timeoutMs）只作最后兜底，不再静默吞错
      timeoutMs: Math.max(this.cfg.timeoutMs - 5000, 10000),
      gptWeightsPath: voice.gptWeightsPath,
      sovitsWeightsPath: voice.sovitsWeightsPath,
      switchGpt,
      switchSovits,
    };
    if (mode === "synth_only") payload.mode = "synth_only";
    return { env: {}, payload };
  }

  sentenceTimeoutMs(): number {
    return this.cfg.timeoutMs;
  }

  ackWeights(evt: { gpt?: string; sovits?: string }): void {
    if (typeof evt.gpt === "string") this.loadedGpt = evt.gpt;
    if (typeof evt.sovits === "string") this.loadedSovits = evt.sovits;
    // 持久化到 pidfile（仅自有 daemon 场景生效，外部服务不写）：
    // 下次复用 daemon 时读回，遇相同说话角色零切换。
    persistLoadedWeights({ gpt: this.loadedGpt ?? undefined, sovits: this.loadedSovits ?? undefined });
  }

  async prepare(): Promise<void> {
    // 确保本地服务就绪；自有 daemon（digest 匹配被复用/冷启动）返回当前已加载权重 → ack，首句免切换；
    // 外部服务返回 null → 不 ack（防止拿错权重致音色错乱，宁可首句多切换一次）。
    const w = await ensureGptSovitsLocalServer(this.cfg);
    if (w) this.ackWeights(w);
    // 每轮合成入口即视为"正在使用"：重置 daemon 空闲计时（空闲 30 分钟未合成才会被回收）
    touchDaemonLastUsed();
    if (this.cfg.mode !== "cloud") return;
    // 云端：预解析所有已配置音色角色（本地 ref 上传 OSS），再会话内校验一次 OSS URL。
    // 上传/校验失败只告警不阻塞队列，后续 buildCommand 失败时由 markRefInvalid 重传。
    for (const agent of AGENT_IDS) {
      if (!this.hasVoice(agent)) continue;
      try {
        await this.ensureResolved(agent);
      } catch (err) {
        console.warn(t(
          `GPT-SoVITS 参考音频准备失败: ${err instanceof Error ? err.message : String(err)}`,
          `GPT-SoVITS ref audio prepare failed: ${err instanceof Error ? err.message : String(err)}`,
        ));
        this.resolved.delete(agent);
        this.refOssSource.delete(agent);
      }
    }
    await this.verifyResolvedRefs();
  }

  /** 作废某角色参考音频缓存（合成报参考音频相关错误时由 tts_stream 触发，下次合成重新上传）。 */
  markRefInvalid(agent: AgentId): void {
    const src = this.refOssSource.get(agent);
    this.resolved.delete(agent);
    this.refOssSource.delete(agent);
    if (src) invalidateOssUrl(src.sourcePath);
  }
}

// ------------------------------------------------------------
// Aliyun（百炼）
// ------------------------------------------------------------

class AliyunTtsProvider implements TtsProvider {
  readonly id = "aliyun" as const;

  label(): string {
    return t("阿里云百炼", "Aliyun Bailian");
  }

  hasVoice(agent: AgentId): boolean {
    return getVoiceId(agent) !== "";
  }

  async buildCommand(agent: AgentId, text: string, mode: "synth_play" | "synth_only"): Promise<TtsCommand> {
    const voiceId = getVoiceId(agent);
    const payload: Record<string, unknown> = {
      provider: "aliyun",
      text,
      voice: voiceId,
      // HTTP 超时 = 保险丝(30s) − 5s：合成挂死时 python 先报真实错误，Node 保险丝只作最后兜底
      timeoutMs: 25_000,
    };
    if (mode === "synth_only") payload.mode = "synth_only";
    return {
      env: {
        QWEN_WORKSPACE_ID: config.workspaceId,
        QWEN_TTS_API_KEY: config.ttsApiKey,
        QWEN_TTS_MODEL: config.ttsModel,
        QWEN_TTS_VOICE: voiceId,
      },
      payload,
    };
  }

  sentenceTimeoutMs(): number {
    return 30_000;
  }

  ackWeights(): void {
    // 百炼无需切换权重
  }
}

// ------------------------------------------------------------
// Factory
// ------------------------------------------------------------

let providerInstance: TtsProvider | undefined;

export function getTtsProvider(): TtsProvider {
  if (!providerInstance) {
    providerInstance =
      config.ttsProvider === "gpt-sovits"
        ? new GptSovitsTtsProvider(normalizeGptSovitsConfig(config.ttsConfig["gpt-sovits"]))
        : new AliyunTtsProvider();
    if (verbose) {
      console.error(`[tts] provider active = ${providerInstance.id}`);
      if (providerInstance.id === "gpt-sovits") {
        console.error(`[tts] gpt-sovits mode=${(config.ttsConfig?.["gpt-sovits"] as { mode?: string } | undefined)?.mode ?? "?"} baseUrl=${(config.ttsConfig?.["gpt-sovits"] as { baseUrl?: string } | undefined)?.baseUrl ?? "?"}`);
      }
    }
  }
  return providerInstance;
}

/**
 * 启动预热：本地 GPT-SoVITS 在程序启动时后台 spawn api_v2 并加载模型（fire-and-forget，不阻塞 CLI）。
 * 首次 TTS 时服务通常已就绪，避免"没声音/卡 180s"式的冷启动等待。
 * 条件：provider=gpt-sovits、local 模式、非 --no-voice、存在可加载的默认权重（全局或每角色）。
 * 失败仅打日志，不影响主流程（首次 TTS 的 drain prepare 仍会按原路径再尝试并给出明确报错）。
 */
export function preloadGptSovitsLocal(): void {
  if (config.noVoice) return;
  if (config.ttsProvider !== "gpt-sovits") {
    // 已切到其它 provider（如 aliyun）：回收残留的本地 GPT-SoVITS 守护进程。
    // 父进程已退出、空闲巡检不再认领的孤儿常占 ~1GB 内存；pidfile + 命令行特征
    // 双重确认只动 ARONA 自己 spawn 的 daemon，不误杀外部手动启动的服务。
    void recycleOwnedGptSovitsDaemon();
    return;
  }
  const cfg = normalizeGptSovitsConfig(config.ttsConfig["gpt-sovits"]);
  if (cfg.mode !== "local") return;
  const hasGpt =
    !!cfg.gptModelPath?.trim() ||
    AGENT_IDS.some((id) => !!getGptSovitsVoice(id)?.gptWeightsPath?.trim());
  const hasSovits =
    !!cfg.sovitsModelPath?.trim() ||
    AGENT_IDS.some((id) => !!getGptSovitsVoice(id)?.sovitsWeightsPath?.trim());
  if (!hasGpt || !hasSovits) {
    if (verbose) console.error("[tts] preload gpt-sovits skipped: 无可用默认权重");
    return;
  }
  if (verbose) console.error(`[tts] preload gpt-sovits local (${cfg.baseUrl})`);
  void ensureGptSovitsLocalServer(cfg)
    .then((w) => {
      if (w) getTtsProvider().ackWeights?.(w); // 复用/冷启动时 ack 已加载权重，首句免切换
    })
    .catch((err) => {
      if (verbose) console.error(`[tts] preload gpt-sovits failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  // Mac 上用 cpu 推理明显慢于 mps：提示但不自动改配置（尊重显式选择；老 Mac 可能不支持 MPS）。
  if (process.platform === "darwin" && cfg.device === "cpu") {
    console.error(t(
      "提示：GPT-SoVITS 推理设备为 cpu，Mac 上改用 device 字段的 mps 可显著提升合成速度。",
      "Hint: GPT-SoVITS device=cpu; on Mac switching device to mps speeds up synthesis significantly.",
    ));
  }
}