import chalk from "chalk";
import { t } from "./locale.ts";

let showThinking = true;
let showToolDetails = true;

export function setShowThinking(v: boolean) { showThinking = v; }
export function getShowThinking() { return showThinking; }
export function setShowToolDetails(v: boolean) { showToolDetails = v; }
export function getShowToolDetails() { return showToolDetails; }

const THINKING_TAIL_LINES = 3;

export function createRenderer(
  onMessageComplete?: (text: string) => void,
  onResponseComplete?: (text: string) => void,
) {
  let responseText = "";
  // Full thinking content accumulated during this assistant message.
  // Display is deferred to message_end where we only show the last 3 lines.
  let thinkingFull = "";
  let inThinking = false;
  let inText = false;

  return {
    subscribe: (session: any) => {
      return session.subscribe((event: any) => {
        switch (event.type) {
          case "message_start":
            responseText = "";
            inText = false;
            inThinking = false;
            thinkingFull = "";
            break;

          case "message_update": {
            const ae = event.assistantMessageEvent;
            if (ae.type === "text_delta") {
              if (!inText) {
                inText = true;
                inThinking = false;
              }
              process.stdout.write(ae.delta);
              responseText += ae.delta;
            } else if (ae.type === "thinking_delta") {
              if (showThinking) {
                if (!inThinking) {
                  inThinking = true;
                  inText = false;
                }
                // Accumulate silently; we'll print only the tail at message_end
                thinkingFull += ae.delta;
              }
            }
            break;
          }

          case "message_end": {
            if (inThinking && showThinking && thinkingFull.trim().length > 0) {
              const allLines = thinkingFull.replace(/\n+$/, "").split("\n");
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
            if (inText) {
              process.stdout.write("\n");
            }
            // 触发逐句 TTS：此时 responseText 是本条消息的完整文本
            if (responseText.trim()) {
              onMessageComplete?.(responseText);
            }
            inThinking = false;
            inText = false;
            thinkingFull = "";
            break;
          }

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

          case "agent_end":
            onResponseComplete?.(responseText);
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
        process.stdout.write(chalk.magenta.bold(t("Arona：", "Arona: ")) + text + "\n\n");
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
