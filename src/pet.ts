import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { join } from "path";
import chalk from "chalk";
import { PET_DIR } from "./config.ts";
import { getMainAgent, type AgentId } from "./agent_registry.ts";
import { t } from "./locale.ts";

const PREFIX = "###PET###";
const MAX_RESTARTS = 3;
const STDERR_RING_SIZE = 100; // 崩溃时 dump 的 stderr 最近行数

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
  // 待切换角色：stop() 后等待旧进程 close 再以新角色拉起（避免双窗口闪现）
  private pendingAgent: AgentId | null = null;

  async start(): Promise<void> {
    // Headless 环境降级（Linux 无显示服务器时直接跳过）
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      console.warn(chalk.yellow(t("桌宠：无显示服务器，跳过启动。", "Pet: no display server, skipping startup.")));
      return;
    }

    let electronPath: string;
    try {
      // electron 包默认导出二进制路径字符串
      const mod = await import("electron");
      electronPath = mod.default as unknown as string;
    } catch {
      console.warn(chalk.yellow(t("桌宠：未安装 electron，跳过启动（npm install -D electron）。", "Pet: electron not installed, skipping startup (npm install -D electron).")));
      return;
    }

    this.intentionalStop = false;

    try {
      // 剔除 ELECTRON_RUN_AS_NODE，否则 Electron 会退化为纯 Node 运行；
      // 注入 ARONA_AGENT 让桌宠主进程选择角色（agents.cjs）
      const env: NodeJS.ProcessEnv = { ...process.env, ARONA_AGENT: this.agentId };
      delete env.ELECTRON_RUN_AS_NODE;
      // --no-sandbox：部分环境（权限受限的终端/容器）无法初始化 Chromium sandbox；
      // 桌宠只加载本地文件，关闭 sandbox 风险可接受
      this.proc = spawn(electronPath, ["--no-sandbox", join(PET_DIR, "main.cjs")], {
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
      if (!msg.includes("dbus") && !msg.includes("GLib")) {
        console.error(chalk.gray("[pet]"), msg);
      }
    });

    this.proc.on("error", (err) => {
      console.warn(chalk.yellow(t(`桌宠：进程错误（${err.message}），已降级。`, `Pet: process error (${err.message}), degraded.`)));
      this.proc = null;
    });

    this.proc.on("close", (code, signal) => {
      this.proc = null;
      if (this.pendingAgent) {
        // 切换角色：旧进程已退出，以新角色重新拉起（stop 时 intentionalStop=true 不会走退避重启）
        const agent = this.pendingAgent;
        this.pendingAgent = null;
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
    if (msg.type === "ready") {
      this.restartCount = 0; // 成功启动后重置退避计数
    } else if (msg.type === "error") {
      console.error(chalk.gray("[pet]"), msg.message);
    } else if (msg.type === "crash") {
      // 渲染/GPU 子进程崩溃上报（pet/main.cjs 的 render-process-gone / child-process-gone）
      console.error(chalk.red(`[pet:crash] ${msg.kind ?? "process"} reason=${msg.reason ?? "?"} exitCode=${msg.exitCode ?? "?"} url=${msg.url ?? ""}`));
    }
    // moved / shake 目前仅作日志用途，无需处理
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.proc || this.proc.killed) return;
    try {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    } catch {
      // stdin 已关闭，忽略
    }
  }

  setEmotion(name: string): void {
    this.send({ type: "set_emotion", name });
  }

  reset(): void {
    this.send({ type: "reset" });
  }

  /**
   * 切换桌宠形象（pet/main.cjs 按 ARONA_AGENT env 选择 agents.cjs 配置）。
   * 运行中：先 stop（intentional，不触发退避重启），旧进程 close 后再以新角色拉起，避免双窗口闪现。
   * 未运行：直接记住角色，下次 start() 生效。
   */
  restartWithAgent(id: AgentId): void {
    this.agentId = id;
    if (!this.isRunning) {
      void this.start();
      return;
    }
    this.pendingAgent = id;
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
