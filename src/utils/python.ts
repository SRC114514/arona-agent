import type { ChildProcessWithoutNullStreams } from "child_process";
import { join } from "path";
import { PYTHON_DIR, config, verbose } from "../config.ts";
import { t, getLang } from "../locale.ts";
import { spawnCompat, stripProxyEnv } from "./spawn.ts";

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
  signal?: AbortSignal,
  gracefulSignal?: AbortSignal,
): Promise<string> {
  const scriptPath = join(PYTHON_DIR, scriptName);
  // ARONA_LANG 传给 Python 侧做 i18n（覆盖仅靠 LANG 不可靠的场景）；PYTHONUTF8 让子进程 stdin/stdout/stderr 走 UTF-8
  // stripProxyEnv 剔除代理变量，避免 websockets 误走本机 SOCKS 代理（DashScope 国内服务应直连）
  const baseEnv = stripProxyEnv({ ...process.env, ARONA_LANG: getLang(), PYTHONUTF8: "1", ...env });
  return new Promise((resolve, reject) => {
    const proc = spawnCompat(config.pythonPath, [scriptPath, ...args], {
      env: baseEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    // 外部取消（如 GUI 麦克风再点一次停止录音）：kill 子进程并 reject
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill("SIGTERM"); } catch {}
      reject(new Error(t("已取消", "Aborted")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // 优雅停止（如 GUI 麦克风再点一次=提前结束录音并识别已说内容）：
    // - POSIX：SIGUSR1 信号（脚本自行收尾输出，Promise 等待正常 resolve）
    // - Windows：进程信号不可捕获（proc.kill 全部等效硬杀），改写 stdin "stop" 行，
    //   由脚本（stt.py）的 stdin 监视线程置位停止标志。因此 stdinData 为空时保持
    //   stdin 打开不 end——脚本自行退出，不依赖 EOF。
    const onGraceful = () => {
      try {
        if (process.platform === "win32") proc.stdin.write("stop\n");
        else proc.kill("SIGUSR1");
      } catch {}
    };
    gracefulSignal?.addEventListener("abort", onGraceful, { once: true });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        gracefulSignal?.removeEventListener("abort", onGraceful);
        try { proc.kill("SIGTERM"); } catch {}
        reject(new Error(t(`Python ${scriptName} 执行超时（${timeoutMs}ms）`, `Python ${scriptName} timed out after ${timeoutMs}ms`)));
      }
    }, timeoutMs);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      // --verbose：逐行实时转发 python stderr，可见 voice_clone 上传/轮询等阶段进度
      if (verbose) {
        for (const line of data.toString().split(/[\r\n]+/)) {
          const msg = line.trim();
          if (msg) console.error(`[python:${scriptName}]`, msg);
        }
      }
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      gracefulSignal?.removeEventListener("abort", onGraceful);
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
      signal?.removeEventListener("abort", onAbort);
      gracefulSignal?.removeEventListener("abort", onGraceful);
      if (settled) return;
      settled = true;
      reject(new Error(t(`无法启动 Python 子进程：${err.message}`, `Failed to spawn Python: ${err.message}`)));
    });

    if (stdinData !== undefined) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    }
    // 无 stdinData：stdin 保持打开。脚本不读 stdin、自行退出；过早 end 会堵死
    // Windows 优雅停止的 "stop" 行通道（且已 end 的管道写入必抛错）。
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
    const scriptPath = join(PYTHON_DIR, this.scriptName);
    this.proc = spawnCompat(config.pythonPath, ["-u", scriptPath, ...this.args], {
      env: stripProxyEnv({ ...process.env, ARONA_LANG: getLang(), PYTHONUTF8: "1", ...this.env }),
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

    // spawn 失败（pythonPath 不存在 / 脚本缺失）不会触发 close；不监听 error 会变成
    // 未处理的 'error' 事件直接崩溃进程。
    this.proc.on("error", (err) => {
      this.proc = null;
      if (this.pendingReject) {
        if (this.pendingTimer) {
          clearTimeout(this.pendingTimer);
          this.pendingTimer = null;
        }
        this.pendingReject(new Error(t(`Python ${this.scriptName} 启动失败：${err.message}`, `Python ${this.scriptName} failed to start: ${err.message}`)));
        this.pendingResolve = null;
        this.pendingReject = null;
      }
    });

    // Wait for ready signal
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.proc?.stdout.off("data", readyChecker);
        this.proc?.off("close", onClose);
        this.proc?.off("error", onError);
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
      // spawn 失败：立即失败，避免干等 10 秒
      const onError = (err: Error) => {
        cleanup();
        reject(new Error(t(`Python ${this.scriptName} 启动失败：${err.message}`, `Python ${this.scriptName} failed to start: ${err.message}`)));
      };
      // Temporarily listen for ready signal
      this.proc?.stdout.on("data", readyChecker);
      this.proc?.once("close", onClose);
      this.proc?.once("error", onError);
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
