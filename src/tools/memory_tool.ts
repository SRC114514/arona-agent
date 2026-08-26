import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { appendToMemory } from "../memory.ts";
import { t } from "../locale.ts";

export const saveMemoryTool = defineTool({
  name: "save_memory",
  label: "Save Memory",
  description: t(
    "将重要信息写入持久记忆（~/.arona/MEMORY.md），跨会话保留。\n\n**推荐 category**：\n- `老师` — 关于老师的硬事实（时区、设备、常用项目、身份背景）\n- `小习惯` — 工作/工具偏好（\"写 Rust 喜欢先看 lifetime\"、\"不喜欢 commit 时自动 push\"）\n- `我们之间` — 互动记忆、心情基线、共同事件\n\n写入格式：\\n## [${category}]\\n_${ISO timestamp}_\\n${content}\\n\n不确定分类时可省略 category。不主动迁移旧数据。",
    "Write important information to persistent memory (~/.arona/MEMORY.md), kept across sessions.\n\n**Recommended categories**:\n- `Teacher` — hard facts about Sensei (timezone, devices, usual projects, background)\n- `Habits` — work/tool preferences (\"likes to check lifetimes first when writing Rust\", \"dislikes auto-push on commit\")\n- `Us` — interaction memories, mood baseline, shared events\n\nWrite format: \\n## [${category}]\\n_${ISO timestamp}_\\n${content}\\n\nYou may omit category when unsure. Do not proactively migrate old data.",
  ),
  parameters: Type.Object({
    content: Type.String({ description: "The information to save to memory" }),
    category: Type.Optional(Type.String({ description: t("记忆条目分类标签。推荐：'老师' | '小习惯' | '我们之间'", "Category label for the memory entry. Recommended: 'Teacher' | 'Habits' | 'Us'") })),
  }),
  execute: async (_id, params) => {
    appendToMemory(params.content, params.category);
    return {
      content: [{ type: "text", text: `Saved to memory${params.category ? ` [${params.category}]` : ""}.` }],
      details: {},
    };
  },
});
