import chalk from "chalk";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import type { AgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";
import * as memory from "./memory.ts";
import * as voice from "./voice.ts";
import * as mcp from "./mcp.ts";
import * as skills from "./skills.ts";
import { setShowThinking, getShowThinking, setShowToolDetails, getShowToolDetails } from "./renderer.ts";
import { resolveSlashCommand } from "./slash_registry.ts";
import { AGENT_IDS, getMainAgent, setMainAgent, type AgentId } from "./agent_registry.ts";
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
}

const HELP_TEXT = t(
  `
${chalk.bold.cyan("ARONA Agent - 命令列表")}

${chalk.bold("会话")}
  /new, /clear     开始新会话（清空上下文）
  /resume          上下键选择并恢复一个已保存的会话
  /exit            退出（仅在有实际对话时保存会话）
  /export          导出当前会话为 Markdown

${chalk.bold("显示")}
  /thinking        开关思考/推理块显示
  /details         开关工具执行详情显示
  /compact         压缩当前上下文以节省 token

${chalk.bold("语音")}
  /tts             开关文字转语音
  /stt             开关语音转文字（长按右 Cmd ≥2秒录音）

${chalk.bold("扩展")}
  /skill           列出或调用技能（/skill <名称>）
  /mcp             列出 MCP 服务器和工具

${chalk.bold("其他")}
  /change-agent    切换主 Agent（桌宠形象 + 人格，上下键选择）
  /undo            撤销上一个回合的全部文件改动（本地快照，无需 git）
  /redo            重做已撤销的改动
  /help            显示本帮助

${chalk.cyan("提示：")}
  ${chalk.cyan("• @文件名 把文件内容插入到消息中")}
  ${chalk.cyan("• !命令 执行 shell 命令并把输出加入消息")}
`,
  `
${chalk.bold.cyan("ARONA Agent - Commands")}

${chalk.bold("Session")}
  /new, /clear     Start a new session (clear context)
  /resume          Pick and resume a saved session with arrow keys
  /exit            Exit (saves session only after a real conversation)
  /export          Export current session as Markdown

${chalk.bold("Display")}
  /thinking        Toggle thinking/reasoning block display
  /details         Toggle tool execution detail display
  /compact         Compact current context to save tokens

${chalk.bold("Voice")}
  /tts             Toggle text-to-speech
  /stt             Toggle speech-to-text (hold right Cmd ≥2s to record)

${chalk.bold("Extensions")}
  /skill           List or invoke a skill (/skill <name>)
  /mcp             List MCP servers and tools

${chalk.bold("Other")}
  /change-agent    Switch the main agent (pet + persona, pick with arrow keys)
  /undo            Undo the previous turn's file changes (local snapshot, no git)
  /redo            Redo undone changes
  /help            Show this help

${chalk.cyan("Tips:")}
  ${chalk.cyan("• @filename inserts the file content into your message")}
  ${chalk.cyan("• !command runs a shell command and appends its output")}
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
        console.log(chalk.cyan(t("长按右 Cmd ≥2秒录音（任务中按会先中断再录音）。", "Hold right Cmd ≥2s to record (press during a task to interrupt it first).")));
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
      handleUndo(ctx);
      return true;

    case "redo":
      handleRedo(ctx);
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

function handleUndo(ctx: CommandContext) {
  if (!ctx.undoManager) {
    console.log(chalk.yellow(t("撤销系统未初始化。", "Undo system is not initialized.")));
    return;
  }
  const r = ctx.undoManager.undo();
  if (r.ok) console.log(chalk.green(r.message));
  else console.log(chalk.yellow(r.message));
}

function handleRedo(ctx: CommandContext) {
  if (!ctx.undoManager) {
    console.log(chalk.yellow(t("撤销系统未初始化。", "Undo system is not initialized.")));
    return;
  }
  const r = ctx.undoManager.redo();
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
 * /change-agent：切换主 Agent（桌宠形象 + 人格）。
 * 交互式 TUI 选择器（沿用终端背景，不用纯色背景）：上下键循环选择 arona/plana，
 * 回车确认，Esc/q/Ctrl+C 取消。确认后走切换流程：写 settings.json → 桌宠换形象 →
 * 保存当前会话 → 重建 session（新人设生效）。
 */
async function handleChangeAgent(ctx: CommandContext) {
  const current = getMainAgent();
  const options: { id: AgentId; label: string }[] = AGENT_IDS.map((id) => ({
    id,
    label: id === "arona" ? t("阿洛娜", "Arona") : id === "plana" ? t("普拉娜", "Plana") : id,
  }));

  // 暂停斜杠菜单 keypress 监听器，避免上下键被菜单捕获并画菜单
  ctx.pauseMenuListener?.();

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let cursor = Math.max(0, options.findIndex((o) => o.id === current));
  let drawnScreenLines = 0;
  const cols = process.stdout.columns ?? 80;

  const render = () => {
    if (drawnScreenLines > 0) {
      process.stdout.write("\x1b[" + drawnScreenLines + "A");
    }
    process.stdout.write("\r\x1b[0J");
    const maxW = cols - 1;
    const out: string[] = [];
    out.push(chalk.bold.cyan(t("切换主 Agent（↑/↓ 选择，回车确认，Esc 取消）：", "Switch main agent (↑/↓ select, Enter confirm, Esc cancel):")));
    options.forEach((o, i) => {
      const marker = i === cursor ? "▶ " : "  ";
      const suffix = o.id === current ? t("（当前）", " (current)") : "";
      const text = `${marker}${o.id}${suffix}  —  ${o.label}`;
      const styled = i === cursor
        ? truncateStyled(text, maxW, (x) => chalk.bold.cyan(x))
        : truncateStyled(text, maxW, (x) => x);
      out.push(styled);
    });
    out.push(chalk.cyan(t("  (回车切换，Esc/q 取消)", "  (Enter to switch, Esc/q to cancel)")));
    process.stdout.write(out.join("\r\n") + "\r\n");
    drawnScreenLines = out.length;
  };

  render();

  // 真正执行切换的异步流程（确认后调用，完成后才 resolve 外层 Promise）
  const applySwitch = async (id: AgentId) => {
    if (id === current) {
      console.log(chalk.cyan(t(`当前主 Agent 已是 ${id}。`, `Main agent is already ${id}.`)));
      return;
    }
    // 1. 持久化（settings.json mainAgent 字段）
    setMainAgent(id);
    // 2. 桌宠换形象（pet/main.cjs 按 ARONA_AGENT env 选 agents.cjs 配置；旧进程退出后自动拉起）
    pet.restartWithAgent(id);
    // 3. 保存当前会话（resume 会话覆盖原文件；新会话仅当有有效对话）——重建会话会丢弃旧 session，先落盘防丢失
    ctx.saveCurrentSession();
    // 4. 重建 session → buildSystemPrompt 依 getMainAgent() 选新人格模板
    await ctx.newSession();
    console.log(chalk.green(t(
      `已切换主 Agent 为 ${id}（桌宠形象 + 人格已切换，新会话已开始）。`,
      `Switched main agent to ${id} (pet + persona switched, new session started).`,
    )));
  };

  let resolveFn: () => void = () => {};
  const onData = (key: string) => {
    if (key === "\x1b[A") {
      cursor = (cursor - 1 + options.length) % options.length;
      render();
    } else if (key === "\x1b[B") {
      cursor = (cursor + 1) % options.length;
      render();
    } else if (key === "\r" || key === "\n") {
      // Enter: confirm selection
      cleanup();
      const sel = options[cursor];
      void applySwitch(sel.id)
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
