import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { t } from "../locale.ts";

/**
 * keep_silent：角色本轮选择不发言（跳过自己的回复）。
 * execute 返回 `{ content: [], details: {}, terminate: true }` 让 agent loop 提前终止，
 * 不再产出后续文本。父级 Repl 在提取回复时发现空文本也不会追加消息。
 */
export const keepSilentTool = defineTool({
  name: "keep_silent",
  label: "Keep Silent",
  description: t(
    "本轮保持沉默，不输出任何文字。当老师的话不需要你回答、或你想把舞台留给其他角色时调用本工具；调用后本回合立即结束。",
    "Stay silent this turn and output no text. Call this when Sensei's message does not need a reply from you, or when you want to leave the stage to other characters; the turn ends immediately after calling it.",
  ),
  // 无参数：调用即沉默
  parameters: Type.Object({}),
  execute: async () => {
    return {
      content: [],
      details: {},
      terminate: true,
    };
  },
});