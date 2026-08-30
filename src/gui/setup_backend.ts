// 图形化 setup 后端：表单数据 → Python 检查 / pip 依赖 / 音色克隆 / 写盘。
// 步骤与字段对齐 CLI src/setup.ts（该文件模块加载即跑 CLI 向导，不能 import，独立实现）。
import { spawn, execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { ARONA_DIR, SETTINGS_FILE, PROJECT_ROOT, resolveModelPrefix } from "../config.ts";
import { VOICE_AGENT_IDS } from "../agent_registry.ts";
import { VOICE_AUDIO, cloneVoice, setVoiceId, setGptSovitsVoice } from "../voices.ts";
import { normalizeGptSovitsConfig } from "../tts_provider.ts";
import { installGptSovitsDeps } from "../gpt_sovits_local.ts";
import { t } from "../locale.ts";
import type { GuiEvent } from "./protocol.ts";

export interface GuiSetupForm {
  language: "auto" | "zh" | "en";
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  pythonPath: string;
  ttsProvider: "aliyun" | "gpt-sovits";
  // aliyun 分支：百炼 Key（TTS+STT 共用）+ 克隆角色列表
  ttsApiKey: string;
  cloneAgents: string[];
  // gpt-sovits 分支
  gptSovits: {
    mode: "cloud" | "local";
    apiKey?: string;
    apiScriptPath?: string;
    pythonPath?: string;
    device?: string;
    bertPath?: string;
    cnhubertPath?: string;
    baseUrl?: string;
    textLang?: string;
    modelVersion?: string;
    installDeps?: boolean;
    voices: Record<string, { gptWeightsPath: string; sovitsWeightsPath: string; refAudioPath: string; promptText: string }>;
  };
}

type Emit = (ev: GuiEvent) => void;

interface ExistingSettings {
  [key: string]: unknown;
  thinkingLevel?: string;
  mainAgent?: string;
  subAgents?: string[];
  ttsEnabled?: boolean;
  ttsAuto?: boolean;
  sttEnabled?: boolean;
  ttsConfig?: Record<string, unknown>;
  workspaceId?: string;
  ttsModel?: string;
  ttsSampleRate?: number;
  sttModel?: string;
  sttFormat?: string;
  sttSampleRate?: number;
  cuaApiKey?: string;
  pythonPath?: string;
  mcpServers?: Record<string, unknown>;
  autoLoadSkills?: boolean;
  demoMode?: boolean;
}

function loadExistingSettings(): ExistingSettings {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/** Python 须为 3.12/3.13（与 CLI setup.checkPythonVersion 一致）。 */
function checkPythonVersion(pythonPath: string): { ok: boolean; version: string } {
  try {
    const output = execSync(`${pythonPath} --version`, { stdio: "pipe" }).toString().trim();
    const match = output.match(/Python\s+(\d+)\.(\d+)\.(\d+)/);
    if (!match) return { ok: false, version: output || "unknown" };
    const major = parseInt(match[1]);
    const minor = parseInt(match[2]);
    const version = `${major}.${minor}.${match[3]}`;
    if (major === 3 && (minor === 12 || minor === 13)) return { ok: true, version };
    return { ok: false, version };
  } catch {
    return { ok: false, version: "not found" };
  }
}

/** 流式执行命令：逐行转发输出，resolve 退出码。 */
function streamCommand(cmd: string, args: string[], emit: Emit, step: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const pump = (data: Buffer) => {
      for (const line of data.toString().split(/[\r\n]+/)) {
        if (line.trim()) emit({ type: "setup_log", step, line });
      }
    };
    child.stdout?.on("data", pump);
    child.stderr?.on("data", pump);
    child.on("error", (err) => {
      emit({ type: "setup_log", step, line: err.message });
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

/**
 * 执行图形化 setup：返回是否成功（成功 = 配置已就绪或 demo 模拟完成）。
 * 失败细节经 setup_log / setup_clone_progress 事件反馈给前端。
 */
export async function runGuiSetup(form: GuiSetupForm, emit: Emit): Promise<boolean> {
  const existing = loadExistingSettings();
  const demoMode = existing.demoMode === true;

  if (!existsSync(ARONA_DIR)) mkdirSync(ARONA_DIR, { recursive: true });

  // ---- Python 版本检查（失败阻断） ----
  let pythonPath = form.pythonPath?.trim() || (existing.pythonPath as string) || "python3";
  let pyCheck = checkPythonVersion(pythonPath);
  if (!pyCheck.ok) {
    pythonPath = "python";
    pyCheck = checkPythonVersion(pythonPath);
  }
  if (!pyCheck.ok) {
    emit({ type: "setup_log", step: "python", line: t(`✗ Python 版本不兼容：${pyCheck.version}（需要 3.12 或 3.13）`, `✗ Incompatible Python version: ${pyCheck.version} (3.12 or 3.13 required)`) });
    return false;
  }
  emit({ type: "setup_log", step: "python", line: t(`Python ${pyCheck.version} ✓`, `Python ${pyCheck.version} ✓`) });

  // ---- pip 依赖安装（流式转发；demo 模式固定用 pip3.13） ----
  const requirementsFile = join(PROJECT_ROOT, "requirements.txt");
  const pipInstallArgs = ["install", "-r", requirementsFile, "-i", "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"];
  const pipBin = demoMode ? "pip3.13" : pythonPath;
  const pipFullArgs = demoMode ? pipInstallArgs : ["-m", "pip", ...pipInstallArgs];
  let depsOk = false;
  {
    const code = await streamCommand(pipBin, pipFullArgs, emit, "pip");
    depsOk = code === 0;
    emit({ type: "setup_log", step: "pip", line: depsOk ? t("✓ Python 依赖安装完成", "✓ Python dependencies installed") : t("✗ Python 依赖安装失败", "✗ Failed to install Python dependencies") });
  }

  // ---- 音色配置 / 克隆 ----
  const ttsProvider = form.ttsProvider;
  let gptSovitsConfig = normalizeGptSovitsConfig((existing.ttsConfig as Record<string, unknown>)?.["gpt-sovits"]);
  delete (gptSovitsConfig as Record<string, unknown>).voices;

  if (ttsProvider === "gpt-sovits") {
    const gs = form.gptSovits;
    gptSovitsConfig = {
      ...gptSovitsConfig,
      mode: gs.mode,
      apiKey: gs.mode === "cloud" ? (gs.apiKey || "") : "",
      apiScriptPath: gs.mode === "local" ? (gs.apiScriptPath || "") : "",
      pythonPath: gs.mode === "local" ? (gs.pythonPath || pythonPath) : "",
      device: gs.mode === "local" ? (gs.device || "cuda") : "cuda",
      bertPath: gs.mode === "local" ? (gs.bertPath || "") : "",
      cnhubertPath: gs.mode === "local" ? (gs.cnhubertPath || "") : "",
      baseUrl: gs.baseUrl || gptSovitsConfig.baseUrl,
      textLang: gs.textLang || gptSovitsConfig.textLang,
      modelVersion: gs.mode === "cloud" ? "v2" : (gs.modelVersion || "v2"),
    };

    // 本地部署：可选依赖安装（api_v2.py 同目录 requirements 优先）
    if (gs.mode === "local" && gs.installDeps && gs.apiScriptPath && !demoMode) {
      const depResult = await installGptSovitsDeps(gs.apiScriptPath, gs.pythonPath || pythonPath, gs.modelVersion || "v2");
      emit({ type: "setup_log", step: "gpt-sovits-deps", line: depResult.message });
    }

    // 每角色音色写 voices.json#gpt-sovits（demo 模式丢弃不写）
    if (!demoMode) {
      for (const [agentId, v] of Object.entries(gs.voices || {})) {
        if (!v.gptWeightsPath || !v.sovitsWeightsPath) continue;
        setGptSovitsVoice(agentId as never, {
          gptWeightsPath: v.gptWeightsPath,
          sovitsWeightsPath: v.sovitsWeightsPath,
          refAudioPath: v.refAudioPath || "",
          promptText: v.promptText || "",
        });
        emit({ type: "setup_clone_progress", agent: agentId, status: "done" });
      }
    }
  } else if (form.ttsApiKey || demoMode) {
    // aliyun 克隆：依赖已装 + dashscope 可导入才执行（demo 模式直接模拟）
    if (demoMode) {
      for (const id of form.cloneAgents) {
        emit({ type: "setup_clone_progress", agent: id, status: "cloning" });
        await new Promise((r) => setTimeout(r, 5000));
        emit({ type: "setup_clone_progress", agent: id, status: "done" });
      }
    } else if (depsOk) {
      let dashscopeOk = false;
      try {
        execSync(`${pythonPath} -c "import dashscope"`, { stdio: "pipe" });
        dashscopeOk = true;
      } catch {
        emit({ type: "setup_log", step: "clone", line: t("dashscope 包不可用，跳过音色克隆。", "dashscope package unavailable, skipping voice cloning.") });
      }
      if (dashscopeOk) {
        const model = (existing.ttsModel as string) || "qwen-audio-3.0-tts-plus";
        for (const id of form.cloneAgents) {
          if (!VOICE_AGENT_IDS.includes(id as never)) continue;
          const voiceMp3 = VOICE_AUDIO[id as keyof typeof VOICE_AUDIO];
          if (!voiceMp3 || !existsSync(voiceMp3)) {
            emit({ type: "setup_clone_progress", agent: id, status: "failed", message: t(`未找到音色文件（${voiceMp3}）`, `Voice file not found (${voiceMp3})`) });
            continue;
          }
          emit({ type: "setup_clone_progress", agent: id, status: "cloning" });
          try {
            const voiceId = await cloneVoice(id as never, form.ttsApiKey, model);
            setVoiceId(id as never, voiceId);
            emit({ type: "setup_clone_progress", agent: id, status: "done" });
          } catch (err) {
            emit({ type: "setup_clone_progress", agent: id, status: "failed", message: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    } else {
      emit({ type: "setup_log", step: "clone", line: t("Python 依赖未安装成功，跳过音色克隆。", "Python dependencies not installed, skipping voice cloning.") });
    }
  }
  if (ttsProvider === "aliyun" && !form.ttsApiKey?.trim() && !demoMode) {
    emit({ type: "setup_log", step: "clone", line: t("未填写百炼 API Key，跳过音色克隆（TTS/STT 将不可用）。", "No Bailian API key provided; skipping voice cloning (TTS/STT will be unavailable).") });
  }

  // ---- 写盘（demo 模式不写） ----
  if (!demoMode) {
    const apiBaseUrl = form.apiBaseUrl?.trim() || "";
    const rawModel = form.model?.trim() || "openai/gpt-4o";
    const resolvedModel = resolveModelPrefix(rawModel, apiBaseUrl);
    const ttsApiKey = form.ttsApiKey?.trim() || "";

    const settings: Record<string, unknown> = {
      apiKey: form.apiKey?.trim() || "",
      apiBaseUrl,
      model: resolvedModel,
      thinkingLevel: (existing.thinkingLevel as string) || "medium",
      language: form.language,
      mainAgent: existing.mainAgent || "arona",
      subAgents: existing.subAgents || [],
      ttsEnabled: existing.ttsEnabled ?? existing.ttsAuto ?? true,
      sttEnabled: existing.sttEnabled ?? true,
      ttsProvider,
      ttsConfig: {
        ...(existing.ttsConfig || {}),
        ...(ttsProvider === "gpt-sovits" ? { "gpt-sovits": gptSovitsConfig } : {}),
      },
      workspaceId: existing.workspaceId || "",
      ttsApiKey,
      ttsModel: existing.ttsModel || "qwen-audio-3.0-tts-plus",
      ttsSampleRate: existing.ttsSampleRate || 22050,
      sttApiKey: ttsApiKey,
      sttModel: existing.sttModel || "qwen-audio-3.0-asr-flash-streaming",
      sttFormat: existing.sttFormat || "pcm",
      sttSampleRate: existing.sttSampleRate || 16000,
      cuaApiKey: existing.cuaApiKey || "",
      pythonPath,
      mcpServers: existing.mcpServers || {},
      autoLoadSkills: existing.autoLoadSkills ?? true,
    };
    // 保留用户手写 GUIEnabled
    if (typeof existing.GUIEnabled === "boolean") settings.GUIEnabled = existing.GUIEnabled;

    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
    emit({ type: "setup_log", step: "save", line: t(`✓ 配置已保存到 ${SETTINGS_FILE}`, `✓ Configuration saved to ${SETTINGS_FILE}`) });
  }

  emit({ type: "setup_done" });
  return true;
}
