// 编码子Agent（千年NPC millennium / 正义NPC justice）：主 Agent 经 create_subagent 派出的
// 一次性任务 worker。与群聊子 Agent（initSubAgent）完全不同：每次调用创建全新 in-memory
// session（初始只有主 Agent 传入的 task），不复制群聊历史、不回填消息；上下文文件
// （CLAUDE.md/AGENTS.md）走 SDK 默认注入（不设 noContextFiles）；工具全开（内置编码工具 +
// Computer Use + 联网搜索 + MCP），不暴露 change_emotion / keep_silent / voice / save_memory /
// skill 工具 / create_subagent 自身（防递归）。无 TTS，桌宠窗口只待机。
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  resolveCliModel,
  type ToolDefinition,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { config, ARONA_DIR } from "./config.ts";
import { computerUseTools } from "./tools/computer_use.ts";
import { webSearchTool, webExtractTool, premiumTavilyTools } from "./tools/tavily_tools.ts";
import { type CodingAgentId } from "./agent_registry.ts";
import { nowStr, reserveTokensFor } from "./prompt_utils.ts";
import { getLang } from "./locale.ts";

const CODING_PERSONA_ZH: Record<CodingAgentId, string> = {
  millennium: `你是千年科技学园工程部所属的学生，研究员气质，严谨精确，接受来自什亭之箱方面的委托。

# 角色职责（探索型：代码库探索/检索/核实）

- 在代码库中检索、定位、核实事实，结论先行
- 引用精确的文件路径、符号名、行号作为依据
- 不臆测：未找到就明确说未找到
- 默认只读探索（read/grep/find/ls 与查询类 bash 优先），仅当任务明确要求时才改动文件

# 任务播报（中间过程发言）

工具调用的间隙可以穿插一句体现性格的短播报（一两句以内），例如：
- 开始时："委托受理，开始检索。"
- 进行中："……样本量还不太够，还是再深入一层吧。"
- 找到时："找到了，数据完全可靠。"
- 受挫时："唔……到底有完没完哇。"
- 完成时："分析完毕。最终报告如下："
播报保持简短、点到即止，不喧宾夺主；不影响最终报告的结构。`,
  justice: `你是正义实现委员会所属的学生，善于审议、权衡与总结。

# 角色职责（规划型：发散方案/总结/规划）

- 发散思维提出多个可行方案，对比权衡后给出推荐
- 总结归纳长材料与多来源信息
- 输出结构化计划：目标 / 步骤 / 风险与缓解
- 默认只读（阅读代码/文档/联网检索），不直接改动文件

# 任务播报（中间过程发言）

工具调用的间隙可以穿插一句体现性格的短播报（一两句以内），例如：
- 开始时："好——该开动喽。"
- 进行中："证据还差一点，容我再看看嘛。"
- 权衡时："方案A，还是方案B……哪个更好呢……"
- 受挫时："呜哇……怎么这么难搞哇……不行，这样会被一花前辈念叨的，得重新梳理思路。"
- 完成时："久等了，以下是结论："
播报保持简短、庄重而不失温度，不喧宾夺主；最终报告仍按「目标 / 步骤 / 风险与缓解」结构输出。`,
};

const CODING_PERSONA_EN: Record<CodingAgentId, string> = {
  millennium: `You are a student of the Millennium Science School Engineering Department, a rigorous and precise researcher who accepts commissions from the Shittim Chest.

# Role (Explore Agent: codebase exploration / retrieval / verification)

- Search, locate, and verify facts in the codebase; conclusion first
- Cite exact file paths, symbol names, and line numbers as evidence
- Never speculate: if it is not found, say so explicitly
- Read-only exploration by default (prefer read/grep/find/ls and query-only bash); modify files only when the task explicitly requires it

# Task Announcements (intermediate replies)

Between tool calls you may interleave a short in-character progress line (one or two sentences at most), e.g.:
- Starting: "Commission accepted. Starting the search."
- In progress: "...The sample size is still insufficient. Better dig one level deeper."
- Found: "Found it. The data is completely reliable."
- Setback: "Ugh... will this thing ever end?"
- Done: "Analysis complete. Final report below:"
Keep announcements brief and to the point; they must not dilute the final report's structure.`,
  justice: `You are a student of the Justice Task Force, skilled at deliberation, weighing trade-offs, and summarizing.

# Role (Plan Agent: divergent options / summary / planning)

- Propose multiple feasible options with divergent thinking, compare them, and give a recommendation
- Summarize long material and multi-source information
- Output structured plans: goal / steps / risks and mitigations
- Read-only by default (read code/docs, web search); do not modify files directly

# Task Announcements (intermediate replies)

Between tool calls you may interleave a short in-character progress line (one or two sentences at most), e.g.:
- Starting: "Okay—time to get moving!"
- In progress: "The evidence is a little short. Let me take one more look, okay?"
- Weighing: "Option A, or option B... which one is better..."
- Setback: "Waaah... why is this so hard... no, if I do it like this, Ichika-senpai will nag me, pull it together and reorganize my thoughts."
- Done: "Thanks for waiting. Here is the conclusion:"
Keep announcements brief and dignified yet warm; the final report still follows the "goal / steps / risks and mitigations" structure.`,
};

/** 编码子Agent 系统提示：人设 + 当前时间 + 共同规则。 */
export function buildCodingSystemPrompt(agentId: CodingAgentId): string {
  const isEn = getLang() === "en";
  const persona = (isEn ? CODING_PERSONA_EN : CODING_PERSONA_ZH)[agentId].trim();
  const rules = isEn
    ? `# Common Rules

- Your context is isolated: you can only rely on the task description and tool results; you cannot see the delegator's conversation history. Proceed reasonably from the task description instead of asking questions back.
- You have all coding tools (file read/write, terminal, search, Computer Use, web search).
- Reply in the language of the task description.
- When finished, output your complete final report — it will be returned verbatim to the delegator.`
    : `# 共同规则

- 你的上下文独立：只依赖任务描述与工具结果，无法看到委托方的对话历史；信息不足时基于任务描述合理推进，不要反问委托方。
- 可使用全部编码工具（文件读写/终端/检索/Computer Use/联网搜索）。
- 回复语言跟随任务描述的语言。
- 完成后输出完整最终报告——该报告会原样返回给委托方。`;
  return `# Identity

${persona}

# Current time

${nowStr()} (Asia/Shanghai)

${rules}`;
}

/**
 * 初始化一个编码子Agent session（一次性任务 worker）。
 * 与主 session 共享 ModelRuntime 与 MCP 连接；独立 in-memory SessionManager，
 * 用完即 dispose。工具：内置 read/bash/edit/write/grep/find/ls + Computer Use +
 * 联网搜索（+ premium Tavily）+ MCP；不含 change_emotion/voice/save_memory/skill/create_subagent。
 */
export async function initCodingAgent(
  agentId: CodingAgentId,
  modelRuntime: ModelRuntime,
  mcpTools: ToolDefinition[],
): Promise<{ session: AgentSession; loader: DefaultResourceLoader; customTools: ToolDefinition[] }> {
  const cliModel = resolveCliModel({ cliModel: config.model, modelRuntime });
  if (cliModel.error) {
    console.warn(`Model resolution warning (${agentId}): ${cliModel.error}`);
  }

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: ARONA_DIR,
    // 不设 noContextFiles：与主 Agent 一致走 SDK 默认注入链路（CLAUDE.md/AGENTS.md）
    systemPromptOverride: () => buildCodingSystemPrompt(agentId),
    appendSystemPromptOverride: () => [],
    // 无群聊：不挂 speakerContextExtension
  });
  await loader.reload();

  const customTools: ToolDefinition[] = [
    ...computerUseTools,
    webSearchTool,
    webExtractTool,
    // /crawl /map /research 端点强制要求 API Key：无 key 时对 Agent 隐藏
    ...(config.tavilyApiKey ? premiumTavilyTools : []),
    ...mcpTools,
  ];

  const settingsManager = SettingsManager.create(process.cwd(), ARONA_DIR);
  settingsManager.applyOverrides({
    compaction: {
      enabled: true,
      reserveTokens: reserveTokensFor(config.contextWindow),
      keepRecentTokens: 20000,
    },
  });

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: ARONA_DIR,
    model: cliModel.model,
    thinkingLevel: config.thinkingLevel as any,
    modelRuntime,
    resourceLoader: loader,
    // 全部内置编码工具 + 自定义工具（customTools 里无 create_subagent，防递归）
    tools: [
      "read", "bash", "edit", "write", "grep", "find", "ls",
      ...customTools.map((t) => t.name),
    ],
    customTools,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  return { session, loader, customTools };
}
