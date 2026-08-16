import * as readline from "readline";
import chalk from "chalk";
import { execSync, type ChildProcessWithoutNullStreams } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { AgentSession, ModelRuntime, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";
import { handleCommand, type CommandContext } from "./commands.ts";
import { createRenderer, renderSavedMessages } from "./renderer.ts";
import * as memory from "./memory.ts";
import * as voice from "./voice.ts";
import { stopComputerUse } from "./tools/computer_use.ts";
import { disconnectAllMcp } from "./mcp.ts";
import { pet, stopPet } from "./pet.ts";
import { SlashMenu } from "./slash_menu.ts";
import { printLogo } from "./logo.ts";
import { PYTHON_DIR } from "./config.ts";
import { UndoManager } from "./undo.ts";
import { t } from "./locale.ts";
import { spawnCompat } from "./utils/spawn.ts";

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
  private ttsPending = false; // TTS 播放中：回合未真正结束，桌宠暂不恢复默认视频
  private ttsQueue: string[] = []; // 逐句 TTS 待播队列（串行播放，避免重叠）
  private ttsPlaying = false; // drainTtsQueue 正在排空中
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
    // onMessageComplete: 每条消息结束时触发逐句 TTS（<50 字过滤）
    // onResponseComplete: 回合结束时保存最后一条消息文本（供 /export）
    this.renderer = createRenderer(
      (text) => this.enqueueTts(text),
    );
    this.rendererUnsub = this.renderer.subscribe(this.session);

    this.setupSignals();
  }

  /**
   * 将一段消息文本加入 TTS 待播队列。<50 字才入队（长段技术说明跳过）。
   * 队列串行播放，避免多段语音重叠。
   */
  private enqueueTts(text: string): void {
    const clean = text.trim();
    if (!config.ttsAuto || !voice.isTtsEnabled() || !clean || clean.length >= 50) return;
    this.ttsQueue.push(clean);
    this.ttsPending = true;
    void this.drainTtsQueue();
  }

  /**
   * 排空 TTS 队列：串行播放每段文本。队列空后恢复桌宠默认视频。
   * 若已在排空则直接返回——新项会被正在运行的循环自动取出。
   */
  private async drainTtsQueue(): Promise<void> {
    if (this.ttsPlaying) return;
    this.ttsPlaying = true;
    while (this.ttsQueue.length > 0) {
      const text = this.ttsQueue.shift()!;
      await voice.speak(text);
    }
    this.ttsPlaying = false;
    this.ttsPending = false;
    pet.reset();
  }

  private setupSignals() {
    // 注意：emitKeypressEvents 后，Ctrl+C 由 readline 拦截并 emit rl 的
    // 'SIGINT' 事件，不会冒泡到 process 的 SIGINT。所以必须监听 rl 上的
    // SIGINT，否则空闲态按 Ctrl+C 会直接走 readline 默认行为（关闭接口）。
    this.rl.on("SIGINT", () => {
      // 正在执行任务：第一次中断任务，第二次（紧随其后）直接退出
      if (this.isProcessing) {
        this.session.abort().catch(() => {});
        this.isProcessing = false;
        this.aborted = true; // 阻止 processInput finally 再次 prompt
        this.ttsQueue = []; // 清空待播 TTS，中断后不再播放后续句子
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
        this.currentSessionPath = null; // 新会话清除源文件路径，退出时另存为新文件
        this.rendererUnsub?.();
        this.rendererUnsub = this.renderer.subscribe(this.session);
      },
      runAgentTurn: (text: string) => this.runRawTurn(text),
      resumeSession: (path: string) => {
        this.resumeSession(path);
      },
      saveCurrentSession: () => {
        // /change-main-agent 重建会话前落盘当前对话（resume 覆盖原文件 / 新会话仅有效对话）
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
   * 检测到右 Cmd 长按 ≥2 秒时，hotkey.py 输出 {"event":"trigger"}，触发 STT 录音。
   */
  private async startHotkeyHook() {
    if (this.hotkeyProc) return; // 已启动
    const scriptPath = `${PYTHON_DIR}/hotkey.py`;
    this.hotkeyReady = false;
    this.hotkeyBuffer = "";
    try {
      const proc = spawnCompat(config.pythonPath, ["-u", scriptPath], {
        env: {
          ...process.env,
          ARONA_HOTKEY_KEY: "cmd_r",
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
      console.warn(chalk.yellow(
        t(
          "STT 热键不可用：全局键盘监听启动失败。\n" +
          "  请确认已安装 pynput（pip install pynput），\n" +
          "  并在 系统设置 → 隐私与安全性 → 辅助功能 中为Python 授权。",
          "STT hotkey unavailable: global keyboard listener failed to start.\n" +
          "  Make sure pynput is installed (pip install pynput),\n" +
          "  and grant Accessibility permission to Python in System Settings.",
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
      this.session.abort().catch(() => {});
      this.isProcessing = false;
      this.aborted = true; // 阻止 processInput finally 再次 prompt
      this.ttsQueue = []; // 清空待播 TTS
      (this.rl as any).line = "";
      (this.rl as any).cursor = 0;
      process.stdout.write(chalk.yellow("\n[aborted by stt]\n"));
      this.rl.prompt(true);
    }
    // 让 readline 先把当前提示符行清掉，再启动录音 UI
    await new Promise((r) => setImmediate(r));
    console.log(chalk.cyan(t("正在聆听... 请说话", "Listening... speak now")));
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
    console.log(chalk.cyan(t(`  模型：${config.model}`, `  Model: ${config.model}`)));
    if (config.noVoice) {
      console.log(chalk.cyan(t("  语音：已禁用（--no-voice）", "  Voice: disabled (--no-voice)")));
    } else {
      console.log(chalk.cyan(t(`  TTS：${voice.isTtsEnabled() ? "开" : "关"}`, `  TTS: ${voice.isTtsEnabled() ? "on" : "off"}`)));
      console.log(chalk.cyan(t(`  STT：${voice.isSttEnabled() ? "开" : "关"}`, `  STT: ${voice.isSttEnabled() ? "on" : "off"}`)));
      // STT 开启时打印热键提示：长按右 Cmd ≥2秒录音；任务中按会先 abort 再录音
      if (voice.isSttEnabled()) {
        console.log(chalk.cyan(t(`  录音：长按右 Cmd ≥${STT_HOLD_MS / 1000}秒（提前松开取消）`, `  Record: hold right Cmd ≥${STT_HOLD_MS / 1000}s (release early to cancel)`)));
        // 非 macOS 无 系统设置 → 隐私与安全性 → 辅助功能 这一路径，提示仅对 macOS 显示
        if (process.platform === "darwin") {
          console.log(chalk.cyan(t("  提示：若热键无响应，请在 系统设置 → 隐私与安全性 → 辅助功能 中为Python授权", "  Tip: if the hotkey does not respond, grant Accessibility permission to Python in System Settings → Privacy & Security")));
        }
      }
    }
    console.log(chalk.cyan(t("  输入 / 弹出命令菜单，/help 查看完整命令，/exit 退出。\n", "  Type / to open the command menu, /help for all commands, /exit to quit.\n")));

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
        if (key.name === "return") { this.menu.confirm(this.rl); return; } // 补全但不提交
        if (key.name === "tab") { return; } // 菜单内 Tab 无操作
      } else if (key.name === "escape" && this.isProcessing) {
        // 菜单关闭且正在执行任务：Esc 中断当前任务（不退出 CLI）
        this.session.abort().catch(() => {});
        this.isProcessing = false;
        this.aborted = true; // 阻止 processInput finally 再次 prompt
        this.ttsQueue = []; // 清空待播 TTS
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

    // STT 开启时启动全局热键监听（pynput，长按右 Cmd ≥2秒触发录音）
    if (voice.isSttEnabled()) {
      this.startHotkeyHook();
    }
  }

  private async processInput(input: string) {
    // 展开 @文件 / !命令 后走完整回合生命周期
    await this.runRawTurn(this.parseInput(input));
  }

  /**
   * 走完整 Agent 回合生命周期（markConversation / undo checkpoint / isProcessing /
   * pet.reset / abort），但不展开 @文件 / !命令。
   * 供 /skill 等需要原样提交内容（含 markdown 中的 @ / !）的场景使用。
   */
  private async runRawTurn(input: string) {
    memory.markConversation();
    this.isProcessing = true;
    // 回合开始前打 checkpoint:扫一次当前工作目录,作为 before 快照
    // (回合结束后 afterTurn 会与它做 diff 入 undo 栈)
    this.undoManager.beforeTurn();
    // 回合开始：不主动切换情绪，保持空闲视频动画播放；
    // 由 agent 调用 change_emotion 一步到位地确定本回合情绪，避免先 saying 再切换的跳变

    try {
      await this.session.prompt(input);
    } catch (err) {
      console.error(chalk.red(t("\n错误：", "\nError: ") + (err instanceof Error ? err.message : err)));
    } finally {
      // 回合结束后打 after checkpoint,产出 diff 入 undo 栈
      try {
        this.undoManager.afterTurn();
      } catch (err) {
        // undo checkpoint 失败不影响主流程
        console.warn(chalk.yellow(t(`撤销快照记录失败：${err instanceof Error ? err.message : err}`, `Failed to record undo snapshot: ${err instanceof Error ? err.message : err}`)));
      }
      this.isProcessing = false;
      // 无 TTS 时回合随回复结束；有 TTS 时由 drainTtsQueue() 排空后恢复默认视频
      if (!this.ttsPending) pet.reset();
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

    // Cleanup
    stopComputerUse();
    try {
      await disconnectAllMcp();
    } catch {
      // 忽略清理失败，继续退出
    }
    stopPet();
    this.session.dispose();

    this.onExit();
    process.exit(0);
  }
}
