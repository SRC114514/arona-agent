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
 *   - 只有回合最后一个 assistant message 的文本走 TTS：renderer 累积 text_delta，
 *     agent_end 时把最后一段完整文本传给 endTurn(text) 一次性处理（中间穿插工具调用的
 *     过程性发言不朗读）——避免被 change_emotion 等工具调用切成多段的句子被拆读
 *   - 整段字数判断：countTextUnits(整段) >= MAX_TURN_LEN 则整段跳过不朗读（长回复静音）
 *   - 围栏代码块（```...```）整块剔除；句内 markdown 成句后剔除
 *   - 句子进入严格串行队列：合成（HTTP+下载）→ 播放 → 下一句
 *   - 音色每句动态取 getVoiceId(currentAgent)，setVoice 仅切换当前角色、无需重启进程
 *   - 覆盖主 + 子 Agent：同一实例通过 setVoice 切角色
 */
// 整段字数阈值（countTextUnits 口径）：>= 50 的回复不朗读
const MAX_SENTENCE_LEN = 50;
const TTS_FORCE_SPLIT_LEN = 9999; // 仅标点切句、不强切

/** 剔除整段文本中的 ``` 代码围栏（文本已完整，无需跨 delta 状态机）。 */
function stripCodeBlocks(s: string): string {
  // 先删成对围栏块，再清掉残留的单个 ```（未闭合/游离标记）
  return s.replace(/```[\s\S]*?```/g, " ").replace(/```/g, " ");
}

export class TtsStream {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pendingCount = 0; // 活跃播放段数（play_start +1 / play_end -1）
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
    if (this.currentAgent !== agentId) {
      this.currentAgent = agentId;
      if (verbose) console.error(`[tts] setVoice ${agentId}`);
    }
  }

  /**
   * 回合结束：处理最后一段回复文本（由 renderer 在 agent_end 时调用）。
   * - 空文本（keep_silent / 无最终发言）→ 不朗读
   * - 整段字数 >= MAX_SENTENCE_LEN → 整段跳过（长回复静音）
   * - 否则切句入队，串行合成播放
   */
  endTurn(text: string): void {
    if (!this.isEnabledFor(this.currentAgent)) return;
    if (!text || !text.trim()) {
      if (verbose) console.error("[tts] endTurn: no final text, skip");
      return;
    }
    const full = stripCodeBlocks(text).trim();
    if (!full) return;
    const units = countTextUnits(stripMarkdown(full));
    if (units === 0 || units >= MAX_SENTENCE_LEN) {
      if (verbose) console.error(`[tts] skip whole turn units=${units} "${full.slice(0, 40)}"`);
      return;
    }
    const { sentences, rest } = splitStreamedText(full, TTS_FORCE_SPLIT_LEN);
    for (const s of sentences) this.emitSentence(s);
    const tail = rest.trim();
    if (tail) this.emitSentence(tail);
    void this.drain();
  }

  /** 打断当前合成与队列（新输入 / Esc / Ctrl+C / STT 触发时调用）。 */
  cancel(): void {
    this.queue = [];
    this.pendingCount = 0;
    this.killProc();
    if (verbose) console.error("[tts] cancel (queue cleared)");
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
   * 句级过滤：剔除句内 markdown 后按字数判断。字数口径 = 中文每字 1、英文单词 1、
   * 符号不计（countTextUnits）；字数为 0（纯符号）的句子不朗读。
   * （整段已 < MAX_SENTENCE_LEN，单句必然 < 阈值，此处过滤为纯防御）
   */
  private emitSentence(sentence: string): void {
    const clean = stripMarkdown(sentence).trim();
    if (!clean) return;
    const units = countTextUnits(clean);
    if (units === 0 || units >= MAX_SENTENCE_LEN) {
      if (verbose) console.error(`[tts] skip sentence units=${units} "${clean.slice(0, 40)}"`);
      return;
    }
    if (verbose) console.error(`[tts] queue push units=${units} "${clean.slice(0, 40)}"`);
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
        if (verbose) console.error(`[tts] speakOne start "${sentence.slice(0, 40)}"`);
        const ok = await this.speakOne(sentence);
        if (verbose) console.error(`[tts] speakOne end ok=${ok} remaining=${this.queue.length}`);
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
      let settled = false;
      const doResolve = (val: boolean) => {
        if (settled) return;
        settled = true;
        resolve(val);
      };
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
              if (verbose) console.error(`[tts] play_start pending=${this.pendingCount}`);
              break;
            case "play_end":
              if (this.pendingCount > 0) this.pendingCount--;
              if (verbose) console.error(`[tts] play_end pending=${this.pendingCount}`);
              doResolve(true); // 播放完成
              break;
            case "error":
              console.warn(t(`TTS: ${evt.message ?? "unknown error"}`, `TTS: ${evt.message ?? "unknown error"}`));
              if (verbose) console.error(`[tts] error: ${evt.message}`);
              // 合成失败不中断队列，靠 close 再 resolve(true) 继续下一句
              break;
            default:
              break;
          }
        }
      });

      proc.stderr.on("data", (data) => {
        if (!verbose) return;
        const msg = data.toString().trim();
        if (msg) console.error(`[python:tts_say]`, msg);
      });

      proc.on("close", () => {
        if (this.proc === proc) this.proc = null;
        // 若已通过 play_end 结算，则 close 不再改写结果；否则按是否被 kill 决定
        doResolve(!this._killRequested);
      });
      proc.on("error", () => {
        if (this.proc === proc) this.proc = null;
        doResolve(!this._killRequested);
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
