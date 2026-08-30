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
import { getAgentLabel, getAgentNameVariants, type AgentId } from "./agent_registry.ts";

/** speaker 是项目自定义字段（repl.ts 回填时标记），不在 SDK 的 AgentMessage 类型上。 */
interface SpeakerMessage {
  role: "assistant";
  speaker?: string;
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
}

// ---- 输出侧「名字：」前缀剥离 -------------------------------------------
// 群聊历史在发送边界带「角色名：」前缀（下方扩展），模型偶发模仿该格式把
// 「星野：」这类前缀写进自己的台词。前缀由 UI/TTS 自行标注（speakerLabel），
// 模型再写一遍就会显示/朗读两遍。输出侧统一剥掉，三层生效：
//   1) 流式：SpeakerPrefixStripper 处理 text_delta（终端 renderer / GUI 转发）；
//   2) 状态：runOneAgent 结束后改写 assistant 文本块（回填/存档/后续上下文干净，
//      否则 speaker 扩展下轮会再叠一层，出现「小鸟游星野：星野：…」双重前缀）；
//   3) 提示词：buildSubSystemPrompt 明确禁止（见 agent.ts）。

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 剥掉文本开头「角色名＋冒号」前缀（长名优先，短名「星野：」不残留）；无前缀原样返回。 */
export function stripSpeakerPrefix(text: string, agentId: AgentId): string {
  if (!text) return text;
  const names = [...getAgentNameVariants(agentId)].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const m = text.match(new RegExp(`^${escapeRegExp(name)}\\s*[：:]`));
    if (m) return text.slice(m[0].length).replace(/^[ \t\u3000]+/, "");
  }
  return text;
}

/**
 * 流式前缀剥离器：逐段喂 text_delta，返回可安全输出的增量。
 * 前缀可能横跨多个 delta（"名字"与"冒号"分两段到达），开头先扣留缓冲：
 * 仍是某候选前缀的前缀则继续等；一旦完整匹配则消费前缀、放行余文（余文为空时
 * 后续增量直通）；确认不匹配或 message 结束时 flush 放行全部扣留内容。
 */
export class SpeakerPrefixStripper {
  private buf = "";
  private done = false;

  constructor(private agentId: AgentId) {}

  push(delta: string): string {
    if (this.done) return delta;
    this.buf += delta;
    // 长名优先；覆盖全/半角冒号及「名字 冒号」间的一个空格
    const names = [...getAgentNameVariants(this.agentId)].sort((a, b) => b.length - a.length);
    const candidates = names.flatMap((n) => [`${n}：`, `${n}:`, `${n} ：`, `${n} :`]);
    for (const c of candidates) {
      if (this.buf.startsWith(c)) {
        this.done = true;
        const rest = this.buf.slice(c.length).replace(/^[ \t\u3000]+/, "");
        this.buf = "";
        return rest;
      }
      if (c.startsWith(this.buf)) return ""; // 还差几个字，继续扣留
    }
    this.done = true;
    const out = this.buf;
    this.buf = "";
    return out;
  }

  /** message 结束时调用：放行仍被扣留的内容（无前缀的短回复可能整段被扣留）。 */
  flush(): string {
    const out = this.done ? "" : this.buf;
    this.buf = "";
    this.done = true;
    return out;
  }
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
