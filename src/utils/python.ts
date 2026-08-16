import type { ChildProcessWithoutNullStreams } from "child_process";
import { PYTHON_DIR, config } from "../config.ts";
import { t, getLang } from "../locale.ts";
import { spawnCompat } from "./spawn.ts";

/**
 * Run a Python script one-shot: spawn, pass input via stdin, return stdout.
 * 超过 timeoutMs（默认 60s）后强制 kill 进程并 reject，避免 TTS/STT 挂起导致 REPL 卡死。
 */
export async function runPython(
  scriptName: string,
  args: string[] = [],
  stdinData?: string,
  env?: Record<string, string>,
  timeoutMs = 60000,
): Promise<string> {
  const scriptPath = `${PYTHON_DIR}/${scriptName}`;
  // ARONA_LANG 传给 Python 侧做 i18n（覆盖仅靠 LANG 不可靠的场景）
  const baseEnv = { ...process.env, ARONA_LANG: getLang(), ...env };
  return new Promise((resolve, reject) => {
    const proc = spawnCompat(config.pythonPath, [scriptPath, ...args], {
      env: baseEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill("SIGTERM"); } catch {}
        reject(new Error(t(`Python ${scriptName} 执行超时（${timeoutMs}ms）`, `Python ${scriptName} timed out after ${timeoutMs}ms`)));
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(t(`Python ${scriptName} 退出码 ${code}: ${stderr}`, `Python ${scriptName} exited with code ${code}: ${stderr}`)));
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error(t(`无法启动 Python 子进程：${err.message}`, `Failed to spawn Python: ${err.message}`)));
    });

    if (stdinData !== undefined) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

/**
 * Persistent Python bridge: long-running process communicating via JSON over stdin/stdout.
 * Used for computer_use.py to maintain a persistent cua connection.
 */
export class PythonBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pendingResolve: ((value: any) => void) | null = null;
  private pendingReject: ((reason: any) => void) | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private buffer = "";
  private scriptName: string;
  private args: string[];
  private env?: Record<string, string>;

  constructor(scriptName: string, args: string[] = [], env?: Record<string, string>) {
    this.scriptName = scriptName;
    this.args = args;
    this.env = env;
  }

  async start(): Promise<void> {
    const scriptPath = `${PYTHON_DIR}/${this.scriptName}`;
    this.proc = spawnCompat(config.pythonPath, ["-u", scriptPath, ...this.args], {
      env: { ...process.env, ARONA_LANG: getLang(), ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (data) => {
      this.buffer += data.toString();
      // Try to parse complete JSON lines
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && this.pendingResolve) {
          try {
            const result = JSON.parse(trimmed);
            this.pendingResolve(result);
            this.pendingResolve = null;
            this.pendingReject = null;
            // 响应已到达，清除 30s 超时定时器，避免泄漏到事件循环
            if (this.pendingTimer) {
              clearTimeout(this.pendingTimer);
              this.pendingTimer = null;
            }
          } catch {
            // Not JSON, skip
          }
        }
      }
    });

    this.proc.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[python:${this.scriptName}]`, msg);
    });

    this.proc.on("close", (code) => {
      if (this.pendingReject) {
        if (this.pendingTimer) {
          clearTimeout(this.pendingTimer);
          this.pendingTimer = null;
        }
        this.pendingReject(new Error(t(`Python ${this.scriptName} 已退出（码 ${code}）`, `Python ${this.scriptName} exited with code ${code}`)));
        this.pendingResolve = null;
        this.pendingReject = null;
      }
      this.proc = null;
    });

    // Wait for ready signal
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.proc?.stdout.off("data", readyChecker);
        this.proc?.off("close", onClose);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(t(`Python ${this.scriptName} 10 秒内未就绪`, `Python ${this.scriptName} failed to start within 10s`)));
      }, 10000);

      const readyChecker = (data: Buffer) => {
        const msg = data.toString();
        if (msg.includes("READY")) {
          cleanup();
          resolve();
        }
      };
      // 进程在 READY 前退出：立即失败，避免干等 10 秒
      const onClose = () => {
        cleanup();
        reject(new Error(t(`Python ${this.scriptName} 启动失败（进程提前退出）`, `Python ${this.scriptName} exited before becoming ready`)));
      };
      // Temporarily listen for ready signal
      this.proc?.stdout.on("data", readyChecker);
      this.proc?.once("close", onClose);
    });
  }

  async send(command: Record<string, any>): Promise<any> {
    if (!this.proc || this.proc.killed) {
      throw new Error(t(`Python 桥接 ${this.scriptName} 未在运行`, `Python bridge ${this.scriptName} is not running`));
    }
    if (this.pendingResolve) {
      throw new Error(t(`Python 桥接 ${this.scriptName} 忙`, `Python bridge ${this.scriptName} is busy`));
    }

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.proc!.stdin.write(JSON.stringify(command) + "\n");

      // Timeout after 30s
      this.pendingTimer = setTimeout(() => {
        if (this.pendingReject) {
          this.pendingReject(new Error(t(`Python 桥接 ${this.scriptName} 超时`, `Python bridge ${this.scriptName} timed out`)));
          this.pendingResolve = null;
          this.pendingReject = null;
          // 超时说明桥已卡死：杀掉进程避免旧响应错配到下一次 send()
          try { this.proc?.kill("SIGTERM"); } catch {}
          this.proc = null;
        }
        this.pendingTimer = null;
      }, 30000);
    });
  }

  stop(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }
}
