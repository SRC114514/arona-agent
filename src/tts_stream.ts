import type { ChildProcessWithoutNullStreams } from "child_process";
import { join } from "path";
import { PYTHON_DIR, config, verbose } from "./config.ts";
import { t, getLang } from "./locale.ts";
import { spawnCompat, stripProxyEnv } from "./utils/spawn.ts";
import { stripMarkdown } from "./voice.ts";
import { getMainAgent, type AgentId } from "./agent_registry.ts";
import { getVoiceId } from "./voices.ts";
import { splitStreamedText, countTextUnits } from "./text_split.ts";

/**
 * 实时流式 TTS 管道（阿里云百炼"实时语音合成"）。
 *
 * 与常驻 Python 进程 python/tts_stream.py 通过 stdin/stdout JSON 行通信：
 *   发送：{"type":"text","data":"..."} / {"type":"end"} / {"type":"cancel"} / {"type":"voice","data":"<id>"} / {"type":"exit"}
 *   接收：{"event":"ready"} / {"event":"play_start"} / {"event":"play_end"} / {"event":"error","message":...}
 *
 * 行为约定：
 *   - LLM text_delta 边生成边按句切分推送合成（共享 text_split.ts：标点边界 + 连续标点归同句，不强切）
 *   - 围栏代码块（```...```）整块剔除不朗读（跨 delta 状态机，未闭合时挂起等待闭合标记）
 *   - 句内 markdown（行内代码/加粗/链接等）在成句后剔除
 *   - 长句跳过：字数 >= 50 不朗读；字数 = 中文每字 1、英文单词 1、符号不计（countTextUnits）
 *   - 音频固定 pcm，Python 侧 pyaudio 边收边播；pyaudio 不可用自动降级缓冲播放
 */
const MAX_SENTENCE_LEN = 50; // 字数（countTextUnits 口径）>= 50 的句子不朗读
const TTS_FORCE_SPLIT_LEN = 9999; // 仅标点切句、不强切（超长无标点文本按长句规则整句跳过）
const READY_TIMEOUT_MS = 10000;

/** 统计字符串尾部连续反引号数（最多计 2 个：可能是被 delta 切断的 ``` 围栏标记）。 */
function trailingFenceTicks(s: string): number {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && n < 2; i--) {
    if (s[i] === "`") n++;
    else break;
  }
  return n;
}

interface OutgoingCmd {
  type: "text" | "end" | "cancel" | "voice";
  data?: string;
}

export class TtsStream {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private ready = false;
  private pendingCount = 0; // 活跃播放段数（play_start +1 / play_end -1），>0 表示还有声音在播
  private buffer = ""; // 未处理文本（切句残段 + 可能被 delta 切断的围栏/未闭合代码块内容）
  private inCodeBlock = false; // 跨 delta 的 ``` 围栏状态：true = 正处于代码块内，暂不切句
  private nodeQueue: OutgoingCmd[] = [];
  private draining = false;
  private startPromise: Promise<boolean> | null = null;
  private readyResolve: (() => void) | null = null;
  private shuttingDown = false;
  // 当前 TTS 音色对应角色；主 Agent 在构造时确定，子 Agent 轮询前由 setVoice 切换
  private currentAgent: AgentId = getMainAgent();

  constructor(
    private isEnabledFor: (agent: AgentId) => boolean,
    private onIdle?: () => void,
  ) {}

  /** 当前是否有未播放完的合成段（供 repl 判断 pet.reset 时机） */
  get isPending(): boolean {
    return this.pendingCount > 0;
  }

  /** 当前 TTS 音色所属角色 */
  get currentAgentId(): AgentId {
    return this.currentAgent;
  }

  /**
   * 切换当前朗读角色音色。必须在上一角色 endSegment（finish-task）之后、下一角色 pushText 之前调用，
   * 保证语音切换落在段边界（"语音"指令在队列中位于 end 之后、text 之前）。
   */
  setVoice(agentId: AgentId): void {
    if (this.currentAgent === agentId) return;
    this.currentAgent = agentId;
    this.enqueue({ type: "voice", data: getVoiceId(agentId) });
  }

  /**
   * LLM 文本增量（text_delta）实时推送。剔除代码块后按标点切句，<50 字的句子立即送入合成。
   */
  pushText(delta: string): void {
    if (!this.isEnabledFor(this.currentAgent)) return;
    if (!delta) return;
    this.ingestDelta(delta);
  }

  /**
   * 当前 assistant 消息结束：残段按同规则收尾（未闭合代码块整段丢弃），并结束当前合成段（finish-task）。
   */
  endSegment(): void {
    if (!this.isEnabledFor(this.currentAgent)) return;
    if (this.inCodeBlock) {
      // 消息结束仍未等到闭合围栏：其后的内容都在代码块内，整段丢弃
      this.buffer = "";
      this.inCodeBlock = false;
    } else {
      const leftover = this.buffer.trim();
      this.buffer = "";
      if (leftover) this.emitSentence(leftover);
    }
    this.enqueue({ type: "end" });
  }

  /**
   * 打断当前合成（新输入 / Esc / Ctrl+C / STT 触发时调用）。
   */
  cancel(): void {
    this.buffer = "";
    this.inCodeBlock = false;
    // 丢弃排队中未发送的文本/结束指令（保留可能的 cancel）
    this.nodeQueue = this.nodeQueue.filter((c) => c.type === "cancel");
    this.pendingCount = 0;
    if (this.proc && this.ready) {
      this.enqueue({ type: "cancel" });
    }
  }

  /**
   * 切换角色后重启 TTS 进程（音色在 spawn 时按当前主 Agent 固化，需杀进程重拉）。
   * 不置 shuttingDown——下次 pushText 自动以新角色音色重新拉起。
   */
  restartVoice(): void {
    this.cancel();
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // 忽略
      }
    }
    // proc.on("close") 已重置 proc/ready/startPromise，无需手动清。
  }

  /** 退出时停止常驻进程 */
  shutdown(): void {
    this.shuttingDown = true;
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    if (proc && !proc.killed) {
      try {
        proc.stdin.write(JSON.stringify({ type: "exit" }) + "\n");
      } catch {
        // 忽略
      }
      // 兜底：0.5s 后仍未退出则强杀。必须闭包捕获局部 proc——this.proc 已置 null，
      // 旧写法引用 this.proc 永远杀不到（python 卡死时会残留僵尸进程占用麦克风/声道）
      const killer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // 忽略
        }
      }, 500);
      killer.unref?.(); // 不阻塞进程退出；stdin 断开后 python 侧 read_stdin 会自行退出
    }
  }

  // ------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------

  /** 把待发指令入队并触发发送（幂等） */
  private enqueue(cmd: OutgoingCmd): void {
    this.nodeQueue.push(cmd);
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      if (!(await this.ensureStarted())) {
        // 启动失败（如 API Key 缺失）：丢弃全部待发指令并复位 pending
        this.nodeQueue = [];
        this.pendingCount = 0;
        return;
      }
      while (this.nodeQueue.length > 0) {
        const cmd = this.nodeQueue.shift()!;
        this.send(cmd);
      }
    } finally {
      this.draining = false;
    }
  }

  private send(cmd: OutgoingCmd): void {
    if (!this.proc || this.proc.killed) return;
    try {
      this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    } catch {
      // 忽略
    }
  }

  /**
   * 处理一段新到达的增量：先用围栏状态机剔除代码块，再把安全文本按标点切句。
   * - 完整 ```...``` 块整块丢弃（代码不朗读）；块内容可能跨多个 delta，未闭合前全部挂起。
   * - 尾部 1-2 个连续反引号可能是被 delta 切断的围栏起始/结束，暂留 buffer 等下一 delta 判定。
   */
  private ingestDelta(delta: string): void {
    let rest = this.buffer + delta;
    let safe = "";
    for (;;) {
      const fence = rest.indexOf("```");
      if (!this.inCodeBlock) {
        if (fence === -1) {
          const hold = trailingFenceTicks(rest);
          safe += rest.slice(0, rest.length - hold);
          rest = rest.slice(rest.length - hold);
          break;
        }
        safe += rest.slice(0, fence) + " "; // 补空格，避免删除代码块后前后词粘连
        rest = rest.slice(fence + 3);
        this.inCodeBlock = true;
      } else {
        if (fence === -1) break; // 未闭合：内容原样挂在 buffer，等闭合围栏到达后重扫
        rest = rest.slice(fence + 3);
        this.inCodeBlock = false;
      }
    }
    // 英文句末句号不在切句边界集（。！？!?\n）内：把后跟空白的句末 "." / "..." 归一为
    // 中文句号再切句，否则英文句子会与后续文本粘连成超长句被整段跳过。
    // 小数点/版本号（"3.12"、"qwen-audio-3.0"）后跟非空白，不受影响。
    safe = safe.replace(/\.+(?=\s)/g, "。");
    const { sentences, rest: rem } = splitStreamedText(safe, TTS_FORCE_SPLIT_LEN);
    for (const s of sentences) this.emitSentence(s);
    this.buffer = rem + rest;
  }

  /**
   * 句级过滤：剔除句内 markdown 后按字数判断。字数口径 = 中文每字 1、英文单词 1、
   * 符号不计（countTextUnits）；字数为 0（纯符号）或 >= 50 的句子不朗读。
   */
  private emitSentence(sentence: string): void {
    const clean = stripMarkdown(sentence).trim();
    if (!clean) return;
    const units = countTextUnits(clean);
    if (units === 0 || units >= MAX_SENTENCE_LEN) return;
    this.enqueue({ type: "text", data: clean });
  }

  /** 懒启动常驻 Python 进程，等待 ready。失败返回 false（后续调用会重试）。 */
  private ensureStarted(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.startPromise) return this.startPromise;
    if (this.shuttingDown) return Promise.resolve(false);
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private doStart(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.ready = ok;
        // 失败后清缓存：否则 startPromise 永远持有 resolved(false) 的 Promise，
        // ensureStarted 后续全部直接返回 false，TTS 一次性永久失效（进程也不会重拉）
        if (!ok) this.startPromise = null;
        resolve(ok);
      };
      try {
        const proc = spawnCompat(config.pythonPath, ["-u", join(PYTHON_DIR, "tts_stream.py")], {
          env: stripProxyEnv({
            ...process.env,
            ARONA_LANG: getLang(),
            PYTHONUTF8: "1",
            QWEN_WORKSPACE_ID: config.workspaceId,
            QWEN_TTS_API_KEY: config.ttsApiKey,
            QWEN_TTS_MODEL: config.ttsModel,
            QWEN_TTS_VOICE: getVoiceId(this.currentAgent),
            QWEN_TTS_SAMPLE_RATE: String(config.ttsSampleRate),
          }),
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.proc = proc;

        const timer = setTimeout(() => {
          try {
            proc.kill("SIGTERM");
          } catch {
            // 忽略
          }
          settle(false);
        }, READY_TIMEOUT_MS);

        this.readyResolve = () => {
          clearTimeout(timer);
          settle(true);
        };

        proc.stdout.on("data", (data) => {
          this.stdoutBuffer += data.toString();
          this.processEvents();
        });
        proc.stderr.on("data", (data) => {
          // 非 --verbose 启动时静默 Python stderr，避免刷 [python:tts_stream] 日志
          if (!verbose) return;
          const msg = data.toString().trim();
          if (msg) console.error(`[python:tts_stream]`, msg);
        });
        proc.on("close", () => {
          clearTimeout(timer);
          // 进程退出（崩溃/被杀）后允许下次指令重新拉起；guard 防止旧进程的
          // 迟到 close 事件清掉新拉起进程的状态
          if (this.proc === proc) {
            this.proc = null;
            this.ready = false;
            this.readyResolve = null;
            this.startPromise = null;
          }
          settle(false);
        });
        proc.on("error", () => {
          clearTimeout(timer);
          settle(false);
        });
      } catch {
        settle(false);
      }
    });
  }

  private processEvents(): void {
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt: { event?: string; message?: string };
      try {
        evt = JSON.parse(trimmed);
      } catch {
        continue;
      }
      switch (evt.event) {
        case "ready":
          this.readyResolve?.();
          this.readyResolve = null;
          break;
        case "play_start":
          this.pendingCount++;
          break;
        case "play_end":
          // 计数归零才触发空闲回调（play_end 可能重复：cancel 与连接收尾各发一次）
          if (this.pendingCount > 0) {
            this.pendingCount--;
            if (this.pendingCount === 0) {
              this.onIdle?.();
            }
          }
          break;
        case "error":
          console.warn(t(`TTS: ${evt.message ?? "unknown error"}`, `TTS: ${evt.message ?? "unknown error"}`));
          break;
        default:
          break;
      }
    }
  }
}
