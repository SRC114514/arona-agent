import * as readline from "readline";
import chalk from "chalk";
import { execSync, type ChildProcessWithoutNullStreams } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { AgentSession, ModelRuntime, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { config, sttHotkeyKey, sttHotkeyLabel } from "./config.ts";
import { handleCommand, type CommandContext } from "./commands.ts";
import { createRenderer, renderSavedMessages } from "./renderer.ts";
import * as memory from "./memory.ts";
import * as voice from "./voice.ts";
import { getTtsProvider } from "./tts_provider.ts";
import { TtsStream } from "./tts_stream.ts";
import { stopGptSovitsLocalServer } from "./gpt_sovits_local.ts";
import { stopComputerUse } from "./tools/computer_use.ts";
import { disconnectAllMcp } from "./mcp.ts";
import { pet, stopPet } from "./pet.ts";
import { SlashMenu } from "./slash_menu.ts";
import { printLogo } from "./logo.ts";
import { PYTHON_DIR } from "./config.ts";
import { UndoManager } from "./undo.ts";
import { t } from "./locale.ts";
import { spawnCompat } from "./utils/spawn.ts";
import { initSubAgent } from "./agent.ts";
import { getMainAgent, getSubAgents, getAgentLabel, type AgentId, type SubAgentId } from "./agent_registry.ts";

// STT 长按阈值：按下录音热键持续 ≥ 该毫秒数并在释放时才触发录音；提前松开视为误触
const STT_HOLD_MS = 2000;

export class Repl {
  private rl: readline.Interface;
  private session: AgentSession;
  private modelRuntime: ModelRuntime;
  private loader: DefaultResourceLoader;
  private isProcessing = false;
  private aborted = false; // 中断标志：避免 processInput finally 重复 prompt
  private sigintCount = 0;
  private sigintTimer: NodeJS.Timeout | null = null;
  // 非流式 TTS 管道：agent_end 时只把最后一个回复 message 交给 endTurn() 整段合成播放
  // 音色按当前发言角色动态切换（setVoice），isEnabled 按该角色是否有克隆音色判断
  private ttsStream = new TtsStream(
    (agentId) => voice.isTtsEnabledFor(agentId),
    () => {
      // TTS 播放结束：先隐藏桌宠气泡，再恢复默认待机
      this.hidePetBubble();
      if (this.turnEnded && !this.ttsStream.isPending) pet.reset();
    },
    // 播放中实时音量 → 桌宠嘴型 lip-sync（转发给对应角色窗口）
    (agentId, rms) => {
      if (pet.isRunning) pet.sendTtsLevel(agentId, rms);
    },
  );
  // 回合结束标志：中间段的 play_end 不触发 pet.reset，只有回合结束后才恢复桌宠
  private turnEnded = false;
  // 子 Agent session 集合（shiroko/hoshino；按 settings 启用）
  private subSessions = new Map<SubAgentId, AgentSession>();
  // 当前正在发言的 session / agent（中断时 abort 的是它，而不是固定主 session）
  private activeSession: AgentSession;
  private activeAgentId: AgentId;
  // TTS 禁用时 5s 后隐藏气泡的定时器
  private bubbleHideTimer: NodeJS.Timeout | null = null;
  private onExit: () => void;
  private onNewSession: () => Promise<{
    session: AgentSession;
    modelRuntime: ModelRuntime;
    loader: DefaultResourceLoader;
  }>;
  // renderer 提升为字段：/new 切换会话后需要重新 subscribe 到新 session
  private renderer!: ReturnType<typeof createRenderer>;
  private rendererUnsub: (() => void) | null = null;
  // --resume= 启动时恢复的消息（在 start() 中渲染，确保 logo 在历史记录之前）
  private resumedMessages: any[] | null;
  // 当前会话的源文件路径。
  // - null：新会话（退出时另存为新文件）
  // - 非 null：从该文件 resume 的会话（退出时覆盖保存回原文件）
  private currentSessionPath: string | null;
  // 斜杠命令菜单（渲染与状态机封装在 SlashMenu 中）
  private menu = new SlashMenu();
  private menuKeyListener: ((s: any, k: any) => void) | null = null;
  // 本地快照式 undo/redo 管理器（不依赖 git）
  private undoManager: UndoManager;

  constructor(
    session: AgentSession,
    modelRuntime: ModelRuntime,
    loader: DefaultResourceLoader,
    onExit: () => void,
    onNewSession: () => Promise<{
      session: AgentSession;
      modelRuntime: ModelRuntime;
      loader: DefaultResourceLoader;
    }>,
    resumedMessages: any[] | null = null,
    initialSessionPath: string | null = null,
  ) {
    this.session = session;
    this.modelRuntime = modelRuntime;
    this.loader = loader;
    this.onExit = onExit;
    this.onNewSession = onNewSession;
    this.resumedMessages = resumedMessages;
    this.currentSessionPath = initialSessionPath;
    this.activeSession = session;
    this.activeAgentId = getMainAgent();

    this.undoManager = new UndoManager(process.cwd());
    this.undoManager.load();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan("❯ "),
      terminal: true,
      // We provide our own Tab behavior; disable readline's default completion
      completer: () => [[], ""],
    });

    // Setup renderer with TTS callbacks
    // onTurnEnd: 回合结束（agent_end）时把最后一个 message 的完整文本交给 TTS 一次性处理
    //   （只朗读最终回复；中间穿插工具调用的过程性发言不朗读）+ 气泡同步上屏最后一段
    // onPetText: 桌宠文字气泡（仅桌宠运行时发送）；情绪仍由 LLM change_emotion 工具驱动
    // --no-voice 模式下没有 play_end 兜底隐藏气泡：final 上屏时挂 5s 定时器
    this.renderer = createRenderer(
      (text) => this.ttsStream.endTurn(text),
      (kind, data) => {
        if (pet.isRunning) pet.sendText(this.activeAgentId, kind, data);
      },
      getAgentLabel(getMainAgent()),
    );
    this.rendererUnsub = this.renderer.subscribe(this.session);

    this.setupSignals();
  }

  /** 通知桌宠隐藏气泡（TTS 播放结束 / 打断时调用） */
  private hidePetBubble(): void {
    if (this.bubbleHideTimer) {
      clearTimeout(this.bubbleHideTimer);
      this.bubbleHideTimer = null;
    }
    if (pet.isRunning) pet.sendText(this.activeAgentId, "tts_end", "");
  }

  /**
   * TTS 禁用时的兜底：5s 后同时隐藏气泡 + 恢复 idle 表情。
   * 涵盖 --no-voice / 缺音色 / 切到无音色角色三种静音原因（voice.isTtsEnabled() 统一判断）。
   */
  private scheduleBubbleHide(): void {
    if (this.bubbleHideTimer) clearTimeout(this.bubbleHideTimer);
    this.bubbleHideTimer = setTimeout(() => {
      this.bubbleHideTimer = null;
      this.hidePetBubble();
      if (pet.isRunning) pet.reset();
    }, 5000);
  }

  private setupSignals() {
    // 注意：emitKeypressEvents 后，Ctrl+C 由 readline 拦截并 emit rl 的
    // 'SIGINT' 事件，不会冒泡到 process 的 SIGINT。所以必须监听 rl 上的
    // SIGINT，否则空闲态按 Ctrl+C 会直接走 readline 默认行为（关闭接口）。
    this.rl.on("SIGINT", () => {
      // 正在执行任务：第一次中断任务，第二次（紧随其后）直接退出
      if (this.isProcessing) {
        this.activeSession.abort().catch(() => {});
        this.isProcessing = false;
        this.aborted = true; // 阻止 processInput finally 再次 prompt
        this.ttsStream.cancel(); // 打断 TTS，中断后不再播放后续内容
        this.hidePetBubble(); // 打断时立即隐藏气泡
        // 清空 readline 缓冲区，避免残留内容在重绘时混入提示符行
        (this.rl as any).line = "";
        (this.rl as any).cursor = 0;
        process.stdout.write(chalk.yellow("\n[aborted]\n"));
        // 标记刚中断过，下一次 Ctrl+C 直接退出（不再提示"再按一次"）
        this.sigintCount = 1;
        if (this.sigintTimer) clearTimeout(this.sigintTimer);
        this.sigintTimer = setTimeout(() => {
          this.sigintCount = 0;
          this.sigintTimer = null;
        }, 1500);
        this.rl.prompt(true);
        return;
      }

      // 空闲态：第一次提示，第二次退出
      this.sigintCount++;
      if (this.sigintCount >= 2) {
        if (this.sigintTimer) {
          clearTimeout(this.sigintTimer);
          this.sigintTimer = null;
        }
        console.log(chalk.yellow("\nExiting..."));
        this.doExit();
      } else {
        process.stdout.write(chalk.cyan(t("\n再按一次 Ctrl+C 退出。\n", "\nPress Ctrl+C again to exit.\n")));
        this.sigintTimer = setTimeout(() => {
          this.sigintCount = 0;
          this.sigintTimer = null;
        }, 1500);
        this.rl.prompt(true);
      }
    });
  }

  private getCommandContext(): CommandContext {
    return {
      session: this.session,
      loader: this.loader,
      exit: () => this.doExit(),
      newSession: async () => {
        // 重建会话：旧 session 已 dispose，需把 Repl 的引用和 renderer 订阅绑到新 session
        const result = await this.onNewSession();
        this.session = result.session;
        this.modelRuntime = result.modelRuntime;
        this.loader = result.loader;
        this.activeSession = this.session;
        this.activeAgentId = getMainAgent();
        this.currentSessionPath = null; // 新会话清除源文件路径，退出时另存为新文件
        // 复制上下文方案下子会话消息每轮被覆盖，无需清历史；此处回收子 session 对象，
        // 让下轮按新主会话重新初始化（刷新 initSubAgent 期捕获的 memory 等快照）
        this.resetSubSessions();
        this.rendererUnsub?.();
        this.renderer.setSpeakerLabel(getAgentLabel(getMainAgent()));
        this.rendererUnsub = this.renderer.subscribe(this.session);
      },
      runAgentTurn: (text: string) => this.runRawTurn(text),
      resumeSession: (path: string) => {
        this.resumeSession(path);
      },
      saveCurrentSession: () => {
        // /change-agent 重建会话前落盘当前对话（resume 覆盖原文件 / 新会话仅有效对话）
        this.saveCurrentSessionIfNeeded();
      },
      // 交互式命令（如 /resume）接管输入期间，暂停斜杠菜单监听器
      pauseMenuListener: () => {
        if (this.menuKeyListener) {
          process.stdin.removeListener("keypress", this.menuKeyListener);
        }
      },
      resumeMenuListener: () => {
        if (this.menuKeyListener) {
          process.stdin.prependListener("keypress", this.menuKeyListener);
        }
      },
      setSttHookEnabled: (enabled: boolean) => {
        if (enabled) this.startHotkeyHook();
        else this.stopHotkeyHook();
      },
      undoManager: this.undoManager,
      restartTts: () => this.ttsStream.restartVoice(),
      // /change-agent 只改子 Agent 组合时回收旧的子 session 对象（dispose + 清空），
      // 下轮 ensureSubSessions 按新组合重新初始化（刷新 initSubAgent 期捕获的 memory/工具状态）。
      resetSubAgents: () => this.resetSubSessions(),
    };
  }

  // 全局热键监听：独立 Python 进程（python/hotkey.py，pynput 实现）
  // 通过 stdout JSON 事件流通信：{"event":"ready"} / {"event":"trigger"} / {"event":"exit"}
  // 独立进程不受 Node 事件循环和 spawn stt.py 影响，比 uiohook-napi native 模块更可靠
  private hotkeyProc: ChildProcessWithoutNullStreams | null = null;
  private hotkeyBuffer = "";
  private hotkeyReady = false;
  // 就绪等待的 reject 句柄：进程提前退出时立即 reject，不必等满 5 秒
  private hotkeyReadyReject: ((e: Error) => void) | null = null;

  /**
   * 启动全局热键监听（Python pynput 独立进程）。
   * 检测到全局录音热键（macOS 右 Cmd / 其他右 Ctrl）长按 ≥2 秒时，hotkey.py 输出 {"event":"trigger"}，触发 STT 录音。
   */
  private async startHotkeyHook() {
    if (this.hotkeyProc) return; // 已启动
    const scriptPath = join(PYTHON_DIR, "hotkey.py");
    this.hotkeyReady = false;
    this.hotkeyBuffer = "";
    try {
      const proc = spawnCompat(config.pythonPath, ["-u", scriptPath], {
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          ARONA_HOTKEY_KEY: sttHotkeyKey(),
          ARONA_HOTKEY_HOLD_MS: String(STT_HOLD_MS),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.hotkeyProc = proc;

      proc.stdout.on("data", (data) => {
        this.hotkeyBuffer += data.toString();
        const lines = this.hotkeyBuffer.split("\n");
        this.hotkeyBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.event === "ready") {
              this.hotkeyReady = true;
            } else if (msg.event === "trigger") {
              // 收到触发事件，调用 triggerStt
              this.triggerStt().catch(() => {});
            }
          } catch {
            // 非 JSON，忽略
          }
        }
      });

      proc.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[python:hotkey]`, msg);
      });

      proc.on("close", (code) => {
        this.hotkeyProc = null;
        this.hotkeyReady = false;
        // 进程提前退出（如 pynput 缺失/未授权）：立即 reject 就绪等待，避免等满 5 秒
        if (this.hotkeyReadyReject) {
          this.hotkeyReadyReject(new Error(t(`hotkey.py 进程退出（code ${code}）`, `hotkey.py process exited (code ${code})`)));
        }
        if (code !== 0 && code !== null) {
          console.warn(chalk.yellow(t(`STT 热键进程退出（code ${code}）。`, `STT hotkey process exited (code ${code}).`)));
        }
      });

      // spawn 失败（pythonPath 不存在 / 脚本缺失）不会触发 close，必须监听 error，
      // 否则 Node 会因未处理的 'error' 事件直接崩溃。
      proc.on("error", (err) => {
        this.hotkeyProc = null;
        this.hotkeyReady = false;
        if (this.hotkeyReadyReject) {
          this.hotkeyReadyReject(new Error(t(`hotkey.py 启动失败：${err.message}`, `hotkey.py failed to start: ${err.message}`)));
        }
      });

      // 等待 ready 信号（最多 5 秒；进程提前退出会立即 reject）
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          clearInterval(interval);
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(t("hotkey.py 未在 5 秒内就绪", "hotkey.py did not become ready within 5s")));
        }, 5000);
        // 轮询检查（ready 在 stdout data 事件里设置）
        const interval = setInterval(() => {
          if (this.hotkeyReady) {
            cleanup();
            resolve();
          }
        }, 50);
        this.hotkeyReadyReject = (e: Error) => {
          cleanup();
          reject(e);
        };
      });
      this.hotkeyReadyReject = null;
    } catch (err) {
      this.hotkeyProc = null;
      const isMac = process.platform === "darwin";
      console.warn(chalk.yellow(
        t(
          isMac
            ? "STT 热键不可用：请安装 pynput（pip install pynput），并在 系统设置 → 隐私与安全性 → 辅助功能 中为Python授权。"
            : "STT 热键不可用：请安装 pynput（pip install pynput），并检查 Python 是否有权限监听全局键盘。",
          isMac
            ? "STT hotkey unavailable: install pynput (pip install pynput) and grant Accessibility permission to Python in System Settings."
            : "STT hotkey unavailable: install pynput (pip install pynput) and check that Python has permission to listen for global keys.",
        )
      ));
    }
  }

  /**
   * 停止全局热键监听，终止 hotkey.py 进程。
   */
  private stopHotkeyHook() {
    if (!this.hotkeyProc) return;
    try {
      this.hotkeyProc.stdin.end();
      this.hotkeyProc.kill("SIGTERM");
    } catch {
      // 忽略
    }
    this.hotkeyProc = null;
    this.hotkeyReady = false;
    this.hotkeyBuffer = "";
  }

  /**
   * 触发一次 STT 录音。任务进行中先 abort 当前任务再开始录音。
   * STT 关闭或无 API Key 时直接 return。
   */
  private async triggerStt() {
    if (!voice.isSttEnabled()) {
      console.log(chalk.cyan(t("STT 已关闭（用 /stt 打开）。", "STT is off (use /stt to enable).")));
      return;
    }
    if (this.isProcessing) {
      // 任务中按热键：先中断当前 Agent，再开始录音
      this.activeSession.abort().catch(() => {});
      this.isProcessing = false;
      this.aborted = true; // 阻止 processInput finally 再次 prompt
      this.ttsStream.cancel(); // 打断 TTS（STT 接管输入前清掉残余播放）
      this.hidePetBubble(); // 打断时立即隐藏气泡
      (this.rl as any).line = "";
      (this.rl as any).cursor = 0;
      process.stdout.write(chalk.yellow("\n[aborted by stt]\n"));
      this.rl.prompt(true);
    }
    // 让 readline 先把当前提示符行清掉，再启动录音 UI
    await new Promise((r) => setImmediate(r));
    console.log(chalk.cyan(t("聆听…请说话", "Listening…")));
    this.rl.prompt();
    const text = await voice.listen();
    if (text) {
      console.log(chalk.green(t(`听到：${text}`, `Heard: ${text}`)));
      await this.processInput(text);
    } else {
      console.log(chalk.cyan(t("未检测到语音。", "No speech detected.")));
      this.rl.prompt();
    }
  }

  /**
   * 保存当前会话。
   * - currentSessionPath 非 null（resume 的会话）：必保存，覆盖原文件（不走 hasConversation 判断）
   * - currentSessionPath 为 null（新会话）：仅在 hasConversation 为 true 时另存为新文件
   */
  private saveCurrentSessionIfNeeded() {
    const messages = this.session.messages;
    const model = this.session.model?.id || "unknown";
    if (this.currentSessionPath) {
      // resume 的会话：必保存（覆盖原文件），即使没有新增对话也保留原内容
      memory.saveSessionToPath(this.currentSessionPath, messages, model);
    } else if (memory.getHasConversation()) {
      // 新会话：仅有有效对话时才保存
      memory.saveSession(messages, model);
    }
  }

  /**
   * 恢复指定会话。
   * 1. 先保存当前会话（resume 的会话必保存覆盖原文件，新会话仅有有效对话时另存新文件）
   * 2. 加载目标会话的消息到 session
   * 3. 记录 currentSessionPath（退出时覆盖保存回原文件）
   * 4. 清屏并渲染历史记录
   */
  private resumeSession(path: string) {
    // 1. 先保存当前会话（resume 的会话覆盖原文件，新会话仅有有效对话时另存新文件）
    this.saveCurrentSessionIfNeeded();

    // 2. 加载目标会话
    try {
      const messages = memory.loadSession(path);
      this.session.agent.state.messages = messages;
      // 复制上下文方案下子会话消息每轮被覆盖，无需清历史；此处回收子 session 对象，
      // 让下轮按恢复的会话重新初始化（刷新 initSubAgent 期捕获的 memory 等快照）
      this.resetSubSessions();
      memory.resetConversationFlag();
      this.currentSessionPath = path; // 退出时覆盖保存回此文件
      console.clear();
      renderSavedMessages(messages);
    } catch (err) {
      console.error(chalk.red(`Failed to load session: ${err instanceof Error ? err.message : err}`));
      // 加载失败，currentSessionPath 保持不变
    }
  }

  private parseInput(input: string): string {
    let processed = input;

    // Handle @file references
    const fileRefs = processed.match(/@(\S+)/g);
    if (fileRefs) {
      for (const ref of fileRefs) {
        const filePath = resolve(ref.slice(1));
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8");
          processed = processed.split(ref).join(`\n--- ${ref.slice(1)} ---\n${content}\n--- end ---\n`);
        }
      }
    }

    // Handle !shell commands
    if (processed.startsWith("!")) {
      const cmd = processed.slice(1);
      try {
        const output = execSync(cmd, { encoding: "utf-8", maxBuffer: 1024 * 1024 * 10 });
        processed = `Shell command: \`${cmd}\`\nOutput:\n\`\`\`\n${output}\n\`\`\``;
      } catch (err) {
        processed = `Shell command: \`${cmd}\`\nError: ${err instanceof Error ? err.message : err}`;
      }
    }

    return processed;
  }

  async start() {
    // --resume= 启动时先清屏，确保 logo 和历史记录在干净的画面上
    if (this.resumedMessages) {
      console.clear();
    }
    printLogo();
    const statusLine: string[] = [];
    statusLine.push(t(`模型：${config.model}`, `Model: ${config.model}`));
    if (config.noVoice) {
      statusLine.push(t("语音：关", "Voice: off"));
    } else {
      statusLine.push(voice.hasCurrentVoice()
        ? t(`TTS：${voice.isTtsEnabled() ? `开（${getTtsProvider().label()}）` : "关"}`, `TTS: ${voice.isTtsEnabled() ? `on (${getTtsProvider().label()})` : "off"}`)
        : t("TTS：关（未配置声音）", "TTS: off (no voice configured)"));
      statusLine.push(t(`STT：${voice.isSttEnabled() ? "开" : "关"}`, `STT: ${voice.isSttEnabled() ? "on" : "off"}`));
    }
    console.log(chalk.cyan("  " + statusLine.join(" · ")));
    // 仅在有编程语义的操作提示时打印帮助行

    // --resume= 启动时渲染恢复的历史记录（在 logo 之后，提示符之前）
    if (this.resumedMessages) {
      renderSavedMessages(this.resumedMessages);
      this.resumedMessages = null; // 渲染完毕，释放引用
    }

    // Enable keypress events so we can intercept arrow/Tab/Esc while the user
    // is typing at the prompt. The keypress listener is added/removed based
    // on whether the slash menu is open.
    readline.emitKeypressEvents(process.stdin, this.rl);
    if (process.stdin.isTTY) {
      (process.stdin as any).setRawMode?.(true);
    }

    // 解析热键已移除：STT 热键改为全局监听（pynput），见 startHotkeyHook()

    this.rl.prompt();

    // 按键监听：菜单打开时拦截导航键并转发给 SlashMenu；其余按键交给
    // readline 先更新缓冲区，再在微任务里刷新菜单。
    // STT 热键检测已移至全局 hook（pynput），此处仅处理斜杠命令菜单。
    this.menuKeyListener = (_str: string, key: any) => {
      if (!key) return;
      if (this.menu.isOpen()) {
        if (key.name === "escape") { this.menu.close(this.rl); return; }
        if (key.name === "up" || key.name === "down") {
          this.menu.move(key.name === "up" ? -1 : 1, this.rl);
          return; // 不转发给 readline（避免移动输入光标）
        }
        // 行末再按 →：把选中指令填入输入框但不执行（用户可随后补参数/编辑，
        // 再自己 Enter）。光标不在行末时落到 readline 正常移动光标。
        if (key.name === "right") {
          const line: string = (this.rl as any).line ?? "";
          const cursor: number = (this.rl as any).cursor ?? 0;
          if (cursor >= line.length) {
            this.menu.complete(this.rl);
            return;
          }
        }
        if (key.name === "return") { this.menu.confirm(this.rl); return; } // 补全但不提交
        if (key.name === "tab") { return; } // 菜单内 Tab 无操作
      } else if (key.name === "escape" && this.isProcessing) {
        // 菜单关闭且正在执行任务：Esc 中断当前任务（不退出 CLI）
        this.activeSession.abort().catch(() => {});
        this.isProcessing = false;
        this.aborted = true; // 阻止 processInput finally 再次 prompt
        this.ttsStream.cancel(); // 打断 TTS
        this.hidePetBubble(); // 打断时立即隐藏气泡
        // 清空 readline 缓冲区，避免残留内容在重绘时混入提示符行
        (this.rl as any).line = "";
        (this.rl as any).cursor = 0;
        process.stdout.write(chalk.yellow("\n[aborted]\n"));
        this.rl.prompt(true);
        return;
      }
      // 其余按键：先让 readline 更新缓冲区，再在微任务里刷新菜单
      queueMicrotask(() => {
        // 若上述处理已把菜单关闭（Esc/Enter），跳过刷新
        if (this.menu.isOpen() && (key.name === "return" || key.name === "tab" || key.name === "escape")) return;
        this.menu.refresh(this.rl);
      });
    };
    // 用 prependListener 让本监听器先于 readline 的 keypress 监听器执行。
    // 这样 Enter 时我们先 confirm（设置 rl.line），readline 随后处理 return
    // 并 emit "line" 事件，line handler 收到的就是补全后的命令名。
    process.stdin.prependListener("keypress", this.menuKeyListener);

    // The 'line' event also needs to close the menu (in case the user
    // submitted text that no longer matches anything).
    this.rl.on("line", async (input: string) => {
      // 提交时关闭菜单（若仍打开）
      if (this.menu.isOpen()) this.menu.close(this.rl);

      // needsParams 指令：菜单 Enter 只填入不执行，
      // 消费信号后仅重绘提示行，让用户补参数再回车。信号由同一按键同步置位、
      // 紧随其后的 "line" 事件消费，无泄漏。
      if (this.menu.consumeNoExecSignal()) {
        // readline 处理 return 时已：①在 emit "line" 前清空 rl.line；②输出了
        // \r\n 换行。故必须用 input（confirm 补全后的指令）恢复 line，且 prompt
        // 带 preserveCursor=true（无参会把 cursor 归零、参数被插到行首），并在
        // 重绘前 \x1b[1A 上移一行抵消那次换行——否则补全内容会错位到下一行。
        (this.rl as any).line = input;
        (this.rl as any).cursor = input.length;
        process.stdout.write("\x1b[1A");
        this.rl.prompt(true);
        return;
      }

      const trimmed = input.trim();

      // Empty input — STT 改由热键触发，空 Enter 仅为刷新提示符
      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      // Slash commands
      if (trimmed.startsWith("/")) {
        await handleCommand(trimmed, this.getCommandContext());
        this.rl.prompt();
        return;
      }

      await this.processInput(trimmed);
    });

    // After every input change, decide whether to show/hide the menu.
    this.rl.on("close", () => {
      this.doExit();
    });

    // STT 开启时启动全局热键监听（pynput，长按全局录音热键 ≥2秒触发录音）
    if (voice.isSttEnabled()) {
      this.startHotkeyHook();
    }
  }

  private async processInput(input: string) {
    // 桌宠手势（摸头/dizzy）不再拼进用户消息：落到主 Agent 发送边界注入（gesture_context.ts），
    // 不进 state.messages → 子 Agent 复制主 session 历史时看不到、会话命名/存储零污染。
    // takeGesture 消费即清空由发送边界扩展完成，只注入最近一次。
    // 展开 @文件 / !命令 后走完整回合生命周期
    await this.runRawTurn(this.parseInput(input));
  }

  /** 把 renderer 订阅切到指定角色 session，并记录当前发言者。 */
  private setActiveAgent(agentId: AgentId, session: AgentSession): void {
    this.activeAgentId = agentId;
    this.activeSession = session;
    this.renderer.setSpeakerLabel(getAgentLabel(agentId));
    // 显式复位回合状态，杜绝跨 session 残留 curMsgText/lastText 被误读
    this.renderer.resetTurn();
    this.rendererUnsub?.();
    this.rendererUnsub = this.renderer.subscribe(session);
  }

  /**
   * 回收全部子 session 对象（dispose + 清空）。
   * 复制上下文方案下子会话每轮被主 session 消息覆盖，无需借此清历史；此处目的是释放
   * session 对象，并让下轮 ensureSubSessions 按新主会话/新子组合重新初始化，刷新
   * initSubAgent 期捕获的 memoryContent 等快照与工具状态（/new、/resume、/change-agent 时调用）。
   */
  private resetSubSessions(): void {
    for (const subSession of this.subSessions.values()) {
      try {
        subSession.dispose();
      } catch {
        // 回收失败不影响主流程
      }
    }
    this.subSessions.clear();
  }

  /** 按 settings.json 当前启用的子 Agent 初始化/补齐子 session。 */
  private async ensureSubSessions(): Promise<void> {
    const enabled = getSubAgents();
    for (const id of enabled) {
      if (this.subSessions.has(id)) continue;
      try {
        const { session } = await initSubAgent(id, this.modelRuntime);
        this.subSessions.set(id, session);
      } catch (err) {
        console.error(chalk.red(t(
          `初始化子 Agent ${getAgentLabel(id)} 失败：${err instanceof Error ? err.message : err}，已跳过该角色。`,
          `Failed to init sub-agent ${getAgentLabel(id)}: ${err instanceof Error ? err.message : err}; skipping it.`,
        )));
      }
    }
  }

  /**
   * 等待当前角色的 TTS 播放完毕（或禁用 TTS 时固定 5 秒）。
   * 这是"主 Agent 回复完 → 子 Agent 轮询"的节奏控制点。
   */
  private async waitTurnSettled(agentId: AgentId): Promise<void> {
    if (!voice.isTtsEnabledFor(agentId)) {
      await new Promise((r) => setTimeout(r, 5000));
      return;
    }
    // 先等最多 2s 让 play_start 到达（若文本全被长句过滤，不会播放）
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (this.ttsStream.isPending) {
          clearInterval(iv);
          resolve();
          return;
        }
        if (Date.now() - t0 > 2000) {
          clearInterval(iv);
          resolve();
        }
      }, 50);
    });
    if (this.ttsStream.isPending) {
      await new Promise<void>((resolve) => {
        const iv = setInterval(() => {
          if (!this.ttsStream.isPending) {
            clearInterval(iv);
            clearTimeout(tout);
            resolve();
          }
        }, 100);
        // 30s 兜底：异常卡死时不阻塞子 Agent 轮询/回合收尾
        const tout = setTimeout(() => {
          clearInterval(iv);
          resolve();
        }, 30000);
      });
    }
  }

  /** 从 session 新增消息中提取本轮 assistant 纯文本（用于 TTS / 回填主 session）。 */
  private extractNewAssistantText(stateMessages: any[], startLen: number): string {
    const texts: string[] = [];
    for (const m of stateMessages.slice(startLen)) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      const text = m.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text || "")
        .join("");
      if (text.trim()) texts.push(text);
    }
    return texts.join("\n").trim();
  }

  /**
   * 运行单个 Agent 的一轮（主或子）。
   * - 切 renderer/TTS 到该角色；
   * - 主 Agent：直接 prompt 用户输入（全量群聊历史已在 session 里）；
   * - 子 Agent：每轮把主 session 的全量群聊日志复制为自己的上下文（与主 Agent 看到的完全一致，
   *   用户输入/主回复/其他子回复都在内，无需拼接注入），只追加一条固定"轮到你了"触发消息；
   * - 提取回复：主 Agent 标记 speaker（历史回放 + 发送边界标注发言者）；
   *   子 Agent 回填主 session（speaker 标记），形成共享群聊历史。
   * 返回该轮文本（可能为空，例如 keep_silent）。
   */
  private async runOneAgent(
    session: AgentSession,
    agentId: AgentId,
    input: string,
    isSub: boolean,
  ): Promise<string> {
    this.setActiveAgent(agentId, session);
    // 段边界切音色：即使目标角色无音色也要更新 currentAgent，保证 isTtsEnabledFor 判断正确
    this.ttsStream.setVoice(agentId);

    if (isSub) {
      // 子 Agent：复制主 session 全量群聊日志作为上下文（浅拷贝，元素引用共享）。
      // 主/子聊天记录完全一致 → 各 Agent 前缀稳定，各自命中各自缓存（system prompt 人设不同 → 不同缓存条目）。
      session.agent.state.messages = [...(this.session.agent.state.messages as any[])];
    }

    const stateMessages = session.agent.state.messages as any[];
    const startLen = stateMessages.length;

    // 子 Agent 的触发消息：固定短句（上下文在复制来的全量日志里，这里只负责"叫醒"它发言）
    const promptText = isSub
      ? t("（现在轮到你，请简短发言）", "(It's your turn now, speak briefly)")
      : input;

    try {
      await session.prompt(promptText);
    } catch (err) {
      console.error(chalk.red(t("\n错误：", "\nError: ") + (err instanceof Error ? err.message : err)));
      return "";
    }

    const text = this.extractNewAssistantText(stateMessages, startLen);
    if (!text) return "";

    if (!isSub) {
      // 主 Agent 的 assistant 消息补 speaker 标记（历史回放显示角色名 + speaker_context 扩展标注发言者）
      for (const m of stateMessages.slice(startLen)) {
        if (m.role === "assistant") m.speaker = agentId;
      }
    } else {
      // 子 Agent 回复回填主 session，形成共享群聊历史（主 Agent 及其他子 Agent 下轮可见）
      (this.session.agent.state.messages as any[]).push({
        role: "assistant",
        speaker: agentId,
        content: [{ type: "text", text }],
      });
    }
    return text;
  }

  /**
   * 走完整多角色回合生命周期（markConversation / undo checkpoint / isProcessing /
   * 主 Agent → settle → 子 Agent 逐个 settle / pet.reset / abort）。
   * 不展开 @文件 / !命令；供普通输入与 /skill 共用。
   */
  private async runRawTurn(input: string) {
    memory.markConversation();
    this.isProcessing = true;
    this.turnEnded = false;
    // 回合开始前打断上一回合残余 TTS 播放（新输入立即接管）
    this.ttsStream.cancel();
    this.hidePetBubble();
    // 回合开始前打 checkpoint:扫一次当前工作目录,作为 before 快照
    // (回合结束后 afterTurn 会与它做 diff 入 undo 栈)
    await this.undoManager.beforeTurn();
    // 回合开始：不主动切换情绪，保持默认待机动画；
    // 由 agent 调用 change_emotion 一步到位地确定本回合情绪，避免先 saying 再切换的跳变

    try {
      await this.ensureSubSessions();

      // 0. 记忆增量检测：MEMORY.md 运行时变更 → 追加到下一轮主 Agent 的 user 消息末尾
      //    （子 Agent 复制主 session 全量后自动继承，无需单独注入）
      const memoryDelta = memory.getMemoryDelta();
      const mainInput = memoryDelta ? `${input}\n\n${memoryDelta}` : input;

      // 1. 主 Agent 回复
      await this.runOneAgent(this.session, getMainAgent(), mainInput, false);
      if (this.aborted) return;
      await this.waitTurnSettled(getMainAgent());
      if (this.aborted) return;

      // 2. 子 Agent 逐个轮询回复（每个子 Agent 回复后等待其 TTS 播完/静音 5s）
      for (const subId of getSubAgents()) {
        const subSession = this.subSessions.get(subId);
        if (!subSession) continue;
        await this.runOneAgent(subSession, subId, input, true);
        if (this.aborted) return;
        await this.waitTurnSettled(subId);
        if (this.aborted) return;
      }

      // 3. 回合结束：renderer 订阅切回主 session，方便下一轮 prompt 展示
      this.setActiveAgent(getMainAgent(), this.session);
    } catch (err) {
      console.error(chalk.red(t("\n错误：", "\nError: ") + (err instanceof Error ? err.message : err)));
    } finally {
      // 回合结束后打 after checkpoint,产出 diff 入 undo 栈
      try {
        await this.undoManager.afterTurn();
      } catch (err) {
        // undo checkpoint 失败不影响主流程
        console.warn(chalk.yellow(t(`撤销快照记录失败：${err instanceof Error ? err.message : err}`, `Failed to record undo snapshot: ${err instanceof Error ? err.message : err}`)));
      }
      this.isProcessing = false;
      // 回合结束：恢复桌宠到 idle
      // - TTS 启用 + 无残余播放 → 立即 reset；有残余由 onIdle(play_end) 兜底
      // - TTS 禁用（--no-voice / 缺音色 / 切到无音色角色）→ 5s 后再撤表情和气泡
      this.turnEnded = true;
      if (voice.isTtsEnabledFor(this.activeAgentId)) {
        if (!this.ttsStream.isPending) pet.reset();
      } else {
        this.scheduleBubbleHide();
      }
      // 若被 Esc/Ctrl+C 中断，中断处理已重绘提示符，跳过重复 prompt
      if (this.aborted) {
        this.aborted = false;
        return;
      }
      console.log(); // Extra newline after response
      this.rl.prompt();
    }
  }

  private async doExit() {
    // 保存当前会话（resume 的会话覆盖原文件，新会话另存为新文件）
    this.saveCurrentSessionIfNeeded();

    // Cleanup keypress listener so the process can actually exit
    if (this.menuKeyListener) {
      process.stdin.removeListener("keypress", this.menuKeyListener);
      this.menuKeyListener = null;
    }
    if (process.stdin.isTTY) {
      (process.stdin as any).setRawMode?.(false);
    }

    // 停止全局热键监听（pynput）
    this.stopHotkeyHook();

    // 停止 TTS：终止当前合成进程并清空队列；同时回收本进程自动启动的 GPT-SoVITS api_v2 子进程
    this.ttsStream.shutdown();
    stopGptSovitsLocalServer();

    // Cleanup
    stopComputerUse();
    try {
      await disconnectAllMcp();
    } catch {
      // 忽略清理失败，继续退出
    }
    stopPet();
    this.session.dispose();
    for (const subSession of this.subSessions.values()) {
      try {
        subSession.dispose();
      } catch {
        // 子 session 清理失败不影响退出
      }
    }

    this.onExit();
    process.exit(0);
  }
}
