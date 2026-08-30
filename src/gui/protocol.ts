// GUI 行协议（backend Node 父进程 ↔ Electron 窗口子进程）。
// 双向 JSON 行，前缀 ###GUI### 过滤 Electron 自身 stdout 噪音（与桌宠 ###PET### 同模式）。

export const GUI_PROTOCOL_PREFIX = "###GUI###";

// ============================================================
// backend → gui
// ============================================================
export type GuiEvent =
  // 页面切换：setup（首次运行图形化向导）/ main（主界面）
  | { type: "mode"; mode: "setup" | "main" }
  // 启动就绪：附当前状态（模型/角色/开关）
  | { type: "ready"; state: GuiState }
  // AgentSession 事件转发（renderer 消费的同款事件 + 当前发言角色）
  | { type: "agent_event"; agentId: string; event: Record<string, unknown> }
  // 命令/操作反馈文本
  | { type: "notice"; level: "info" | "warn" | "error" | "success"; text: string }
  // 会话列表（侧栏数据源；currentPath=当前恢复会话，用于高亮）
  | { type: "sessions"; currentPath: string | null; sessions: Array<{ path: string; preview: string; timestamp: string; model: string }> }
  // 技能列表（/skill 弹窗数据）
  | { type: "skills"; skills: Array<{ name: string; description: string }> }
  // STT 结果（空串=未识别到语音）与录音状态
  | { type: "stt_result"; text: string }
  | { type: "stt_state"; recording: boolean }
  // resume 回放：历史消息数组（renderSavedMessages 同构）
  | { type: "history"; messages: unknown[] }
  // resume 回放：编码子代理执行过程（与 history 中 create_subagent 的 toolCallId 关联；不进主 Agent 上下文）
  | { type: "coding_runs"; runs: Array<{ agent: string; toolCallId: string; task: string; timestamp: string; messages: unknown[] }> }
  // change-agent 弹窗数据
  | { type: "agents"; main: string[]; subs: string[]; currentMain: string; currentSubs: string[] }
  // /mcp 面板数据
  | { type: "mcp_servers"; servers: Array<{ name: string; tools: string[] }> }
  // setup 阶段进度（pip/依赖安装/克隆日志行）
  | { type: "setup_log"; step: string; line: string }
  // setup 单个角色克隆进度
  | { type: "setup_clone_progress"; agent: string; status: "cloning" | "done" | "failed"; message?: string }
  // setup 完成信号（配置已写盘，前端切换到主界面）
  | { type: "setup_done" }
  // setup 失败信号（未写盘；前端解除提交锁定，允许修正后重试）
  | { type: "setup_failed" }
  // setup 页数据：可配置音色的角色列表
  | { type: "setup_info"; agents: Array<{ id: string; label: string }> }
  // 斜杠命令清单（菜单与帮助面板数据源，单一事实源 slash_registry.ts）
  | { type: "commands"; commands: Array<{ name: string; aliases: string[]; description: string; interactive?: boolean; needsParams?: boolean }> }
  // 退出前通知（前端可不等）
  | { type: "exiting" };

/** ready 附带的运行状态快照。 */
export interface GuiState {
  model: string;
  mainAgent: string;
  mainAgentLabel: string;
  subAgents: string[];
  ttsEnabled: boolean;
  sttEnabled: boolean;
  noVoice: boolean;
  processing: boolean;
  recording: boolean;
  /** 当前恢复中的会话文件路径（null=新会话），侧栏高亮用。 */
  currentSessionPath: string | null;
}

// ============================================================
// gui → backend
// ============================================================
export type GuiRequest =
  // 用户消息（@file/!shell 由 backend 展开）
  | { type: "input"; text: string }
  // 斜杠命令（name 不含 "/"）
  | { type: "command"; name: string; args?: string }
  // 中断当前任务
  | { type: "abort" }
  // 麦克风按钮
  | { type: "stt_start" }
  | { type: "stt_stop" }
  // 列表数据请求
  | { type: "list_sessions" }
  | { type: "list_skills" }
  | { type: "list_agents" }
  | { type: "list_mcp" }
  // 恢复会话
  | { type: "resume_session"; path: string }
  // 侧栏会话管理（右键菜单）
  | { type: "delete_session"; path: string }
  | { type: "rename_session"; path: string; title: string }
  // 调用技能
  | { type: "invoke_skill"; name: string }
  // 切换角色
  | { type: "change_agent"; main: string; subs: string[] }
  // MCP 工具调用
  | { type: "mcp_call"; server: string; tool: string; args: Record<string, unknown> }
  // setup 表单提交
  | { type: "setup_submit"; form: Record<string, unknown> }
  // 退出
  | { type: "exit" };

/** 把一行 stdout 文本解析为协议消息（非协议行返回 null）。 */
export function parseGuiLine(line: string): GuiRequest | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(GUI_PROTOCOL_PREFIX)) return null;
  try {
    return JSON.parse(trimmed.slice(GUI_PROTOCOL_PREFIX.length)) as GuiRequest;
  } catch {
    return null;
  }
}

/** 把协议消息序列化为一行协议文本（含前缀与换行）。 */
export function formatGuiLine(msg: GuiEvent | GuiRequest): string {
  return GUI_PROTOCOL_PREFIX + JSON.stringify(msg) + "\n";
}
