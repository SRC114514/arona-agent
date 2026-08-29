// GuiController：Repl（src/repl.ts）的无 readline 版回合编排，GUI 模式专用。
// 与 Repl 的对应关系（双改须同步）：parseInput / runRawTurn / runOneAgent / ensureSubSessions /
// waitTurnSettled / extractNewAssistantText / setActiveAgent / resetSubSessions /
// saveCurrentSessionIfNeeded / resumeSession（渲染差异：输出走 agent_event 协议而非 stdout）。
import { execSync } from "child_process";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import type { AgentSession, ModelRuntime, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { config } from "../config.ts";
import * as memory from "../memory.ts";
import * as voice from "../voice.ts";
import { TtsStream } from "../tts_stream.ts";
import { stopGptSovitsLocalServer } from "../gpt_sovits_local.ts";
import { stopComputerUse } from "../tools/computer_use.ts";
import { disconnectAllMcp, listMcpServers, callMcpTool } from "../mcp.ts";
import { pet, stopPet } from "../pet.ts";
import { UndoManager } from "../undo.ts";
import { t } from "../locale.ts";
import { initSubAgent } from "../agent.ts";
import { countTextUnits } from "../text_split.ts";
import {
  getMainAgent, getSubAgents, getAgentLabel, setMainAgent, setSubAgents,
  MAIN_AGENT_IDS, SUB_AGENT_IDS,
  type AgentId, type SubAgentId, type MainAgentId,
} from "../agent_registry.ts";
import * as skills from "../skills.ts";
import { SLASH_COMMANDS, resolveSlashCommand } from "../slash_registry.ts";
import type { GuiEvent, GuiState } from "./protocol.ts";

const PET_MAX_BUBBLE_LEN = 50;

/** 把 lines 按"最早的优先保留"裁到总字数 < maxUnits（与 renderer.trimBubbleLines 一致）。 */
function trimBubbleLines(lines: string[], maxUnits: number): string[] {
  let total = lines.reduce((s, l) => s + countTextUnits(l), 0);
  while (total > maxUnits && lines.length > 1) {
    total -= countTextUnits(lines[0]);
    lines.shift();
  }
  return lines;
}

export class GuiController {
  private session: AgentSession;
  private modelRuntime: ModelRuntime;
  private loader: DefaultResourceLoader;
  private isProcessing = false;
  private aborted = false;
  private turnEnded = false;
  private showThinking = true;
  private showToolDetails = true;
  private recording = false;
  private sttAbort: AbortController | null = null;
  private sttGraceful: AbortController | null = null;
  // 当前会话文件被用户删除：置位后本轮对话不再回写文件（避免删除后被自动保存复活）
  private currentSessionDeleted = false;

  private ttsStream = new TtsStream(
    (agentId) => voice.isTtsEnabledFor(agentId),
    () => {
      this.hidePetBubble();
      if (this.turnEnded && !this.ttsStream.isPending) pet.reset();
    },
    (agentId, rms) => {
      if (pet.isRunning) pet.sendTtsLevel(agentId, rms);
    },
  );

  private subSessions = new Map<SubAgentId, AgentSession>();
  private activeSession: AgentSession;
  private activeAgentId: AgentId;
  private bubbleHideTimer: NodeJS.Timeout | null = null;
  private rendererUnsub: (() => void) | null = null;
  private currentSessionPath: string | null = null;
  private undoManager: UndoManager;

  // 回合文本累积（与 renderer.ts 同构：只保留最后一个 assistant message 的文本）
  private curMsgText = "";
  private lastText = "";

  constructor(
    session: AgentSession,
    modelRuntime: ModelRuntime,
    loader: DefaultResourceLoader,
    private emit: (ev: GuiEvent) => void,
    private onExit: () => void,
    private onNewSession: () => Promise<{
      session: AgentSession;
      modelRuntime: ModelRuntime;
      loader: DefaultResourceLoader;
    }>,
  ) {
    this.session = session;
    this.modelRuntime = modelRuntime;
    this.loader = loader;
    this.activeSession = session;
    this.activeAgentId = getMainAgent();

    this.undoManager = new UndoManager(process.cwd());
    this.undoManager.load();

    this.rendererUnsub = this.subscribeTo(session);
  }

  // ============================================================
  // 状态
  // ============================================================

  buildState(): GuiState {
    return {
      model: config.model,
      mainAgent: getMainAgent(),
      mainAgentLabel: getAgentLabel(getMainAgent()),
      subAgents: getSubAgents(),
      ttsEnabled: voice.isTtsEnabled(),
      sttEnabled: voice.isSttEnabled(),
      noVoice: config.noVoice,
      processing: this.isProcessing,
      recording: this.recording,
      currentSessionPath: this.currentSessionPath,
    };
  }

  /** 推送侧栏会话列表（附当前会话路径供高亮）。 */
  pushSessions(): void {
    this.emit({
      type: "sessions",
      currentPath: this.currentSessionPath,
      sessions: memory.listSessions().map((s) => ({
        path: s.path, preview: s.preview, timestamp: s.timestamp, model: s.model,
      })),
    });
  }

  private notice(level: "info" | "warn" | "error" | "success", text: string): void {
    this.emit({ type: "notice", level, text });
  }

  private hidePetBubble(): void {
    if (this.bubbleHideTimer) {
      clearTimeout(this.bubbleHideTimer);
      this.bubbleHideTimer = null;
    }
    if (pet.isRunning) pet.sendText(this.activeAgentId, "tts_end", "");
  }

  private scheduleBubbleHide(): void {
    if (this.bubbleHideTimer) clearTimeout(this.bubbleHideTimer);
    this.bubbleHideTimer = setTimeout(() => {
      this.bubbleHideTimer = null;
      this.hidePetBubble();
      if (pet.isRunning) pet.reset();
    }, 5000);
  }

  // ============================================================
  // Agent 事件订阅（renderer 同构 → agent_event 协议）
  // ============================================================

  private subscribeTo(session: AgentSession): () => void {
    return session.subscribe((event: any) => {
      // GUI 渲染流：thinking/tool 按显示开关过滤；折叠规则由前端实现（尾部 3 行）
      switch (event.type) {
        case "message_start":
          this.curMsgText = "";
          break;
        case "message_update": {
          const ae = event.assistantMessageEvent;
          if (ae?.type === "text_delta") {
            this.curMsgText += ae.delta;
          }
          break;
        }
        case "message_end":
          this.lastText = this.curMsgText.trim();
          this.curMsgText = "";
          break;
        case "agent_end": {
          // TTS 与气泡收尾（与 renderer agent_end 分支一致）
          if (this.lastText) {
            this.ttsStream.endTurn(this.lastText);
            const units = countTextUnits(this.lastText);
            if (units > 0 && pet.isRunning) {
              const data = units >= PET_MAX_BUBBLE_LEN
                ? this.lastText
                : trimBubbleLines([this.lastText], PET_MAX_BUBBLE_LEN).join("\n");
              pet.sendText(this.activeAgentId, "final", data);
            }
          }
          this.lastText = "";
          break;
        }
      }
      // 协议转发（含上述事件原文，前端自行分流渲染）
      if (event.type === "message_update") {
        const ae = event.assistantMessageEvent;
        if (ae?.type === "thinking_delta" && !this.showThinking) return;
      }
      if (event.type === "tool_execution_start" && !this.showToolDetails) return;
      if (event.type === "tool_execution_end" && !this.showToolDetails) return;
      this.emit({ type: "agent_event", agentId: this.activeAgentId, event: event as Record<string, unknown> });
    });
  }

  /** 切 renderer 订阅到指定角色 session（与 Repl.setActiveAgent 一致）。 */
  private setActiveAgent(agentId: AgentId, session: AgentSession): void {
    this.activeAgentId = agentId;
    this.activeSession = session;
    this.curMsgText = "";
    this.lastText = "";
    this.rendererUnsub?.();
    this.rendererUnsub = this.subscribeTo(session);
  }

  // ============================================================
  // 输入处理
  // ============================================================

  private parseInput(input: string): string {
    let processed = input;

    // @file 引用展开
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

    // !shell 命令展开
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

  /** GUI 输入入口：斜杠命令分发或普通消息回合。 */
  async handleInput(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      await this.handleCommand(trimmed);
      return;
    }
    await this.processInput(trimmed);
  }

  private async processInput(input: string): Promise<void> {
    await this.runRawTurn(this.parseInput(input));
  }

  // ============================================================
  // 命令（GUI 版 15 条全量）
  // ============================================================

  async handleCommand(input: string): Promise<void> {
    const stripped = input.startsWith("/") ? input.slice(1) : input;
    const parts = stripped.split(/\s+/);
    const typedName = parts[0];
    const args = parts.slice(1).join(" ");

    const spec = resolveSlashCommand(typedName);
    if (!spec) {
      this.notice("error", t(`未知命令：/${typedName}`, `Unknown command: /${typedName}`));
      return;
    }

    switch (spec.name) {
      case "help":
        this.emit({ type: "notice", level: "info", text: SLASH_COMMANDS.map((c) => `/${c.name}${c.aliases?.length ? `, /${c.aliases.join(", /")}` : ""}  ${c.description}`).join("\n") });
        return;

      case "exit":
        await this.doExit();
        return;

      case "new":
        await this.newSession();
        this.notice("success", t("已开始新会话。", "Started a new session."));
        return;

      case "compact":
        try {
          await this.session.compact(args.trim() || undefined);
        } catch {
          // 错误信息已由 compaction_end 事件输出（经 agent_event 转发）
        }
        return;

      case "thinking":
        this.showThinking = !this.showThinking;
        this.emit({ type: "display", thinking: this.showThinking, toolDetails: this.showToolDetails });
        return;

      case "details":
        this.showToolDetails = !this.showToolDetails;
        this.emit({ type: "display", thinking: this.showThinking, toolDetails: this.showToolDetails });
        return;

      case "tts":
        if (config.noVoice) {
          this.notice("info", t("语音功能已禁用（--no-voice）。", "Voice features disabled (--no-voice)."));
          return;
        }
        if (!voice.hasCurrentVoice()) {
          this.notice("warn", t(
            "当前角色未克隆音色，TTS 强制静音。运行 arona voice add 补全音色后即可启用。",
            "The current agent has no cloned voice, so TTS is force-muted. Run `arona voice add` to add a voice first.",
          ));
          return;
        }
        voice.setTtsEnabled(!voice.isTtsEnabled());
        this.notice("info", t(`TTS：${voice.isTtsEnabled() ? "开" : "关"}`, `TTS: ${voice.isTtsEnabled() ? "on" : "off"}`));
        this.emit({ type: "ready", state: this.buildState() });
        return;

      case "stt":
        if (config.noVoice) {
          this.notice("info", t("语音功能已禁用（--no-voice）。", "Voice features disabled (--no-voice)."));
          return;
        }
        voice.setSttEnabled(!voice.isSttEnabled());
        this.notice("info", t(`STT：${voice.isSttEnabled() ? "开" : "关"}`, `STT: ${voice.isSttEnabled() ? "on" : "off"}`));
        this.emit({ type: "ready", state: this.buildState() });
        return;

      case "resume":
        this.sendSessions();
        return;

      case "export":
        this.exportSession();
        return;

      case "undo": {
        const r = await this.undoManager.undo();
        this.notice(r.ok ? "success" : "warn", r.message);
        return;
      }

      case "redo": {
        const r = await this.undoManager.redo();
        this.notice(r.ok ? "success" : "warn", r.message);
        return;
      }

      case "skill":
        if (!args) {
          this.sendSkills();
        } else {
          await this.invokeSkill(args.trim());
        }
        return;

      case "mcp":
        if (!args || args === "list") {
          this.emit({ type: "mcp_servers", servers: listMcpServers() });
        } else {
          await this.handleMcpCall(args);
        }
        return;

      case "change-agent":
        this.sendAgents();
        return;
    }
  }

  private sendSessions(): void {
    this.pushSessions();
  }

  private sendSkills(): void {
    this.emit({
      type: "skills",
      skills: skills.listSkills(this.loader).map((s) => ({ name: s.name, description: s.description })),
    });
  }

  private sendAgents(): void {
    this.emit({
      type: "agents",
      main: [...MAIN_AGENT_IDS],
      subs: [...SUB_AGENT_IDS],
      currentMain: getMainAgent(),
      currentSubs: getSubAgents(),
    });
  }

  private exportSession(): void {
    const messages = this.session.messages;
    const exportTitle = t("ARONA 会话导出", "ARONA Session Export");
    const userLabel = t("用户", "User");
    const aronaLabel = "ARONA";
    const toolLabel = t("工具", "tool");
    const resultLabel = t("结果", "result");
    let markdown = `# ${exportTitle}\n\n_${new Date().toISOString()}_\n\n---\n\n`;

    for (const msg of messages) {
      const role = msg.role === "user" ? `## ${userLabel}` : msg.role === "assistant" ? `## ${aronaLabel}` : `## ${msg.role}`;
      markdown += `${role}\n\n`;
      if ("content" in msg) {
        if (typeof msg.content === "string") {
          markdown += `${msg.content}\n\n`;
        } else {
          for (const part of msg.content) {
            if (part.type === "text") markdown += `${part.text}\n\n`;
            else if (part.type === "thinking") markdown += `> ${part.thinking}\n\n`;
            else if (part.type === "toolCall") markdown += `[${toolLabel}：${part.name}]\n\n`;
            else if (part.type === "image") markdown += `[${t("图片", "image")}：${part.mimeType}]\n\n`;
          }
          if (msg.role === "toolResult") {
            markdown += `[${resultLabel}：${msg.toolName}]\n\n`;
          }
        }
      }
      markdown += "---\n\n";
    }

    const exportPath = join(process.cwd(), `arona-export-${Date.now()}.md`);
    writeFileSync(exportPath, markdown);
    this.notice("success", t(`已导出到 ${exportPath}`, `Exported to ${exportPath}`));
  }

  private async invokeSkill(skillName: string): Promise<void> {
    const content = skills.getSkillContent(skillName, this.loader);
    if (!content) {
      this.notice("error", t(`未找到技能 "${skillName}"。`, `Skill "${skillName}" not found.`));
      return;
    }
    this.notice("success", t(`已调用技能：${skillName}`, `Invoked skill: ${skillName}`));
    await this.runRawTurn(t(`[技能：${skillName}]`, `[skill: ${skillName}]`) + `\n\n${content}`);
  }

  private async handleMcpCall(args: string): Promise<void> {
    const parts = args.split(/\s+/);
    const serverName = parts[0];
    const toolName = parts[1];
    if (!toolName) {
      const server = listMcpServers().find((s) => s.name === serverName);
      if (server) {
        this.notice("info", server.tools.map((tool) => `${serverName} · ${tool}`).join("\n") || t("（无工具）", "(no tools)"));
      } else {
        this.notice("error", t(`未找到服务器 "${serverName}"。`, `Server "${serverName}" not found.`));
      }
      return;
    }
    try {
      const parsedArgs = parts.slice(2).join(" ") ? JSON.parse(parts.slice(2).join(" ")) : {};
      const result = await callMcpTool(serverName, toolName, parsedArgs);
      this.notice("info", String(result));
    } catch (err) {
      this.notice("error", t(`MCP 调用失败：${err instanceof Error ? err.message : err}`, `MCP call failed: ${err instanceof Error ? err.message : err}`));
    }
  }

  /** /change-agent 确认（GUI 弹窗提交）。 */
  async applyAgentSelection(main: string, subs: string[]): Promise<void> {
    if (!MAIN_AGENT_IDS.includes(main as MainAgentId)) return;
    const validSubs = SUB_AGENT_IDS.filter((id) => subs.includes(id)) as SubAgentId[];
    const current = getMainAgent();
    const currentSubs = getSubAgents();
    const mainChanged = main !== current;
    const subsChanged = JSON.stringify(validSubs) !== JSON.stringify(currentSubs);
    if (!mainChanged && !subsChanged) {
      this.notice("info", t("角色选择未变化。", "No character selection change."));
      return;
    }
    setMainAgent(main as MainAgentId);
    setSubAgents(validSubs);
    pet.restartWithSelection(main as AgentId, validSubs);
    if (subsChanged) this.resetSubSessions();
    if (mainChanged) {
      this.ttsStream.restartVoice();
      this.saveCurrentSessionIfNeeded();
      await this.newSession();
      this.notice("success", t(
        `主 Agent 已切换为 ${getAgentLabel(main as MainAgentId)}。`,
        `Main agent switched to ${getAgentLabel(main as MainAgentId)}.`,
      ));
    } else {
      this.notice("success", t("子 Agent 已更新。", "Sub agents updated."));
    }
    this.emit({ type: "ready", state: this.buildState() });
  }

  // ============================================================
  // 会话
  // ============================================================

  private async newSession(): Promise<void> {
    const result = await this.onNewSession();
    this.session = result.session;
    this.modelRuntime = result.modelRuntime;
    this.loader = result.loader;
    this.activeSession = this.session;
    this.activeAgentId = getMainAgent();
    this.currentSessionPath = null;
    this.currentSessionDeleted = false;
    this.resetSubSessions();
    this.rendererUnsub?.();
    this.rendererUnsub = this.subscribeTo(this.session);
    this.emit({ type: "history", messages: [] });
    this.pushSessions();
  }

  /** 删除会话文件；若删的是当前会话，丢弃其后续自动保存。 */
  deleteSessionByPath(path: string): void {
    memory.deleteSession(path);
    if (this.currentSessionPath === path) {
      this.currentSessionPath = null;
      this.currentSessionDeleted = true;
    }
    this.pushSessions();
  }

  /** 重命名会话（更新 preview 与文件名），返回是否成功。 */
  renameSessionByPath(path: string, title: string): boolean {
    const newPath = memory.renameSession(path, title);
    if (!newPath) {
      this.notice("error", t("重命名失败。", "Rename failed."));
      return false;
    }
    if (this.currentSessionPath === path) this.currentSessionPath = newPath;
    this.pushSessions();
    return true;
  }

  resumeSession(path: string): void {
    this.saveCurrentSessionIfNeeded();
    try {
      const messages = memory.loadSession(path);
      this.session.agent.state.messages = messages;
      this.resetSubSessions();
      memory.resetConversationFlag();
      this.currentSessionPath = path;
      this.currentSessionDeleted = false;
      this.emit({ type: "history", messages });
      this.pushSessions();
      this.notice("success", t("已恢复会话。", "Session resumed."));
    } catch (err) {
      this.notice("error", `Failed to load session: ${err instanceof Error ? err.message : err}`);
    }
  }

  private saveCurrentSessionIfNeeded(): void {
    if (this.currentSessionDeleted) return; // 用户已删除该会话，不再回写
    const messages = this.session.messages;
    const model = this.session.model?.id || "unknown";
    if (this.currentSessionPath) {
      memory.saveSessionToPath(this.currentSessionPath, messages, model);
    } else if (memory.getHasConversation()) {
      memory.saveSession(messages, model);
    }
  }

  private resetSubSessions(): void {
    for (const subSession of this.subSessions.values()) {
      try {
        subSession.dispose();
      } catch {
        // 回收失败不影响主流程
      }
    }
    this.subSessions.clear();
  }

  private async ensureSubSessions(): Promise<void> {
    const enabled = getSubAgents();
    for (const id of enabled) {
      if (this.subSessions.has(id)) continue;
      try {
        const { session } = await initSubAgent(id, this.modelRuntime);
        this.subSessions.set(id, session);
      } catch (err) {
        this.notice("error", t(
          `初始化子 Agent ${getAgentLabel(id)} 失败：${err instanceof Error ? err.message : err}，已跳过该角色。`,
          `Failed to init sub-agent ${getAgentLabel(id)}: ${err instanceof Error ? err.message : err}; skipping it.`,
        ));
      }
    }
  }

  // ============================================================
  // 回合编排（与 Repl.runRawTurn / runOneAgent 一致）
  // ============================================================

  private async waitTurnSettled(agentId: AgentId): Promise<void> {
    if (!voice.isTtsEnabledFor(agentId)) {
      await new Promise((r) => setTimeout(r, 5000));
      return;
    }
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (this.ttsStream.isPending) {
          clearInterval(iv);
          resolve();
          return;
        }
        if (Date.now() - t0 > 2000) {
          clearInterval(iv);
          resolve();
        }
      }, 50);
    });
    if (this.ttsStream.isPending) {
      await new Promise<void>((resolve) => {
        const iv = setInterval(() => {
          if (!this.ttsStream.isPending) {
            clearInterval(iv);
            clearTimeout(tout);
            resolve();
          }
        }, 100);
        const tout = setTimeout(() => {
          clearInterval(iv);
          resolve();
        }, 30000);
      });
    }
  }

  private extractNewAssistantText(stateMessages: any[], startLen: number): string {
    const texts: string[] = [];
    for (const m of stateMessages.slice(startLen)) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      const text = m.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text || "")
        .join("");
      if (text.trim()) texts.push(text);
    }
    return texts.join("\n").trim();
  }

  private async runOneAgent(
    session: AgentSession,
    agentId: AgentId,
    input: string,
    isSub: boolean,
  ): Promise<string> {
    this.setActiveAgent(agentId, session);
    this.ttsStream.setVoice(agentId);

    if (isSub) {
      // 子 Agent：复制主 session 全量群聊日志作为上下文（浅拷贝，元素引用共享）
      session.agent.state.messages = [...(this.session.agent.state.messages as any[])];
    }

    const stateMessages = session.agent.state.messages as any[];
    const startLen = stateMessages.length;

    const promptText = isSub
      ? t(
          `（你是${getAgentLabel(agentId)}。现在轮到你发言——保持你自己的身份和语气，不要扮演或模仿其他角色。请简短发言。）`,
          `(You are ${getAgentLabel(agentId)}. It's your turn — stay in your own character and voice; do not play or mimic another character. Speak briefly.)`,
        )
      : input;

    try {
      await session.prompt(promptText);
    } catch (err) {
      this.notice("error", t("错误：", "Error: ") + (err instanceof Error ? err.message : err));
      return "";
    }

    const text = this.extractNewAssistantText(stateMessages, startLen);
    if (!text) return "";

    if (!isSub) {
      for (const m of stateMessages.slice(startLen)) {
        if (m.role === "assistant") m.speaker = agentId;
      }
    } else {
      (this.session.agent.state.messages as any[]).push({
        role: "assistant",
        speaker: agentId,
        content: [{ type: "text", text }],
      });
    }
    return text;
  }

  async runRawTurn(input: string): Promise<void> {
    memory.markConversation();
    this.isProcessing = true;
    this.turnEnded = false;
    this.ttsStream.cancel();
    this.hidePetBubble();
    await this.undoManager.beforeTurn();

    try {
      await this.ensureSubSessions();

      // 记忆增量检测：MEMORY.md 运行时变更 → 追加到下一轮主 Agent 的 user 消息末尾
      const memoryDelta = memory.getMemoryDelta();
      const mainInput = memoryDelta ? `${input}\n\n${memoryDelta}` : input;

      await this.runOneAgent(this.session, getMainAgent(), mainInput, false);
      if (this.aborted) return;
      await this.waitTurnSettled(getMainAgent());
      if (this.aborted) return;

      for (const subId of getSubAgents()) {
        const subSession = this.subSessions.get(subId);
        if (!subSession) continue;
        await this.runOneAgent(subSession, subId, input, true);
        if (this.aborted) return;
        await this.waitTurnSettled(subId);
        if (this.aborted) return;
      }

      this.setActiveAgent(getMainAgent(), this.session);
    } catch (err) {
      this.notice("error", t("错误：", "Error: ") + (err instanceof Error ? err.message : err));
    } finally {
      try {
        await this.undoManager.afterTurn();
      } catch (err) {
        this.notice("warn", t(`撤销快照记录失败：${err instanceof Error ? err.message : err}`, `Failed to record undo snapshot: ${err instanceof Error ? err.message : err}`));
      }
      this.isProcessing = false;
      this.turnEnded = true;
      if (!this.ttsStream.isPending) {
        pet.reset();
        this.scheduleBubbleHide();
      }
      if (this.aborted) {
        this.aborted = false;
        return;
      }
      this.emit({ type: "ready", state: this.buildState() });
    }
  }

  // ============================================================
  // 中断 / STT / 退出
  // ============================================================

  abort(): void {
    if (!this.isProcessing) return;
    this.activeSession.abort().catch(() => {});
    this.isProcessing = false;
    this.aborted = true;
    this.ttsStream.cancel();
    this.hidePetBubble();
    this.notice("info", "[aborted]");
    this.emit({ type: "ready", state: this.buildState() });
  }

  /** 麦克风按钮：stt.py 自带 VAD 静音自动停止（1.5s 静音/15s 上限），等待返回即可。 */
  async startStt(): Promise<void> {
    if (this.recording) return;
    if (!voice.isSttEnabled()) {
      this.notice("info", t("STT 已关闭（用 /stt 打开）。", "STT is off (use /stt to enable)."));
      return;
    }
    if (this.isProcessing) {
      // 任务中录音：先中断当前任务（对齐 CLI triggerStt 行为）
      this.abort();
    }
    this.recording = true;
    this.emit({ type: "stt_state", recording: true });
    this.sttAbort = new AbortController();
    this.sttGraceful = new AbortController();
    const text = await voice.listen(this.sttAbort.signal, this.sttGraceful.signal);
    this.sttAbort = null;
    this.sttGraceful = null;
    this.recording = false;
    this.emit({ type: "stt_state", recording: false });
    this.emit({ type: "stt_result", text });
  }

  /**
   * 录音中再次点击麦克风：优雅停止——SIGUSR1 让 stt.py 提前跳出录音循环，
   * 走正常 finish-task 流程把已说内容识别返回（不丢弃音频）。
   */
  cancelStt(): void {
    if (!this.recording) return;
    this.sttGraceful?.abort();
  }

  setDisplay(thinking?: boolean, toolDetails?: boolean): void {
    if (thinking !== undefined) this.showThinking = thinking;
    if (toolDetails !== undefined) this.showToolDetails = toolDetails;
    this.emit({ type: "display", thinking: this.showThinking, toolDetails: this.showToolDetails });
  }

  async doExit(): Promise<void> {
    this.saveCurrentSessionIfNeeded();
    this.ttsStream.shutdown();
    stopGptSovitsLocalServer();
    stopComputerUse();
    try {
      await disconnectAllMcp();
    } catch {
      // 清理失败不影响退出
    }
    stopPet();
    this.session.dispose();
    for (const subSession of this.subSessions.values()) {
      try {
        subSession.dispose();
      } catch {
        // 子 session 清理失败不影响退出
      }
    }
    this.emit({ type: "exiting" });
    this.onExit();
  }
}
