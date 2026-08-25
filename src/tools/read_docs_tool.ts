import { basename } from "path";
import { Type } from "typebox";
import { defineTool, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { t } from "../locale.ts";
import { ARONA_DIR } from "../config.ts";

// 子 Agent 专属工具：主 Agent 默认由 Pi SDK 注入项目文档，子 Agent 用 noContextFiles:true 剔除，
// 需要了解工作目录约定时由子 Agent 主动调用本工具。发现逻辑直接复用 Pi SDK 的
// loadProjectContextFiles（候选名、优先级、cwd→父目录上溯、去重、~/.arona 全局文件、worktree
// 遮蔽判断全部与主 Agent 注入链路一致），保证"读到的主 Agent 一定有"。

// 两文档相似度 > 70% 时视为高度重复，只返回 CLAUDE.md。
const SIMILAR_THRESHOLD = 0.7;

/** 归一化：转小写并去掉全部非字母/数字字符（抹平大小写与格式差异，仅供相似度比较）。 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** 取定长字符 n-gram 集合（对中文/英文/混合文本通用）。 */
function shingles(s: string, n = 3): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

/** Dice 相似度 [0,1]：2·|A∩B| / (|A|+|B|)，对子串重叠、长度差异鲁棒。 */
export function docSimilarity(a: string, b: string): number {
  const A = shingles(normalize(a));
  const B = shingles(normalize(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const s of A) if (B.has(s)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function isClaude(p: string): boolean {
  const n = basename(p).toLowerCase();
  return n === "claude.md";
}
function isAgents(p: string): boolean {
  const n = basename(p).toLowerCase();
  return n === "agents.md";
}

export const readDocsTool = defineTool({
  name: "read_docs",
  label: "Read Project Docs",
  description: t(
    "读取工作目录的项目文档（CLAUDE.md / AGENTS.md，含 cwd 到上级目录与全局 ~/.arona，规则与主 Agent 注入链路一致）并打包返回，供需要了解工作目录约定或项目规则时主动查阅。",
    "Read the project docs (CLAUDE.md / AGENTS.md, from the cwd up through parent directories and the global ~/.arona — the same discovery chain the main agent injects) and return them together, for when you need to consult the workspace conventions or project rules.",
  ),
  parameters: Type.Object({}),
  execute: async () => {
    // 与主 Agent 相同的发现链路：候选名/优先级、cwd→父目录上溯、按路径去重、~/.arona 全局、worktree 遮蔽。
    let docs: Array<{ path: string; content: string }>;
    try {
      docs = loadProjectContextFiles({ cwd: process.cwd(), agentDir: ARONA_DIR });
    } catch {
      docs = [];
    }
    if (docs.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: t("未找到项目文档。", "No project docs found."),
        }],
        details: { similarity: undefined },
      };
    }
    const claude = docs.find((d) => isClaude(d.path));
    const agents = docs.find((d) => isAgents(d.path));
    let selected = docs;
    if (claude && agents && docSimilarity(claude.content, agents.content) > SIMILAR_THRESHOLD) {
      // 两文档高度重复：只留 CLAUDE.md
      selected = docs.filter((d) => !isAgents(d.path));
    }
    const blocks = selected.map((d) => `--- ${d.path} ---\n${d.content}`);
    return {
      content: [{ type: "text" as const, text: blocks.join("\n\n") }],
      details: { similarity: claude && agents ? docSimilarity(claude.content, agents.content) : undefined },
    };
  },
});
