// 群聊发言者标注扩展：每次 LLM 调用前（context 事件）触发，给带 speaker 标记的
// assistant 历史消息文本加上「角色名：」前缀，让模型能区分"哪句话是谁说的"。
//
// 为什么需要它：SDK 序列化请求时只取 role + content（pi-ai convertMessages），
// 项目自定义的 speaker 字段不会发给模型 —— 必须把发言者编码进文本才能让模型区分。
//
// 关键性质：只作用于发送边界。扩展返回新数组（不改 state.messages），
// 因此存储 / 渲染 / TTS / 会话存档全部保持纯文本，前缀零污染。
// 当前正在生成的 assistant 回复没有 speaker，不会被加前缀（模型知道自己说什么）。

import type { ContextEvent, ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getAgentLabel, type AgentId } from "./agent_registry.ts";

/** speaker 是项目自定义字段（repl.ts 回填时标记），不在 SDK 的 AgentMessage 类型上。 */
interface SpeakerMessage {
  role: "assistant";
  speaker?: string;
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
}

export const speakerContextExtension: InlineExtension = {
  name: "arona-speaker-context",
  hidden: true, // 不显示在启动扩展列表
  factory: (pi: ExtensionAPI) => {
    pi.on("context", (event: ContextEvent) => {
      const messages = event.messages.map((m) => {
        const speaker = (m as unknown as SpeakerMessage).speaker;
        if (m.role !== "assistant" || !speaker || !Array.isArray(m.content)) return m;
        const label = getAgentLabel(speaker as AgentId);
        if (!label) return m;
        return {
          ...m,
          content: m.content.map((b) =>
            b.type === "text" && b.text?.trim() ? { ...b, text: `${label}：${b.text}` } : b,
          ),
        };
      });
      return { messages };
    });
  },
};
