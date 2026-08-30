import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, rmSync, appendFileSync } from "fs";
import { basename, join, resolve } from "path";
import { MEMORY_FILE, SESSIONS_DIR } from "./config.ts";
import { inferWorkspaceFromContent } from "./workspace.ts";
import { t, getLang } from "./locale.ts";

// ============================================================
// MEMORY.md management
// ============================================================

const DEFAULT_MEMORY_CONTENT_ZH = `# ARONA Memory

阿洛娜的持久记忆。每次会话启动时自动加载到 system prompt，由 Arona 主动调用 \`save_memory\` 工具维护。

按三个 category 组织：

## 老师

关于老师的硬事实：时区、设备、常用项目、身份背景等。
写入示例：\`save_memory(content="时区 Asia/Shanghai", category="老师")\` → 产生 \`## [老师] _<ISO 时间戳>_ 时区 Asia/Shanghai\`

## 小习惯

工作/工具/风格偏好，例如"写 Rust 喜欢先看 lifetime"、"不喜欢 commit 时自动 push"等。
写入示例：\`save_memory(content="...", category="小习惯")\` → 产生 \`## [小习惯] _<时间戳>_ ...\`

## 我们之间

互动记忆、共同事件。
一般条目：\`save_memory(content="...", category="我们之间")\` → 产生 \`## [我们之间] _<时间戳>_ ...\`

**心情基线**（跨会话持久化的情绪状态）使用专门标题，便于 Arona 启动时自动加载到 system prompt。具体格式见 system prompt 中"心情基线规则"段的写入格式说明。
`;

const DEFAULT_MEMORY_CONTENT_EN = `# ARONA Memory

Arona's persistent memory. Loaded into the system prompt at every session start, maintained by Arona via the \`save_memory\` tool.

Organized by three categories:

## Teacher

Hard facts about Sensei: timezone, devices, usual projects, background, etc.
Example write: \`save_memory(content="timezone Asia/Shanghai", category="Teacher")\` → produces \`## [Teacher] _<ISO timestamp>_ timezone Asia/Shanghai\`

## Habits

Work/tool/style preferences, e.g. "likes to check lifetimes first when writing Rust", "dislikes auto-push on commit", etc.
Example write: \`save_memory(content="...", category="Habits")\` → produces \`## [Habits] _<timestamp>_ ...\`

## Us

Interaction memories, shared events.
General entry: \`save_memory(content="...", category="Us")\` → produces \`## [Us] _<timestamp>_ ...\`

**Mood baseline** (the emotional state persisted across sessions) uses a dedicated heading so Arona can auto-load it into the system prompt at startup. See the "Mood baseline rules" section of the system prompt for the write format.
`;

/** 按当前语言返回默认 MEMORY.md 模板（首次写入时定型；存量文件不迁移）。 */
function getDefaultMemoryContent(): string {
  return getLang() === "en" ? DEFAULT_MEMORY_CONTENT_EN : DEFAULT_MEMORY_CONTENT_ZH;
}

export function loadMemory(): string {
  if (!existsSync(MEMORY_FILE)) {
    const content = getDefaultMemoryContent();
    writeFileSync(MEMORY_FILE, content);
    return content;
  }
  return readFileSync(MEMORY_FILE, "utf-8");
}

export function appendToMemory(content: string, category?: string): void {
  const timestamp = new Date().toISOString();
  const header = category ? `## [${category}]` : `## Memory`;
  const entry = `\n${header}\n_${timestamp}_\n${content}\n`;
  const current = existsSync(MEMORY_FILE) ? readFileSync(MEMORY_FILE, "utf-8") : "";
  writeFileSync(MEMORY_FILE, current + entry);
}

/**
 * 从 MEMORY.md 内容中提取最近一条心情基线记录。
 * 匹配中英双标题（"## [我们之间] · 心情基线" / "## [Us] · Mood baseline"）下、
 * 跳过时间戳行后的正文块（到下一个 ## 标题或文档末尾）。无则返回空字符串。
 */
export function loadMoodBaseline(memoryContent: string): string {
  if (!memoryContent) return "";
  const re = /## \[(?:我们之间|Us)\] · (?:心情基线|Mood baseline)\n_[^_\n]+_\n([\s\S]*?)(?=\n## |\n*$)/;
  const m = memoryContent.match(re);
  return m ? m[1].trim() : "";
}

// ============================================================
// 运行时记忆增量（MEMORY.md 变更检测 → 注入下一轮 user 消息末尾）
// ============================================================

// 上次注入时的记忆内容基线。null 表示尚未建立基线。
let memoryBaseline: string | null = null;

/**
 * 记录当前 MEMORY.md 内容为基线（不注入）。
 * session 创建时（initAgent / initSubAgent）调用：system prompt 开头的初始记忆
 * 快照已包含基线内容，避免首次 getMemoryDelta() 重复注入。
 */
export function snapshotMemory(): void {
  memoryBaseline = existsSync(MEMORY_FILE) ? readFileSync(MEMORY_FILE, "utf-8") : "";
}

/**
 * 检测 MEMORY.md 自基线以来是否变化，返回应注入到下一轮 user 消息末尾的增量；无变化返回 null。
 * - 纯追加（save_memory 走 appendToMemory 追加）：返回新增后缀，token 开销最小。
 * - 检测到非纯追加（手动编辑/重写）：退化为返回最新全量内容，保证不丢信息。
 * - 有变化时只注入一次，之后前缀稳定，缓存不重复失效。
 */
export function getMemoryDelta(): string | null {
  const current = existsSync(MEMORY_FILE) ? readFileSync(MEMORY_FILE, "utf-8") : "";
  if (memoryBaseline === null) {
    // 未建立基线（理论上 snapshotMemory 已在 init 时调用）：以当前内容为基线，不注入
    memoryBaseline = current;
    return null;
  }
  if (current === memoryBaseline) return null;

  // 找最长公共前缀（append-only 时 LCP 就是旧内容，差异 = 新增后缀）
  let i = 0;
  const maxLen = Math.min(memoryBaseline.length, current.length);
  while (i < maxLen && memoryBaseline[i] === current[i]) i++;

  const isPureAppend = i >= memoryBaseline.length && current.length > memoryBaseline.length;
  const added = current.slice(i).trim();
  memoryBaseline = current; // 无论注入与否都更新基线，避免同内容重复注入

  if (!added) return null;
  if (!isPureAppend) {
    // 手动编辑/重写：LCP 截断不可靠，退化为全量最新内容
    return `# 记忆更新（MEMORY.md 内容已变更）\n\n${current}`;
  }
  return `# 记忆更新（新增）\n\n${added}`;
}

// ============================================================
// Session management (conditional save)
// ============================================================

let hasConversation = false;

export function markConversation(): void {
  hasConversation = true;
}

export function resetConversationFlag(): void {
  hasConversation = false;
}

export function getHasConversation(): boolean {
  return hasConversation;
}

export interface SessionInfo {
  filename: string;
  path: string;
  timestamp: string;
  preview: string;
  model: string;
  /** 所属工作区（创建会话时的启动目录绝对路径）；旧会话可能缺失（undefined → 展示层归入「未分组」）。 */
  workspace?: string;
}

interface SessionHeader {
  type: "arona-session";
  version: number;
  timestamp: string;
  model: string;
  preview: string;
  /** 所属工作区（启动目录绝对路径）。version 2 起写入；读取不校验版本，缺失视为「未分组」。 */
  workspace?: string;
}

/** 从首条 user 消息提取会话预览。 */
function firstUserPreview(messages: any[]): string {
  const firstUserMsg = messages.find((m) => m.role === "user");
  if (!firstUserMsg) return "(empty)";
  const content =
    typeof firstUserMsg.content === "string"
      ? firstUserMsg.content
      : Array.isArray(firstUserMsg.content)
        ? firstUserMsg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join(" ")
        : "";
  let preview = content.slice(0, 50).replace(/\n/g, " ");
  if (content.length > 50) preview += "...";
  return preview;
}

export function saveSession(messages: any[], model: string, silent = false, workspace?: string): string | null {
  if (!hasConversation) {
    if (!silent) console.log(t("无对话可保存。", "No conversation to save."));
    return null;
  }

  // Find first user message for preview (剥离桌宠手势注入块，见 firstUserPreview)
  const preview = firstUserPreview(messages);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safePreview = preview.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 30);
  const filename = `${timestamp}__${safePreview}.jsonl`;
  const filepath = join(SESSIONS_DIR, filename);

  // 落盘前修剪残缺尾部（生成中存盘时可能含未配对 toolCall，防 resume 后服务端 400；
  // 对完整历史幂等）。只影响文件内容，不改内存——回合可继续，完成后以完整版覆盖。
  const persisted = trimPartialTail(messages);

  const header: SessionHeader = {
    type: "arona-session",
    version: 2,
    timestamp: new Date().toISOString(),
    model,
    preview,
    workspace,
  };

  const lines: string[] = [JSON.stringify(header)];
  for (const msg of persisted) {
    lines.push(JSON.stringify(msg));
  }
  writeFileSync(filepath, lines.join("\n"));
  if (!silent) console.log(t(`会话已保存到 ${filepath}`, `Session saved to ${filepath}`));
  return filepath;
}

/**
 * 将会话保存到指定路径（覆盖原文件）。
 * 用于 /resume 恢复的会话退出时保存回原文件，而非另存为新文件。
 * 保留原文件的 header（timestamp/preview/workspace），仅更新 model 字段；
 * 原 header 缺 workspace（旧会话）且调用方传入时补写——resume 保存即归入当前工作区。
 */
export function saveSessionToPath(filepath: string, messages: any[], model: string, silent = false, workspace?: string): void {
  let header: SessionHeader;
  try {
    const content = readFileSync(filepath, "utf-8");
    header = JSON.parse(content.split("\n")[0]) as SessionHeader;
    header.model = model; // 模型可能已切换，更新之
    if (!header.workspace && workspace) header.workspace = workspace;
  } catch {
    // 原文件不存在或损坏，生成新 header（剥离桌宠手势注入块，见 firstUserPreview）
    const preview = firstUserPreview(messages);
    header = {
      type: "arona-session",
      version: 2,
      timestamp: new Date().toISOString(),
      model,
      preview,
      workspace,
    };
  }

  const lines: string[] = [JSON.stringify(header)];
  // 同 saveSession：落盘前修剪残缺尾部（幂等；只影响文件，不改内存）
  for (const msg of trimPartialTail(messages)) {
    lines.push(JSON.stringify(msg));
  }
  writeFileSync(filepath, lines.join("\n"));
  if (!silent) console.log(t(`会话已保存到 ${filepath}`, `Session saved to ${filepath}`));
}

export function listSessions(): SessionInfo[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".coding.jsonl"));
  const sessions: SessionInfo[] = [];

  for (const filename of files) {
    const filepath = join(SESSIONS_DIR, filename);
    try {
      const content = readFileSync(filepath, "utf-8");
      const firstLine = content.split("\n")[0];
      const header = JSON.parse(firstLine) as SessionHeader;
      if (header.type === "arona-session") {
        sessions.push({
          filename,
          path: filepath,
          timestamp: header.timestamp,
          preview: header.preview,
          model: header.model,
          workspace: header.workspace,
        });
      }
    } catch {
      // Skip malformed files
    }
  }

  // Sort by timestamp descending (newest first)
  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

/** 删除会话文件及其子代理过程 sidecar（GUI 侧栏右键菜单）。文件不存在时静默成功。 */
export function deleteSession(filepath: string): void {
  try {
    rmSync(filepath, { force: true });
    rmSync(codingSidecarPath(filepath), { force: true });
  } catch (err) {
    console.warn(`deleteSession: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * 重命名会话（更新 header preview 并同步改文件名）。
 * 返回新路径；解析失败返回 null（不动原文件）。
 */
export function renameSession(filepath: string, title: string): string | null {
  try {
    const content = readFileSync(filepath, "utf-8");
    const lines = content.split("\n");
    const header = JSON.parse(lines[0]) as SessionHeader;
    if (header.type !== "arona-session") return null;

    const preview = title.trim().slice(0, 50) || header.preview;
    header.preview = preview;
    lines[0] = JSON.stringify(header);

    // 沿用原文件名的时间戳前缀，替换预览 slug（basename：Windows 路径分隔符是 \，split("/") 会把整个路径当文件名）
    const stamp = basename(filepath).split("__")[0] || new Date().toISOString().replace(/[:.]/g, "-");
    const safePreview = preview.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 30);
    const newPath = join(SESSIONS_DIR, `${stamp}__${safePreview}.jsonl`);

    writeFileSync(newPath, lines.join("\n"));
    if (newPath !== filepath) {
      unlinkSync(filepath);
      // 子代理过程 sidecar 跟随改名
      const oldSidecar = codingSidecarPath(filepath);
      if (existsSync(oldSidecar)) {
        try {
          appendFileSync(codingSidecarPath(newPath), readFileSync(oldSidecar, "utf-8"));
          unlinkSync(oldSidecar);
        } catch (err) {
          console.warn(`renameSession sidecar: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    return newPath;
  } catch (err) {
    console.warn(`renameSession: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * 修剪尾部残缺回合（"未完成也存盘"场景专用）：LLM 生成中落盘时，尾部可能存在
 * 未应答的 toolCall（没有配对的 toolResult，甚至参数只生成了半截）——直接写盘，
 * resume 后提交服务端会 400。规则：
 * - toolCall/toolResult 数量不配对 → 修剪回最后一条 user 消息（含）；
 * - 数量配对但尾部停在 toolResult（模型总结还没生成）→ 同样修剪：resume 后的
 *   新输入会与 toolResult 所在的 user 消息相邻，仍有 400 风险；
 * - 以 assistant 文本收尾（哪怕是生成到一半的文本）→ 保留：API 合法状态，
 *   重启恢复后能看到已生成的半成品，可让模型接着写。
 * 只影响写盘内容，不改内存中的会话（后台回合继续跑，完成后以完整版覆盖存盘）。
 */
export function trimPartialTail(messages: any[]): any[] {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return []; // 没有用户消息：历史不完整（不该发生），退到空
  const tail = messages.slice(lastUser + 1);
  let calls = 0;
  let results = 0;
  for (const m of tail) {
    if (m.role === "assistant") {
      for (const b of m.content ?? []) {
        if (b.type === "toolCall") calls++;
      }
    } else if (m.role === "toolResult") {
      results++;
    }
  }
  const last = tail[tail.length - 1];
  const endsOnToolResult = last?.role === "toolResult";
  if (calls === results && !endsOnToolResult) return messages; // 合法收尾（含半截文本），原样保存
  return messages.slice(0, lastUser + 1);
}

export function loadSession(filepath: string): any[] {  const content = readFileSync(filepath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const messages: any[] = [];

  for (const line of lines) {
    const parsed = JSON.parse(line);
    if (parsed.type === "arona-session") continue; // Skip header
    messages.push(parsed);
  }

  return messages;
}

/**
 * 写入会话的所属工作区（就地改 header 首行，文件名不变）。
 * force=false 时仅补写缺失的 workspace（旧会话回填）；force=true 用于「移动到工作区」。
 */
export function setSessionWorkspace(filepath: string, workspace: string, force = false): boolean {
  try {
    const content = readFileSync(filepath, "utf-8");
    const nl = content.indexOf("\n");
    const firstLine = nl >= 0 ? content.slice(0, nl) : content;
    const header = JSON.parse(firstLine) as SessionHeader;
    if (header.type !== "arona-session") return false;
    if (header.workspace && !force) return false;
    header.workspace = resolve(workspace);
    const rest = nl >= 0 ? content.slice(nl) : "";
    writeFileSync(filepath, JSON.stringify(header) + rest);
    return true;
  } catch (err) {
    console.warn(`setSessionWorkspace: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * 一次性回填：为未记录工作区的旧会话按内容推断工作区（会话中出现频率最高的项目目录）。
 * 推断不出（纯聊天、无绝对路径）保持未分组。返回回填数量。CLI/GUI 启动时各调用一次。
 */
export function backfillLegacyWorkspaces(): number {
  let migrated = 0;
  for (const s of listSessions()) {
    if (s.workspace) continue;
    try {
      const content = readFileSync(s.path, "utf-8");
      const inferred = inferWorkspaceFromContent(content);
      if (inferred && setSessionWorkspace(s.path, inferred)) migrated++;
    } catch {
      // 单个文件损坏不影响其余回填
    }
  }
  return migrated;
}

// ============================================================
// 编码子代理过程留痕（sidecar：`<会话名>.coding.jsonl`）
// 单独存放：不出现在会话列表（header 类型不同被过滤），loadSession 不读它（不进主 Agent 上下文）。
// ============================================================

export interface CodingRun {
  agent: string;        // millennium | justice
  toolCallId: string;   // 主会话中 create_subagent 调用 id，回放时按此关联
  task: string;
  timestamp: string;
  messages: any[];      // 子代理 session 的全量消息快照
}

function codingSidecarPath(filepath: string): string {
  return filepath.replace(/\.jsonl$/, ".coding.jsonl");
}

/** 追加一条子代理执行记录到会话的 sidecar 文件（自动建 header）。 */
export function appendCodingRun(filepath: string, run: CodingRun): void {
  const sidecar = codingSidecarPath(filepath);
  try {
    const chunks: string[] = [];
    if (!existsSync(sidecar)) {
      chunks.push(JSON.stringify({ type: "arona-coding-log", version: 1 }));
    }
    chunks.push(JSON.stringify(run));
    appendFileSync(sidecar, chunks.join("\n") + "\n");
  } catch (err) {
    console.warn(`appendCodingRun: ${err instanceof Error ? err.message : err}`);
  }
}

/** 读取会话的全部子代理执行记录（按发生顺序）。sidecar 不存在返回空数组。 */
export function loadCodingRuns(filepath: string): CodingRun[] {
  const sidecar = codingSidecarPath(filepath);
  if (!existsSync(sidecar)) return [];
  try {
    const runs: CodingRun[] = [];
    for (const line of readFileSync(sidecar, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (parsed.type === "arona-coding-log") continue; // header
      runs.push(parsed as CodingRun);
    }
    return runs;
  } catch (err) {
    console.warn(`loadCodingRuns: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}
