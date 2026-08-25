import chalk from "chalk";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import type { AgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { config, sttHotkeyLabel } from "./config.ts";
import * as memory from "./memory.ts";
import * as voice from "./voice.ts";
import * as mcp from "./mcp.ts";
import * as skills from "./skills.ts";
import { setShowThinking, getShowThinking, setShowToolDetails, getShowToolDetails } from "./renderer.ts";
import { resolveSlashCommand } from "./slash_registry.ts";
import { MAIN_AGENT_IDS, SUB_AGENT_IDS, getMainAgent, getSubAgents, getAgentLabel, setMainAgent, setSubAgents, type MainAgentId, type SubAgentId, type AgentId } from "./agent_registry.ts";
import { pet } from "./pet.ts";
import type { UndoManager } from "./undo.ts";
import { t } from "./locale.ts";

export interface CommandContext {
  session: AgentSession;
  loader?: DefaultResourceLoader;
  exit: () => void;
  newSession: () => Promise<void>;
  resumeSession: (path: string) => void;
  // 保存当前会话（resume 会话覆盖原文件；新会话仅当有有效对话时才另存）。
  // 与 Repl 退出时的保存语义一致；/change-agent 在重建会话前调用，避免对话丢失。
  saveCurrentSession: () => void;
  // 走完整 Agent 回合生命周期（undo/isProcessing/pet.reset/abort），但不展开 @文件 / !命令。
  // /skill 调用技能时使用，避免技能内容里的 @ / ! 被当作输入展开。
  runAgentTurn: (text: string) => Promise<void>;
  // 暂停/恢复斜杠菜单的 keypress 监听器。交互式命令（如 /resume）接管
  // 输入期间需暂停，否则上下键会被菜单监听器捕获并画菜单。
  pauseMenuListener?: () => void;
  resumeMenuListener?: () => void;
  // /stt 切换时启停全局热键监听（pynput）
  setSttHookEnabled?: (enabled: boolean) => void;
  // /undo /redo 撤销/重做管理器（本地快照,不依赖 git）
  undoManager?: UndoManager;
  // /change-agent 切换角色后重启 TTS 进程（音色随主 Agent，spawn 时固化，需重拉）
  restartTts?: () => void;
  // /change-agent 只改子 Agent 组合时回收旧子 session 对象，下轮按新组合重新初始化
  resetSubAgents?: () => void;
}

const HELP_TEXT = t(
  `${chalk.bold.cyan("ARONA Agent - 命令列表")}

${chalk.bold("会话")}
  /new, /clear     开始新会话（清空上下文）
  /resume          上下键选择并恢复一个已保存的会话
  /exit            退出
  /export          导出当前会话为 Markdown

${chalk.bold("显示")}
  /thinking        开关推理块显示
  /details         开关工具执行详情显示
  /compact         压缩上下文

${chalk.bold("语音")}
  /tts             开关文字转语音
  /stt             开关语音转文字

${chalk.bold("扩展")}
  /skill           列出或调用技能（/skill <名称>）
  /mcp             列出 MCP 服务器和工具

${chalk.bold("其他")}
  /change-agent    切换主 Agent + 多选子 Agent
  /undo            撤销上一个回合的全部文件改动
  /redo            重做已撤销的改动
  /help            显示本帮助
`,
  `${chalk.bold.cyan("ARONA Agent - Commands")}

${chalk.bold("Session")}
  /new, /clear     Start a new session (clear context)
  /resume          Pick and resume a saved session with arrow keys
  /exit            Exit
  /export          Export current session as Markdown

${chalk.bold("Display")}
  /thinking        Toggle thinking/reasoning block display
  /details         Toggle tool execution detail display
  /compact         Compact current context to save tokens

${chalk.bold("Voice")}
  /tts             Toggle text-to-speech
  /stt             Toggle speech-to-text

${chalk.bold("Extensions")}
  /skill           List or invoke a skill (/skill <name>)
  /mcp             List MCP servers and tools

${chalk.bold("Other")}
  /change-agent    Switch main agent + multi-select sub agents
  /undo            Undo the previous turn's file changes
  /redo            Redo undone changes
  /help            Show this help
`,
);

export async function handleCommand(input: string, ctx: CommandContext): Promise<boolean> {
  // Bare "/" → show menu (just like typing "/help")
  const stripped = input.startsWith("/") ? input.slice(1) : input;
  if (!stripped) {
    console.log(HELP_TEXT);
    return true;
  }

  const parts = stripped.split(/\s+/);
  const typedName = parts[0];
  const args = parts.slice(1).join(" ");

  const spec = resolveSlashCommand(typedName);
  if (!spec) {
    console.log(chalk.red(t(`未知命令：/${typedName}。输入 /help 查看可用命令。`, `Unknown command: /${typedName}. Type /help to see available commands.`)));
    return true;
  }

  // Dispatch by spec.name (the canonical name) so aliases route to the same handler
  switch (spec.name) {
    case "help":
      console.log(HELP_TEXT);
      return true;

    case "exit":
      ctx.exit();
      return true;

    case "new":
      await ctx.newSession();
      console.log(chalk.cyan(t("已开始新会话。", "Started a new session.")));
      return true;

    case "compact":
      // 反馈（开始/完成/取消/失败）统一由 renderer 的 compaction_start/compaction_end 事件输出；
      // SDK 在失败或取消时会先 emit compaction_end 再 throw，故此处静默吞掉即可。
      try {
        // 透传可选自定义指令（如 /compact 保留架构决策）；空串视为 undefined
        await ctx.session.compact(args.trim() || undefined);
      } catch {
        // 静默：错误信息已由 compaction_end 事件输出
      }
      return true;

    case "thinking":
      setShowThinking(!getShowThinking());
      console.log(chalk.cyan(t(`思考块显示：${getShowThinking() ? "开" : "关"}`, `Thinking display: ${getShowThinking() ? "on" : "off"}`)));
      return true;

    case "details":
      setShowToolDetails(!getShowToolDetails());
      console.log(chalk.cyan(t(`工具详情显示：${getShowToolDetails() ? "开" : "关"}`, `Tool details display: ${getShowToolDetails() ? "on" : "off"}`)));
      return true;

    case "tts":
      if (config.noVoice) {
        console.log(chalk.cyan(t("语音功能已禁用（--no-voice）。", "Voice features disabled (--no-voice).")));
        return true;
      }
      if (!voice.hasCurrentVoice()) {
        console.log(chalk.yellow(t(
          "当前角色未克隆音色，TTS 强制静音。运行 arona voice add 补全音色后即可启用。",
          "The current agent has no cloned voice, so TTS is force-muted. Run `arona voice add` to add a voice first.",
        )));
        return true;
      }
      voice.setTtsEnabled(!voice.isTtsEnabled());
      console.log(chalk.cyan(t(`TTS：${voice.isTtsEnabled() ? "开" : "关"}`, `TTS: ${voice.isTtsEnabled() ? "on" : "off"}`)));
      return true;

    case "stt":
      if (config.noVoice) {
        console.log(chalk.cyan(t("语音功能已禁用（--no-voice）。", "Voice features disabled (--no-voice).")));
        return true;
      }
      voice.setSttEnabled(!voice.isSttEnabled());
      console.log(chalk.cyan(t(`STT：${voice.isSttEnabled() ? "开" : "关"}`, `STT: ${voice.isSttEnabled() ? "on" : "off"}`)));
      if (voice.isSttEnabled()) {
        console.log(chalk.cyan(t(`长按${sttHotkeyLabel()} ≥2秒录音。`, `Hold ${sttHotkeyLabel()} ≥2s to record.`)));
      }
      ctx.setSttHookEnabled?.(voice.isSttEnabled());
      return true;

    case "resume":
      await handleResume(ctx);
      return true;

    case "export":
      handleExport(ctx);
      return true;

    case "undo":
      await handleUndo(ctx);
      return true;

    case "redo":
      await handleRedo(ctx);
      return true;

    case "skill":
      await handleSkill(args, ctx);
      return true;

    case "mcp":
      await handleMcp(args);
      return true;

    case "change-agent":
      await handleChangeAgent(ctx);
      return true;

    default:
      // Shouldn't happen since SLASH_COMMANDS is the source of truth, but be safe.
      console.log(chalk.red(t(`未知命令：/${typedName}。输入 /help 查看可用命令。`, `Unknown command: /${typedName}. Type /help to see available commands.`)));
      return true;
  }
}

/** 计算一个字符串去除 ANSI 转义后的可见宽度（CJK/全角算 2，控制符算 0）。 */
function visibleWidth(s: string): number {
  const stripped = s.replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|[0-9])/g, "");
  let w = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x1100 && (
      code <= 0x115f || (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3040 && code <= 0x33bf) || (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    )) w += 2;
    else if (code >= 0x20) w += 1;
  }
  return w;
}

/** 截断字符串到可见宽度（保留 ANSI 颜色转义，超出加 …）。 */
function truncateStyled(text: string, maxW: number, style: (s: string) => string): string {
  if (visibleWidth(text) <= maxW) return style(text);
  let res = "";
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const cw = (code >= 0x1100 && (
      code <= 0x115f || (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3040 && code <= 0x33bf) || (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    )) ? 2 : 1;
    if (w + cw > maxW - 1) break;
    res += ch;
    w += cw;
  }
  return style(res + "…");
}

/**
 * Interactive session picker. Uses raw-mode stdin to capture up/down arrows.
 * Pressing Enter or Escape selects (Enter = current, Escape = cancel).
 * Sessions are listed newest first; up arrow moves toward newer, down arrow toward older.
 */
async function handleResume(ctx: CommandContext) {
  const sessions = memory.listSessions();
  if (sessions.length === 0) {
    console.log(chalk.yellow(t("未找到已保存的会话。", "No saved sessions found.")));
    return;
  }

  // 暂停斜杠菜单的 keypress 监听器，否则上下键会被它捕获并画菜单。
  // （会话为空时已提前 return，无需暂停。）
  ctx.pauseMenuListener?.();

  // Stop the parent readline so it doesn't capture our keypresses
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let cursor = 0; // index of currently highlighted session
  let drawnScreenLines = 0; // 已画出的屏幕行数（按终端宽度折行后），用于精确上移
  const cols = process.stdout.columns ?? 80;

  const render = () => {
    // 上移已画出的屏幕行数（首次为 0，不移动），避免上移过多吞掉上方内容
    if (drawnScreenLines > 0) {
      process.stdout.write("\x1b[" + drawnScreenLines + "A");
    }
    // \r 回到第 1 列再清到屏幕末尾，确保整行被清（\x1b[0J 从光标列清起，
    // 若光标停在行中间会残留行首，重绘后出现"已已保存"等叠字）
    process.stdout.write("\r\x1b[0J");
    // 每行截断到终端宽度，防止换行导致屏幕行数 > 逻辑行数
    const maxW = cols - 1;
    const out: string[] = [];
    out.push(chalk.bold.cyan(t("已保存的会话（↑/↓ 选择，回车确认，Esc 取消）：", "Saved sessions (↑/↓ select, Enter confirm, Esc cancel):")));
    sessions.forEach((s, i) => {
      const date = new Date(s.timestamp).toLocaleString();
      const marker = i === cursor ? "▶ " : "  ";
      const text = `${marker}${i + 1}. ${s.preview}  (${date} · ${s.model})`;
      const styled = i === cursor
        ? truncateStyled(text, maxW, (t) => chalk.bold.cyan(t))
        : truncateStyled(text, maxW, (t) => t);
      out.push(styled);
    });
    out.push(chalk.cyan(t("  (按回车恢复当前选中项)", "  (press Enter to resume the highlighted item)")));
    // 用 \r\n 分隔确保每行回到第 1 列（\n 不复位列，可能导致后续行错位）
    process.stdout.write(out.join("\r\n") + "\r\n");
    // 每行恰好占 1 个屏幕行（已截断），屏幕行数 = 逻辑行数
    drawnScreenLines = out.length;
  };

  // Initial render
  render();

  // resolve 由 onData 在用户确认/取消时调用；提到外层以便 cleanup 引用，
  // 避免 const onData 暂时性死区导致 Esc 时 ReferenceError。
  let resolveFn: () => void = () => {};
  const onData = (key: string) => {
    // Arrow keys come as escape sequences: ESC [ A/B
    if (key === "\x1b[A") {
      // Up arrow: move toward newer (lower index)
      cursor = Math.max(0, cursor - 1);
      render();
    } else if (key === "\x1b[B") {
      // Down arrow: move toward older
      cursor = Math.min(sessions.length - 1, cursor + 1);
      render();
    } else if (key === "\r" || key === "\n") {
      // Enter: confirm selection
      cleanup();
      const sel = sessions[cursor];
      ctx.resumeSession(sel.path);
      console.log(chalk.green(t(`已恢复：${sel.preview}`, `Resumed: ${sel.preview}`)));
      resolveFn();
    } else if (key === "\x1b" || key === "\x1b\x1b") {
      // Escape: cancel
      cleanup();
      console.log(chalk.cyan(t("已取消。", "Cancelled.")));
      resolveFn();
    } else if (key === "q" || key === "\x03") {
      // q or Ctrl+C: cancel
      cleanup();
      console.log(chalk.cyan(t("已取消。", "Cancelled.")));
      resolveFn();
    }
  };

  const cleanup = () => {
    // 仅移除本选择器的 data 监听器，不要 pause stdin 或 setRawMode(false)——
    // 那会触发 readline 的 close 事件 → doExit() 导致程序意外退出。
    // readline 始终在 raw mode 下工作，选择器复用同一模式即可。
    process.stdin.removeListener("data", onData);
    // 恢复斜杠菜单监听器
    ctx.resumeMenuListener?.();
  };

  process.stdin.on("data", onData);
  return new Promise<void>((resolve) => { resolveFn = resolve; });
}

function handleExport(ctx: CommandContext) {
  const messages = ctx.session.messages;
  const exportTitle = t("ARONA 会话导出", "ARONA Session Export");
  const userLabel = t("用户", "User");
  const aronaLabel = t("ARONA", "ARONA");
  const toolLabel = t("工具", "tool");
  const resultLabel = t("结果", "result");
  let markdown = `# ${exportTitle}\n\n_${new Date().toISOString()}_\n\n---\n\n`;

  for (const msg of messages) {
    const role = msg.role === "user" ? `## ${userLabel}` : msg.role === "assistant" ? `## ${aronaLabel}` : `## ${msg.role}`;
    markdown += `${role}\n\n`;

    if ("content" in msg) {
      if (typeof msg.content === "string") {
        markdown += `${msg.content}\n\n`;
      } else {
        for (const part of msg.content) {
          if (part.type === "text") markdown += `${part.text}\n\n`;
          else if (part.type === "thinking") markdown += `> ${part.thinking}\n\n`;
          else if (part.type === "toolCall") markdown += `[${toolLabel}：${part.name}]\n\n`;
          else if (part.type === "image") markdown += `[${t("图片", "image")}：${part.mimeType}]\n\n`;
        }
        if (msg.role === "toolResult") {
          markdown += `[${resultLabel}：${msg.toolName}]\n\n`;
        }
      }
    }
    markdown += "---\n\n";
  }

  const exportPath = join(process.cwd(), `arona-export-${Date.now()}.md`);
  writeFileSync(exportPath, markdown);
  console.log(chalk.green(t(`已导出到 ${exportPath}`, `Exported to ${exportPath}`)));

  try {
    execSync(`open "${exportPath}"`, { stdio: "ignore" });
  } catch {
    // Not macOS or open not available
  }
}

async function handleUndo(ctx: CommandContext) {
  if (!ctx.undoManager) {
    console.log(chalk.yellow(t("撤销系统未初始化。", "Undo system is not initialized.")));
    return;
  }
  const r = await ctx.undoManager.undo();
  if (r.ok) console.log(chalk.green(r.message));
  else console.log(chalk.yellow(r.message));
}

async function handleRedo(ctx: CommandContext) {
  if (!ctx.undoManager) {
    console.log(chalk.yellow(t("撤销系统未初始化。", "Undo system is not initialized.")));
    return;
  }
  const r = await ctx.undoManager.redo();
  if (r.ok) console.log(chalk.green(r.message));
  else console.log(chalk.yellow(r.message));
}

async function handleSkill(args: string, ctx: CommandContext) {
  if (!args) {
    const allSkills = skills.listSkills(ctx.loader);
    if (allSkills.length === 0) {
      console.log(chalk.yellow(t("未找到技能。请在 ~/.arona/skills/<名称>/SKILL.md 中放置。", "No skills found. Place them in ~/.arona/skills/<name>/SKILL.md.")));
      return;
    }
    console.log(chalk.bold.cyan(t("\n可用技能：", "\nAvailable skills:")));
    allSkills.forEach((s, i) => {
      console.log(`  ${i + 1}. ${chalk.bold(s.name)}  ${chalk.cyan(s.description)}`);
    });
    console.log(chalk.cyan(t("\n使用 /skill <名称> 调用技能。", "\nUse /skill <name> to invoke a skill.")));
    return;
  }

  const skillName = args.trim();
  const content = skills.getSkillContent(skillName, ctx.loader);
  if (!content) {
    console.log(chalk.red(t(`未找到技能 "${skillName}"。`, `Skill "${skillName}" not found.`)));
    return;
  }

  // 走完整 Agent 回合生命周期（undo/isProcessing/pet.reset/abort），
  // 但不展开 @文件 / !命令，避免技能 markdown 中的 @ / ! 被误解析。
  console.log(chalk.green(t(`已调用技能：${skillName}`, `Invoked skill: ${skillName}`)));
  await ctx.runAgentTurn(t(`[技能：${skillName}]`, `[skill: ${skillName}]`) + `\n\n${content}`);
}

/**
 * /change-agent：切换主 Agent（单选）+ 子 Agent（多选）。
 * 交互式 TUI：主 Agent 用 [*] 单选，子 Agent 用 [*] 多选；
 * 确认后写 settings.json → 桌宠按新组合重建多窗口 → 主 Agent 变了才重启 TTS + 保存会话 + 重建会话。
 */
async function handleChangeAgent(ctx: CommandContext) {
  const current = getMainAgent();
  const currentSubs = getSubAgents();

  type Row = { kind: "main" | "sub"; id: string };
  const mainRows: Row[] = MAIN_AGENT_IDS.map((id) => ({ kind: "main", id }));
  const subRows: Row[] = SUB_AGENT_IDS.map((id) => ({ kind: "sub", id }));
  const rows = [...mainRows, ...subRows];

  let selectedMain: string = current;
  const selectedSubs = new Set<string>(currentSubs);
  let cursor = Math.max(0, rows.findIndex((r) => r.id === current));
  let drawnScreenLines = 0;
  const cols = process.stdout.columns ?? 80;

  // 暂停斜杠菜单 keypress 监听器，避免上下键被菜单捕获并画菜单
  ctx.pauseMenuListener?.();

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const render = () => {
    if (drawnScreenLines > 0) {
      process.stdout.write("\x1b[" + drawnScreenLines + "A");
    }
    process.stdout.write("\r\x1b[0J");
    const maxW = cols - 1;
    const out: string[] = [];
    out.push(truncateStyled(
      t("选择角色（↑/↓ 移动，空格选择，回车确认，Esc 取消）：", "Select characters (↑/↓ move, Space select, Enter confirm, Esc cancel):"),
      maxW,
      (x) => chalk.bold.cyan(x),
    ));
    out.push(truncateStyled(t("  主 Agent（单选）", "  Main agent (single)"), maxW, (x) => chalk.cyan(x)));
    mainRows.forEach((row, i) => {
      const marker = cursor === i ? "▶ " : "  ";
      const checked = row.id === selectedMain ? "[*]" : "[ ]";
      const suffix = row.id === current ? t("（当前）", " (current)") : "";
      // 只显示双语显示名（中文“阿洛娜”/英文“Arona”），不显示英文 id
      const text = `${marker}${checked} ${getAgentLabel(row.id as MainAgentId)}${suffix}`;
      out.push(truncateStyled(text, maxW, (x) => cursor === i ? chalk.bold.cyan(x) : x));
    });
    out.push(truncateStyled(t("  子 Agent（多选）", "  Sub agents (multi-select)"), maxW, (x) => chalk.cyan(x)));
    subRows.forEach((row, i) => {
      const idx = mainRows.length + i;
      const marker = cursor === idx ? "▶ " : "  ";
      const checked = selectedSubs.has(row.id) ? "[*]" : "[ ]";
      const text = `${marker}${checked} ${getAgentLabel(row.id as SubAgentId)}`;
      out.push(truncateStyled(text, maxW, (x) => cursor === idx ? chalk.bold.cyan(x) : x));
    });
    out.push(truncateStyled(t("  空格：选中/取消子 Agent；主 Agent 空格直接选定", "  Space: toggle sub-agent; Space on main agent selects it"), maxW, (x) => chalk.cyan(x)));
    process.stdout.write(out.join("\r\n") + "\r\n");
    drawnScreenLines = out.length;
  };

  render();

  // 真正执行切换的异步流程（确认后调用，完成后才 resolve 外层 Promise）
  const applySelection = async () => {
    const main = selectedMain as MainAgentId;
    const subs = SUB_AGENT_IDS.filter((id) => selectedSubs.has(id));
    const mainChanged = main !== current;
    const subsChanged = JSON.stringify(subs) !== JSON.stringify(currentSubs);
    if (!mainChanged && !subsChanged) {
      console.log(chalk.cyan(t("角色选择未变化。", "No character selection change.")));
      return;
    }
    // 1. 持久化（settings.json mainAgent + subAgents 字段）
    setMainAgent(main);
    setSubAgents(subs);
    // 2. 桌宠多窗口按新组合重建
    pet.restartWithSelection(main, subs);
    // 2.5 子 Agent 组合变化：回收旧子 session 对象；主 Agent 切换时 newSession 也会回收
    if (subsChanged) ctx.resetSubAgents?.();
    // 3. 主 Agent 切换才需要重启 TTS（音色随主 Agent 变化）与重建会话（人格变化）
    if (mainChanged) {
      ctx.restartTts?.();
      // 保存当前会话（resume 会话覆盖原文件；新会话仅当有有效对话）——重建会话会丢弃旧 session，先落盘防丢失
      ctx.saveCurrentSession();
      await ctx.newSession();
      console.log(chalk.green(t(
        `主 Agent 已切换为 ${getAgentLabel(main)}，子 Agent：${subs.length ? subs.map((s) => getAgentLabel(s)).join("、") : t("无", "none")}。`,
        `Main agent switched to ${getAgentLabel(main)}; sub agents: ${subs.length ? subs.map((s) => getAgentLabel(s)).join(", ") : "none"}.`,
      )));
    } else {
      console.log(chalk.green(t(
        `子 Agent 已更新：${subs.length ? subs.map((s) => getAgentLabel(s)).join("、") : t("无", "none")}。`,
        `Sub agents updated: ${subs.length ? subs.map((s) => getAgentLabel(s)).join(", ") : "none"}.`,
      )));
    }
  };

  let resolveFn: () => void = () => {};
  const onData = (key: string) => {
    if (key === "\x1b[A") {
      cursor = (cursor - 1 + rows.length) % rows.length;
      render();
    } else if (key === "\x1b[B") {
      cursor = (cursor + 1) % rows.length;
      render();
    } else if (key === " ") {
      const row = rows[cursor];
      if (row.kind === "main") {
        selectedMain = row.id;
      } else {
        if (selectedSubs.has(row.id)) selectedSubs.delete(row.id);
        else selectedSubs.add(row.id);
      }
      render();
    } else if (key === "\r" || key === "\n") {
      cleanup();
      void applySelection()
        .catch((err) => {
          console.error(chalk.red(t("切换失败：", "Switch failed: ") + (err instanceof Error ? err.message : err)));
        })
        .finally(() => resolveFn());
    } else if (key === "\x1b" || key === "\x1b\x1b" || key === "q" || key === "\x03") {
      // Esc / q / Ctrl+C: cancel
      cleanup();
      console.log(chalk.cyan(t("已取消。", "Cancelled.")));
      resolveFn();
    }
  };

  const cleanup = () => {
    // 仅移除本选择器的 data 监听器，不要 pause stdin 或 setRawMode(false)——
    // 那会触发 readline 的 close 事件 → doExit() 导致程序意外退出。
    process.stdin.removeListener("data", onData);
    // 恢复斜杠菜单监听器
    ctx.resumeMenuListener?.();
  };

  process.stdin.on("data", onData);
  return new Promise<void>((resolve) => { resolveFn = resolve; });
}

async function handleMcp(args: string) {
  const servers = mcp.listMcpServers();
  if (servers.length === 0) {
    console.log(chalk.yellow(t("未连接任何 MCP 服务器。在 settings.json 中配置（mcpServers）。", "No MCP servers connected. Configure them in settings.json (mcpServers).")));
    return;
  }

  if (!args || args === "list") {
    console.log(chalk.bold.cyan(t("\nMCP 服务器：", "\nMCP servers:")));
    for (const s of servers) {
      console.log(t(`  ${chalk.bold(s.name)}：${s.tools.join("、") || "(无工具)"}`, `  ${chalk.bold(s.name)}: ${s.tools.join(", ") || "(no tools)"}`));
    }
    console.log(chalk.cyan(t("\n使用 /mcp <服务器> <工具> <json参数> 调用工具。", "\nUse /mcp <server> <tool> <json args> to invoke a tool.")));
    return;
  }

  const parts = args.split(/\s+/);
  const serverName = parts[0];
  const toolName = parts[1];
  const jsonArgs = parts.slice(2).join(" ");

  if (!toolName) {
    const server = servers.find((s) => s.name === serverName);
    if (server) {
      console.log(chalk.bold(t(`\n${serverName} 的工具：`, `\nTools of ${serverName}:`)));
      server.tools.forEach((t) => console.log(`  - ${t}`));
    } else {
      console.log(chalk.red(t(`未找到服务器 "${serverName}"。`, `Server "${serverName}" not found.`)));
    }
    return;
  }

  try {
    const parsedArgs = jsonArgs ? JSON.parse(jsonArgs) : {};
    const result = await mcp.callMcpTool(serverName, toolName, parsedArgs);
    console.log(result);
  } catch (err) {
    console.error(chalk.red(t(`MCP 调用失败：${err instanceof Error ? err.message : err}`, `MCP call failed: ${err instanceof Error ? err.message : err}`)));
  }
}
