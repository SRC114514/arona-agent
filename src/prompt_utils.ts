// 系统提示共用工具：时间注入 + 压缩预留推导（主 Agent 与编码子Agent 共用）。
// 独立成模块避免 coding_agent ↔ agent 循环导入。
import { getLang } from "./locale.ts";

// Asia/Shanghai 当前时间，注入到 system prompt 供情境台词使用；语言随界面
export function nowStr(): string {
  const locale = getLang() === "en" ? "en-US" : "zh-CN";
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Shanghai",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

/**
 * 由上下文窗口推导压缩预留 token（SDK shouldCompact: contextTokens > contextWindow - reserveTokens）。
 * 取窗口的 ~15% 并钳制在 [4096, 200000]：
 *   - 1M 窗口 → 150000（~85% 水位触发，与历史行为一致）
 *   - 64K → 9600 / 128K → 19200 / 200K → 30000（小窗口不再每轮误触发压缩）
 */
export function reserveTokensFor(contextWindow: number): number {
  return Math.min(200000, Math.max(4096, Math.round(contextWindow * 0.15)));
}
