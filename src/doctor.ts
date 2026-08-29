// arona doctor：独立环境自检命令（bin/arona.mjs 路由到本文件，不走 REPL/斜杠命令）。
// 颜色语义：绿 = 正常；黄 = 可略过（未配置/某功能不可用）；红 = 可能影响使用。
// 注意：勿 import tts_provider / gpt_sovits_local——后者模块级 setInterval 会让本进程无法退出，
// GPT-SoVITS 配置在此处直接解析 ttsConfig["gpt-sovits"] 原始字段。

import chalk from "chalk";
import net from "net";
import { existsSync } from "fs";
import { join } from "path";
import { config, settingsExist, PROJECT_ROOT } from "./config.ts";
import { t } from "./locale.ts";
import { VOICE_AGENT_IDS, getMainAgent } from "./agent_registry.ts";
import { getVoiceId, getGptSovitsVoice } from "./voices.ts";
import { spawnCompat } from "./utils/spawn.ts";

type Level = "ok" | "warn" | "fail";

let failCount = 0;
let warnCount = 0;

function item(level: Level, text: string): void {
  const mark = level === "ok" ? chalk.green("✓") : level === "warn" ? chalk.yellow("!") : chalk.red("✗");
  if (level === "warn") warnCount++;
  if (level === "fail") failCount++;
  console.log(`  ${mark} ${text}`);
}

function section(title: string): void {
  console.log(`\n${chalk.bold(title)}`);
}

interface ProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** 运行一个命令并收集输出（超时/启动失败均视为不可用，不抛异常）。 */
function probe(bin: string, args: string[], timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnCompat(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, stdout: "", stderr: "spawn failed" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill("SIGKILL"); } catch {}
        resolve({ ok: false, stdout, stderr: "timeout" });
      }
    }, timeoutMs);
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr: err.message });
      }
    });
    proc.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout, stderr });
      }
    });
  });
}

function tcpReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        socket.destroy();
        resolve(v);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/** 主程序 Python 的版本要求：3.12 / 3.13（3.14 起 pydantic-core 不支持）。 */
const PY_REQUIRE = "3.12 / 3.13";

function pyVersionFrom(out: string): string | null {
  const m = out.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/** 主程序 Python 依赖（requirements.txt）：一次子进程探测全部 import。 */
const DEPS = ["cua", "websockets", "pyaudio", "numpy", "pynput", "dashscope"] as const;

const DEPS_SCRIPT = [
  "import json",
  `mods = ${JSON.stringify([...DEPS])}`,
  "r = {}",
  "for m in mods:",
  "    try:",
  "        __import__(m)",
  "        r[m] = 1",
  "    except Exception:",
  "        r[m] = 0",
  "print(json.dumps(r))",
].join("\n");

interface GsvInfo {
  mode: "local" | "cloud";
  baseUrl: string;
  /** 显式配置的 GPT-SoVITS 专用 Python；空 = 回退主程序 Python。 */
  pythonPath: string;
  apiScriptPath: string;
  gptModelPath: string;
  sovitsModelPath: string;
  bertPath: string;
  cnhubertPath: string;
}

/** 解析 ttsConfig["gpt-sovits"] 原始字段；无任何有效键 = 暂未配置。 */
function readGsvConfig(): GsvInfo | null {
  const raw = config.ttsConfig?.["gpt-sovits"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const s = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string).trim() : "");
  const configured = ["mode", "pythonPath", "apiScriptPath", "gptModelPath", "sovitsModelPath", "bertPath", "cnhubertPath", "baseUrl", "apiKey"].some((k) => s(k));
  if (!configured) return null;
  return {
    mode: obj.mode === "cloud" ? "cloud" : "local",
    baseUrl: s("baseUrl") || "http://127.0.0.1:9880",
    pythonPath: s("pythonPath"),
    apiScriptPath: s("apiScriptPath"),
    gptModelPath: s("gptModelPath"),
    sovitsModelPath: s("sovitsModelPath"),
    bertPath: s("bertPath"),
    cnhubertPath: s("cnhubertPath"),
  };
}

function parseBaseUrl(baseUrl: string): { host: string; port: number } {
  try {
    const u = new URL(baseUrl);
    return { host: u.hostname || "127.0.0.1", port: u.port ? Number(u.port) : 9880 };
  } catch {
    return { host: "127.0.0.1", port: 9880 };
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold("ARONA doctor"));

  const mainPy = config.pythonPath;
  const gsv = readGsvConfig();
  const gsvPy = gsv?.pythonPath || mainPy;

  // 并行探测：主程序 Python 版本 + 依赖；GPT-SoVITS Python 版本 + torch
  const pyVerP = probe(mainPy, ["--version"], 10000);
  const pyDepsP = probe(mainPy, ["-c", DEPS_SCRIPT], 60000);
  let gsvVerP: Promise<ProbeResult> | null = null;
  let gsvTorchP: Promise<ProbeResult> | null = null;
  if (gsv) {
    gsvVerP = probe(gsvPy, ["--version"], 10000);
    gsvTorchP = probe(gsvPy, ["-c", "import torch;print(torch.__version__)"], 90000);
  }
  const [pyVer, pyDeps, gsvVer, gsvTorch] = await Promise.all([pyVerP, pyDepsP, gsvVerP, pyTorch(gsvTorchP)]);

  // ---------------- 核心环境 ----------------
  section(t("核心环境", "Core"));

  const nodeVer = process.versions.node;
  const [nodeMajor, nodeMinor] = nodeVer.split(".").map(Number);
  if (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19)) {
    item("ok", `Node.js v${nodeVer}`);
  } else {
    item("fail", t(`Node.js v${nodeVer}，需 ≥ 22.19.0`, `Node.js v${nodeVer}, need >= 22.19.0`));
  }

  if (settingsExist()) {
    item("ok", t("配置文件 ~/.arona/settings.json", "Config file ~/.arona/settings.json"));
  } else {
    item("fail", t("配置文件不存在，请先运行 arona setup", "Config file missing. Run `arona setup` first"));
  }

  item(
    config.apiKey ? "ok" : "fail",
    config.apiKey
      ? t("LLM API Key 已配置", "LLM API Key configured")
      : t("LLM API Key 未配置", "LLM API Key not configured"),
  );

  if (!pyVer.ok) {
    item("fail", t(`主程序 Python 未找到：${mainPy}`, `Main Python not found: ${mainPy}`));
  } else {
    const ver = pyVersionFrom(pyVer.stdout);
    const mm = ver?.split(".").slice(0, 2).join(".");
    if (!ver) {
      item("fail", t("无法获取主程序 Python 版本", "Failed to detect main Python version"));
    } else if (mm !== "3.12" && mm !== "3.13") {
      item("fail", t(`主程序 Python ${ver} 版本不受支持，需 ${PY_REQUIRE}`, `Main Python ${ver} unsupported, need ${PY_REQUIRE}`));
    } else {
      item("ok", t(`主程序 Python ${ver}`, `Main Python ${ver}`));
    }
  }

  if (pyVer.ok) {
    let missing: string[] | null = null;
    try {
      const r = JSON.parse(pyDeps.stdout) as Record<string, unknown>;
      missing = DEPS.filter((d) => !r[d]);
    } catch {
      missing = null;
    }
    if (missing === null) {
      item("warn", t("Python 依赖检查失败", "Python dependency check failed"));
    } else if (missing.length > 0) {
      item("warn", t(
        `缺少 Python 依赖：${missing.join("、")}，运行 pip install -r requirements.txt 补装`,
        `Missing Python deps: ${missing.join(", ")}. Run pip install -r requirements.txt`,
      ));
    } else {
      item("ok", t("Python 依赖完整", "Python dependencies installed"));
    }
  }

  // ---------------- 语音 ----------------
  if (config.noVoice) {
    console.log(t("\n语音功能已禁用（--no-voice），跳过语音检查。", "\nVoice disabled (--no-voice), voice checks skipped."));
  } else {
    section(t("语音", "Voice"));
    console.log(`  TTS Provider：${config.ttsProvider === "gpt-sovits" ? "GPT-SoVITS" : t("阿里云百炼", "Aliyun Bailian")}`);

    if (config.ttsProvider === "aliyun") {
      item(
        config.ttsApiKey ? "ok" : "warn",
        config.ttsApiKey
          ? t("TTS API Key 已配置", "TTS API Key configured")
          : t("TTS API Key 未配置，语音合成不可用", "TTS API Key not configured, speech synthesis unavailable"),
      );
    }

    const mainAgent = getMainAgent();
    if (config.ttsProvider === "aliyun") {
      item(
        getVoiceId(mainAgent) ? "ok" : "warn",
        getVoiceId(mainAgent)
          ? t(`当前角色 ${mainAgent} 已配置音色`, `Current agent ${mainAgent} has a cloned voice`)
          : t(`当前角色 ${mainAgent} 未克隆音色，TTS 静音；arona voice add 可补全`, `Current agent ${mainAgent} has no cloned voice, TTS muted. Run \`arona voice add\``),
      );
    }

    // GPT-SoVITS（无论当前 provider 是否为它，配置了就体检）
    if (!gsv) {
      item("warn", t("GPT-SoVITS：暂未配置", "GPT-SoVITS: not configured"));
    } else {
      if (gsv.pythonPath) {
        if (!gsvVer?.ok) {
          item("fail", t(`GPT-SoVITS Python 未找到：${gsv.pythonPath}`, `GPT-SoVITS Python not found: ${gsv.pythonPath}`));
        } else {
          const ver = pyVersionFrom(gsvVer.stdout) ?? "";
          item("ok", t(`GPT-SoVITS Python ${ver}`, `GPT-SoVITS Python ${ver}`));
        }
      } else {
        // 未单独配置专用 Python：按设计回退主程序 Python（是否可用由 torch 检查揭示）
        if (!pyVer.ok) {
          item("fail", t("GPT-SoVITS Python 未配置，且主程序 Python 不可用", "GPT-SoVITS Python not configured and main Python unavailable"));
        } else {
          item("warn", t(
            `GPT-SoVITS Python 未单独配置，将使用主程序 Python ${pyVersionFrom(pyVer.stdout) ?? ""}`,
            `GPT-SoVITS Python not set; falls back to main Python ${pyVersionFrom(pyVer.stdout) ?? ""}`,
          ));
        }
      }

      if (gsvTorch?.ok && gsvTorch.stdout.trim()) {
        item("ok", t(`PyTorch ${gsvTorch.stdout.trim()}`, `PyTorch ${gsvTorch.stdout.trim()}`));
      } else {
        item("warn", t("PyTorch 未安装，GPT-SoVITS 合成不可用", "PyTorch not installed, GPT-SoVITS synthesis unavailable"));
      }

      if (gsv.mode === "local") {
        if (!gsv.apiScriptPath) {
          item("warn", t("api_v2 脚本未配置，无法自动启动本地服务", "api_v2 script not configured, cannot auto-start local server"));
        } else if (!existsSync(gsv.apiScriptPath)) {
          item("warn", t(`api_v2 脚本不存在：${gsv.apiScriptPath}`, `api_v2 script not found: ${gsv.apiScriptPath}`));
        } else {
          item("ok", t("api_v2 脚本就绪", "api_v2 script ready"));
        }

        // 配置了但路径失效的权重
        const badPaths: string[] = [];
        if (gsv.gptModelPath && !existsSync(gsv.gptModelPath)) badPaths.push("gptModelPath");
        if (gsv.sovitsModelPath && !existsSync(gsv.sovitsModelPath)) badPaths.push("sovitsModelPath");
        if (badPaths.length > 0) {
          item("warn", t(`模型权重路径不存在：${badPaths.join("、")}`, `Model weight path(s) not found: ${badPaths.join(", ")}`));
        } else {
          const hasGpt = !!gsv.gptModelPath || VOICE_AGENT_IDS.some((id) => !!getGptSovitsVoice(id)?.gptWeightsPath?.trim());
          const hasSovits = !!gsv.sovitsModelPath || VOICE_AGENT_IDS.some((id) => !!getGptSovitsVoice(id)?.sovitsWeightsPath?.trim());
          if (hasGpt && hasSovits) {
            item("ok", t("模型权重已配置", "Model weights configured"));
          } else {
            item("warn", t("未配置模型权重，本地合成不可用", "No model weights configured, local synthesis unavailable"));
          }
        }

        const bertOk = !!gsv.bertPath && existsSync(gsv.bertPath);
        const hubOk = !!gsv.cnhubertPath && existsSync(gsv.cnhubertPath);
        if (bertOk && hubOk) {
          item("ok", t("BERT / CNHubert 就绪", "BERT / CNHubert ready"));
        } else {
          item("warn", t("BERT 或 CNHubert 未配置或不存在，自动启动本地服务需要它们", "BERT or CNHubert missing; both are required to auto-start the local server"));
        }

        const { host, port } = parseBaseUrl(gsv.baseUrl);
        const alive = await tcpReachable(host, port);
        item(
          alive ? "ok" : "warn",
          alive
            ? t(`本地服务运行中 ${host}:${port}`, `Local server running at ${host}:${port}`)
            : t("本地服务未运行，首次合成时自动启动", "Local server not running; it will auto-start on first synthesis"),
        );
      } else {
        const { host, port } = parseBaseUrl(gsv.baseUrl);
        const alive = await tcpReachable(host, port, 3000);
        item(
          alive ? "ok" : "warn",
          alive
            ? t(`云端服务可达 ${gsv.baseUrl}`, `Cloud service reachable at ${gsv.baseUrl}`)
            : t(`云端服务不可达：${gsv.baseUrl}`, `Cloud service unreachable: ${gsv.baseUrl}`),
        );
      }
    }

    if (config.sttEnabled) {
      item(
        config.sttApiKey ? "ok" : "warn",
        config.sttApiKey
          ? t("STT API Key 已配置", "STT API Key configured")
          : t("STT API Key 未配置，语音识别不可用", "STT API Key not configured, speech recognition unavailable"),
      );
    }
  }

  // ---------------- 桌宠 ----------------
  section(t("桌宠", "Pet"));
  const electronOk = existsSync(join(PROJECT_ROOT, "node_modules", "electron"));
  item(
    electronOk ? "ok" : "fail",
    electronOk
      ? t("Electron 已安装", "Electron installed")
      : t(`Electron 未安装，桌宠不可用；在 ${PROJECT_ROOT} 运行 npm install`, `Electron not installed, pet unavailable. Run npm install in ${PROJECT_ROOT}`),
  );

  // ---------------- 汇总 ----------------
  console.log();
  if (failCount > 0) {
    console.log(chalk.red(t(`发现 ${failCount} 项可能影响使用的问题`, `${failCount} issue(s) that may affect usage`)));
  } else if (warnCount > 0) {
    console.log(chalk.yellow(t(`有 ${warnCount} 项可略过（未配置或功能受限）`, `${warnCount} item(s) skippable (not configured or limited)`)));
  } else {
    console.log(chalk.green(t("一切正常", "All checks passed")));
  }
  process.exitCode = failCount > 0 ? 1 : 0;
}

/** 占位透传：让 Promise.all 的元素类型统一（null 探测保持 null）。 */
function pyTorch(p: Promise<ProbeResult> | null): Promise<ProbeResult | null> {
  return p ?? Promise.resolve(null);
}

main().catch((err) => {
  console.error(chalk.red(t(`doctor 执行失败：`, `doctor failed: `) + (err instanceof Error ? err.message : String(err))));
  process.exitCode = 1;
});
