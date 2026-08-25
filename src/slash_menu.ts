/**
 * 斜杠命令候选菜单。
 *
 * 参考 opencode-source/packages/tui/src/component/prompt/autocomplete.tsx 的
 * 状态机思路（visible/selected/scrollTop + 循环选择 + 视口滚动），但用原生
 * ANSI 实现，不依赖 SolidJS/OpenTUI 框架。
 *
 * 关键设计：
 * - 菜单画在 readline 提示符下方，带完整边框浮层。
 * - 用「相对光标移动」管理位置（\r\n 下移、\x1b[NA 上移），不依赖 DECSC/DECRC
 *   的绝对位置——后者在菜单导致终端滚动时会失效（保存的坐标被滚动打乱），
 *   从而造成菜单堆积。相对移动天然抗滚动。
 * - 每行用 \r\n 分隔，确保每行回到第 1 列；画完后上移 lineCount 行回到提示行，
 *   再调 rl.prompt(true) 让 readline 重新渲染提示行并校正光标列。
 * - Enter 补全时整体替换 rl.line；
 *   若已敲完命令名、正在补参数（首 token = 完整名/别名），则保留原行只关菜单。
 */

import chalk from "chalk";
import type { Interface } from "readline";
import { SLASH_COMMANDS, resolveSlashCommand, type SlashCommandSpec } from "./slash_registry.ts";
import { t } from "./locale.ts";

const MAX_VISIBLE = 8;

// ── 显示宽度工具（CJK/全角算 2，控制符算 0）──────────────────────
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

/** 去除 ANSI 颜色/光标转义序列，返回纯可见文本。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|[0-9])/g, "");
}

function padRight(s: string, width: number): string {
  const w = strWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

function truncateToWidth(s: string, width: number): string {
  if (width <= 0) return "";
  if (strWidth(s) <= width) return s;
  let res = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > width - 1) break;
    res += ch;
    w += cw;
  }
  return res + "…";
}

// ── 模糊评分（子序列匹配 + 连续命中加分 + 前缀加权）──────────────
function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatch = false;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += prevMatch ? 5 : 1;
      if (ti === 0) score += 8; // 前缀加权
      qi++;
      prevMatch = true;
    } else {
      prevMatch = false;
    }
  }
  return qi === q.length ? score : -1;
}

function bestScore(query: string, spec: SlashCommandSpec): number {
  const names = [spec.name, ...(spec.aliases ?? [])];
  let best = -1;
  for (const n of names) {
    const s = fuzzyScore(query, n);
    if (s > best) best = s;
  }
  return best;
}

// ── 菜单类 ───────────────────────────────────────────────────────
export class SlashMenu {
  private matches: SlashCommandSpec[] = [];
  private selected = 0;
  private scrollTop = 0;
  private visible = false;
  // 当前已画出的菜单行数（含边框与页脚）。用于 close 时定位要清除的区域。
  private drawnLineCount = 0;
  // 「本次填入不执行」信号：confirm() 在选中 needsParams 指令且实际替换了输入行时
  // 置位，由 repl 的 line handler 消费（同一按键的 "line" 事件同步跟随，无泄漏）。
  private pendingNoExec = false;

  isOpen(): boolean {
    return this.visible;
  }

  /** 供 repl 的 line handler 读取并清除「本次填入不执行」信号。 */
  consumeNoExecSignal(): boolean {
    const v = this.pendingNoExec;
    this.pendingNoExec = false;
    return v;
  }

  /**
   * 根据当前 readline 缓冲区决定打开/关闭/更新菜单。用于普通按键后调用
   *（readline 已先更新缓冲区）。
   */
  refresh(rl: Interface): void {
    const line = (rl as any).line ?? "";
    if (!line.startsWith("/")) {
      if (this.visible) this.close(rl);
      return;
    }
    const query = line.slice(1).split(/\s/)[0]; // 仅对第一个 token 做模糊
    // 守卫：首 token 已是完整指令名/别名（已选定或正在输参数）→ 不弹菜单，
    // 让输入框干净地留着指令。仅输入 "/" 时 query 为空，跳过守卫照常弹全部。
    if (query && resolveSlashCommand(query)) {
      if (this.visible) this.close(rl);
      return;
    }
    if (query === "") {
      this.setMatches(SLASH_COMMANDS.slice(), rl);
      return;
    }
    const scored = SLASH_COMMANDS.map((spec) => ({ spec, s: bestScore(query, spec) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.spec);
    if (scored.length === 0) {
      if (this.visible) this.close(rl);
      return;
    }
    this.setMatches(scored, rl);
  }

  private setMatches(matches: SlashCommandSpec[], rl: Interface): void {
    this.matches = matches;
    this.selected = 0;
    this.scrollTop = 0;
    if (!this.visible) {
      this.visible = true;
    }
    this.redraw(rl);
  }

  /** ↑/↓ 导航（循环）。 */
  move(direction: -1 | 1, rl: Interface): void {
    if (!this.visible || this.matches.length === 0) return;
    let next = this.selected + direction;
    if (next < 0) next = this.matches.length - 1;
    if (next >= this.matches.length) next = 0;
    this.selected = next;
    this.clampScroll();
    this.redraw(rl);
  }

  /**
   * Enter：把选中命令写入输入框（整体替换 rl.line），然后让 readline 的
   * return 处理自然 emit "line" 事件以执行命令。
   *
   * 时序（配合 repl.ts 里的 prependListener，本监听器先于 readline 执行）：
   * 1. 本方法：eraseMenu 擦画面 + 重置状态 + 设置 rl.line = "/<name> "
   * 2. readline 的 _onKeypress 处理 return → _onLine → emit "line" 带新值
   * 3. repl 的 line handler 收到补全后的命令名并执行
   *
   * 注意：不能调 rl.prompt(true)——它的 clearScreenDown 会干扰，且会让
   * readline 认为 return 前已重绘，可能跳过 emit "line"。
   *
   * needsParams 指令：填完不执行——置 pendingNoExec
   * 信号，repl 的 line handler 消费后只重绘提示行，用户补参数再 Enter。
   */
  confirm(rl: Interface): void {
    if (!this.visible) {
      this.pendingNoExec = false;
      return;
    }
    const spec = this.matches[this.selected];
    const filled = this.fillSelected(rl);
    this.pendingNoExec = !!(filled && spec?.needsParams);
  }

  /**
   * → 键：把选中命令填入输入框，但不触发执行（无后续 return 事件，readline
   * 不会 emit "line"）。与 confirm 的区别仅在「是否让执行发生」，填入逻辑共享
   * fillSelected。填完手动 prompt(true) 重绘提示行——此流程没有后续按键来触发
   * 重绘。参数保护同样生效：已在输参数时只关菜单保留原行。
   */
  complete(rl: Interface): void {
    if (!this.visible) return;
    this.fillSelected(rl);
    (rl as any).prompt(true);
  }

  /**
   * 擦菜单 + 重置状态 + 按选中项整体替换 rl.line（含参数保护）。返回是否真正
   * 替换了行（false = 首 token 已是完整命令名/别名，参数输入中，保留原行）。
   * 注意先读 spec 再重置 this.matches。
   */
  private fillSelected(rl: Interface): boolean {
    const spec = this.matches[this.selected];
    // 擦除菜单画面并重置状态
    this.eraseMenu();
    this.visible = false;
    this.matches = [];
    this.selected = 0;
    this.scrollTop = 0;
    this.drawnLineCount = 0;
    if (!spec) return false;
    const currentLine: string = (rl as any).line ?? "";
    const currentToken = currentLine.startsWith("/") ? currentLine.slice(1).split(/\s/)[0] : "";
    const names = [spec.name, ...(spec.aliases ?? [])];
    if (names.includes(currentToken)) return false; // 参数输入中，保留原行
    const replacement = spec.interactive ? `/${spec.name}` : `/${spec.name} `;
    (rl as any).line = replacement;
    (rl as any).cursor = replacement.length;
    return true;
  }

  /** Esc / 外部关闭。保留已输入内容。 */
  close(rl: Interface): void {
    if (!this.visible) return;
    this.eraseMenu();
    this.visible = false;
    this.matches = [];
    this.selected = 0;
    this.scrollTop = 0;
    this.drawnLineCount = 0;
    (rl as any).prompt(true);
  }

  // ── 渲染 ──────────────────────────────────────────────────────

  private clampScroll(): void {
    const maxVisible = this.maxVisible();
    if (this.selected < this.scrollTop) this.scrollTop = this.selected;
    else if (this.selected >= this.scrollTop + maxVisible) {
      this.scrollTop = this.selected - maxVisible + 1;
    }
    // 防止 scrollTop 超出末尾窗口
    const lastTop = Math.max(0, this.matches.length - maxVisible);
    if (this.scrollTop > lastTop) this.scrollTop = lastTop;
  }

  private maxVisible(): number {
    const rows = process.stdout.rows ?? 24;
    return Math.max(3, Math.min(MAX_VISIBLE, rows - 6));
  }

  /**
   * 擦除已绘制的菜单并回到提示行。调用时光标应在提示行（由上次 redraw 或
   * readline 的按键处理留在那里）。用相对移动：下移 1 行到菜单顶 → 清到屏幕
   * 末尾 → 上移 1 行回提示行。相对移动天然抗终端滚动。
   */
  private eraseMenu(): void {
    if (this.drawnLineCount === 0) return;
    process.stdout.write("\r\n"); // 回到第 1 列并下移 1 行（到菜单顶）
    process.stdout.write("\x1b[0J"); // 清除从菜单顶到屏幕末尾
    process.stdout.write("\x1b[1A"); // 上移 1 行回提示行
    this.drawnLineCount = 0;
  }

  private redraw(rl: Interface): void {
    if (!this.visible) return;
    const cols = process.stdout.columns ?? 80;
    const maxVisible = this.maxVisible();
    const start = this.scrollTop;
    const end = Math.min(this.matches.length, start + maxVisible);
    const items = this.matches.slice(start, end);

    // 计算列宽
    const nameCols = items.map((s) => {
      const alias = s.aliases?.length ? ` (${s.aliases.join(", ")})` : "";
      return `/${s.name}${alias}`;
    });
    const maxNameW = Math.max(...nameCols.map(strWidth));
    const descStart = 2 + maxNameW + 2; // marker(2) + name + gap(2)
    let maxDescW = Math.max(...items.map((s) => strWidth(s.description)));

    const maxInnerW = Math.max(20, cols - 6);
    let innerW = descStart + maxDescW;
    if (innerW > maxInnerW) {
      innerW = maxInnerW;
      maxDescW = Math.max(0, innerW - descStart);
    }

    const lines: string[] = [];
    const border = chalk.cyan;
    // 顶边
    lines.push(border("┌" + "─".repeat(innerW + 2) + "┐"));
    // 各项
    for (let i = 0; i < items.length; i++) {
      const spec = items[i];
      const idx = start + i;
      const nameCol = nameCols[i];
      const marker = idx === this.selected ? "▶ " : "  ";
      const gap = " ".repeat(descStart - 2 - strWidth(nameCol));
      let desc = spec.description;
      if (strWidth(desc) > maxDescW) desc = truncateToWidth(desc, maxDescW);
      const content = marker + nameCol + gap + desc;
      const padded = padRight(content, innerW);
      // 选中行整行高亮（含边框），否则边框青色、内容默认色
      const full =
        idx === this.selected
          ? chalk.bgCyan.black("┃ " + padded + " ┃")
          : border("┃ ") + padded + border(" ┃");
      lines.push(full);
    }
    // 底边
    lines.push(border("└" + "─".repeat(innerW + 2) + "┘"));
    // 页脚提示
    const moreUp = this.scrollTop > 0;
    const moreDown = this.scrollTop + maxVisible < this.matches.length;
    let footer = t("  ↑/↓ 选择 · Enter 补全 · → 填入 · Esc 取消", "  ↑/↓ select · Enter complete · → fill · Esc cancel");
    if (moreUp || moreDown) {
      const ind = `${moreUp ? "↑" : ""}${moreDown ? "↓" : ""}`;
      footer += t(`  · ${ind} 可滚动`, `  · ${ind} scrollable`);
    }
    lines.push(chalk.cyan(footer));

    // ── 绘制（相对移动，抗滚动）──────────────────────────────────
    // 光标当前在提示行。下移 1 行到菜单顶 → 清到屏幕末尾（擦旧菜单）→
    // 画新菜单 → 回到提示行并定位光标到输入位置。
    //
    // 关键：不能调 rl.prompt(true)！readline 的 _refreshLine 会执行
    // clearScreenDown（\x1b[J 清到屏幕末尾），把刚画的菜单整个擦掉。
    // 改为手动把光标定位到「prompt 宽度 + cursor」列，让光标停在输入
    // 末尾，readline 下次按键时会自行重绘提示行。
    process.stdout.write("\r\n"); // 回到第 1 列并下移 1 行（末行会滚动）
    process.stdout.write("\x1b[0J"); // 清除从菜单顶到屏幕末尾（擦旧菜单）
    // 画各行，用 \r\n 分隔确保每行回到第 1 列
    process.stdout.write(lines.join("\r\n"));
    // 光标现在在最后一行末尾；回到提示行第 1 列
    const lineCount = lines.length;
    process.stdout.write("\r\x1b[" + lineCount + "A");
    this.drawnLineCount = lineCount;
    // 光标右移到输入位置：prompt 可见宽度 + cursor。
    // 注意 prompt 可能带 ANSI 颜色转义（如 chalk.cyan("❯ ")），必须先 strip
    // 否则转义里的 [36m 等可见字符会被算进宽度，导致光标右移过多。
    const promptStr = stripAnsi(String((rl as any)._prompt ?? ""));
    const targetCol = strWidth(promptStr) + ((rl as any).cursor ?? 0);
    if (targetCol > 0) process.stdout.write("\x1b[" + targetCol + "C");
  }
}
