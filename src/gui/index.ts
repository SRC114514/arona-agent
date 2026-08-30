// GUI 模式入口：Node 后端父进程 + Electron 窗口子进程（###GUI### 行协议，与桌宠桥同模式）。
// 启动条件：裸 `arona`（默认入口，src/index.ts 分流到本文件；--cli / settings.json CLIEnabled: true 时走命令行）。
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import chalk from "chalk";
import { PROJECT_ROOT, settingsExist, reloadConfig, config, verbose } from "../config.ts";
import { t, refreshLanguage } from "../locale.ts";
import { getElectronPath } from "../utils/electron_bin.ts";
import { formatGuiLine, parseGuiLine, type GuiEvent, type GuiRequest } from "./protocol.ts";
import type { GuiController } from "./controller.ts";
import { runGuiSetup, type GuiSetupForm } from "./setup_backend.ts";
import { listMcpServers, callMcpTool, disconnectAllMcp } from "../mcp.ts";
import { stopGptSovitsLocalServer } from "../gpt_sovits_local.ts";
import { stopComputerUse } from "../tools/computer_use.ts";

const GUI_DIR = join(PROJECT_ROOT, "gui");

class GuiBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private controller: GuiController | null = null;
  private startingMain = false;
  private exited = false;
  // Windows 下 spawn 后立刻写 stdin 会丢数据，且实测 GUI 子系统 Electron 的 stdin **完全不可达**
  //（hello 握手证明进程与 stdout 均正常，数据仍不到达）——GUI 进程起 127.0.0.1 随机端口 + 随机 token
  // 的 HTTP 服务，端口/token 随 hello 行告知；hello 前入队，收到后按序经 HTTP 下发。
  // httpPort=0（HTTP 起失败）时退回 stdin 写入（非 Windows 平台 stdin 本来就通）。
  private helloReceived = false;
  private queuedEvents: GuiEvent[] = [];
  private guiHttpPort = 0;
  private guiHttpToken = "";
  private httpChain: Promise<void> = Promise.resolve(); // 串行链保序（HTTP 异步，并发会乱序）

  emit(ev: GuiEvent): void {
    if (verbose) console.error(chalk.gray("[gui:verbose]"), "emit", ev.type, this.helloReceived ? "" : "(queued)");
    if (!this.helloReceived) {
      this.queuedEvents.push(ev);
      return;
    }
    if (!this.proc || this.proc.killed) return;
    if (this.guiHttpPort) {
      this.httpChain = this.httpChain.then(() => this.postEvent(ev));
      return;
    }
    try {
      this.proc.stdin.write(formatGuiLine(ev));
    } catch {
      // stdin 已关闭，忽略
    }
  }

  /** 经本地 HTTP 通道下发事件（gui/main.cjs 的 127.0.0.1 随机端口服务，token 鉴权） */
  private async postEvent(ev: GuiEvent): Promise<void> {
    try {
      await fetch(`http://127.0.0.1:${this.guiHttpPort}/`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-arona-token": this.guiHttpToken },
        body: JSON.stringify(ev),
      });
    } catch (err) {
      if (verbose) {
        console.error(chalk.gray("[gui:verbose]"), "http emit failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  async start(): Promise<void> {
    const electronPath = await getElectronPath();
    if (!electronPath) {
      console.error(chalk.red(t("GUI：Electron 不可用，退出。", "GUI: Electron unavailable, exiting.")));
      process.exit(1);
    }

    const env: NodeJS.ProcessEnv = { ...process.env, ARONA_GUI: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = ["--no-sandbox"];
    if (verbose) {
      // --enable-logging：渲染进程 console（GPU 初始化失败等）原样打进 stderr，白屏根因不传则完全不可见；
      // ARONA_GUI_VERBOSE：接通 gui/main.cjs 的 VERBOSE 分支（GPU feature status / renderer console
      // 全量转发 / devtools 自动打开）——此前未接线，--verbose 下这些诊断从未生效过。
      args.push("--enable-logging");
      env.ARONA_GUI_VERBOSE = "1";
      console.error(chalk.gray("[gui:verbose]"), "spawn", electronPath, args.concat(join(GUI_DIR, "main.cjs")).join(" "));
    }

    this.proc = spawn(electronPath, args.concat(join(GUI_DIR, "main.cjs")), {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // 握手超时告警：hello 不来 = GUI 进程的 stdin/stdout 协议链路不通（页面白屏只是其结果）
    setTimeout(() => {
      if (!this.helloReceived && !this.exited && this.proc) {
        console.error(chalk.red(t(
          "GUI：15s 未收到 GUI 进程握手（hello），###GUI### stdin 协议链路不通，界面将保持白屏。",
          "GUI: no handshake (hello) from the GUI process within 15s; the ###GUI### stdin protocol is broken and the window will stay blank.",
        )));
      }
    }, 15000);

    this.proc.stdout.on("data", (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        const req = parseGuiLine(line);
        if (req) void this.handleRequest(req);
      }
    });

    // Electron 自身日志（main.cjs 走 stderr 转发）；非 verbose 仅打印错误行，
    // dbus/GLib/IMKCFRunLoopWakeUpReliable 为系统层噪音（Linux 桌面 / macOS 输入法），过滤之
    this.proc.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (!msg) return;
      if (verbose || (!msg.includes("dbus") && !msg.includes("GLib") && !msg.includes("IMKCFRunLoopWakeUpReliable"))) {
        console.error(chalk.gray("[gui]"), msg);
      }
    });

    this.proc.on("close", (code) => {
      this.proc = null;
      if (this.exited) return;
      // 窗口被系统/用户关闭：走完整清理后退出
      void this.shutdown(code ?? 0);
    });

    // 首次运行 → setup 页；否则直接进主界面
    if (!settingsExist()) {
      this.emit({ type: "mode", mode: "setup" });
      const { VOICE_AGENT_IDS, getAgentLabel } = await import("../agent_registry.ts");
      this.emit({
        type: "setup_info",
        agents: VOICE_AGENT_IDS.map((id) => ({ id, label: getAgentLabel(id) })),
      });
    } else {
      await this.startMain();
    }
  }

  /** 初始化主界面（Agent session / 桌宠 / TTS）并通知前端。 */
  private async startMain(): Promise<void> {
    if (this.startingMain || this.controller) return;
    this.startingMain = true;
    try {
      reloadConfig();
      refreshLanguage();

      const [{ initAgent }, { startPet }, { preloadGptSovitsLocal }, { syncSkillsFromAgentsDir }, { GuiController }] =
        await Promise.all([
          import("../agent.ts"),
          import("../pet.ts"),
          import("../tts_provider.ts"),
          import("../skills.ts"),
          import("./controller.ts"),
        ]);

      if (config.autoLoadSkills) {
        syncSkillsFromAgentsDir();
      }

      // 旧会话工作区一次性回填（按内容推断；已在启动初期完成，会话列表/侧栏分组才准确）
      const { backfillLegacyWorkspaces } = await import("../memory.ts");
      const migrated = backfillLegacyWorkspaces();
      if (migrated > 0) {
        console.error(chalk.gray(`[ws] 已将 ${migrated} 个历史会话按内容归入工作区`));
      }

      // 恢复/设定活动工作区（须在 initAgent 前，SDK cwd 跟随）。GUI 的进程启动目录
      // 对用户无意义，不作为工作区：有上次选择用之，否则默认家目录。
      const { getLastWorkspace } = await import("../config.ts");
      const { setActiveWorkspace, guiDefaultWorkspace } = await import("../workspace.ts");
      const last = getLastWorkspace();
      setActiveWorkspace(last && existsSync(last) ? last : guiDefaultWorkspace());

      let current = await initAgent();
      await startPet();
      preloadGptSovitsLocal();

      this.controller = new GuiController(
        current.session,
        current.modelRuntime,
        current.loader,
        (ev) => this.emit(ev),
        () => {
          this.exited = true;
          process.exit(0);
        },
        // 只负责创建新会话（cwd 跟随当前活动工作区）；旧会话的生命周期由 controller
        // 槽位管理：生成中挂后台继续、空闲存盘释放，这里不得 dispose。
        async () => {
          const { initAgent } = await import("../agent.ts");
          return await initAgent();
        },
      );

      this.emit({ type: "mode", mode: "main" });
      this.emit({ type: "ready", state: this.controller.buildState() });
      this.controller.pushSessions();
      const { SLASH_COMMANDS } = await import("../slash_registry.ts");
      // GUI 菜单不展示的命令：恢复走侧栏列表、语音走设置开关、new/exit 走按钮（CLI 不受影响）。
      // 仅隐藏菜单项；handleCommand 分发仍解析它们。
      const GUI_HIDDEN_COMMANDS = new Set(["help", "exit", "new", "resume", "tts", "stt", "change-agent"]);
      this.emit({
        type: "commands",
        commands: SLASH_COMMANDS.filter((c) => !GUI_HIDDEN_COMMANDS.has(c.name)).map((c) => ({
          name: c.name,
          aliases: c.aliases ?? [],
          description: c.description,
          interactive: c.interactive,
          needsParams: c.needsParams,
        })),
      });
    } catch (err) {
      console.error(chalk.red(t("GUI：初始化失败：", "GUI: init failed: ") + (err instanceof Error ? err.message : err)));
      this.emit({ type: "notice", level: "error", text: String(err instanceof Error ? err.message : err) });
      process.exit(1);
    } finally {
      this.startingMain = false;
    }
  }

  private async handleRequest(req: GuiRequest): Promise<void> {
    switch (req.type) {
      case "hello": {
        // GUI 进程握手：解锁排队中的事件（emit mode/setup_info 在 spawn 后立即调用，Windows 下彼时
        // stdin 写入会丢失）。端口/token 就位后，后续事件经本地 HTTP 通道下发。
        this.helloReceived = true;
        this.guiHttpPort = Number(req.httpPort) || 0;
        this.guiHttpToken = String(req.token || "");
        const queued = this.queuedEvents;
        this.queuedEvents = [];
        if (verbose && queued.length) {
          console.error(chalk.gray("[gui:verbose]"), "hello received (httpPort=" + this.guiHttpPort + "), flushing", queued.length, "queued events");
        }
        for (const ev of queued) this.emit(ev);
        break;
      }
      case "setup_submit": {
        const ok = await runGuiSetup(req.form as unknown as GuiSetupForm, (ev) => this.emit(ev));
        if (ok) await this.startMain();
        else this.emit({ type: "setup_failed" });
        break;
      }
      case "exit":
        await this.shutdown(0);
        break;
      case "abort":
        this.controller?.abort();
        break;
      case "input":
        await this.controller?.handleInput(req.text);
        break;
      case "command":
        await this.controller?.handleCommand(`/${req.name}${req.args ? " " + req.args : ""}`);
        break;
      case "stt_start":
        await this.controller?.startStt();
        break;
      case "stt_stop":
        // 录音中再次点击麦克风：取消识别
        this.controller?.cancelStt();
        break;
      case "list_sessions":
        await this.controller?.handleCommand("/resume");
        break;
      case "list_skills":
        await this.controller?.handleCommand("/skill");
        break;
      case "list_agents":
        await this.controller?.handleCommand("/change-agent");
        break;
      case "list_mcp":
        this.emit({ type: "mcp_servers", servers: listMcpServers() });
        break;
      case "resume_session":
        this.controller?.resumeSession(req.path);
        break;
      case "delete_session":
        this.controller?.deleteSessionByPath(req.path);
        break;
      case "rename_session":
        this.controller?.renameSessionByPath(req.path, req.title);
        break;
      case "set_workspace":
        await this.controller?.setWorkspace(req.path);
        break;
      case "move_session":
        this.controller?.moveSessionByPath(req.path, req.workspace);
        break;
      // pick_workspace_folder 在 gui/main.cjs 进程内拦截弹原生目录框，不经此处
      case "invoke_skill":
        await this.controller?.handleCommand(`/skill ${req.name}`);
        break;
      case "change_agent":
        await this.controller?.applyAgentSelection(req.main, req.subs);
        break;
      case "mcp_call": {
        try {
          const result = await callMcpTool(req.server, req.tool, req.args);
          this.emit({ type: "notice", level: "info", text: String(result) });
        } catch (err) {
          this.emit({ type: "notice", level: "error", text: String(err instanceof Error ? err.message : err) });
        }
        break;
      }
    }
  }

  /** 完整清理（保存会话、停桌宠/TTS/MCP）后退出。 */
  private async shutdown(code: number): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    if (this.controller) {
      await this.controller.doExit();
      // doExit 的 onExit 会 process.exit(0)
      return;
    }
    // setup 阶段直接退出：清理可能已拉起的子进程
    try {
      await disconnectAllMcp();
    } catch {
      // 忽略
    }
    stopGptSovitsLocalServer();
    stopComputerUse();
    process.exit(code);
  }
}

export async function runGui(): Promise<void> {
  // GUI 模式标记：设置到本进程环境（create_subagent 等模块据此把子代理事件转发前端而非打印终端），
  // 同时随 Electron 子进程 env 传递
  process.env.ARONA_GUI = "1";
  const bridge = new GuiBridge();
  await bridge.start();
}

// bin/arona.mjs 直接 spawn 本文件时自启动；被 src/index.ts import 时不重复执行
import { pathToFileURL } from "node:url";
import { resolve as pathResolve } from "node:path";
if (process.argv[1] && import.meta.url === pathToFileURL(pathResolve(process.argv[1])).href) {
  runGui().catch((err) => {
    console.error(chalk.red(t("GUI：致命错误：", "GUI: fatal error: ") + (err instanceof Error ? err.message : err)));
    process.exit(1);
  });
}
