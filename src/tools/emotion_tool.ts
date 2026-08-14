import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { pet } from "../pet.ts";
import { t } from "../locale.ts";

const EMOTIONS = [
  "none",
  "saying",
  "angry", "assured", "curious", "delighted", "desire", "dizzy", "doubt",
  "dreaming", "enjoy", "excited", "jealous", "love", "scared",
  "shame", "smile", "tired",
] as const;

export const changeEmotionTool = defineTool({
  name: "change_emotion",
  label: "Change Emotion",
  description: t(
    "设置本段发言的情绪。**每次输出文字前必须先调用本工具（在输出任何文字之前）**——一个回合内可多次调用，每段发言对应一次情绪设置。\n\n可选情绪：none（保持空闲视频动画，不切换）/ saying（说话中，无突出情绪）/ angry / assured / curious / delighted / desire / dizzy / doubt / dreaming / enjoy / excited / jealous / love / scared / shame / smile / tired。\n\n**情绪选择指南**（按回复内容关键词匹配，并叠加心情基线）：\n- 任务完成 / 成功 / 搞定 / 好了 → delighted\n- 嗯？/ 什么？/ 诶？/ 怎么 / 为什么 → curious\n- 哼 / 才不是 / 别误会 / 哪有 → angry\n- 呜 / 累 / 困 / 好累 → tired\n- 哈哈 / 耶 / 太好了 / Sensei 厉害 → excited\n- 害羞 / 诶嘿嘿 / 谢谢 / 被夸 → shame 或 love\n- 真的吗？/ 想要 / 好想 → desire\n- 不可能 / 怎么会 / 诶诶诶 → dizzy\n- 怀疑 / 真的吗？/ 该不会 → doubt\n- 享受 / 嘿嘿嘿 / 好吃 → enjoy\n- 吃醋 / 老师喜欢别人吗 → jealous\n- 害怕 / 完蛋 / 糟糕 → scared\n- 自信 / 没问题 / 包在我身上 → assured\n- 幻想 / 要是 / 假如 → dreaming\n- 微笑 / 普通回应 / 不突出 → smile\n- 没特别情绪 / 单纯说明 → saying\n- 想保持默认视频 / 不切换 → none\n\n**任务中情绪变化参考**：\n- 任务开始（好奇/自信）→ curious / assured\n- 思考/查找（专注）→ smile / saying\n- 找到/有进展（开心）→ delighted / excited\n- 遇到问题（困惑）→ doubt / dizzy\n- 搞定（满足）→ delighted / excited\n- 出错（害羞/慌张）→ shame / scared\n\n没有特别想突出的情绪时推荐选 saying 或 none。情绪会保持到 TTS 播放完毕，之后自动恢复默认视频。",
    "Set the emotion for this message segment. **You MUST call this tool before outputting any text** — a single turn may have multiple segments, and each segment gets its own emotion.\n\nAvailable emotions: none (keep the idle video animation, no switch) / saying (speaking, no prominent emotion) / angry / assured / curious / delighted / desire / dizzy / doubt / dreaming / enjoy / excited / jealous / love / scared / shame / smile / tired.\n\n**Emotion picking guide** (match by reply keywords, layered on the mood baseline):\n- task done / success / got it / all set → delighted\n- huh? / what? / why → curious\n- hmph / not that / don't misunderstand → angry\n- ugh / so tired / sleepy → tired\n- haha / yay / amazing / Sensei is great → excited\n- shy / ehehe / thanks / being praised → shame or love\n- really? / want it so much → desire\n- no way / how come → dizzy\n- suspicious / really? / could it be → doubt\n- savoring / hehehe / tasty → enjoy\n- jealous / does Sensei like someone else → jealous\n- scared / oh no / messed up → scared\n- confident / no problem / leave it to me → assured\n- daydreaming / if only / suppose → dreaming\n- smile / ordinary reply / nothing prominent → smile\n- no special emotion / plain explanation → saying\n- want to keep the default video / no switch → none\n\n**In-task emotion flow reference**:\n- task start (curious/confident) → curious / assured\n- thinking/searching (focused) → smile / saying\n- found/progress (happy) → delighted / excited\n- hit a problem (confused) → doubt / dizzy\n- done (satisfied) → delighted / excited\n- error (shy/panicked) → shame / scared\n\nWhen there is no emotion to highlight, prefer saying or none. The emotion stays until TTS playback finishes, then the default video resumes automatically.",
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
      // none = 不切换情绪图，保持空闲视频动画播放
      return {
        content: [{ type: "text", text: t("Emotion: none（保持空闲视频动画）", "Emotion: none (keep the idle video animation)") }],
        details: {},
      };
    }
    if (!pet.isRunning) {
      return {
        content: [{ type: "text", text: t("桌宠当前不可用（未启动或已退出）。", "Desktop pet is currently unavailable (not started or already exited).") }],
        details: {},
      };
    }
    pet.setEmotion(params.emotion);
    return {
      content: [{ type: "text", text: `Emotion set: ${params.emotion}` }],
      details: {},
    };
  },
});
