// GuiController：Repl（src/repl.ts）的无 readline 版回合编排，GUI 模式专用。
// 与 Repl 的对应关系（双改须同步）：parseInput / runRawTurn / runOneAgent / ensureSubSessions /
// waitTurnSettled / extractNewAssistantText / setActiveAgent / resumeSession（渲染差异：输出走 agent_event 协议而非 stdout）。
// 会话管理为"槽位"模型：LLM 生成中切换会话/工作区不中断回合——旧会话挂后台继续，
// 结束按槽位存盘（含其定格的工作区），可随时从侧栏接回实时查看。
import { execSync } from "child_process";
import { homedir } from "os";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import type { AgentSession, ModelRuntime, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { config, getStoredWorkspaces, rememberWorkspace } from "../config.ts";
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
import { setCodingRunSink, setCodingEventSink } from "../coding_process.ts";
import { stripSpeakerPrefix, SpeakerPrefixStripper } from "../speaker_context.ts";
import { currentWorkspace, setActiveWorkspace, guiDefaultWorkspace, workspaceLabel } from "../workspace.ts";
import type { CodingRun } from "../memory.ts";
import type { GuiEvent, GuiState } from "./protocol.ts";

const PET_MAX_BUBBLE_LEN = 50; // 气泡字数上限（countTextUnits 口径）：≥50 字的回复不上气泡
const MAX_BACKGROUND_SLOTS = 6; // 后台会话上限（超出时释放最早的未在生成的会话）

/**
 * 会话槽位：每个 AgentSession 一份元数据。当前会话与"挂在后台继续生成"的会话统一管理——
 * 切换会话不再复用/销毁同一个 session 对象，后台回合结束时按槽位存盘。
 */
interface SessionSlot {
  session: AgentSession;
  path: string | null;       // 已落盘文件路径（null = 尚未存盘）
  workspace: string;         // 会话归属工作区（创建时定格；后台回合存盘用它，避免被切换后的 currentWorkspace 误标）
  deleted: boolean;          // 用户已删除该会话文件：不再回写
  hasConversation: boolean;  // 该会话是否发生过有效对话（原全局 hasConversation 的按会话版）
  processing: boolean;       // 回合进行中（可能在后台）
  abortRequested: boolean;   // 用户点了停止
  pendingRuns: CodingRun[];  // 首次落盘前缓冲的子代理执行记录
  undo: UndoManager;         // 撤销快照按会话隔离（不同工作区/并发回合互不串扰）
  subs: Map<SubAgentId, AgentSession>; // 群聊子 Agent 会话按主会话隔离（并发回合各自的子会话消息不互踩）
}

export class GuiController {
  private session: AgentSession;
  private modelRuntime: ModelRuntime;
  private loader: DefaultResourceLoader;
  private turnEnded = false;
  private recording = false;
  private sttAbort: AbortController | null = null;
  private sttGraceful: AbortController | null = null;

  private slots = new Map<AgentSession, SessionSlot>();
  // 进行中的回合栈（栈顶 = 最近开始的回合；编码子代理过程按它路由落盘）
  private turnStack: SessionSlot[] = [];
  private activeSession: AgentSession;
  private activeAgentId: AgentId;
  private bubbleHideTimer: NodeJS.Timeout | null = null;
  private rendererUnsub: (() => void) | null = null;
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

  // 回合文本累积（与 renderer.ts 同构：只保留最后一个 assistant message 的文本）
  private curMsgText = "";
  private lastText = "";
  // 流式剥离「名字：」前缀（模型偶发模仿历史消息写出；GUI 侧已单独标注说话人，会显示两遍）
  private prefixStripper: SpeakerPrefixStripper | null = null;

  /** 取会话槽位（无则按当前工作区创建）。 */
  private slotOf(session: AgentSession): SessionSlot {
    let slot = this.slots.get(session);
    if (!slot) {
      slot = {
        session,
        path: null,
        workspace: currentWorkspace(),
        deleted: false,
        hasConversation: false,
        processing: false,
        abortRequested: false,
        pendingRuns: [],
        undo: new UndoManager(currentWorkspace()),
        subs: new Map<SubAgentId, AgentSession>(),
      };
      slot.undo.load();
      this.slots.set(session, slot);
    }
    return slot;
  }

  private get activeSlot(): SessionSlot {
    return this.slotOf(this.activeSession);
  }

  constructor(
    session: AgentSession,
    modelRuntime: ModelRuntime,
    loader: DefaultResourceLoader,
    private emit: (ev: GuiEvent) => void,
    private onExit: () => void,
    private onCreateSession: () => Promise<{
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

    // 编码子代理过程留痕：按栈顶回合的会话路由（该会话文件已存在 → 直接写 sidecar；
    // 尚未落盘（新会话首回合）→ 缓冲，回合结束存盘后回填）。
    setCodingRunSink((run) => {
      const slot = this.turnStack[this.turnStack.length - 1] ?? this.activeSlot;
      if (slot.deleted) return;
      if (slot.path) {
        memory.appendCodingRun(slot.path, run);
      } else {
        slot.pendingRuns.push(run);
      }
    });
    // 编码子代理事件实时转发前端（agentId 区分角色，前端以对应角色名义渲染）；
    // 栈顶回合不是当前会话（后台回合）时不投影，避免后台过程串进前台画面。
    setCodingEventSink((agentId, event) => {
      const top = this.turnStack[this.turnStack.length - 1];
      if (top && top.session !== this.activeSession) return;
      this.emit({ type: "agent_event", agentId, event: event as Record<string, unknown> });
    });

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
      processing: this.activeSlot.processing,
      recording: this.recording,
      currentSessionPath: this.activeSlot.path,
    };
  }

  /** 推送侧栏会话列表（附当前会话路径供高亮 + 当前工作区与已知工作区）。 */
  pushSessions(): void {
    const listed = memory.listSessions();
    // 已知工作区 = settings 选择历史 ∪ 会话 header 推导 ∪ 当前活动工作区（去重保序）
    const known: string[] = [];
    const push = (ws: string | null | undefined) => {
      if (ws && !known.includes(ws)) known.push(ws);
    };
    for (const ws of getStoredWorkspaces()) push(ws);
    for (const s of listed) push(s.workspace);
    push(currentWorkspace()); // 启动时已无条件设定（上次选择或家目录），不在列表中丢失
    this.emit({
      type: "sessions",
      currentPath: this.activeSlot.path,
      currentWorkspace: currentWorkspace(),
      homeDir: homedir(),
      knownWorkspaces: known,
      sessions: listed.map((s) => ({
        path: s.path, preview: s.preview, timestamp: s.timestamp, model: s.model, workspace: s.workspace,
      })),
    });
  }

  /**
   * 切换活动工作区（GUI 欢迎页选择器）：当前会话存盘/转后台 → 切换 → 在新工作区建会话（SDK cwd 跟随）。
   * 生成中也可切换：进行中的回合按旧会话槽位继续，结束按其定格的工作区存盘。
   */
  async setWorkspace(path: string): Promise<void> {
    const target = resolve(path);
    if (target === currentWorkspace()) return;
    if (!existsSync(target)) {
      this.notice("error", t(`文件夹不存在：${target}`, `Folder not found: ${target}`));
      return;
    }
    await this.detachActive(); // 存盘/转后台须在切换前：存盘补写的 workspace 用旧值才正确
    setActiveWorkspace(target);
    rememberWorkspace(target);
    await this.createAndAttach();
    this.notice("success", t(
      `工作区已切换：${workspaceLabel(target)}`,
      `Workspace switched: ${workspaceLabel(target)}`,
    ));
    this.emit({ type: "ready", state: this.buildState() });
  }

  /** 把会话移动到指定工作区（右键菜单），返回是否成功。 */
  moveSessionByPath(path: string, workspace: string): void {
    const ok = memory.setSessionWorkspace(path, workspace, true);
    if (!ok) {
      this.notice("error", t("移动失败。", "Move failed."));
      return;
    }
    this.pushSessions();
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
      // 前缀剥离把整个 delta 扣留时置位：本条事件不向下转发（无可上屏内容）
      let dropEvent = false;
      // GUI 渲染流：thinking/tool 按显示开关过滤；折叠规则由前端实现（尾部 3 行）
      switch (event.type) {
        case "message_start":
          this.curMsgText = "";
          this.prefixStripper = new SpeakerPrefixStripper(this.activeAgentId);
          break;
        case "message_update": {
          const ae = event.assistantMessageEvent;
          if (ae?.type === "text_delta") {
            // 转发前剥离前缀：就地改写 delta，走末尾统一转发（前端上屏与 TTS/气泡累积都干净）
            const stripped = this.prefixStripper?.push(ae.delta) ?? ae.delta;
            if (!stripped) {
              dropEvent = true; // 整段被扣留（前缀未判完）
            } else {
              this.curMsgText += stripped;
              ae.delta = stripped;
            }
          }
          break;
        }
        case "message_end": {
          // 放行剥离器仍扣留的内容（无前缀的短回复可能整段被扣到 message 结束）
          const held = this.prefixStripper?.flush() ?? "";
          if (held) {
            this.curMsgText += held;
            this.emit({
              type: "agent_event",
              agentId: this.activeAgentId,
              event: {
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: held },
              } as Record<string, unknown>,
            });
          }
          this.lastText = this.curMsgText.trim();
          this.curMsgText = "";
          break;
        }
      case "agent_end": {
        // TTS 收尾 + 桌宠气泡：仅前台会话的回合（后台会话用户看不到，静默继续避免抢音/抢气泡）
        if (session === this.activeSession) {
          if (this.lastText) {
            this.ttsStream.endTurn(this.lastText);
            if (pet.isRunning) {
              const units = countTextUnits(this.lastText);
              if (units > 0 && units < PET_MAX_BUBBLE_LEN) {
                pet.sendText(this.activeAgentId, "final", this.lastText);
              }
            }
          }
          this.lastText = "";
        }
        break;
      }
      }
      if (dropEvent) return;
      // 协议转发（思考块与工具详情始终显示，前端自行分流渲染）
      this.emit({ type: "agent_event", agentId: this.activeAgentId, event: event as Record<string, unknown> });
    });
  }

  /** 该会话是否是前台主会话的群聊子会话。 */
  private isFrontSub(session: AgentSession): boolean {
    for (const sub of this.activeSlot.subs.values()) {
      if (sub === session) return true;
    }
    return false;
  }

  /** 切 renderer 订阅到指定角色 session（与 Repl.setActiveAgent 一致）。
   *  仅前台会话（及其群聊子会话）的回合接管渲染；后台会话的回合静默继续，
   *  结束后由 finally 存盘，不抢订阅。 */
  private setActiveAgent(agentId: AgentId, session: AgentSession): void {
    if (session !== this.activeSession && !this.isFrontSub(session)) return;
    this.activeAgentId = agentId;
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
        const r = await this.activeSlot.undo.undo();
        this.notice(r.ok ? "success" : "warn", r.message);
        return;
      }

      case "redo": {
        const r = await this.activeSlot.undo.redo();
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
    if (mainChanged) {
      this.ttsStream.restartVoice();
      // 保存/转后台由 newSession 的 detachActive 统一处理
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
  // 会话（槽位模型：当前会话与后台会话统一管理）
  // ============================================================

  /** 新会话：当前会话若在生成则转后台继续，否则存盘释放；然后建新会话。 */
  private async newSession(): Promise<void> {
    await this.detachActive();
    await this.createAndAttach();
  }

  /** 创建新 AgentSession（cwd 跟随当前活动工作区）并接管前台。 */
  private async createAndAttach(): Promise<void> {
    const result = await this.onCreateSession();
    this.session = result.session;
    this.modelRuntime = result.modelRuntime;
    this.loader = result.loader;
    this.attach(result.session);
  }

  /** 接管某会话为前台：绑定渲染订阅并下发回放数据（重新接上后台会话时含其当前消息）。 */
  private attach(session: AgentSession, replay?: { runs: CodingRun[]; messages: unknown[] }): void {
    this.activeSession = session;
    this.activeAgentId = getMainAgent();
    this.curMsgText = "";
    this.lastText = "";
    this.prefixStripper = null;
    this.rendererUnsub?.();
    this.rendererUnsub = this.subscribeTo(session);
    if (replay) {
      this.emit({ type: "coding_runs", runs: replay.runs });
      this.emit({ type: "history", messages: replay.messages });
    } else {
      const slot = this.slotOf(session);
      // 重新接上（可能是后台生成中的会话）：下发已有消息，之后实时事件继续流向前台
      this.emit({ type: "coding_runs", runs: slot.path ? memory.loadCodingRuns(slot.path) : [] });
      this.emit({ type: "history", messages: (session.agent.state.messages ?? []) as unknown[] });
    }
    this.emit({ type: "ready", state: this.buildState() });
    this.pushSessions();
  }

  /**
   * 脱离当前前台会话：
   * - 回合进行中 → 先按当前内容落盘（修剪残缺尾部，侧栏立即可见、随时可点回），
   *   再挂后台：断开渲染订阅，回合继续，结束时以完整上下文覆盖存盘；
   * - 空闲 → 立即存盘并释放（含其子会话）。
   */
  private detachActive(): void {
    const old = this.activeSession;
    const slot = this.slotOf(old);
    if (slot.processing) {
      this.saveSlot(slot, old); // 立即落盘（修剪版）：侧栏马上出现该会话，点击可接回实时画面
      this.rendererUnsub?.();
      this.rendererUnsub = null;
      this.pruneBackgroundSlots(old);
    } else {
      this.saveSlot(slot, old);
      this.disposeSession(old);
    }
  }

  /** 后台会话超上限时释放最早的未在生成的会话（渲染订阅已断开，直接释放即可）。 */
  private pruneBackgroundSlots(keep: AgentSession): void {
    const bg = [...this.slots.values()].filter((s) => s.session !== keep);
    if (bg.length <= MAX_BACKGROUND_SLOTS) return;
    for (const slot of bg) {
      if (this.slots.size <= MAX_BACKGROUND_SLOTS + 1) break; // +1 为前台会话
      if (!slot.processing) this.disposeSession(slot.session);
    }
  }

  private disposeSession(session: AgentSession): void {
    const slot = this.slots.get(session);
    if (slot) {
      for (const sub of slot.subs.values()) {
        try {
          sub.dispose();
        } catch {
          // 回收失败不影响主流程
        }
      }
    }
    try {
      session.dispose();
    } catch {
      // 回收失败不影响主流程
    }
    this.slots.delete(session);
  }

  /**
   * 按槽位存盘。silent=true（默认）用于自动保存；前台会话首次落盘时弹「已保存」提示。
   * - slot.path 非 null：覆盖原文件（workspace 保留 header 原值，缺失时补写槽位定格的工作区）
   * - 为 null：仅有有效对话时另存为新文件（归属槽位定格的工作区，后台回合不被切换误标）
   * 生成中的会话由 memory 写盘函数统一修剪残缺尾部（防 resume 400），不影响内存与后台回合。
   */
  private saveSlot(slot: SessionSlot, session: AgentSession, silent = true): void {
    if (slot.deleted) return; // 用户已删除该会话，不再回写
    const messages = session.agent.state.messages as any[];
    const model = session.model?.id || "unknown";
    if (slot.path) {
      memory.saveSessionToPath(slot.path, messages, model, silent, slot.workspace);
    } else if (slot.hasConversation) {
      slot.path = memory.saveSession(messages, model, silent, slot.workspace);
      if (slot.path && !silent && session === this.activeSession) {
        this.notice("success", t(`会话已保存`, "Session saved"));
      }
    }
    // 首次落盘后，回填期间缓冲的子代理执行记录
    if (slot.path && slot.pendingRuns.length) {
      for (const run of slot.pendingRuns) {
        memory.appendCodingRun(slot.path, run);
      }
      slot.pendingRuns = [];
    }
  }

  /** 恢复会话：后台已有该会话（可能仍在生成）直接接回；否则新建会话加载历史。 */
  async resumeSession(path: string): Promise<void> {
    if (this.activeSlot.path === path) return;
    for (const slot of this.slots.values()) {
      if (slot.session !== this.activeSession && slot.path === path) {
        this.detachActive();
        this.attach(slot.session); // 接回：生成中则继续实时渲染
        return;
      }
    }
    this.detachActive();
    try {
      const messages = memory.loadSession(path);
      const { session } = await this.onCreateSession();
      session.agent.state.messages = messages;
      this.session = session;
      const slot = this.slotOf(session);
      slot.path = path;
      this.attach(session, { runs: memory.loadCodingRuns(path), messages });
    } catch (err) {
      this.notice("error", `Failed to load session: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** 删除会话文件；命中所有槽位（含后台生成中的）标记删除，后续不再回写。 */
  deleteSessionByPath(path: string): void {
    memory.deleteSession(path);
    for (const slot of this.slots.values()) {
      if (slot.path === path) {
        slot.deleted = true;
        slot.path = null;
      }
    }
    this.pushSessions();
  }

  /** 重命名会话（更新 preview 与文件名），返回是否成功；槽位里的路径同步跟随。 */
  renameSessionByPath(path: string, title: string): boolean {
    const newPath = memory.renameSession(path, title);
    if (!newPath) {
      this.notice("error", t("重命名失败。", "Rename failed."));
      return false;
    }
    for (const slot of this.slots.values()) {
      if (slot.path === path) slot.path = newPath;
    }
    this.pushSessions();
    return true;
  }

  private async ensureSubSessions(main: AgentSession): Promise<void> {
    const slot = this.slotOf(main);
    for (const id of getSubAgents()) {
      if (slot.subs.has(id)) continue;
      try {
        const { session } = await initSubAgent(id, this.modelRuntime);
        slot.subs.set(id, session);
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
    mainSession: AgentSession,
    session: AgentSession,
    agentId: AgentId,
    input: string,
    isSub: boolean,
  ): Promise<string> {
    this.setActiveAgent(agentId, session);
    if (session === this.activeSession || this.isFrontSub(session)) {
      this.ttsStream.setVoice(agentId);
    }

    if (isSub) {
      // 子 Agent：复制所属主 session 全量群聊日志作为上下文（浅拷贝，元素引用共享）
      session.agent.state.messages = [...(mainSession.agent.state.messages as any[])];
    }

    const stateMessages = session.agent.state.messages as any[];
    const startLen = stateMessages.length;

    const promptText = isSub
      ? t(
          `（你是${getAgentLabel(agentId)}。现在轮到你发言——保持你自己的身份和语气，不要扮演或模仿其他角色。直接说台词，不要以「${getAgentLabel(agentId)}：」这类名字前缀开头。请简短发言。）`,
          `(You are ${getAgentLabel(agentId)}. It's your turn — stay in your own character and voice; do not play or mimic another character. Speak your line directly, without starting with a name prefix like "${getAgentLabel(agentId)}:". Speak briefly.)`,
        )
      : input;

    try {
      await session.prompt(promptText);
    } catch (err) {
      this.notice("error", t("错误：", "Error: ") + (err instanceof Error ? err.message : err));
      return "";
    }

    // 输出侧兜底：模型偶发模仿历史消息把「星野：」这类前缀写进台词，统一剥掉
    // （与 Repl.runOneAgent 同步；否则下轮 speaker 扩展会叠出双重前缀）
    for (const m of stateMessages.slice(startLen)) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === "text" && typeof b.text === "string" && b.text) {
          b.text = stripSpeakerPrefix(b.text, agentId);
        }
      }
    }

    const text = this.extractNewAssistantText(stateMessages, startLen);
    if (!text) return "";

    if (!isSub) {
      for (const m of stateMessages.slice(startLen)) {
        if (m.role === "assistant") m.speaker = agentId;
      }
    } else {
      (mainSession.agent.state.messages as any[]).push({
        role: "assistant",
        speaker: agentId,
        content: [{ type: "text", text }],
      });
    }
    return text;
  }

  async runRawTurn(input: string): Promise<void> {
    // 回合上下文整体局部化到槽位：回合进行中用户可切换会话/工作区，
    // 本回合在后台继续，结束时按槽位存盘（不再读写"当前会话"的易变状态）
    const turnSession = this.activeSession;
    const turnSlot = this.slotOf(turnSession);
    turnSlot.hasConversation = true;
    turnSlot.abortRequested = false;
    turnSlot.processing = true;
    this.turnStack.push(turnSlot);
    memory.markConversation();
    this.ttsStream.cancel();
    this.hidePetBubble();
    this.emit({ type: "ready", state: this.buildState() });
    await turnSlot.undo.beforeTurn();

    try {
      await this.ensureSubSessions(turnSession);

      // 记忆增量检测：MEMORY.md 运行时变更 → 追加到下一轮主 Agent 的 user 消息末尾
      const memoryDelta = memory.getMemoryDelta();
      const mainInput = memoryDelta ? `${input}\n\n${memoryDelta}` : input;

      await this.runOneAgent(turnSession, turnSession, getMainAgent(), mainInput, false);
      if (turnSlot.abortRequested) return;
      await this.waitTurnSettled(getMainAgent());
      if (turnSlot.abortRequested) return;

      const subs = turnSlot.subs;
      for (const subId of getSubAgents()) {
        const subSession = subs.get(subId);
        if (!subSession) continue;
        await this.runOneAgent(turnSession, subSession, subId, input, true);
        if (turnSlot.abortRequested) return;
        await this.waitTurnSettled(subId);
        if (turnSlot.abortRequested) return;
      }

      this.setActiveAgent(getMainAgent(), turnSession);
    } catch (err) {
      this.notice("error", t("错误：", "Error: ") + (err instanceof Error ? err.message : err));
    } finally {
      try {
        await turnSlot.undo.afterTurn();
      } catch (err) {
        this.notice("warn", t(`撤销快照记录失败：${err instanceof Error ? err.message : err}`, `Failed to record undo snapshot: ${err instanceof Error ? err.message : err}`));
      }
      turnSlot.processing = false;
      this.turnEnded = true;
      this.turnStack = this.turnStack.filter((s) => s !== turnSlot);
      // 每回合结束自动存盘（静默；resume 会话覆盖原文件）——前台后台一视同仁，并刷新侧栏
      this.saveSlot(turnSlot, turnSession);
      this.pushSessions();
      if (turnSession === this.activeSession) {
        if (!this.ttsStream.isPending) {
          pet.reset();
          this.scheduleBubbleHide();
        }
      }
      this.emit({ type: "ready", state: this.buildState() });
    }
  }

  // ============================================================
  // 中断 / STT / 退出
  // ============================================================

  abort(): void {
    const slot = this.activeSlot;
    if (!slot.processing) return;
    this.activeSession.abort().catch(() => {});
    slot.abortRequested = true;
    slot.processing = false; // UI 立即恢复；runRawTurn 的 finally 兜底收尾
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
    if (this.activeSlot.processing) {
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

  async doExit(): Promise<void> {
    // 所有会话槽位落盘（前台保留「已保存」提示；后台/生成中的会话按各自工作区静默保存）
    const active = this.activeSlot;
    const activeHadPath = active.path !== null;
    for (const slot of this.slots.values()) {
      this.saveSlot(slot, slot.session, slot !== active);
    }
    if (!activeHadPath && active.path && active.hasConversation) {
      this.notice("success", t(`会话已保存`, "Session saved"));
    }
    this.ttsStream.shutdown();
    stopGptSovitsLocalServer();
    stopComputerUse();
    try {
      await disconnectAllMcp();
    } catch {
      // 清理失败不影响退出
    }
    stopPet();
    for (const slot of this.slots.values()) {
      try {
        slot.session.dispose();
      } catch {
        // 清理失败不影响退出
      }
      for (const subSession of slot.subs.values()) {
        try {
          subSession.dispose();
        } catch {
          // 子 session 清理失败不影响退出
        }
      }
    }
    this.emit({ type: "exiting" });
    this.onExit();
  }
}
