import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { listen } from "../voice.ts";

/**
 * 语音相关 Tool 集合。
 *
 * 设计原则：TTS 完全由程序在 Agent 回复时自动触发（renderer text_delta → TtsStream 实时流式），
 * 语气风格由 TTS 引擎自身决定，无需 Tool 介入。
 * STT 在用户长按右 Cmd ≥2秒时自动 listen（见 repl.ts），也无需 Tool 介入。
 *
 * 保留 transcribe Tool 仅作为手动触发 STT 的兜底入口（auto STT 关时仍可工作）。
 */
export const transcribeTool = defineTool({
  name: "transcribe",
  label: "Listen",
  description: "Listen to the user's microphone and transcribe speech to text. Use this when you want to hear from the user verbally.",
  parameters: Type.Object({}),
  execute: async (_id, _params) => {
    const text = await listen();
    return {
      content: [{ type: "text", text: text || "(no speech detected)" }],
      details: {},
    };
  },
});

export const voiceTools = [transcribeTool];
