import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { PET_DIR, verbose } from "./config.ts";
import { getMainAgent, getSubAgents, type AgentId } from "./agent_registry.ts";
import { t } from "./locale.ts";

/** 桌宠要注入到下一轮用户消息的手势事件类型（摸头 / dizzy） */
export type PetGestureType = "pat" | "dizzy";

const PREFIX = "###PET###";
const MAX_RESTARTS = 3;
const STDERR_RING_SIZE = 100; // 崩溃时 dump 的 stderr 最近行数
// Electron 42+ 移除了 postinstall 自动下载：二进制改为首次 require 时才按需下载（供应链安全考虑）。
// pet 桥是项目里唯一 require("electron") 的地方，这里用国内镜像在 import 之前手动预下载，
// 避免首次启动时 CLI 卡在慢速的 GitHub Releases 下载上。
const ELECTRON_DIR = join(PET_DIR, "..", "node_modules", "electron");
// 国内源实测：华为云 mirrors.huaweicloud.com/electron/ 可用（v<版本>/*.zip → 200）；npmmirror 亦可。
const ELECTRON_MIRROR = "https://mirrors.huaweicloud.com/electron/";

// --verbose 调试日志：原样转发 Electron stdout/stderr、spawn 参数、协议消息，
// 用于锁定 Windows 白屏等"进程活着但无画面"类问题（正常模式这些日志被静默/过滤）。
function vlog(...args: unknown[]): void {
  if (verbose) console.error(chalk.gray("[pet:verbose]"), ...args);
}

/** 与 electron/install.js getPlatformPath() 保持一致：各平台可执行文件的相对路径 */
function electronPlatformPath(): string {
  if (process.platform === "win32") return "electron.exe";
  if (process.platform === "darwin") return "Electron.app/Contents/MacOS/Electron";
  return "electron";
}

/** dist 二进制是否已就绪（版本匹配 + 可执行文件存在），与 install.js 的 isInstalled() 判定一致 */
function isElectronInstalled(): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(ELECTRON_DIR, "package.json"), "utf-8"));
    const version = readFileSync(join(ELECTRON_DIR, "dist", "version"), "utf-8").replace(/^v/, "");
    return version === pkg.version && existsSync(join(ELECTRON_DIR, "dist", electronPlatformPath()));
  } catch {
    return false;
  }
}

/**
 * Desktop pet bridge: spawns the Electron pet window as a subprocess and
 * talks to it via stdin/stdout JSON lines (protocol lines prefixed with
 * ###PET### to filter Electron's own stdout noise).
 *
 * All commands are fire-and-forget — the pet is not a critical path.
 */
class PetBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private intentionalStop = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  // stderr 环形缓冲：进程异常退出时 dump 最近输出，便于定位崩溃根因
  private stderrRing: string[] = [];
  // 当前桌宠角色（ARONA_AGENT env 传给 pet/main.cjs）；默认跟随 settings.json mainAgent
  private agentId: AgentId = getMainAgent();
  // 当前启用的子 Agent（ARONA_SUB_AGENTS env 传给 pet/main.cjs）；默认跟随 settings.json subAgents
  private subAgents: AgentId[] = getSubAgents();
  // 待切换角色组合：stop() 后等待旧进程 close 再以新组合拉起（避免双窗口闪现）
  private pendingSelection: { main: AgentId; subs: AgentId[] } | null = null;
  // 最近一次桌宠手势（摸头/dizzy）：只保留最新一次，供下一条用户消息注入一次后即消费清空
  private latestGesture: PetGestureType | null = null;

  /**
   * Electron 42+ 把二进制下载从 postinstall 挪到了首次 require，而 pet 桥是唯一
   * require("electron") 的地方。这里在 import 之前抢先检查 dist 是否就绪：
   * 未就绪则用国内镜像手动执行预下载脚本（install.js 与原 postinstall 同代码、自带幂等检查），
   * 并给下载过程让出一段专属输出区域提示用户等待。
   *
   * @returns "missing" = electron npm 包未安装;true = 已就绪或下载成功;false = 下载失败
   */
  private async ensureElectronBinary(): Promise<true | false | "missing"> {
    if (!existsSync(join(ELECTRON_DIR, "package.json"))) return "missing";
    if (isElectronInstalled()) return true;

    // 下载期间只显示一行提示，忽略 --verbose；install.js 的进度/冗余输出全部静默（stdio 不继承）
    console.log(chalk.cyan(t("  正在使用国内源下载Electron……", "  Downloading Electron from CN mirror…")));

    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(process.execPath, [join(ELECTRON_DIR, "install.js")], {
        // 注入国内镜像；用户若已自定义 ELECTRON_MIRROR 则尊重其配置
        env: { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? ELECTRON_MIRROR },
        // 默认静默（只显示一行提示）；--verbose 时转发 install.js 全量输出便于排障
        stdio: verbose ? "inherit" : "ignore",
      });
      child.on("error", (err) => {
        console.warn(chalk.yellow(t(`桌宠：无法启动 Electron 安装器（${err.message}）。`, `Pet: failed to launch Electron installer (${err.message}).`)));
        resolve(false);
      });
      child.on("exit", (code) => {
        if (code !== 0) {
          console.warn(chalk.yellow(t("桌宠：Electron 下载失败，已跳过桌宠，可稍后重试。", "Pet: Electron download failed, pet skipped; retry later.")));
          resolve(false);
          return;
        }
        console.log(chalk.green(t("  ✓ Electron 安装完成", "  ✓ Electron installed")));
        resolve(true);
      });
    });
    return ok;
  }

  async start(): Promise<void> {
    // Headless 环境降级（Linux 无显示服务器时直接跳过）
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      console.warn(chalk.yellow(t("桌宠：无显示服务器，跳过启动。", "Pet: no display server, skipping startup.")));
      return;
    }

    // 未安装 electron 包 → 维持原有降级提示；下载失败 → 提示已在 ensureElectronBinary 内输出
    const binaryState = await this.ensureElectronBinary();
    if (binaryState === "missing") {
      console.warn(chalk.yellow(t("桌宠：未安装 electron，跳过启动（npm install -D electron）。", "Pet: electron not installed, skipping startup (npm install -D electron).")));
      return;
    }
    if (binaryState === false) return;

    let electronPath: string;
    try {
      // electron 包默认导出二进制路径字符串
      const mod = await import("electron");
      electronPath = mod.default as unknown as string;
    } catch {
      console.warn(chalk.yellow(t("桌宠：electron 加载失败，跳过启动。", "Pet: failed to load electron, skipping startup.")));
      return;
    }

    this.intentionalStop = false;

    try {
      // 剔除 ELECTRON_RUN_AS_NODE，否则 Electron 会退化为纯 Node 运行；
      // 注入 ARONA_AGENT 让桌宠主进程选择主角色，ARONA_SUB_AGENTS 选择子角色窗口（agents.cjs）
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ARONA_AGENT: this.agentId,
        ARONA_SUB_AGENTS: this.subAgents.join(","),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      // --no-sandbox：部分环境（权限受限的终端/容器）无法初始化 Chromium sandbox；
      // 桌宠只加载本地文件，关闭 sandbox 风险可接受
      const args = ["--no-sandbox"];
      if (verbose) {
        // --enable-logging：把渲染进程 console（WebGL/GPU 初始化失败等）原样打进 stderr——
        // 不传的话 renderer 的 console.error 默认只进 devtools，白屏根因完全不可见。
        // 同时用 env 通知 pet/main.cjs 输出主进程详细日志。
        args.push("--enable-logging");
        env.ARONA_PET_VERBOSE = "1";
        vlog("spawn", electronPath, args.concat(join(PET_DIR, "main.cjs")), "main=", this.agentId, "subs=", this.subAgents.join(","));
      }
      this.proc = spawn(electronPath, args.concat(join(PET_DIR, "main.cjs")), {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      console.warn(chalk.yellow(t(`桌宠：启动失败（${err instanceof Error ? err.message : err}），已降级。`, `Pet: failed to start (${err instanceof Error ? err.message : err}), degraded.`)));
      this.proc = null;
      return;
    }

    this.proc.stdout.on("data", (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) this.handleLine(line);
    });

    this.proc.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (!msg) return;
      // 始终入环（崩溃时 dump 用）；平时仅打印非空且不常见的错误
      this.stderrRing.push(msg);
      if (this.stderrRing.length > STDERR_RING_SIZE) this.stderrRing.shift();
      // verbose：原样转发全部 stderr（不过滤 dbus/GLib——它们可能夹带关键渲染日志）
      if (verbose || (!msg.includes("dbus") && !msg.includes("GLib"))) {
        console.error(chalk.gray("[pet]"), msg);
      }
    });

    this.proc.on("error", (err) => {
      vlog("spawn error:", err.message);
      console.warn(chalk.yellow(t(`桌宠：进程错误（${err.message}），已降级。`, `Pet: process error (${err.message}), degraded.`)));
      this.proc = null;
    });

    this.proc.on("close", (code, signal) => {
      vlog("process closed", { code, signal, intentional: this.intentionalStop, pendingSelection: this.pendingSelection });
      this.proc = null;
      if (this.pendingSelection) {
        // 切换角色：旧进程已退出，以新角色组合重新拉起（stop 时 intentionalStop=true 不会走退避重启）
        const sel = this.pendingSelection;
        this.pendingSelection = null;
        this.agentId = sel.main;
        this.subAgents = sel.subs;
        void this.start();
      } else if (!this.intentionalStop && (code === null || code !== 0)) {
        // 正常退出（code 0）不重启；被信号终止（code null）或异常退出才视为崩溃
        console.warn(chalk.yellow(t(`桌宠：进程异常退出（code=${code} signal=${signal}），准备重启。`, `Pet: process exited abnormally (code=${code} signal=${signal}), restarting.`)));
        this.dumpStderr();
        this.scheduleRestart();
      }
    });
  }

  /** 崩溃时输出 Electron 最近 stderr（渲染崩溃/主进程异常堆栈都在这里） */
  private dumpStderr(): void {
    if (!this.stderrRing.length) return;
    console.error(chalk.gray(`[pet:stderr] 最近 ${this.stderrRing.length} 行输出（定位崩溃用）：\n` + this.stderrRing.join("\n")));
    this.stderrRing = [];
  }

  private scheduleRestart(): void {
    if (this.restartCount >= MAX_RESTARTS) {
      console.warn(chalk.yellow(t("桌宠：崩溃次数过多，已放弃重启。", "Pet: too many crashes, giving up restarting.")));
      return;
    }
    const delay = 1000 * 2 ** this.restartCount; // 1s / 2s / 4s
    this.restartCount++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, delay);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith(PREFIX)) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed.slice(PREFIX.length));
    } catch {
      return;
    }
    vlog("recv", JSON.stringify(msg));
    if (msg.type === "ready") {
      this.restartCount = 0; // 成功启动后重置退避计数
    } else if (msg.type === "error") {
      console.error(chalk.gray("[pet]"), msg.message);
    } else if (msg.type === "crash") {
      // 渲染/GPU 子进程崩溃上报（pet/main.cjs 的 render-process-gone / child-process-gone）
      console.error(chalk.red(`[pet:crash] ${msg.kind ?? "process"} reason=${msg.reason ?? "?"} exitCode=${msg.exitCode ?? "?"} url=${msg.url ?? ""}`));
      // verbose：附带原始 detail（main.cjs 在 ARONA_PET_VERBOSE 下会补全字段）
      vlog("crash detail:", JSON.stringify(msg));
    } else if (msg.type === "shake") {
      // 摸头：记录最新手势。仅主 Agent 事件（sub 无摸头），无需区分 agent。
      this.latestGesture = "pat";
    } else if (msg.type === "dizzy") {
      this.latestGesture = "dizzy";
    }
    // moved 目前仅作日志用途，无需处理
  }

  /**
   * 取走待注入的手势且只保留最近一次：消费即清空，避免重复注入。
   * 返回 null 表示没有待注入手势（用户没有摸头/dizzy，正常只发普通消息）。
   */
  takeGesture(): PetGestureType | null {
    const g = this.latestGesture;
    this.latestGesture = null;
    return g;
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.proc || this.proc.killed) return;
    vlog("send", JSON.stringify(msg));
    try {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    } catch {
      // stdin 已关闭，忽略
    }
  }

  setEmotion(agentId: AgentId, name: string): void {
    this.send({ type: "set_emotion", agent: agentId, name });
  }

  sendText(agentId: AgentId, kind: string, data: string): void {
    this.send({ type: "text", agent: agentId, kind, data });
  }

  /** 播放中实时音量（RMS 0~1）→ 桌宠嘴型 lip-sync */
  sendTtsLevel(agentId: AgentId, rms: number): void {
    this.send({ type: "tts_level", agent: agentId, rms });
  }

  reset(): void {
    this.send({ type: "reset" });
  }

  /**
   * 切换桌宠主角色（子 Agent 组合保持当前值）。
   * 运行中：先 stop（intentional，不触发退避重启），旧进程 close 后再以新组合拉起，避免双窗口闪现。
   * 未运行：直接记住角色，下次 start() 生效。
   */
  restartWithAgent(id: AgentId): void {
    this.restartWithSelection(id, this.subAgents);
  }

  /**
   * 切换主角色 + 子角色组合（pet/main.cjs 按 ARONA_AGENT + ARONA_SUB_AGENTS 创建多窗口）。
   */
  restartWithSelection(main: AgentId, subs: readonly AgentId[]): void {
    if (!this.isRunning) {
      this.agentId = main;
      this.subAgents = [...subs];
      void this.start();
      return;
    }
    this.pendingSelection = { main, subs: [...subs] };
    this.stop();
  }

  stop(): void {
    this.intentionalStop = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc && !this.proc.killed) {
      this.send({ type: "quit" });
      try {
        this.proc.stdin.end();
      } catch {
        // 忽略
      }
      const proc = this.proc;
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGTERM");
      }, 500);
      this.proc = null;
    }
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }
}

export const pet = new PetBridge();

export async function startPet(): Promise<void> {
  await pet.start();
}

export function stopPet(): void {
  pet.stop();
}
