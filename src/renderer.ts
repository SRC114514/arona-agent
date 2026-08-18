import chalk from "chalk";
import { t } from "./locale.ts";
import { getAgentLabel, getMainAgent } from "./agent_registry.ts";
import { splitStreamedText, countTextUnits } from "./text_split.ts";

let showThinking = true;
let showToolDetails = true;

export function setShowThinking(v: boolean) { showThinking = v; }
export function getShowThinking() { return showThinking; }
export function setShowToolDetails(v: boolean) { showToolDetails = v; }
export function getShowToolDetails() { return showToolDetails; }

const THINKING_TAIL_LINES = 3; // 流式与历史回放统一：只显示思考尾部 N 行
const PET_BUBBLE_FORCE_SPLIT_LEN = 9999; // 气泡只显示完整句子，不做强切，禁止截断
const PET_MAX_BUBBLE_LEN = 50;

// ── 显示宽度 & 行数工具（CJK/全角算 2，ANSI 控制符算 0）────────────
function charWidth(code: number): number {
  if (code < 0x20) return 0;
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3040 && code <= 0x33bf) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f9ff))
  ) {
    return 2;
  }
  return 1;
}
function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}
/** 给定一行可见文本，根据当前终端列宽计算实际占用的物理行数（自动软换行）。 */
function physicalLinesForRow(visibleText: string): number {
  const cols = process.stdout.columns ?? 80;
  if (cols <= 0) return 1;
  const w = Math.max(1, strWidth(visibleText));
  return Math.ceil(w / cols);
}

type PetTextKind = "mid" | "final";

export function createRenderer(
  onTurnEnd?: () => void,
  onTextDelta?: (delta: string) => void,
  onPetText?: (kind: PetTextKind, data: string) => void,
  initialSpeakerLabel?: string,
) {
  let speakerLabel = initialSpeakerLabel;
  let inThinking = false;
  let inText = false;
  let textPrefixWritten = false;

  // ── 流式思考折叠重绘 ──────────────────────────────────────────
  let thinkingBuffer = "";          // 完整思考内容缓冲区
  let drawnThinkingLines = 0;      // 上次渲染占用的**物理行数**（含 ANSI 软换行）
  // 思考前缀：每行都加 2 空格缩进（与历史回放 renderSavedMessages 对齐）
  const THINKING_PREFIX = "  ";

  /** 擦除上次画出的思考区域，回到思考块第一行的行首。 */
  function eraseDrawnThinking(): void {
    if (drawnThinkingLines <= 0) return;
    // 光标当前在思考块最后一行末尾。先回到该行第 1 列 → 上移 N-1 行到思考块顶行 → 清到屏幕末尾
    process.stdout.write("\r");
    if (drawnThinkingLines > 1) {
      process.stdout.write(`\x1b[${drawnThinkingLines - 1}A`);
    }
    process.stdout.write("\x1b[0J");
    drawnThinkingLines = 0;
  }

  /**
   * 根据 thinkingBuffer 按折叠规则渲染（省略前缀 + 最后 THINKING_TAIL_LINES 行）。
   * 与历史回放 renderSavedMessages 的格式严格对齐：
   *   - 空缓冲 → 什么都不画
   *   - 逻辑行 ≤ THINKING_TAIL_LINES → 全画
   *   - 逻辑行 > THINKING_TAIL_LINES → 1 行省略提示 + 尾部 N 行
   *   - 每行前缀 = THINKING_PREFIX
   */
  function renderThinking(): void {
    const raw = thinkingBuffer.replace(/\n+$/, "");
    if (!raw) return;
    const allLines = raw.split("\n");
    const total = allLines.length;
    const showTail = total <= THINKING_TAIL_LINES
      ? allLines
      : allLines.slice(-THINKING_TAIL_LINES);
    const hidden = total - showTail.length;

    // 准备要写出的行（带格式、带前缀）
    const renderLines: { visible: string; styled: string }[] = [];
    if (hidden > 0) {
      const visibleMsg = t(
        `… (已省略 ${hidden} 行早期思考内容)`,
        `… (${hidden} earlier thinking lines omitted)`,
      );
      renderLines.push({
        visible: THINKING_PREFIX + visibleMsg,
        styled: chalk.dim(THINKING_PREFIX + visibleMsg),
      });
    }
    for (const line of showTail) {
      renderLines.push({
        visible: THINKING_PREFIX + line,
        styled: chalk.dim(THINKING_PREFIX + line),
      });
    }

    // 输出 + 统计物理行数
    let physLines = 0;
    const out: string[] = [];
    for (const row of renderLines) {
      out.push(row.styled);
      physLines += physicalLinesForRow(row.visible);
    }
    process.stdout.write(out.join("\r\n"));
    drawnThinkingLines = physLines;
  }

  /** 流式思考增量更新：擦旧 → 追加缓冲 → 重绘。 */
  function appendThinkingDelta(delta: string): void {
    eraseDrawnThinking();
    thinkingBuffer += delta;
    renderThinking();
  }

  /** 结束流式思考、准备输出正文时调用。把思考块"封版"，游标移到下一行开头。 */
  function finalizeThinking(): void {
    if (drawnThinkingLines > 0) {
      // 画完最后一帧后光标在末行末尾；切到下一行第 1 列即可。
      process.stdout.write("\r\n");
    }
    drawnThinkingLines = 0;
    thinkingBuffer = "";
  }

  // 气泡状态
  let petMidBuffer = "";
  // 已上气泡的内容（按顺序累计，行用 "\n" 分隔）；超出 PET_MAX_BUBBLE_LEN 字时挤掉最早的
  let petShownLines: string[] = [];

  /** 把 lines 按"最早的优先保留、最后一条优先被挤掉"裁到总字数 < maxUnits。 */
  function trimBubbleLines(lines: string[], maxUnits: number): string[] {
    let total = lines.reduce((s, l) => s + countTextUnits(l), 0);
    while (total > maxUnits && lines.length > 1) {
      total -= countTextUnits(lines[0]);
      lines.shift();
    }
    return lines;
  }

  function flushPetMid(delta: string) {
    petMidBuffer += delta;
    if (!onPetText) return;
    const { sentences, rest } = splitStreamedText(petMidBuffer, PET_BUBBLE_FORCE_SPLIT_LEN);
    petMidBuffer = rest;
    for (const sent of sentences) {
      const clean = sent.trim();
      if (!clean) continue;
      const units = countTextUnits(clean);
      if (units === 0) continue;
      // 单句本身就超过上限：仍显示一句（不切，按真实样子），不参与后续滚动
      if (units >= PET_MAX_BUBBLE_LEN) {
        petShownLines = [clean];
      } else {
        petShownLines.push(clean);
        petShownLines = trimBubbleLines(petShownLines, PET_MAX_BUBBLE_LEN);
      }
      onPetText?.("mid", petShownLines.join("\n"));
    }
  }

  return {
    setSpeakerLabel(label: string | undefined) {
      speakerLabel = label;
    },
    subscribe: (session: any) => {
      return session.subscribe((event: any) => {
        switch (event.type) {
          case "message_start":
            inText = false;
            inThinking = false;
            textPrefixWritten = false;
            petMidBuffer = "";
            petShownLines = [];
            thinkingBuffer = "";
            drawnThinkingLines = 0;
            break;

          case "message_update": {
            const ae = event.assistantMessageEvent;
            if (ae.type === "text_delta") {
              if (!inText) {
                if (inThinking) {
                  finalizeThinking();
                  inThinking = false;
                }
                inText = true;
                if (speakerLabel && !textPrefixWritten) {
                  process.stdout.write(chalk.magenta.bold(speakerLabel + "："));
                  textPrefixWritten = true;
                }
              }
              process.stdout.write(ae.delta);
              // 实时 TTS：文本增量边生成边送入非流式合成管道（按标点成句入队）
              onTextDelta?.(ae.delta);
              flushPetMid(ae.delta);
            } else if (ae.type === "thinking_delta") {
              if (showThinking) {
                if (!inThinking) {
                  inThinking = true;
                  inText = false;
                  // 先开一个新行；后续所有增量走 erase+redraw，从这行开始覆盖
                  process.stdout.write("\r\n");
                  drawnThinkingLines = 0;
                  thinkingBuffer = "";
                }
                appendThinkingDelta(ae.delta);
              }
            }
            break;
          }

          case "message_end": {
            if (inThinking && showThinking) {
              finalizeThinking();
            }
            if (inText) {
              process.stdout.write("\n");
            }
            // 注意：不再在 message_end 触发 TTS 收尾——那会把被 change_emotion 等工具调用
            // 切断的句子（如"好好吃饭哦"）拆成两段分别朗读。TTS 收尾改在 agent_end（onTurnEnd）。
            // 把没有标点收尾的残段挂到累计池（已通过 mid 完整成句的部分不重复）。
            // 残段本身是句子的尾巴，无完整标点，长度不可控：若超上限就单独占一行（保留原样、不切）。
            const leftover = petMidBuffer.trim();
            if (leftover) {
              const units = countTextUnits(leftover);
              if (units > 0) {
                if (units >= PET_MAX_BUBBLE_LEN) {
                  petShownLines = [leftover];
                } else {
                  petShownLines.push(leftover);
                  petShownLines = trimBubbleLines(petShownLines, PET_MAX_BUBBLE_LEN);
                }
                onPetText?.("final", petShownLines.join("\n"));
              }
            }
            inThinking = false;
            inText = false;
            petMidBuffer = "";
            // 注意：petShownLines 不清空——final 是回合末尾，气泡要保留到 tts_end 再隐藏
            // （hidPetBubble 在 tts 播放结束时才触发）
            thinkingBuffer = "";
            drawnThinkingLines = 0;
            break;
          }

          case "agent_end":
            // 回合全部文字输出完毕：收尾 TTS 残段（跨 message 累积的句子尾巴），触发合成队列排空
            onTurnEnd?.();
            break;

          case "tool_execution_start":
            if (showToolDetails) {
              const name = event.toolName;
              const input = event.input ? JSON.stringify(event.input).slice(0, 100) : "";
              process.stdout.write(chalk.cyan(t(`\n  [工具] ${name}`, `\n  [tool] ${name}`)) + (input ? ` ${input}` : "") + "\n");
            }
            break;

          case "tool_execution_end":
            if (showToolDetails) {
              const status = event.isError ? chalk.red(t("错误", "error")) : chalk.green(t("完成", "done"));
              process.stdout.write(t("  [工具] ", "  [tool] ") + `${status}\n`);
            }
            break;

          case "compaction_start":
            process.stdout.write(chalk.yellow(t("\n[正在压缩上下文...]\n", "\n[Compacting context...]\n")));
            break;

          case "compaction_end":
            if (event.aborted) {
              process.stdout.write(chalk.yellow(t("[压缩已取消]\n\n", "[Compaction cancelled]\n\n")));
            } else if (event.errorMessage) {
              // SDK 错误信息带 "Compaction failed: " 前缀，去掉保持输出整洁
              const msg = String(event.errorMessage).replace(/^Compaction failed:\s*/i, "");
              process.stdout.write(chalk.red(t(`[压缩失败] ${msg}\n\n`, `[Compaction failed] ${msg}\n\n`)));
            } else {
              process.stdout.write(chalk.yellow(t("[压缩完成]\n\n", "[Compaction complete]\n\n")));
            }
            break;

          case "auto_retry_start":
            process.stdout.write(chalk.yellow(t("\n[重试中...]\n", "\n[Retrying...]\n")));
            break;
        }
      });
    },
  };
}

/**
 * 将已保存会话的消息回放渲染到终端（用于 /resume 恢复后重绘历史）。
 * 仅渲染文件中的消息，不涉及当前 session 状态，避免上下文串扰。
 *
 * 消息结构（见 memory.ts loadSession）：
 *   - { role: "user", content: [{type:"text",text}] }
 *   - { role: "assistant", content: [{type:"thinking"},{type:"text"},{type:"toolCall"}] }
 *   - { role: "toolResult", toolName, content:[{type:"text",text}], isError }
 */
export function renderSavedMessages(messages: any[]) {
  for (const msg of messages) {
    if (msg.type === "arona-session") continue; // 跳过 header（loadSession 已过滤）

    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (text) {
        process.stdout.write(chalk.cyan.bold(t("你：", "You: ")) + text + "\n\n");
      }
    } else if (msg.role === "assistant") {
      const content = msg.content || [];
      // 思考内容（仅显示尾部，与流式渲染一致）
      const thinkingBlocks = content.filter((b: any) => b.type === "thinking");
      for (const tb of thinkingBlocks) {
        const thinking = tb.thinking || "";
        if (thinking.trim()) {
          const allLines = thinking.replace(/\n+$/, "").split("\n");
          const tail = allLines.slice(-THINKING_TAIL_LINES);
          const hidden = allLines.length - tail.length;
          process.stdout.write("\n");
          if (hidden > 0) {
            process.stdout.write(chalk.dim(t(`  … (已省略 ${hidden} 行早期思考内容)\n`, `  … (${hidden} earlier thinking lines omitted)\n`)));
          }
          for (const line of tail) {
            process.stdout.write(chalk.dim(`  ${line}\n`));
          }
        }
      }
      // 文本内容
      const text = extractText(content);
      if (text) {
        const speaker = typeof msg.speaker === "string" ? getAgentLabel(msg.speaker as any) : getAgentLabel(getMainAgent());
        process.stdout.write(chalk.magenta.bold(speaker + "：") + text + "\n\n");
      }
      // 工具调用
      const toolCalls = content.filter((b: any) => b.type === "toolCall");
      for (const tc of toolCalls) {
        const input = tc.arguments ? JSON.stringify(tc.arguments).slice(0, 100) : "";
        process.stdout.write(chalk.cyan(t("  [工具] ", "  [tool] ") + (tc.name || "")) + (input ? ` ${input}` : "") + "\n");
      }
    } else if (msg.role === "toolResult") {
      const status = msg.isError ? chalk.red(t("错误", "error")) : chalk.green(t("完成", "done"));
      const toolName = msg.toolName || "";
      process.stdout.write(chalk.cyan(t("  [工具] ", "  [tool] ") + `${toolName} ${status}\n`));
    }
  }
}

function extractText(content: any): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text || "")
    .join("");
}
