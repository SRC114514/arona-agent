import chalk from "chalk";
import { Type } from "typebox";
import { defineTool, type ModelRuntime, type ToolDefinition, type AgentSession } from "@earendil-works/pi-coding-agent";
import { t } from "../locale.ts";
import { pet } from "../pet.ts";
import { getAgentLabel, type CodingAgentId } from "../agent_registry.ts";
import { initCodingAgent } from "../coding_agent.ts";
import { createRenderer, type RendererStyle } from "../renderer.ts";
import { recordCodingRun, emitCodingEvent } from "../coding_process.ts";

// 终端配色与主/群聊子 Agent（magenta）区分，且不用灰/黑：millennium = blue，justice = yellow
const CODING_AGENT_STYLE: Record<CodingAgentId, RendererStyle> = {
  millennium: { speaker: (s) => chalk.blue.bold(s), thinking: (s) => chalk.blue(s), tool: (s) => chalk.blue(s) },
  justice: { speaker: (s) => chalk.yellow.bold(s), thinking: (s) => chalk.yellow(s), tool: (s) => chalk.yellow(s) },
};

/**
 * 从编码子Agent session 的全部消息中提取最后一个 assistant 纯文本段作为最终报告
 * （复用 repl.extractNewAssistantText 的思路；session 为一次性 in-memory，全量扫描即可）。
 */
function extractFinalReport(stateMessages: any[]): string {
  const texts: string[] = [];
  for (const m of stateMessages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const text = m.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text || "")
      .join("");
    if (text.trim()) texts.push(text);
  }
  return texts.length ? texts[texts.length - 1].trim() : "";
}

/**
 * create_subagent：主 Agent 派出编码子Agent（millennium=探索 / justice=规划）执行任务，
 * 流式渲染其终端输出（专用配色），取回其最终报告作为工具结果。
 * 桌宠侧：任务期间临时 spawn 对应 NPC 窗口（只待机，无 change_emotion），完成即关。
 */
export function makeCreateSubagentTool(modelRuntime: ModelRuntime, mcpTools: ToolDefinition[]) {
  return defineTool({
    name: "create_subagent",
    label: "Create Subagent",
    description: t(
      "派出编码子Agent执行任务并返回其最终报告。agent：millennium=代码库探索/检索（默认）；justice=发散方案/总结/规划。task 须自包含（编码子Agent上下文独立，只能看到 task）。",
      "Dispatch a coding sub-agent to run a task and return its final report. agent: millennium=codebase exploration/retrieval (default); justice=divergent options/summary/planning. task must be self-contained (the sub-agent has an isolated context and only sees task).",
    ),
    parameters: Type.Object({
      task: Type.String({ description: t("任务描述（自包含）", "Task description (self-contained)") }),
      agent: Type.Optional(
        Type.Union([Type.Literal("millennium"), Type.Literal("justice")], {
          description: t("编码子Agent，缺省 millennium", "Coding sub-agent; defaults to millennium"),
        }),
      ),
    }),
    execute: async (toolCallId, params) => {
      const agentId: CodingAgentId = params.agent ?? "millennium";
      const style = CODING_AGENT_STYLE[agentId];
      const label = getAgentLabel(agentId);
      process.stdout.write(style.speaker(t(`${label} 开始任务`, `${label} starts the task`) + "\n"));

      if (pet.isRunning) pet.spawnAgent(agentId);

      let unsub: (() => void) | null = null;
      let session: AgentSession | null = null;
      try {
        const inited = await initCodingAgent(agentId, modelRuntime, mcpTools);
        session = inited.session;

        if (process.env.ARONA_GUI === "1") {
          // GUI：事件实时转发前端渲染（stdout renderer 会把过程打进启动 GUI 的终端）
          unsub = session.subscribe((event) => emitCodingEvent(agentId, event));
        } else {
          // CLI：终端流式渲染（专用配色）
          const renderer = createRenderer(undefined, undefined, label, style);
          unsub = renderer.subscribe(session);
        }

        await session.prompt(params.task);

        const report = extractFinalReport(session.agent.state.messages as any[]);

        // 过程留痕：子代理 session 全量消息快照交给 sink（GUI 落盘 sidecar；CLI 无 sink 直接丢弃）
        recordCodingRun({
          agent: agentId,
          toolCallId,
          task: params.task,
          timestamp: new Date().toISOString(),
          messages: session.agent.state.messages as any[],
        });

        return {
          content: [{
            type: "text",
            text: report || t("（编码子Agent未产出文本报告）", "(the coding sub-agent produced no text report)"),
          }],
          details: {},
        };
      } finally {
        unsub?.();
        session?.dispose();
        if (pet.isRunning) pet.closeAgent(agentId);
      }
    },
  });
}
