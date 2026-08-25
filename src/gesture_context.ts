// 桌宠手势上下文注入扩展：摸头/dizzy 触发后，在**主 Agent** 的发送边界（context 事件）
// 追加一条 user 消息，描述"刚才发生了什么"，引导主 Agent 在回复中自然流露出确实感受到了。
//
// 为什么用发送边界而不是拼进用户输入：repl.ts 的 processInput 会把文本写进主 session 的
// state.messages，会污染会话命名/存储；拼进输入仍可能被主 session 落盘/导出，且子 Agent 每轮
// 复制主 session 全量（stateless）时会一并看到。发送边界注入只改本次请求的消息数组、不进
// state.messages → 仅主 Agent 本轮看到、零存储污染、会话命名天然干净。
//
// 只注册在**主 Agent** 的 loader 扩展列表（agent.ts initAgent），子 Agent（initSubAgent）
// 的 loader 不含本扩展 → 不会收到。消费经 pet.takeGesture()（消费即清空，只注入最近一次）。

import type { ContextEvent, ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { pet } from "./pet.ts";
import { t } from "./locale.ts";

/** 桌宠手势 → user 消息的上下文场景文本（双语）。 */
function petGestureScene(type: "pat" | "dizzy"): string {
  if (type === "dizzy") {
    return t(
      "（Sensei刚才拖着你到处晃来晃去，你感觉有些头晕。请在回复里自然地体现出这份晕眩感。）",
      "(Sensei just swung you around, and you feel a bit dizzy. Let that dizziness show naturally in your reply.)",
    );
  }
  return t(
    "（Sensei刚才摸了摸你的头。请在回复里自然地体现出被摸头的感受。）",
    "(Sensei just petted your head. Let that show naturally in your reply.)",
  );
}

export const gestureContextExtension: InlineExtension = {
  name: "arona-gesture-context",
  hidden: true, // 不显示在启动扩展列表
  factory: (pi: ExtensionAPI) => {
    pi.on("context", (event: ContextEvent) => {
      // 有手势时才注入；takeGesture 消费即清空 → 一次 LLM 调用只注入一次、无手势时原样返回
      const gesture = pet.takeGesture();
      if (!gesture) return;
      const scene = petGestureScene(gesture);
      if (!scene) return;
      return {
        messages: [
          ...event.messages,
          { role: "user" as const, content: [{ type: "text" as const, text: scene }], timestamp: Date.now() },
        ],
      };
    });
  },
};