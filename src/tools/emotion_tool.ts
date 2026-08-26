import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { pet } from "../pet.ts";
import { t } from "../locale.ts";
import type { AgentId } from "../agent_registry.ts";

const EMOTIONS = [
  "none",
  "saying",
  "angry", "assured", "curious", "delighted", "desire", "dizzy", "doubt",
  "dreaming", "enjoy", "excited", "jealous", "love", "scared",
  "shame", "smile", "tired",
] as const;

/**
 * 按角色参数化的 change_emotion 工具。
 * 主 Agent 与子 Agent 各持一份，`pet.setEmotion(agentId, name)` 将情绪路由到对应桌宠窗口。
 */
export function makeChangeEmotionTool(agentId: AgentId) {
  return defineTool({
    name: "change_emotion",
    label: "Change Emotion",
    description: t(
      "设置本段发言的情绪。**每次输出文字前必须先调用本工具（在输出任何文字之前）**——一个回合内可多次调用，每段发言对应一次情绪设置。\n\n可选情绪：none（保持空闲待机动画）/ saying（说话中，无突出情绪）/ angry / assured / curious / delighted / desire / dizzy / doubt / dreaming / enjoy / excited / jealous / love / scared / shame / smile / tired（delighted 与 excited 为同一表情，二选一）。\n\n情绪可叠加心情基线（见系统提示「心情基线规则」）。没有突出情绪时选 saying 或 none；情绪会保持到 TTS 播放完毕，之后自动恢复默认待机动画。",
      "Set the emotion for this message segment. **You MUST call this tool before outputting any text** — a single turn may have multiple segments, and each segment gets its own emotion.\n\nAvailable emotions: none (keep the idle animation) / saying (speaking, no prominent emotion) / angry / assured / curious / delighted / desire / dizzy / doubt / dreaming / enjoy / excited / jealous / love / scared / shame / smile / tired (delighted and excited now map to the same expression).\n\nThe emotion can layer on the mood baseline (see the Mood Baseline Rules in the system prompt). Choose saying or none when nothing stands out; the emotion stays until TTS playback finishes, then the default idle animation resumes automatically.",
    ),
    parameters: Type.Object({
      emotion: Type.Unsafe<(typeof EMOTIONS)[number]>({
        type: "string",
        enum: [...EMOTIONS],
        description: t("本段发言的情绪，18 选 1；无特别情绪时选 none 或 saying", "Emotion for this segment, pick 1 of 18; choose none or saying when nothing stands out"),
      }),
    }),
    execute: async (_id, params) => {
      if (params.emotion === "none") {
        // none = 不切换情绪预设，保持空闲待机动画播放
        return {
          content: [{ type: "text", text: t("Emotion: none（保持空闲待机动画）", "Emotion: none (keep the idle animation)") }],
          details: {},
        };
      }
      if (!pet.isRunning) {
        return {
          content: [{ type: "text", text: t("桌宠当前不可用（未启动或已退出）。", "Desktop pet is currently unavailable (not started or already exited).") }],
          details: {},
        };
      }
      pet.setEmotion(agentId, params.emotion);
      return {
        content: [{ type: "text", text: `Emotion set: ${params.emotion}` }],
        details: {},
      };
    },
  });
}