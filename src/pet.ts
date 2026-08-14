import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { join } from "path";
import chalk from "chalk";
import { PET_DIR } from "./config.ts";
import { t } from "./locale.ts";

const PREFIX = "###PET###";
const MAX_RESTARTS = 3;

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
      // 剔除 ELECTRON_RUN_AS_NODE，否则 Electron 会退化为纯 Node 运行
      const env = { ...process.env };
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
      // Electron 自身告警较多，仅打印非空且不常见的错误
      if (msg && !msg.includes("dbus") && !msg.includes("GLib")) {
        console.error(chalk.gray("[pet]"), msg);
      }
    });

    this.proc.on("error", (err) => {
      console.warn(chalk.yellow(t(`桌宠：进程错误（${err.message}），已降级。`, `Pet: process error (${err.message}), degraded.`)));
      this.proc = null;
    });

    this.proc.on("close", () => {
      this.proc = null;
      if (!this.intentionalStop) this.scheduleRestart();
    });
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
