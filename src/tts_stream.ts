import type { ChildProcessWithoutNullStreams } from "child_process";
import { join } from "path";
import { PYTHON_DIR, config, verbose } from "./config.ts";
import { t } from "./locale.ts";
import { spawnCompat, stripProxyEnv } from "./utils/spawn.ts";
import { stripMarkdown } from "./voice.ts";
import { getMainAgent, type AgentId } from "./agent_registry.ts";
import { getTtsProvider, type TtsCommand } from "./tts_provider.ts";
import { splitStreamedText, countTextUnits } from "./text_split.ts";

/** --verbose 日志用：掩码载荷里的 apiKey（避免密钥进日志）。 */
function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  if (typeof out.apiKey === "string" && out.apiKey) out.apiKey = "***";
  return out;
}

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
 *   - 句子进入串行播放队列 + 单槽预合成流水线：上一句播放期间预合成下一句（synth_only 写临时
 *     wav），句间只付一次无 HTTP 的 play 进程启动，消除句间合成停顿；预合成失败回退合成+播放
 *   - 音色按句入队时固化发音人 {text, agent}，spawn 用该角色 voice_id（不受后续 setVoice 影响）
 *   - 每句带 TTS_SENTENCE_TIMEOUT_MS 保险丝：卡死的句子被跳过，busy 必然复位，整体不静音
 *   - 覆盖主 + 子 Agent：同一实例通过 setVoice 切当前角色判断开关，队列句音色已各自绑定
 */
// 整段字数阈值（countTextUnits 口径）：>= 50 的回复不朗读
const MAX_SENTENCE_LEN = 50;
const TTS_FORCE_SPLIT_LEN = 9999; // 仅标点切句、不强切
// 每句合成+播放的时长保险丝：到点仍未 play_end/close 则主动杀进程、按"正常结束"推进下一句。
// 防止 busy 被卡死的句子永久钉死整条队列（多 Agent 紧邻回合会把单句故障放大成整体静音）。
const TTS_SENTENCE_TIMEOUT_MS = 30_000;

/** 队列项：入队即固化发音人，之后任何 setVoice/cancel 都不影响本句音色选择。
    audioPath：undefined=未尝试预合成；null=预合成失败（回退合成+播放）；string=预合成好的 wav 路径 */
interface PendingSentence {
  text: string;
  agent: AgentId;
  audioPath?: string | null;
  prefetchPromise?: Promise<void>;
}

/** 剔除整段文本中的 ``` 代码围栏（文本已完整，无需跨 delta 状态机）。 */
function stripCodeBlocks(s: string): string {
  // 先删成对围栏块，再清掉残留的单个 ```（未闭合/游离标记）
  return s.replace(/```[\s\S]*?```/g, " ").replace(/```/g, " ");
}

/**
 * 判断 GPT-SoVITS 报错是否与参考音频相关（"发现无效→重新上传再试"的依据）。
 * 参考音频是云端通过 OSS URL 引用的，URL 失效时服务端报错文案多样，这里做宽松匹配。
 * 误判只多一次重试（无害）；漏判则跳过本句、下轮 prepare 重新校验。
 */
function isRefAudioError(msg: string | undefined): boolean {
  if (!msg) return false;
  return /(参考音频|ref_?audio|ref.?wav|refer|示例音频|prompt|无法打开|not found|404|下载失败|download.*fail|cannot.*(?:audio|wav)|invalid.*(?:audio|wav))/i.test(msg);
}

export class TtsStream {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pendingCount = 0; // 活跃播放段数（play_start +1 / play_end -1）
  private queue: PendingSentence[] = []; // 待合成句子队列（按句绑定发音人）
  private busy = false; // 当前是否有句子在合成/播放
  private shuttingDown = false;
  private _killRequested = false; // 本次是否因 cancel 主动杀进程（区分正常结束与打断）
  private generation = 0; // 打断纪元：cancel 自增以作废在途 drain，杜绝双 drain 竞态
  private prefetchProc: ChildProcessWithoutNullStreams | null = null; // 在途预合成进程（cancel 时一并杀）
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
    // 碎句合并：切句器把「…」当句末（人设常用结巴省略号），会产生 1 字碎句（如「嗯……」
    // 被切成「嗯…」+「好呀。」）。GPT-SoVITS 对 1 字超短输入的合成又快又怪（语速快/吞字感），
    // 这里把 countTextUnits ≤ 1 的碎句并入相邻句，仅影响 TTS，不影响气泡渲染。
    const merged: string[] = [];
    for (const s of sentences) {
      if (countTextUnits(stripMarkdown(s)) <= 1 && merged.length > 0) {
        merged[merged.length - 1] += s;
      } else {
        merged.push(s);
      }
    }
    for (const s of merged) this.emitSentence(s, this.currentAgent);
    const tail = rest.trim();
    if (tail) this.emitSentence(tail, this.currentAgent);
    void this.drain();
  }

  /** 打断当前合成与队列（新输入 / Esc / Ctrl+C / STT 触发时调用）。 */
  cancel(): void {
    // 自增纪元作废任何在途 drain，并复位 busy：即使被杀进程不 close，下一回合也不会被残余 busy 吞掉
    this.generation++;
    this.busy = false;
    if (verbose) console.error("[tts] cancel (generation++ queue cleared busy=0)");
    this.queue = [];
    this.pendingCount = 0;
    this.killProc();
    this.killPrefetchProc();
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
  private emitSentence(sentence: string, agent: AgentId): void {
    const clean = stripMarkdown(sentence).trim();
    if (!clean) return;
    const units = countTextUnits(clean);
    if (units === 0 || units >= MAX_SENTENCE_LEN) {
      if (verbose) console.error(`[tts] skip sentence units=${units} "${clean.slice(0, 40)}"`);
      return;
    }
    if (verbose) console.error(`[tts] queue push agent=${agent} units=${units} "${clean.slice(0, 40)}"`);
    // 入队即固化发音人：之后任何 setVoice/cancel 都不影响本句音色选择
    this.queue.push({ text: clean, agent });
    void this.drain();
  }

  /** 串行排空队列：合成 + 播放一句再下一句；下一句在上一句播放期间预合成（单槽流水线）。
      全部播完且未被打断时触发 onIdle。 */
  private async drain(): Promise<void> {
    if (this.busy || this.shuttingDown) return;
    if (this.queue.length === 0) return;
    const gen = this.generation;
    this.busy = true;
    let aborted = false;
    try {
      // 合成前准备：本地 GPT-SoVITS 确保 api_v2 已启动/可达；云端模式预上传并校验 OSS 参考音频。
      const provider = getTtsProvider();
      if (provider.prepare) {
        try {
          await provider.prepare();
        } catch (err) {
          console.warn(t(
            `GPT-SoVITS 本地服务准备失败：${err instanceof Error ? err.message : String(err)}`,
            `GPT-SoVITS local server prepare failed: ${err instanceof Error ? err.message : String(err)}`,
          ));
        }
        if (this.generation !== gen || this.shuttingDown) return;
      }
      while (this.queue.length > 0 && !this.shuttingDown) {
        if (this.generation !== gen) return; // 已被 cancel 作废，停止处理
        const item = this.queue.shift()!;
        const next = this.queue[0];
        // 单槽预合成：仅当本句走 play 模式（已合成 wav，只播本地不碰 GPT-SoVITS 服务器）时提前启动。
        // 本句走合成+播放（audioPath 为空/失败）时若提前 prefetch(next)，两个 python 进程会并发
        // set_gpt_weights 争抢同一 api_v2 的全局权重 → 首句 /tts 可能落入 next 权重（群聊音色错乱）。
        // 因此仅 play 模式预取；合成模式下 defer 到本句 play_start（音频已到手、权重可切换）后再预取。
        let prefetchStarted = false;
        const startPrefetch = () => {
          if (prefetchStarted) return;
          if (this.generation !== gen) return;
          if (!next || next.audioPath !== undefined || next.prefetchPromise) return;
          prefetchStarted = true;
          next.prefetchPromise = this.prefetch(next).finally(() => {
            next.prefetchPromise = undefined;
          });
        };
        if (typeof item.audioPath === "string") startPrefetch();
        // 短句兜底：上一句太短时预合成可能未完成，等其收尾
        if (item.prefetchPromise) {
          if (verbose) console.error(`[tts] await prefetch "${item.text.slice(0, 40)}"`);
          await item.prefetchPromise;
          if (this.generation !== gen) return; // 等待期间被 cancel 作废
        }
        if (verbose) console.error(`[tts] speakOne start agent=${item.agent} "${item.text.slice(0, 40)}"`);
        const ok = await this.speakOne(item, typeof item.audioPath === "string" ? undefined : startPrefetch);
        if (verbose) console.error(`[tts] speakOne end agent=${item.agent} ok=${ok} remaining=${this.queue.length}`);
        if (!ok) {
          aborted = true;
          break;
        }
      }
    } finally {
      // 仅最年轻的 drain 复位 busy；被 cancel 作废的旧 drain 不再动它，避免清掉新一轮 drain 的 busy
      if (this.generation === gen && this.busy) this.busy = false;
    }
    if (this.generation === gen && !aborted && !this.shuttingDown && this.pendingCount === 0) {
      this.onIdle?.();
    }
  }

  /**
   * 预合成下一句：spawn 一次性 synth_only 进程，把 wav 写到临时文件，供播放时直接读（无 HTTP）。
   * 成功（synth_done）→ item.audioPath = 路径（仅当 generation 未变）；失败/超时/被杀 → null（回退合成+播放）。
   * 在上一句播放期间调用，消除句间 HTTP 合成停顿。带 TTS_SENTENCE_TIMEOUT_MS 保险丝。
   * 参考音频相关错误 → 通知 provider 作废缓存（本句回退合成+播放，speakOne 会重传重试）。
   */
  private async prefetch(item: PendingSentence): Promise<void> {
    if (verbose) console.error(`[tts] prefetch start agent=${item.agent} "${item.text.slice(0, 40)}"`);
    const gen = this.generation;
    const provider = getTtsProvider();
    let cmd: TtsCommand;
    try {
      cmd = await provider.buildCommand(item.agent, item.text, "synth_only");
    } catch (err) {
      console.warn(t(`TTS: ${err instanceof Error ? err.message : String(err)}`, `TTS: ${err instanceof Error ? err.message : String(err)}`));
      if (this.generation === gen) item.audioPath = null;
      return;
    }
    if (this.generation !== gen) return;
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const doResolve = () => {
        if (settled) return;
        if (timer) clearTimeout(timer);
        settled = true;
        resolve();
      };
      const fuseMs = provider.sentenceTimeoutMs();
      let stdoutBuffer = "";
      const proc = spawnCompat(config.pythonPath, ["-u", join(PYTHON_DIR, "tts_say.py")], {
        env: stripProxyEnv({
          ...process.env,
          PYTHONUTF8: "1",
          ...cmd.env,
        }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.prefetchProc = proc;

      // 保险丝：预合成最多等 fuseMs（provider 自定义，aliyun 30s / gpt-sovits timeoutMs），
      // 超时杀进程 + null 回退（busy 必然复位、整体不静音）
      timer = setTimeout(() => {
        if (settled) return;
        if (verbose) console.error(`[tts] prefetch TIMEOUT (${fuseMs}ms) agent=${item.agent} "${item.text.slice(0, 40)}"`);
        if (this.prefetchProc === proc) this.prefetchProc = null;
        if (!proc.killed) {
          try {
            proc.kill("SIGTERM");
          } catch {
            // 忽略
          }
        }
        if (this.generation === gen) item.audioPath = null;
        doResolve();
      }, fuseMs);

      proc.stdout.on("data", (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let evt: { event?: string; message?: string; path?: string; gpt?: string; sovits?: string };
          try {
            evt = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (evt.event === "synth_done" && evt.path) {
            if (verbose) console.error(`[tts] prefetch synth_done agent=${item.agent} "${item.text.slice(0, 40)}"`);
            if (this.generation === gen) item.audioPath = evt.path;
            doResolve();
          } else if (evt.event === "weights_loaded") {
            if (verbose) console.error(`[tts] prefetch weights_loaded agent=${item.agent} gpt=${evt.gpt ?? ""} sovits=${evt.sovits ?? ""}`);
            provider.ackWeights?.({ gpt: evt.gpt, sovits: evt.sovits });
          } else if (evt.event === "error") {
            console.warn(t(`TTS: ${evt.message ?? "unknown error"}`, `TTS: ${evt.message ?? "unknown error"}`));
            if (verbose) console.error(`[tts] prefetch error: ${evt.message}`);
            if (isRefAudioError(evt.message)) provider.markRefInvalid?.(item.agent);
            if (this.generation === gen) item.audioPath = null;
            doResolve();
          }
        }
      });

      proc.stderr.on("data", (data) => {
        if (!verbose) return;
        const msg = data.toString().trim();
        if (msg) console.error(`[python:tts_say]`, msg);
      });

      proc.on("close", () => {
        if (this.prefetchProc === proc) this.prefetchProc = null;
        if (!settled) {
          // 进程退出但没等到 synth_done（被杀 / 异常）：按失败回退
          if (this.generation === gen) item.audioPath = null;
          doResolve();
        }
      });
      proc.on("error", () => {
        if (this.prefetchProc === proc) this.prefetchProc = null;
        if (!settled) {
          if (this.generation === gen) item.audioPath = null;
          doResolve();
        }
      });

      try {
        if (verbose) console.error(`[tts] prefetch payload ${JSON.stringify(redactPayload(cmd.payload))}`);
        proc.stdin.write(JSON.stringify(cmd.payload) + "\n");
        proc.stdin.end();
      } catch {
        // 忽略
      }
    });
  }

  /**
   * 合成并播放一句话：spawn 一次性 python 进程，等待其播完（play_end）或退出。
   * 已预合成（item.audioPath 为 string）走 play 模式（无 HTTP，直接播临时 wav）；
   * 未预合成（含预合成失败回退）走默认合成+播放模式。
   * 音色按句固定：环境变量与 stdin 都用该句所属角色的 voice_id，不受后续 setVoice 影响。
   * 带 TTS_SENTENCE_TIMEOUT_MS 保险丝：到点仍未 play_end/close → 杀进程 + 按正常结束继续下一句，
   * 保证 drain 必然推进、busy 必然复位，杜绝"卡死一句 → 整条 TTS 永久静音"。
   * 参考音频相关错误（云端 OSS URL 失效等）→ markRefInvalid 作废缓存并【重新上传再试一次】。
   * @param onPlayStart 合成+播放模式下，本句音频已到手（play_start）时回调：此刻 GPT-SoVITS
   *                    服务器权重可安全切换，由调用方在此启动下一句预合成（避免权重并发竞态）。
   * @returns true = 正常结束（含合成失败/超时，继续下一句）；false = 被 cancel 打断
   */
  private async speakOne(item: PendingSentence, onPlayStart?: () => void): Promise<boolean> {
    const { text, agent } = item;
    const provider = getTtsProvider();
    const gen = this.generation;
    this._killRequested = false;
    let retried = false;
    for (;;) {
      if (this.generation !== gen) return false;
      let cmd: TtsCommand;
      try {
        cmd = await provider.buildCommand(agent, text, "synth_play");
      } catch (err) {
        console.warn(t(`TTS: ${err instanceof Error ? err.message : String(err)}`, `TTS: ${err instanceof Error ? err.message : String(err)}`));
        return true; // 音色解析失败：跳过本句继续
      }
      if (this.generation !== gen) return false;
      const payload =
        typeof item.audioPath === "string"
          ? { mode: "play", path: item.audioPath }
          : cmd.payload;
      const result = await this.runSentence(cmd.env, payload, agent, text, provider.sentenceTimeoutMs(), onPlayStart);
      if (result === "retry" && !retried) {
        retried = true;
        if (verbose) console.error(`[tts] 参考音频无效，重新上传后重试 agent=${agent} "${text.slice(0, 40)}"`);
        provider.markRefInvalid?.(agent);
        item.audioPath = null; // 丢弃可能已预合成的旧 wav，走合成+播放
        continue;
      }
      return result === "cancel" ? false : true;
    }
  }

  /**
   * 合成+播放一句（spawn 一次性 python 进程）：play 模式只播已合成 wav；否则合成+播放。
   * 带 fuseMs 时长保险丝：超时杀进程并按"正常结束"返回，保证整条 TTS 不静音。
   * @param onPlayStart 合成模式收到 play_start 时调用一次（在此启动下一句预合成）
   * @returns "ok"=正常结束（继续下一句）；"cancel"=被 cancel 打断；"retry"=参考音频相关错误（可重试）
   */
  private runSentence(
    env: Record<string, string>,
    payload: Record<string, unknown>,
    agent: AgentId,
    text: string,
    fuseMs: number,
    onPlayStart?: () => void,
  ): Promise<"ok" | "cancel" | "retry"> {
    return new Promise((resolve) => {
      this._killRequested = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined; // 时长保险丝句柄（TDZ 安全：先声明，后赋值）
      const doResolve = (val: "ok" | "cancel" | "retry") => {
        if (settled) return;
        if (timer) clearTimeout(timer);
        // 无论正常 play_end、异常退出、超时还是取消，本句结束后都不允许残留 pendingCount，
        // 否则 onIdle/isPending 会被卡死（play_start 后进程异常退出/超时是主要泄漏路径）。
        this.pendingCount = 0;
        settled = true;
        resolve(val);
      };
      const provider = getTtsProvider();
      let stdoutBuffer = "";
      const proc = spawnCompat(config.pythonPath, ["-u", join(PYTHON_DIR, "tts_say.py")], {
        env: stripProxyEnv({
          ...process.env,
          PYTHONUTF8: "1",
          ...env,
        }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;

      // 时长保险丝：一句合成+播放最多等 fuseMs（provider 自定义），超时主动杀进程并推进一步
      timer = setTimeout(() => {
        if (settled) return;
        if (verbose) console.error(`[tts] speakOne TIMEOUT (${fuseMs}ms) agent=${agent} "${text.slice(0, 40)}"`);
        if (this.proc === proc) this.killProc();
        doResolve("ok");
      }, fuseMs);

      proc.stdout.on("data", (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let evt: { event?: string; message?: string; gpt?: string; sovits?: string };
          try {
            evt = JSON.parse(trimmed);
          } catch {
            continue;
          }
          switch (evt.event) {
            case "play_start":
              this.pendingCount++;
              onPlayStart?.(); // 音频已到手、服务器权重可切换 → 启动下一句预合成
              if (verbose) console.error(`[tts] play_start pending=${this.pendingCount}`);
              break;
            case "play_end":
              if (this.pendingCount > 0) this.pendingCount--;
              if (verbose) console.error(`[tts] play_end pending=${this.pendingCount}`);
              doResolve("ok"); // 播放完成
              break;
            case "weights_loaded":
              if (verbose) console.error(`[tts] speakOne weights_loaded agent=${agent} gpt=${evt.gpt ?? ""} sovits=${evt.sovits ?? ""}`);
              provider.ackWeights?.({ gpt: evt.gpt, sovits: evt.sovits });
              break;
            case "error":
              console.warn(t(`TTS: ${evt.message ?? "unknown error"}`, `TTS: ${evt.message ?? "unknown error"}`));
              if (verbose) console.error(`[tts] error: ${evt.message}`);
              // 参考音频相关错误（OSS URL 失效等）→ 返回 retry 让上层重传重试；其它错误靠 close 继续下一句
              if (isRefAudioError(evt.message)) doResolve("retry");
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
        doResolve(this._killRequested ? "cancel" : "ok");
      });
      proc.on("error", () => {
        if (this.proc === proc) this.proc = null;
        doResolve(this._killRequested ? "cancel" : "ok");
      });

      try {
        if (verbose) console.error(`[tts] speakOne payload ${JSON.stringify(redactPayload(payload))}`);
        proc.stdin.write(JSON.stringify(payload) + "\n");
        proc.stdin.end();
      } catch {
        // 忽略
      }
    });
  }

  private killPrefetchProc(): void {
    const proc = this.prefetchProc;
    this.prefetchProc = null;
    if (proc && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // 忽略
      }
    }
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
