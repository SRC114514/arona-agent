// GPT-SoVITS 本地部署服务管理器。
//
// 云端模式（mode=cloud）：ARONA 只负责调用远程 API，不启动本地进程。
// 本地模式（mode=local）：
//   - 如果 baseUrl 已经可达（用户已手动启动 api_v2），直接使用，不重复启动；
//   - 否则若配置了 apiScriptPath 与 GPT/SoVITS/BERT/CNHubert 路径，
//     自动生成 ~/.arona/gpt-sovits-tts-infer.yaml，并 spawn `api_v2.py -a 127.0.0.1 -p <port> -c <yaml>`。
//
// 生成的 YAML 使用 GPT-SoVITS 官方 tts_infer.yaml 的 custom 段结构：
//   custom:
//     bert_base_path: ...
//     cnhuhbert_base_path: ...
//     device: cuda
//     is_half: false   // 默认关（MPS/CPU 半精度可能更慢或不稳；CUDA 可显式开 true 省显存）
//     t2s_weights_path: ...
//     version: v2
//     vits_weights_path: ...
//
// 进程生命周期：ARONA 退出时 kill 本进程启动的 api_v2 子进程（见 repl.ts doExit 与 process exit 钩子）。

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, statSync, mkdirSync } from "fs";
import { delimiter, dirname, join } from "path";
import net from "net";
import { ARONA_DIR, config, verbose } from "./config.ts";
import { t } from "./locale.ts";
import { AGENT_IDS, getMainAgent, type AgentId } from "./agent_registry.ts";
import { getGptSovitsVoice } from "./voices.ts";
import type { GptSovitsConfig } from "./tts_provider.ts";
import { spawnCompat, stripProxyEnv } from "./utils/spawn.ts";

let child: ChildProcess | null = null;
let startPromise: Promise<{ gpt?: string; sovits?: string } | null> | null = null;
/** 最近一次 spawn 时是否 keepAlive（stop 时据此决定回收与否）。 */
let spawnedKeepAlive = true;
/** 本进程 spawn/复用的自有 daemon pid（用于写 pidfile / 判断外部服务）。 */
let ownedPid: number | null = null;

/** 常驻 daemon 状态文件：进程可跨 ARONA 重启存活，靠它 + 端口探活复用。 */
const PIDFILE = join(ARONA_DIR, "gpt-sovits-api-v2.json");
/** 常驻 daemon 日志（stdio 重定到文件，父进程退出后服务不因管道阻塞）。 */
const LOG_DIR = join(ARONA_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "gpt-sovits-api-v2.log");
/**
 * 离线 NLTK 数据目录（punkt_tab / averaged_perceptron_tagger(_eng) / cmudict）。
 * GPT-SoVITS 处理中英混合文本时经 g2p_en 触发 nltk 按需下载；缺包时 api_v2 会
 * 在请求线程里同步联网下载（无超时），事件循环被阻塞 → 后续 /tts 全部排队超时。
 * 预置数据 + 注入 NLTK_DATA 让它彻底离线化。
 */
const NLTK_DATA_DIR = join(ARONA_DIR, "nltk_data");

interface Pidfile {
  pid: number;
  host: string;
  port: number;
  /** sha256(生成的 yaml 全文 + apiScriptPath + pythonPath + host + port) */
  digest: string;
  startedAt: number;
  loadedWeights?: { gpt?: string; sovits?: string };
  /** 最后一次 TTS 合成时间（ms）；空闲超过 IDLE_TIMEOUT_MS 的 daemon 会被回收。 */
  lastUsedAt?: number;
}

/** 空闲自动回收阈值：超过该时长没有任何合成请求，api_v2 daemon 自我退出释放内存（硬编码 30 分钟）。 */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** arona 会话内对 daemon 空闲状态的巡检间隔。 */
const IDLE_CHECK_MS = 60 * 1000;

function parseHostPort(baseUrl: string): { host: string; port: number } {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname || "127.0.0.1";
    return {
      host: host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host,
      port: u.port ? Number(u.port) : 9880,
    };
  } catch {
    return { host: "127.0.0.1", port: 9880 };
  }
}

function checkReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const cleanup = () => {
      done = true;
      socket.destroy();
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      if (!done) {
        cleanup();
        resolve(true);
      }
    });
    socket.once("timeout", () => {
      if (!done) {
        cleanup();
        resolve(false);
      }
    });
    socket.once("error", () => {
      if (!done) {
        cleanup();
        resolve(false);
      }
    });
    socket.connect(port, host);
  });
}

/**
 * HTTP 健康探活：GET / 短超时，能拿到 2xx/4xx 响应即视为服务可用。
 * TCP 端口可达 ≠ uvicorn 事件循环/模型加载正常（僵死进程会一直吃掉 TTS 请求到超时）。
 */
async function checkApiHealthy(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

function yamlStr(value: string): string {
  // JSON.stringify 输出双引号字符串，YAML 1.1/1.2 都接受，安全处理空格/冒号/中文/盘符。
  return JSON.stringify(value);
}

/**
 * yaml 默认权重：优先 provider 级 gptModelPath/sovitsModelPath（手工配置/兼容旧值）；
 * 为空则优先主 Agent 的每角色 .ckpt/.pth（主 Agent 是默认说话人，权重启动即就位，首句免切换），
 * 再回退第一个已配置角色的每角色 .ckpt/.pth（.ckpt/.pth 单角色专属，通常不填全局，
 * 服务启动后按请求逐角色 set_gpt_weights/set_sovits_weights 切换）。
 */
function defaultWeights(cfg: GptSovitsConfig): { gpt: string; sovits: string } {
  let gpt = cfg.gptModelPath?.trim() || "";
  let sovits = cfg.sovitsModelPath?.trim() || "";
  if (gpt && sovits) return { gpt, sovits };
  const pick = (id: AgentId): void => {
    if (gpt && sovits) return;
    const v = getGptSovitsVoice(id);
    if (!v) return;
    if (!gpt && v.gptWeightsPath?.trim()) gpt = v.gptWeightsPath.trim();
    if (!sovits && v.sovitsWeightsPath?.trim()) sovits = v.sovitsWeightsPath.trim();
  };
  pick(getMainAgent());
  for (const id of AGENT_IDS) {
    if (gpt && sovits) break;
    pick(id);
  }
  return { gpt, sovits };
}

/**
 * 确定性生成 tts_infer.yaml 的 custom 段内容（纯字符串，不读盘）。
 * digest 必须基于它而非磁盘文件：api_v2 启动时会把官方默认模板（v1..v4 等块）
 * merge 后经 save_configs **回写**到传入的 yaml 路径，磁盘文件会被污染，
 * 基于文件的 digest 会在此后每个进程里误判 "config changed"。
 */
function buildTtsInferYaml(cfg: GptSovitsConfig): string {
  const { gpt, sovits } = defaultWeights(cfg);
  const lines = [
    "custom:",
    `  bert_base_path: ${yamlStr(cfg.bertPath?.trim() || "")}`,
    `  cnhuhbert_base_path: ${yamlStr(cfg.cnhubertPath?.trim() || "")}`,
    `  device: ${yamlStr(cfg.device?.trim() || "cuda")}`,
    `  is_half: ${cfg.isHalf === false ? "false" : "true"}`,
    `  t2s_weights_path: ${yamlStr(gpt)}`,
    `  version: ${yamlStr(cfg.modelVersion || "v2")}`,
    `  vits_weights_path: ${yamlStr(sovits)}`,
  ];
  return lines.join("\n") + "\n";
}

function writeTtsInferYaml(cfg: GptSovitsConfig): string {
  const file = join(ARONA_DIR, "gpt-sovits-tts-infer.yaml");
  writeFileSync(file, buildTtsInferYaml(cfg));
  return file;
}

/** 打开日志文件追加 fd；>10MB 先 truncate，避免日志无限膨胀。失败返回 -1（Node stdio 中视为 ignore）。 */
function openLogFd(): number {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE)) {
      try {
        if (statSync(LOG_FILE).size > 10 * 1024 * 1024) writeFileSync(LOG_FILE, "");
      } catch {
        // 忽略 stat/write 失败
      }
    }
    return openSync(LOG_FILE, "a");
  } catch {
    return -1;
  }
}

function spawnLocalServer(cfg: GptSovitsConfig): ChildProcess {
  const { host, port } = parseHostPort(cfg.baseUrl);
  const yamlPath = writeTtsInferYaml(cfg);
  const python = cfg.pythonPath?.trim() || config.pythonPath;
  const script = cfg.apiScriptPath!.trim();
  const bindHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const args = [script, "-a", bindHost, "-p", String(port), "-c", yamlPath];
  if (verbose) {
    console.error(`[gpt-sovits] spawn ${python} ${args.join(" ")}`);
    console.error(`[gpt-sovits] log → ${LOG_FILE} ${cfg.keepAlive !== false ? "(keep-alive)" : ""}`);
  }
  // keepAlive：detached + stdio 重定向日志文件 —— 父进程退出后服务不因管道阻塞而 hang，
  // 且成为独立进程组不被随父回收；下一次启动探活 & pidfile 复用热服务。
  const logFd = openLogFd();
  const options: SpawnOptions = {
    cwd: dirname(script),
    // PYTHONUNBUFFERED：pipe 下 Python 默认块缓冲，api_v2 的 print 不刷新就看不到进度/报错；写文件同样需要。
    // NLTK_DATA：优先指向预置的离线数据（~/.arona/nltk_data），缺失时 g2p_en 会在请求线程
    // 同步联网下载并阻塞事件循环（表现为 /tts 整体卡死直至超时）。附加而非覆盖，保留用户已有路径。
    env: stripProxyEnv({
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONUNBUFFERED: "1",
      NLTK_DATA: [NLTK_DATA_DIR, process.env.NLTK_DATA].filter(Boolean).join(delimiter),
    }),
    stdio: ["ignore", logFd, logFd],
    detached: cfg.keepAlive !== false,
  };
  const proc = spawnCompat(python, args, options);
  // 父进程侧 fd 在子进程继承 dup 后可关闭，避免句柄泄漏。
  try {
    closeSync(logFd);
  } catch {
    // 忽略
  }
  child = proc;
  proc.on("error", (err) => {
    if (child === proc) child = null;
    console.error(t(
      `[gpt-sovits] 本地服务启动失败：${err.message}`,
      `[gpt-sovits] failed to start local server: ${err.message}`,
    ));
  });
  proc.on("close", (code) => {
    if (child === proc) child = null;
    if (verbose) console.error(`[gpt-sovits] local server exited code=${code} signal=${proc.signalCode ?? ""}`);
  });
  return proc;
}

/**
 * 轮询等待 api_v2 就绪。watch = 进程存活检查（返回 false = 进程已退，提前抛错）；
 * 传 null 则不做进程退出检测（如纯外部服务）。
 */
async function waitForServer(
  host: string,
  port: number,
  timeoutMs: number,
  watch: (() => boolean) | null = null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  if (verbose) console.error(`[gpt-sovits] waiting for api_v2 ready ${host}:${port} (≤${Math.round(timeoutMs / 1000)}s)`);
  let lastProgressLog = 0;
  while (Date.now() < deadline) {
    if (await checkReachable(host, port, 1200)) return;
    if (watch && !watch()) {
      throw new Error(t("GPT-SoVITS 本地服务进程已退出", "GPT-SoVITS local server process exited"));
    }
    if (verbose && Date.now() - lastProgressLog >= 15000) {
      lastProgressLog = Date.now();
      console.error(`[gpt-sovits] still waiting for api_v2 ready (${Math.round((deadline - Date.now()) / 1000)}s left)...`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(t(
    `GPT-SoVITS 本地服务 ${timeoutMs / 1000}s 内未就绪（${host}:${port}）`,
    `GPT-SoVITS local server not ready within ${timeoutMs / 1000}s (${host}:${port})`,
  ));
}

// ---------------- 常驻 pidfile / daemon 检测 ----------------

/** digest = sha256(确定性 yaml 字符串 + apiScriptPath + pythonPath + host + port)。基于生成产物而非磁盘文件（api_v2 会回写 yaml），配置变则 digest 变。 */
function computeDigest(cfg: GptSovitsConfig, host: string, port: number): string {
  const python = cfg.pythonPath?.trim() || config.pythonPath;
  const content = buildTtsInferYaml(cfg);
  const material = [content, cfg.apiScriptPath?.trim() || "", python, host, String(port)].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

function readPidfile(): Pidfile | null {
  try {
    if (!existsSync(PIDFILE)) return null;
    const parsed = JSON.parse(readFileSync(PIDFILE, "utf-8")) as Pidfile;
    if (!parsed || typeof parsed !== "object" || typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePidfile(pf: Pidfile): void {
  try {
    writeFileSync(PIDFILE, JSON.stringify(pf, null, 2) + "\n");
  } catch {
    // 忽略（仅影响下次复用，冷启动仍可用）
  }
}

function clearPidfile(): void {
  try {
    writeFileSync(PIDFILE, "");
  } catch {
    // 忽略
  }
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 该 pid 是否确实是 api_v2 服务进程（防 PID 复用误杀）。win32 仅查存活。 */
function pidIsApiV2(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  if (process.platform === "win32") return true;
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" });
    return out.includes("api_v2");
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // 忽略（可能已退出）
  }
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * kill 并等待进程彻底消失（释放端口/资源），再允许后续操作（如重 spawn 绑同一端口）。
 * SIGTERM 是异步优雅关闭，若不等其退出就立刻 spawn 新进程，新进程 bind 同端口会因旧进程
 * 尚未释放而失败；而 waitForServer 探到的是旧进程残留端口 → 误判就绪 → 连接被拒。
 * 超时退化为 SIGKILL。
 */
async function killPidAndWait(pid: number, timeoutMs = 10000): Promise<void> {
  if (!pidAlive(pid)) return;
  killPid(pid);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await sleepMs(150);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 忽略
  }
}

/**
 * spawn 并等待就绪，写 pidfile，返回 yaml 默认权重（供 provider ack，首句免切换）。
 */
async function spawnAndWait(
  cfg: GptSovitsConfig,
  host: string,
  port: number,
): Promise<{ gpt?: string; sovits?: string }> {
  spawnedKeepAlive = cfg.keepAlive !== false;
  const proc = spawnLocalServer(cfg);
  ownedPid = proc.pid ?? null;
  await waitForServer(host, port, 180_000, () => proc.exitCode === null && proc.signalCode === null && !proc.killed);
  const { gpt, sovits } = defaultWeights(cfg);
  writePidfile({
    pid: ownedPid!,
    host,
    port,
    digest: computeDigest(cfg, host, port),
    startedAt: Date.now(),
    loadedWeights: { gpt: gpt || undefined, sovits: sovits || undefined },
    lastUsedAt: Date.now(),
  });
  if (verbose) console.error(`[gpt-sovits] cold start ready pid=${ownedPid} gpt="${gpt}" sovits="${sovits}"`);
  return { gpt: gpt || undefined, sovits: sovits || undefined };
}

async function doEnsure(
  cfg: GptSovitsConfig,
): Promise<{ gpt?: string; sovits?: string } | null> {
  const { host, port } = parseHostPort(cfg.baseUrl);
  const pidfile = readPidfile();
  const daemonAlive = !!pidfile && pidAlive(pidfile.pid) && pidIsApiV2(pidfile.pid);

  if (await checkReachable(host, port, 1200)) {
    // 端口已监听
    if (daemonAlive && pidfile!.digest === computeDigest(cfg, host, port)) {
      // 自有 daemon & 配置未变 → 先看是否已空闲超时（30 分钟无合成）：
      // 超时视为过期，杀旧冷启，避免模型一直驻留占内存（空闲自动回收）。
      if (pidfile!.lastUsedAt !== undefined && Date.now() - pidfile!.lastUsedAt > IDLE_TIMEOUT_MS) {
        if (verbose) console.error(`[gpt-sovits] daemon pid=${pidfile!.pid} idle > 30min, recycling`);
        await killPidAndWait(pidfile!.pid);
        clearPidfile();
        return spawnAndWait(cfg, host, port);
      }
      // 再做 HTTP 健康探活：端口可达 ≠ 服务可用（进程可能已僵死：模型半加载/事件循环卡死，
      // 请求挂到超时）。不健康则视为坏 daemon，杀旧冷启，避免一轮 TTS 全部等 60s 超时。
      if (!(await checkApiHealthy(host, port))) {
        if (verbose) console.error(`[gpt-sovits] reusing daemon pid=${pidfile!.pid} unhealthy (no HTTP response), restarting`);
        await killPidAndWait(pidfile!.pid);
        clearPidfile();
        return spawnAndWait(cfg, host, port);
      }
      // 自有 daemon & 配置未变 → 复用热服务，ack 上次退出时的权重（首句免切换）
      ownedPid = pidfile!.pid;
      spawnedKeepAlive = true;
      touchLastUsed();
      if (verbose) console.error(`[gpt-sovits] reusing daemon pid=${pidfile!.pid} (digest match)`);
      return pidfile!.loadedWeights ?? {};
    }
    if (daemonAlive) {
      // 自有 daemon 但配置已变 → 杀旧进程（等其退出释放端口）再重 spawn
      if (verbose) console.error(`[gpt-sovits] config changed, restarting daemon pid=${pidfile!.pid}`);
      await killPidAndWait(pidfile!.pid);
      clearPidfile();
      return spawnAndWait(cfg, host, port);
    }
    // 否则是外部服务（用户手动启动）→ 再探一次 HTTP 健康：TCP 可达不代表服务可用
    //（僵死进程会一直吃掉 TTS 请求到超时）；外部进程不归我们管，不杀不重启，仅告警。
    if (!(await checkApiHealthy(host, port))) {
      console.warn(t(
        `[gpt-sovits] 检测到端口 ${host}:${port} 的服务无 HTTP 响应（可能僵死），TTS 合成将等待超时。请检查后重启该服务。`,
        `[gpt-sovits] Service on ${host}:${port} is not responding over HTTP (possibly hung); TTS requests will time out. Please check and restart it.`,
      ));
    }
    if (verbose) console.error("[gpt-sovits] external server on port, using as-is");
    return null;
  }

  // 端口不可达
  if (child && !child.killed) {
    // 本进程已 spawn 但未就绪 → 继续等待
    await waitForServer(host, port, 180_000, () => child !== null && child.exitCode === null && child.signalCode === null && !child.killed);
    ownedPid = child.pid ?? ownedPid;
    touchLastUsed();
    return pidfile?.loadedWeights ?? {};
  }
  if (daemonAlive) {
    // 自有 daemon 仍在加载（上次 ARONA 退出时未就绪）→ 轮询等；pid 死则 respawn
    if (verbose) console.error(`[gpt-sovits] daemon pid=${pidfile!.pid} still loading, waiting...`);
    ownedPid = pidfile!.pid;
    spawnedKeepAlive = true;
    try {
      await waitForServer(host, port, 180_000, () => pidAlive(pidfile!.pid));
    } catch {
      // pid 死了：respawn
      if (verbose) console.error(`[gpt-sovits] daemon pid=${pidfile!.pid} died while loading, respawning`);
      await killPidAndWait(pidfile!.pid);
      clearPidfile();
      return spawnAndWait(cfg, host, port);
    }
    touchLastUsed();
    return pidfile?.loadedWeights ?? {};
  }

  // 干净冷启动
  return spawnAndWait(cfg, host, port);
}

/**
 * 确保本地 GPT-SoVITS api_v2 服务可用。
 * - cloud 模式或缺少本地启动必需字段（apiScriptPath / bertPath / cnhubertPath）时直接返回 null，
 *   视为用户手动启动服务（与旧行为一致）。.ckpt/.pth 单角色专属、不要求全局，
 *   默认权重由 defaultWeights 从主 Agent / 每角色配置兜底。
 * - 返回自有 daemon 当前已加载权重（供 provider ack，消除首句冗余切换）；外部服务返回 null。
 * - 多次并发调用共享同一个启动 Promise，避免重复 spawn。
 */
export function ensureGptSovitsLocalServer(
  cfg: GptSovitsConfig,
): Promise<{ gpt?: string; sovits?: string } | null> {
  if (cfg.mode !== "local") return Promise.resolve(null);
  if (
    !cfg.apiScriptPath?.trim() ||
    !cfg.bertPath?.trim() ||
    !cfg.cnhubertPath?.trim()
  ) {
    // 路径不齐：不自动启动，沿用“用户先手动启动 api_v2”的旧模式。
    return Promise.resolve(null);
  }
  if (startPromise) return startPromise;
  startPromise = doEnsure(cfg).finally(() => {
    startPromise = null;
  });
  return startPromise;
}

/**
 * 停止本进程启动的本地 api_v2 子进程（幂等）。
 * keepAlive=true（默认）：仅清引用不 kill（detached + 文件 stdio，进程自然存活供下次复用）；
 *   但若已空闲超时（30 分钟无合成）则顺手回收，避免模型持续驻留占内存。
 * keepAlive=false：SIGTERM 回收（回归"退出即回收"旧行为）。
 */
export function stopGptSovitsLocalServer(): void {
  const proc = child;
  child = null;
  ownedPid = null;
  if (!proc || proc.killed) return;
  if (spawnedKeepAlive) {
    // 退出时若已空闲超时 → 一并回收
    const pf = readPidfile();
    if (pf && pf.lastUsedAt !== undefined && Date.now() - pf.lastUsedAt > IDLE_TIMEOUT_MS) {
      if (verbose) console.error(`[gpt-sovits] exit: daemon idle > 30min, recycling`);
      try {
        proc.kill("SIGTERM");
      } catch {
        // 忽略
      }
    }
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    // 忽略
  }
}

/**
 * 通过 ps 扫描"由 ARONA 启动的残留 api_v2"进程（pidfile 可能已被清但进程未死，
 * 如父进程异常退出后成孤儿）。特征 = 命令行含 api_v2.py 且 -c 指向我们生成的 yaml
 * （ARONA spawn 时固定传 ~/.arona/gpt-sovits-tts-infer.yaml，外部手动启动避不开此特征）。
 * win32 无 ps -o command，仅靠 pidfile 路径回收该场景。
 */
function scanStrayApiV2Pids(): number[] {
  if (process.platform === "win32") return [];
  const marker = join(ARONA_DIR, "gpt-sovits-tts-infer.yaml");
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 });
    const pids: number[] = [];
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      const cmd = m[2];
      // 排除 JS 运行时进程（node/tsx/npm）：调用者的包装命令行可能携带特征串（如 -e 脚本、
      // 文档命令），真实 api_v2 一定是 python 解释器启动，误杀会把回收者自己干掉。
      if (/node(\.exe)?\s|tsx|npm(\.cmd)?/i.test(cmd)) continue;
      if (cmd.includes("api_v2.py") && cmd.includes(marker)) {
        const pid = Number(m[1]);
        if (pid > 0) pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

/**
 * 回收残留的 GPT-SoVITS 守护进程（ttsProvider 非 gpt-sovits 时于启动调用）。
 * 先按 pidfile 命中回收；pidfile 缺失/已被清（孤儿场景）再按命令行特征扫残留进程。
 * pidfile + 命令行双重确认只动 ARONA 自己 spawn 的 daemon，不误杀外部手动服务。
 */
export async function recycleOwnedGptSovitsDaemon(): Promise<void> {
  const pf = readPidfile();
  if (pf && pidAlive(pf.pid) && pidIsApiV2(pf.pid)) {
    if (verbose) console.error(`[gpt-sovits] ttsProvider 非 gpt-sovits，回收残留守护进程 pid=${pf.pid}`);
    await killPidAndWait(pf.pid);
  } else {
    for (const pid of scanStrayApiV2Pids()) {
      if (pf?.pid === pid) continue;
      if (verbose) console.error(`[gpt-sovits] ttsProvider 非 gpt-sovits，回收残留守护进程 pid=${pid} (stray)`);
      await killPidAndWait(pid);
    }
  }
  clearPidfile();
}

/** 刷新自有 daemon 的 lastUsedAt（写 pidfile；仅自有 daemon，外部服务不写）。 */
function touchLastUsed(): void {
  const pf = readPidfile();
  if (!pf || pf.pid !== ownedPid) return;
  writePidfile({ ...pf, lastUsedAt: Date.now() });
}

/**
 * 供 provider 在每轮 TTS 合成入口（prepare）调用：视为"正在使用"，重置空闲计时。
 * 合成请求到来即刷新，空闲回收只对"长期无合成"的 daemon 生效。
 */
export function touchDaemonLastUsed(): void {
  touchLastUsed();
}

/** 会话内空闲巡检：空闲超 30 分钟的 daemon 自动回收释放内存（unref，不阻止进程退出）。 */
setInterval(() => {
  if (ownedPid == null) return;
  const pf = readPidfile();
  if (!pf || pf.pid !== ownedPid || pf.lastUsedAt === undefined) return;
  if (Date.now() - pf.lastUsedAt <= IDLE_TIMEOUT_MS) return;
  if (verbose) console.error(`[gpt-sovits] idle ${Math.round((Date.now() - pf.lastUsedAt) / 60000)}min > 30min, recycling daemon pid=${pf.pid}`);
  const dead = pf.pid;
  child = null;
  ownedPid = null;
  void killPidAndWait(dead).then(() => clearPidfile());
}, IDLE_CHECK_MS).unref();

/**
 * 供 provider ack 权重后持久化到 pidfile（仅自有 daemon 场景写，外部服务不写）。
 * fire-and-forget；下次启动复用 daemon 时读回，遇相同说话角色零切换。
 */
export function persistLoadedWeights(weights: { gpt?: string; sovits?: string }): void {
  if (ownedPid == null) return;
  const pf = readPidfile();
  if (!pf || pf.pid !== ownedPid) return;
  writePidfile({ ...pf, loadedWeights: { gpt: weights.gpt, sovits: weights.sovits } });
}

// 兜底：即使 doExit 漏调，进程退出也尽量回收子进程（keepAlive 场景 stop 不 kill，策略见 stopGptSovitsLocalServer）。
process.once("exit", () => {
  stopGptSovitsLocalServer();
});

// ---------------------------------------------------------------------------
// 依赖安装（setup 本地部署时调用）
// GPT-SoVITS 各模型版本（v2/v2Pro/v3/v4）都在官方同一仓库 RVC-Boss/GPT-SoVITS，
// `version` 只是 tts_infer.yaml 的运行时字段（v14=v2、v16=v3、v17=v4），依赖清单共用根目录
// requirements.txt，无按版本拆分。**清单来源固定为下方硬编码内置字符串**（官方清单 + torchcodec），
// 不读 api_v2.py 同目录 requirements.txt（用户克隆/定制的版本可能与运行时所需不一致，统一收敛到
// 项目内一份可追踪；torchcodec 是 api_v2 解码参考音频 mp3 所需，官方旧 requirements 未含）。

/** 内置清单（硬编码，setup 自动装 GPT-SoVITS 依赖的唯一来源）。 */
const GPT_SOVITS_REQ_FALLBACK = `--no-binary=opencc
numpy<2.0
scipy
tensorboard
librosa==0.10.2
numba
pytorch-lightning>=2.4
gradio<5
ffmpeg-python
onnxruntime; platform_machine == "aarch64" or platform_machine == "arm64"
onnxruntime-gpu; platform_machine == "x86_64" or platform_machine == "AMD64"
tqdm
funasr>=1.3.7
cn2an
pypinyin
pyopenjtalk>=0.4.1
g2p_en
torchaudio
torchcodec
modelscope
sentencepiece
transformers>=4.51,<5
peft<0.18.0
chardet
PyYAML
psutil
jieba_fast
jieba
split-lang
fast_langdetect>=0.3.1
wordsegment
rotary_embedding_torch
ToJyutping
g2pk2
ko_pron
opencc
python_mecab_ko; sys_platform != 'win32'
fastapi[standard]>=0.115.2
x_transformers
torchmetrics<=1.5
pydantic<=2.10.6
ctranslate2>=4.0,<5
av>=11
tqdm
`;

/** 写盘目标：~/.arona/gpt-sovits-requirements.txt（供 pip 读取）。 */
const GPT_SOVITS_REQ_DEST = join(ARONA_DIR, "gpt-sovits-requirements.txt");

/**
 * 解析 GPT-SoVITS 依赖清单来源：固定写硬编码内置清单到 ~/.arona/gpt-sovits-requirements.txt。
 * 不读 api_v2.py 同目录 requirements.txt（用户定制版可能与运行时所需不一致）；
 * 写 ~/.arona 而非项目 assets，覆盖非符号链接 npm 安装场景（该目录未被 package.json#files 打包）。
 * 返回清单文件路径与来源说明。
 */
function resolveRequirements(): { file: string; source: string } {
  writeFileSync(GPT_SOVITS_REQ_DEST, GPT_SOVITS_REQ_FALLBACK);
  return {
    file: GPT_SOVITS_REQ_DEST,
    source: t(
      "项目内置硬编码清单（官方 RVC-Boss/GPT-SoVITS requirements + torchcodec）",
      "built-in hardcoded list (official RVC-Boss/GPT-SoVITS requirements + torchcodec)",
    ),
  };
}

/**
 * 安装 GPT-SoVITS 依赖：`<python> -m pip install -r <requirements>`。
 * 清单来源：固定项目内置硬编码清单（官方 requirements + torchcodec），不读 api_v2.py 目录。
 * pip 走清华源（与 setup.ts 主依赖安装一致），torch 等 wheel 国内下载更快。
 * 透传 pip 输出到终端，用户可实时看到进度。
 */
const PIP_TSINGHUA = "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple";
export async function installGptSovitsDeps(
  _apiScriptPath: string,
  pythonPath: string,
  _modelVersion: string,
): Promise<{ ok: boolean; message: string; source: string }> {
  const { file, source } = resolveRequirements();
  console.error(t(
    `  [gpt-sovits] 依赖清单来源：${source}`,
    `  [gpt-sovits] requirements source: ${source}`,
  ));
  return new Promise((resolve) => {
    const proc = spawnCompat(pythonPath, ["-m", "pip", "install", "-r", file, "-i", PIP_TSINGHUA], {
      env: stripProxyEnv({
        ...process.env,
        PYTHONUTF8: "1",
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
      }),
      stdio: ["ignore", "inherit", "inherit"],
    });
    proc.on("error", (err) => {
      resolve({
        ok: false,
        message: t(`无法启动 pip：${err.message}`, `Failed to run pip: ${err.message}`),
        source,
      });
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, message: t("依赖安装完成。", "Dependencies installed."), source });
      } else {
        resolve({
          ok: false,
          message: t(
            `依赖安装失败（pip 退出码 ${code}）。请检查网络/环境后重试，或手动执行：${pythonPath} -m pip install -r ${file} -i ${PIP_TSINGHUA}`,
            `Dependency install failed (pip exit ${code}). Check network/env and retry, or run manually: ${pythonPath} -m pip install -r ${file} -i ${PIP_TSINGHUA}`,
          ),
          source,
        });
      }
    });
  });
}