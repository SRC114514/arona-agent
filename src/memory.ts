import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { MEMORY_FILE, SESSIONS_DIR } from "./config.ts";
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
}

interface SessionHeader {
  type: "arona-session";
  version: number;
  timestamp: string;
  model: string;
  preview: string;
}

export function saveSession(messages: any[], model: string): string | null {
  if (!hasConversation) {
    console.log(t("无对话可保存。", "No conversation to save."));
    return null;
  }

  // Find first user message for preview
  const firstUserMsg = messages.find((m) => m.role === "user");
  let preview = "(empty)";
  if (firstUserMsg) {
    const content =
      typeof firstUserMsg.content === "string"
        ? firstUserMsg.content
        : Array.isArray(firstUserMsg.content)
          ? firstUserMsg.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join(" ")
          : "";
    preview = content.slice(0, 50).replace(/\n/g, " ");
    if (content.length > 50) preview += "...";
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safePreview = preview.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 30);
  const filename = `${timestamp}__${safePreview}.jsonl`;
  const filepath = join(SESSIONS_DIR, filename);

  const header: SessionHeader = {
    type: "arona-session",
    version: 1,
    timestamp: new Date().toISOString(),
    model,
    preview,
  };

  const lines: string[] = [JSON.stringify(header)];
  for (const msg of messages) {
    lines.push(JSON.stringify(msg));
  }
  writeFileSync(filepath, lines.join("\n"));
  console.log(t(`会话已保存到 ${filepath}`, `Session saved to ${filepath}`));
  return filepath;
}

/**
 * 将会话保存到指定路径（覆盖原文件）。
 * 用于 /resume 恢复的会话退出时保存回原文件，而非另存为新文件。
 * 保留原文件的 header（timestamp/preview），仅更新 model 字段。
 */
export function saveSessionToPath(filepath: string, messages: any[], model: string): void {
  let header: SessionHeader;
  try {
    const content = readFileSync(filepath, "utf-8");
    header = JSON.parse(content.split("\n")[0]) as SessionHeader;
    header.model = model; // 模型可能已切换，更新之
  } catch {
    // 原文件不存在或损坏，生成新 header
    const firstUserMsg = messages.find((m) => m.role === "user");
    let preview = "(empty)";
    if (firstUserMsg) {
      const content =
        typeof firstUserMsg.content === "string"
          ? firstUserMsg.content
          : Array.isArray(firstUserMsg.content)
            ? firstUserMsg.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join(" ")
            : "";
      preview = content.slice(0, 50).replace(/\n/g, " ");
      if (content.length > 50) preview += "...";
    }
    header = {
      type: "arona-session",
      version: 1,
      timestamp: new Date().toISOString(),
      model,
      preview,
    };
  }

  const lines: string[] = [JSON.stringify(header)];
  for (const msg of messages) {
    lines.push(JSON.stringify(msg));
  }
  writeFileSync(filepath, lines.join("\n"));
  console.log(t(`会话已保存到 ${filepath}`, `Session saved to ${filepath}`));
}

export function listSessions(): SessionInfo[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl"));
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

export function loadSession(filepath: string): any[] {
  const content = readFileSync(filepath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const messages: any[] = [];

  for (const line of lines) {
    const parsed = JSON.parse(line);
    if (parsed.type === "arona-session") continue; // Skip header
    messages.push(parsed);
  }

  return messages;
}
