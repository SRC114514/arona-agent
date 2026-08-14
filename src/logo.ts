/**
 * 开屏 ASCII 艺术字（动态生成）。
 *
 * 使用 figlet 根据终端宽度自动选择合适的字体，确保在各种终端宽度下
 * 都能显示立体艺术字。配色保留 SCHALE 风格的蓝→浅蓝→青三段行级渐变。
 */

import figlet from "figlet";

// 配色（与原 launcher.sh 一致）
const C = "\x1b[38;2;0;210;255m"; // CYAN  #00D2FF  边框 + 底部字母
const B = "\x1b[38;2;66;135;245m"; // BLUE  #4287F5  顶部字母
const L = "\x1b[38;2;100;180;255m"; // LIGHT_BLUE #64B4FF 中部字母
const R = "\x1b[0m"; // RESET

// 字体降级策略：ANSI Shadow 绝对优先，剩下立体优先、平面兜底
//
// 1) ANSI Shadow + 完整 "ARONA AGENT"   （用户最想要的效果，~101 列）
// 2) ANSI Shadow + 缩短 "ARONA"         （~53 列）
// 3) 其他 3D 立体字体（按宽度降序）：每个字体都先试 "ARONA AGENT"，装不下再试 "ARONA"
// 4) 平面字体（最后兜底）：按宽度降序，每个字体也是先 AGENT 再 ARONA
//
// 列数估算已留出边框 2 格 + 缩进 2 格 + 内边距 6 格（即 width + 10）
const VARIANTS: { text: string; font: figlet.Fonts }[] = [
  // —— ANSI Shadow 绝对优先 ——
  { text: "ARONA AGENT", font: "ANSI Shadow" }, // ~101 列
  { text: "ARONA",       font: "ANSI Shadow" }, // ~53 列

  // —— 其他 3D 立体字体（按宽度降序，AGENT → ARONA 配对） ——
  { text: "ARONA AGENT", font: "Line Blocks" },     // ~100
  { text: "ARONA",       font: "Line Blocks" },     // ~55
  { text: "ARONA AGENT", font: "Larry 3D 2" },      // ~96
  { text: "ARONA",       font: "Larry 3D 2" },      // ~54
  { text: "ARONA AGENT", font: "Larry 3D" },        // ~96
  { text: "ARONA",       font: "Larry 3D" },        // ~54
  { text: "ARONA AGENT", font: "Speed" },           // ~96
  { text: "ARONA",       font: "Speed" },           // ~49
  { text: "ARONA AGENT", font: "Banner" },          // ~94
  { text: "ARONA",       font: "Banner" },          // ~51
  { text: "ARONA AGENT", font: "Old Banner" },      // ~93
  { text: "ARONA",       font: "Old Banner" },      // ~50
  { text: "ARONA AGENT", font: "Shadow" },          // ~91
  { text: "ARONA",       font: "Shadow" },          // ~50
  { text: "ARONA AGENT", font: "JS Block Letters" }, // ~83
  { text: "ARONA",       font: "JS Block Letters" }, // ~46
  { text: "ARONA AGENT", font: "Broadway KB" },      // ~79
  { text: "ARONA",       font: "Broadway KB" },      // ~43
  { text: "ARONA AGENT", font: "Small Shadow" },     // ~75
  { text: "ARONA",       font: "Small Shadow" },     // ~42
  { text: "ARONA AGENT", font: "Pyramid" },          // ~63
  { text: "ARONA",       font: "Pyramid" },          // ~35

  // —— 平面字体兜底（按宽度降序，AGENT → ARONA 配对） ——
  { text: "ARONA AGENT", font: "Big" },              // ~88
  { text: "ARONA",       font: "Big" },              // ~50
  { text: "ARONA AGENT", font: "Slant" },            // ~79
  { text: "ARONA",       font: "Slant" },            // ~43
  { text: "ARONA AGENT", font: "Standard" },         // ~79
  { text: "ARONA",       font: "Standard" },         // ~43
  { text: "ARONA AGENT", font: "Small" },            // ~66
  { text: "ARONA",       font: "Small" },            // ~39
  { text: "ARONA",       font: "Mini" },             // ~34
  { text: "ARONA",       font: "Bubble" },           // ~32
  { text: "ARONA",       font: "Digital" },          // ~22
];

/**
 * 输出开屏 logo。根据终端宽度自动选择 figlet 字体，
 * 确保艺术字不会超出终端宽度导致换行错乱。
 */
export function printLogo(): void {
  const cols = process.stdout.columns ?? 80;
  const indent = "  ";
  const pad = 3; // 边框内 padding

  for (const { text, font } of VARIANTS) {
    try {
      const rendered = figlet.textSync(text, { font });
      let lines = rendered.split("\n");
      // 去除首尾全空行
      lines = lines.filter((l) => l.trim().length > 0);
      if (lines.length === 0) continue;

      const maxLen = Math.max(...lines.map((l) => l.length));
      const innerWidth = maxLen + pad * 2; // 内容区宽度（不含 ║）
      const totalWidth = innerWidth + 2 + indent.length; // +2 for ║║

      if (totalWidth > cols) continue;

      // 三段渐变：上 1/3 蓝、中 1/3 浅蓝、下 1/3 青
      const n = lines.length;
      const bEnd = Math.floor(n / 3);
      const lEnd = Math.floor((n * 2) / 3);

      const border = "═".repeat(innerWidth);
      const blank = " ".repeat(innerWidth);
      const padStr = " ".repeat(pad);

      const out: string[] = [];
      out.push(`${C}${indent}╔${border}╗${R}`);
      out.push(`${C}${indent}║${blank}║${R}`);
      lines.forEach((line, i) => {
        const color = i < bEnd ? B : i < lEnd ? L : C;
        const padded = line.padEnd(maxLen, " ");
        out.push(`${C}${indent}║${padStr}${color}${padded}${C}${padStr}║${R}`);
      });
      out.push(`${C}${indent}║${blank}║${R}`);
      out.push(`${C}${indent}╚${border}╝${R}`);

      process.stdout.write("\n" + out.join("\n") + "\n\n");
      return;
    } catch {
      // 字体不存在或渲染失败，尝试下一个
      continue;
    }
  }

  // 所有字体都放不下，退化为单行文字
  process.stdout.write(`${C}  ARONA AGENT${R}\n\n`);
}
