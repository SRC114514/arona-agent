import type { ChildProcessWithoutNullStreams } from "child_process";
import { join } from "path";
import { PYTHON_DIR, config } from "./config.ts";
import { t, getLang } from "./locale.ts";
import { spawnCompat, stripProxyEnv } from "./utils/spawn.ts";
import { stripMarkdown } from "./voice.ts";

/**
 * 实时流式 TTS 管道（阿里云百炼"实时语音合成"）。
 *
 * 与常驻 Python 进程 python/tts_stream.py 通过 stdin/stdout JSON 行通信：
 *   发送：{"type":"text","data":"..."} / {"type":"end"} / {"type":"cancel"} / {"type":"exit"}
 *   接收：{"event":"ready"} / {"event":"play_start"} / {"event":"play_end"} / {"event":"error","message":...}
 *
 * 行为约定（与旧版 enqueueTts 一致）：
 *   - LLM text_delta 边生成边按句切分（。！？\n 为边界）推送合成，中间过程与最终回复统一覆盖
 *   - "长段跳过"：句子长度 >= 50 字不朗读（仅 <50 字的短句实时朗读）
 *   - 音频固定 pcm，Python 侧 pyaudio 边收边播；pyaudio 不可用自动降级缓冲播放
 */
const MAX_SENTENCE_LEN = 50; // 与旧版一致：>= 50 字跳过
const SENTENCE_BOUNDARY = /[。！？!?\n]/;
const READY_TIMEOUT_MS = 10000;

interface OutgoingCmd {
  type: "text" | "end" | "cancel";
  data?: string;
}

export class TtsStream {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private ready = false;
  private pendingCount = 0; // 活跃播放段数（play_start +1 / play_end -1），>0 表示还有声音在播
  private buffer = ""; // 未成句的残段（等待后续 delta 补全）
  private nodeQueue: OutgoingCmd[] = [];
  private draining = false;
  private startPromise: Promise<boolean> | null = null;
  private readyResolve: (() => void) | null = null;
  private shuttingDown = false;

  constructor(
    private isEnabled: () => boolean,
    private onIdle?: () => void,
  ) {}

  /** 当前是否有未播放完的合成段（供 repl 判断 pet.reset 时机） */
  get isPending(): boolean {
    return this.pendingCount > 0;
  }

  /**
   * LLM 文本增量（text_delta）实时推送。按句切分后，<50 字的句子立即送入合成。
   */
  pushText(delta: string): void {
    if (!this.isEnabled()) return;
    if (!delta) return;
    this.buffer += delta;
    this.flushSentences(false);
  }

  /**
   * 当前 assistant 消息结束：残段按同规则收尾，并结束当前合成段（finish-task）。
   */
  endSegment(): void {
    if (!this.isEnabled()) return;
    this.flushSentences(true);
    this.enqueue({ type: "end" });
  }

  /**
   * 打断当前合成（新输入 / Esc / Ctrl+C / STT 触发时调用）。
   */
  cancel(): void {
    this.buffer = "";
    // 丢弃排队中未发送的文本/结束指令（保留可能的 cancel）
    this.nodeQueue = this.nodeQueue.filter((c) => c.type === "cancel");
    this.pendingCount = 0;
    if (this.proc && this.ready) {
      this.enqueue({ type: "cancel" });
    }
  }

  /** 退出时停止常驻进程 */
  shutdown(): void {
    this.shuttingDown = true;
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.stdin.write(JSON.stringify({ type: "exit" }) + "\n");
      } catch {
        // 忽略
      }
      // 兜底：0.5s 后仍未退出则强杀
      setTimeout(() => {
        try {
          this.proc?.kill("SIGTERM");
        } catch {
          // 忽略
        }
      }, 500);
    }
    this.proc = null;
    this.ready = false;
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

  /** 切分句子并推送可朗读内容（长句跳过）。isEnd=true 时残段也按规则收尾。 */
  private flushSentences(isEnd: boolean): void {
    if (!this.buffer) return;
    let rest = this.buffer;
    const sentences: string[] = [];
    let idx = 0;
    while (idx < rest.length) {
      if (SENTENCE_BOUNDARY.test(rest[idx])) {
        const sent = rest.slice(0, idx + 1).trim();
        if (sent) sentences.push(sent);
        rest = rest.slice(idx + 1);
        idx = 0;
      } else {
        idx++;
      }
    }
    this.buffer = rest; // 无边界残段留待下一 delta
    for (const s of sentences) this.emitSentence(s);
    if (isEnd && rest.trim()) {
      this.buffer = "";
      this.emitSentence(rest.trim());
    }
  }

  /** 句级过滤：<50 字才朗读（保持"长段跳过"语义） */
  private emitSentence(sentence: string): void {
    const clean = stripMarkdown(sentence).trim();
    if (!clean || clean.length >= MAX_SENTENCE_LEN) return;
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
            QWEN_TTS_VOICE: config.ttsVoice,
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
