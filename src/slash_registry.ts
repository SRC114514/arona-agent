/**
 * Slash command registry shared by the completion menu and the dispatcher.
 *
 * Each command has a primary name, optional aliases, and a Chinese description
 * shown in the menu. Add new commands here and they'll automatically appear
 * in the / menu AND be dispatchable by /name or /alias.
 */

import { t } from "./locale.ts";

export interface SlashCommandSpec {
  name: string;
  aliases?: string[];
  description: string;
  // When true, the command takes over the line (e.g. /resume opens an
  // interactive picker that uses raw-mode keypresses). The menu should
  // not auto-append a space after these commands.
  interactive?: boolean;
  // When true, Enter in the menu fills the command into the input line
  // WITHOUT executing it, so the user can type the required argument
  // and press Enter again. Set for every argument-taking command.
  needsParams?: boolean;
}

export const SLASH_COMMANDS: SlashCommandSpec[] = [
  { name: "help", aliases: ["?"], description: t("显示命令列表", "Show command list") },
  { name: "exit", aliases: ["quit", "q"], description: t("退出（仅在有实际对话时保存会话）", "Exit (saves session only after a real conversation)") },
  { name: "new", aliases: ["clear"], description: t("开始新会话（清空上下文）", "Start a new session (clear context)") },
  { name: "resume", aliases: ["r"], description: t("上下键选择并恢复一个已保存的会话", "Pick and resume a saved session with arrow keys"), interactive: true },
  { name: "export", description: t("导出当前会话为 Markdown", "Export current session as Markdown") },
  { name: "thinking", description: t("开关思考/推理块显示", "Toggle thinking/reasoning block display") },
  { name: "details", description: t("开关工具执行详情显示", "Toggle tool execution detail display") },
  { name: "compact", description: t("压缩当前上下文以节省 token", "Compact current context to save tokens") },
  { name: "tts", description: t("开关文字转语音", "Toggle text-to-speech") },
  { name: "stt", description: t("开关语音转文字（长按右 Cmd ≥2秒录音）", "Toggle speech-to-text (hold right Cmd ≥2s to record)") },
  { name: "skill", description: t("调用技能（/skill <名称>）", "Invoke a skill (/skill <name>)") },
  { name: "mcp", description: t("管理 MCP 服务器和工具", "Manage MCP servers and tools") },
  { name: "change-agent", description: t("切换主 Agent + 多选子 Agent", "Switch main agent + multi-select sub agents"), interactive: true },
  { name: "undo", description: t("撤销上一个回合的全部文件改动（本地快照）", "Undo the previous turn's file changes (local snapshot)") },
  { name: "redo", description: t("重做已撤销的改动", "Redo undone changes") },
];

/**
 * Resolve a typed command (without leading `/`) to its spec. Matches against
 * the primary name and any alias. Returns null if not found.
 */
export function resolveSlashCommand(typed: string): SlashCommandSpec | null {
  for (const spec of SLASH_COMMANDS) {
    if (spec.name === typed) return spec;
    if (spec.aliases?.includes(typed)) return spec;
  }
  return null;
}
