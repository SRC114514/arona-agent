import type { ChildProcessWithoutNullStreams } from "child_process";
import { join } from "path";
import { PYTHON_DIR, config, verbose } from "./config.ts";
import { t } from "./locale.ts";
import { spawnCompat, stripProxyEnv } from "./utils/spawn.ts";
import { stripMarkdown } from "./voice.ts";
import { getMainAgent, type AgentId } from "./agent_registry.ts";
import { getVoiceId } from "./voices.ts";
import { splitStreamedText, countTextUnits } from "./text_split.ts";

/**
 * 非流式 TTS 管道（阿里云百炼"非实时语音合成"，整句一次 HTTP 合成）。
 *
 * 每句话 spawn 一次性 Python 进程 python/tts_say.py，通过 stdin/stdout JSON 行通信：
 *   发送：{"text":"...","voice":"<id>"}（单行，进程随即退出）
 *   接收：{"event":"ready"} / {"event":"play_start"} / {"event":"play_end"} / {"event":"error","message":...}
 *
 * 行为约定：
 *   - LLM text_delta 边生成边按句切分（共享 text_split.ts：只按终止标点切，不强切）
 *   - 句子进入严格串行队列：合成（HTTP+下载）→ 播放 → 下一句
 *   - 残段跨 assistant message 累积，回合结束（endTurn）才收尾——避免"好好吃饭哦"这类句子
 *     被 change_emotion 等工具调用切成两段、末字被单独朗读
 *   - 围栏代码块（```...```）整块剔除；句内 markdown 成句后剔除
 *   - 长句跳过：字数 >= 50 不朗读（countTextUnits 口径）
 *   - 音色每句动态取 getVoiceId(currentAgent)，setVoice 仅切换当前角色、无需重启进程
 */
const MAX_SENTENCE_LEN = 50; // 字数（countTextUnits 口径）>= 50 的句子不朗读
const TTS_FORCE_SPLIT_LEN = 9999; // 仅标点切句、不强切

/** 统计字符串尾部连续反引号数（最多计 2 个：可能是被 delta 切断的 ``` 围栏标记）。 */
function trailingFenceTicks(s: string): number {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && n < 2; i--) {
    if (s[i] === "`") n++;
    else break;
  }
  return n;
}

export class TtsStream {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pendingCount = 0; // 活跃播放段数（play_start +1 / play_end -1）
  private buffer = ""; // 未处理文本（切句残段 + 可能被 delta 切断的围栏内容）
  private inCodeBlock = false; // 跨 delta 的 ``` 围栏状态
  private queue: string[] = []; // 待合成句子队列
  private busy = false; // 当前是否有句子在合成/播放
  private shuttingDown = false;
  private _killRequested = false; // 本次是否因 cancel 主动杀进程（区分正常结束与打断）
  private currentAgent: AgentId = getMainAgent();

  constructor(
    private isEnabledFor: (agent: AgentId) => boolean,
    private onIdle?: () => void,
  ) {}

  /** 当前是否有未播放完的合成段（供 repl 判断 pet.reset 时机） */
  get isPending(): boolean {
    return this.pendingCount > 0 || this.busy || this.queue.length > 0;
  }

  /** 当前 TTS 音色所属角色 */
  get currentAgentId(): AgentId {
    return this.currentAgent;
  }

  /** 切换当前朗读角色音色（非流式下每句 spawn 时动态取 voice，无需重启进程）。 */
  setVoice(agentId: AgentId): void {
    this.currentAgent = agentId;
  }

  /**
   * LLM 文本增量（text_delta）实时推送。剔除代码块后按标点切句，<50 字的句子进入合成队列。
   * 残段不在此成句——跨 message 累积，回合结束（endTurn）才收尾。
   */
  pushText(delta: string): void {
    if (!this.isEnabledFor(this.currentAgent)) return;
    if (!delta) return;
    this.ingestDelta(delta);
  }

  /**
   * 回合结束：残段按同规则收尾（未闭合代码块整段丢弃），并触发队列排空。
   * 由 renderer 在 agent_end 事件时调用（而非 message_end，避免句中被工具调用截断）。
   */
  endTurn(): void {
    if (!this.isEnabledFor(this.currentAgent)) return;
    if (this.inCodeBlock) {
      this.buffer = "";
      this.inCodeBlock = false;
    } else {
      const leftover = this.buffer.trim();
      this.buffer = "";
      if (leftover) this.emitSentence(leftover);
    }
    void this.drain();
  }

  /** 打断当前合成与队列（新输入 / Esc / Ctrl+C / STT 触发时调用）。 */
  cancel(): void {
    this.buffer = "";
    this.inCodeBlock = false;
    this.queue = [];
    this.pendingCount = 0;
    this.killProc();
  }

  /** 切换角色后清空残余（非流式音色动态取，无需杀进程重拉）。 */
  restartVoice(): void {
    this.cancel();
  }

  /** 退出时停止当前合成进程 */
  shutdown(): void {
    this.shuttingDown = true;
    this.cancel();
  }

  // ------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------

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
    this.queue.push(clean);
    void this.drain();
  }

  /** 串行排空队列：合成 + 播放一句再下一句。全部播完且未被打断时触发 onIdle。 */
  private async drain(): Promise<void> {
    if (this.busy || this.shuttingDown) return;
    if (this.queue.length === 0) return;
    this.busy = true;
    let aborted = false;
    try {
      while (this.queue.length > 0 && !this.shuttingDown) {
        const sentence = this.queue.shift()!;
        const ok = await this.speakOne(sentence);
        if (!ok) {
          aborted = true;
          break;
        }
      }
    } finally {
      this.busy = false;
    }
    if (!aborted && !this.shuttingDown && this.pendingCount === 0) {
      this.onIdle?.();
    }
  }

  /**
   * 合成并播放一句话：spawn 一次性 python 进程，等待其播完（play_end）或退出。
   * @returns true = 正常结束（含合成失败，继续下一句）；false = 被 cancel 打断
   */
  private speakOne(text: string): Promise<boolean> {
    return new Promise((resolve) => {
      this._killRequested = false;
      let stdoutBuffer = "";
      const proc = spawnCompat(config.pythonPath, ["-u", join(PYTHON_DIR, "tts_say.py")], {
        env: stripProxyEnv({
          ...process.env,
          PYTHONUTF8: "1",
          QWEN_WORKSPACE_ID: config.workspaceId,
          QWEN_TTS_API_KEY: config.ttsApiKey,
          QWEN_TTS_MODEL: config.ttsModel,
          QWEN_TTS_VOICE: getVoiceId(this.currentAgent),
        }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;

      proc.stdout.on("data", (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
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
            case "play_start":
              this.pendingCount++;
              break;
            case "play_end":
              if (this.pendingCount > 0) this.pendingCount--;
              resolve(true); // 播放完成
              break;
            case "error":
              console.warn(t(`TTS: ${evt.message ?? "unknown error"}`, `TTS: ${evt.message ?? "unknown error"}`));
              break;
            default:
              break;
          }
        }
      });

      proc.stderr.on("data", (data) => {
        // 非 --verbose 启动时静默 Python stderr
        if (!verbose) return;
        const msg = data.toString().trim();
        if (msg) console.error(`[python:tts_say]`, msg);
      });

      proc.on("close", () => {
        if (this.proc === proc) this.proc = null;
        resolve(!this._killRequested);
      });
      proc.on("error", () => {
        if (this.proc === proc) this.proc = null;
        resolve(!this._killRequested);
      });

      try {
        proc.stdin.write(JSON.stringify({ text, voice: getVoiceId(this.currentAgent) }) + "\n");
        proc.stdin.end();
      } catch {
        // 忽略
      }
    });
  }

  private killProc(): void {
    this._killRequested = true;
    const proc = this.proc;
    this.proc = null;
    if (proc && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // 忽略
      }
    }
  }
}
