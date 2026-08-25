// 通用多选 TUI 选择器（raw-mode stdin）。
// 用于 setup 与 arona voice add 的角色音色选择：↑/↓ 移动、空格切换 [*]/[ ]、回车确认、Esc/q/Ctrl+C 取消。
// 复用 commands.ts 的可见宽度计算与行截断思路，避免 CJK 折行导致重绘叠字。

import chalk from "chalk";
import { t } from "./locale.ts";

export interface SelectOption {
  id: string;
  label: string;
  /** 锁定：强制显示 [*]，空格不可切换（已有音色的角色）。 */
  locked?: boolean;
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
 * 多选 TUI。返回选中的 id 集合；用户取消（Esc/q/Ctrl+C）返回 null。
 *
 * 交互：↑/↓ 循环移动光标，空格切换 [*]/[ ]，回车确认。
 * single=true 时单选：空格把当前项设为唯一选中（再按空格取消不选）。
 * 调用方需保证进入前 stdin 未被 readline 占用（setup 在调用前 rl.close()）。
 */
export async function multiSelect(
  title: string,
  options: SelectOption[],
  initiallySelected: Set<string>,
  hint?: string,
  single = false,
): Promise<Set<string> | null> {
  if (options.length === 0) return new Set<string>();

  const wasRaw = process.stdin.isRaw ?? false;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const selected = new Set<string>(initiallySelected);
  let cursor = 0;
  let drawnScreenLines = 0;
  /** 临时提示（单选未选择就按回车时显示，下次按键清除） */
  let notice: string | null = null;
  const cols = process.stdout.columns ?? 80;

  const render = () => {
    if (drawnScreenLines > 0) {
      process.stdout.write("\x1b[" + drawnScreenLines + "A");
    }
    process.stdout.write("\r\x1b[0J");
    const maxW = cols - 1;
    const out: string[] = [];
    // title / hint 也必须截断到终端宽度：否则超宽折行 → 实际屏幕行数 > 逻辑行数，
    // drawnScreenLines 低估导致下一次 \x1b[N A 上移不足、上一帧残留累积（英文长标题复现）
    out.push(truncateStyled(title, maxW, (x) => chalk.bold.cyan(x)));
    options.forEach((o, i) => {
      const checked = o.locked || selected.has(o.id);
      const marker = checked ? "[*]" : "[ ]";
      const text = `${marker} ${o.label}`;
      const styled = i === cursor
        ? truncateStyled(text, maxW, (x) => chalk.bold.cyan(x))
        : truncateStyled(text, maxW, (x) => x);
      out.push(styled);
    });
    if (hint) out.push(truncateStyled(hint, maxW, (x) => chalk.cyan(x)));
    if (notice) out.push(truncateStyled(notice, maxW, (x) => chalk.yellow(x)));
    process.stdout.write(out.join("\r\n") + "\r\n");
    drawnScreenLines = out.length;
  };

  render();

  let resolveFn: (v: Set<string> | null) => void = () => {};
  const onData = (key: string) => {
    if (key === "\x1b[A") {
      notice = null;
      cursor = (cursor - 1 + options.length) % options.length;
      render();
    } else if (key === "\x1b[B") {
      notice = null;
      cursor = (cursor + 1) % options.length;
      render();
    } else if (key === " ") {
      notice = null;
      const o = options[cursor];
      if (o.locked) return; // 锁定项：空格无效，保持 [*]
      if (single) {
        // 单选：空格把当前项设为唯一选中；已选中时按空格取消（可 Enter 由调用方回退默认）
        if (selected.has(o.id)) selected.delete(o.id);
        else {
          selected.clear();
          selected.add(o.id);
        }
      } else if (selected.has(o.id)) {
        selected.delete(o.id);
      } else {
        selected.add(o.id);
      }
      render();
    } else if (key === "\r" || key === "\n") {
      // 单选未选中任何项时回车不生效：不静默回落默认项，
      // 提示后保持菜单，等待用户明确选择
      if (single && selected.size === 0) {
        notice = t(
          "请先按空格选择一项，再回车确认",
          "Press Space to select an item first, then Enter",
        );
        render();
        return;
      }
      cleanup();
      resolveFn(selected);
    } else if (key === "\x1b" || key === "\x1b\x1b" || key === "q" || key === "\x03") {
      cleanup();
      resolveFn(null);
    }
  };

  const cleanup = () => {
    process.stdin.removeListener("data", onData);
    // 恢复进入前的 raw mode 状态（setup 已 rl.close()、voice_cli 无 rl，均安全）
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(wasRaw);
      } catch {
        // 忽略
      }
    }
    // pause stdin：resume() 后 stdin 保持 flowing，事件循环被 stdin 引用挂住，
    // 进程不会退出（按 Esc/回车取消后只能 Ctrl+C 强退）。本 TUI 仅用于
    // setup / voice add 的独立进程场景（REPL 内联选择器才需要保持 resume）。
    process.stdin.pause();
  };

  process.stdin.on("data", onData);
  return new Promise<Set<string> | null>((resolve) => { resolveFn = resolve; });
}
