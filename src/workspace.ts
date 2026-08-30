// 工作区（workspace）：会话所属的目录。CLI 以启动目录为工作区；GUI 支持在下拉里切换，
// 切换后重建 Agent 会话（SDK cwd 跟随），新会话归属新工作区。
// 会话 header 记录工作区绝对路径，展示层（CLI /resume 选择器、GUI 侧栏）按工作区分组。
import { basename, join, resolve } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { t } from "./locale.ts";

// 活动工作区（GUI 切换时由 setActiveWorkspace 更新；null = 跟随进程启动目录）。
// agent.ts / coding_agent.ts 的 SDK cwd 均取 currentWorkspace()，切换后新会话即在新目录生效。
let activeWorkspace: string | null = null;
// 进程启动目录在模块加载时定格（CLI 语义：启动目录即工作区）
const startupDir = resolve(process.cwd());

/** 当前活动工作区（绝对路径）。未显式设置时 = 进程启动目录（CLI）。 */
export function currentWorkspace(): string {
  return activeWorkspace ?? startupDir;
}

/**
 * GUI 默认工作区：家目录。GUI 的进程启动目录对用户无意义（多为安装/项目目录），
 * 不作为工作区——GUI 启动时无条件设定活动工作区（上次选择，缺省回落家目录），
 * 因此 GUI 下本回退值不会生效；工作区列表也只含显式选择与会话推导，无启动目录。
 */
export function guiDefaultWorkspace(): string {
  return homedir();
}

/** 设置活动工作区（GUI 切换工作区时调用；CLI 不调用，始终为启动目录）。 */
export function setActiveWorkspace(path: string): void {
  activeWorkspace = resolve(path);
}

/** 工作区显示名：取目录名；家目录显示「用户目录」；根目录显示 /；空值 = 旧会话未记录工作区，显示「未分组」。 */
export function workspaceLabel(workspace: string | null | undefined): string {
  if (!workspace) return t("未分组", "Ungrouped");
  if (workspace === "/") return "/";
  if (workspace === homedir()) return t("用户目录", "Home");
  return basename(workspace) || workspace;
}

export interface WorkspaceGroup<T extends { workspace?: string; timestamp: string }> {
  /** 工作区绝对路径；null = 旧会话未记录（「未分组」组，恒排最后）。 */
  workspace: string | null;
  label: string;
  sessions: T[];
}

/**
 * 按工作区分组：组内按会话时间倒序；组间按组内最新会话时间倒序，「未分组」恒排最后。
 * 不区分 CLI/GUI 来源——同属一个工作区的会话归为一组。
 */
export function groupByWorkspace<T extends { workspace?: string; timestamp: string }>(
  sessions: T[],
): WorkspaceGroup<T>[] {
  const byKey = new Map<string | null, T[]>();
  for (const s of sessions) {
    const key = s.workspace || null;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(s);
  }
  const groups: WorkspaceGroup<T>[] = [];
  for (const [workspace, list] of byKey) {
    list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    groups.push({ workspace, label: workspaceLabel(workspace), sessions: list });
  }
  groups.sort((a, b) => {
    if (!a.workspace) return 1; // 未分组恒最后
    if (!b.workspace) return -1;
    return (b.sessions[0]?.timestamp ?? "").localeCompare(a.sessions[0]?.timestamp ?? "");
  });
  return groups;
}

// ============================================================
// 旧会话工作区推断（一次性回填）
// ============================================================

// POSIX 绝对路径（/Users/...、/home/...，含更深层级）。JSON 文本里路径两侧是引号/空白。
const POSIX_PATH_RE = /\/(?:Users|home)\/[^\s"'`,:;\\<>|*?[\]()]+/g;
// Windows 路径（JSON 内反斜杠成对出现：C:\\Users\\...）
const WIN_PATH_RE = /[A-Za-z]:(?:\\\\|\\)[^\s"',:;*?<>|]+/g;

/** 项目根标志文件：候选目录里存在任一即视为项目根（推断并列时的最强信号）。 */
const PROJECT_MARKERS = ["package.json", ".git", "pyproject.toml", "Cargo.toml", "go.mod", "requirements.txt", "pom.xml"];

/** 常见代码子目录名：路径并列时降低其优先级（工作区应是项目根而非其中的子目录）。 */
const CODE_DIR_NAMES = new Set([
  "src", "lib", "app", "bin", "dist", "build", "out", "test", "tests", "docs",
  "node_modules", "components", "utils", "hooks", "services", "pages", "api",
  "public", "assets", "scripts", "config", "types", "python", "gui", "pet",
]);

/** 推断时排除的目录（无项目意义）：系统根、用户家目录本身、常见系统目录。 */
function excludedDirs(): Set<string> {
  const home = homedir();
  return new Set([
    "/", "/Users", "/home", home,
    "/tmp", "/usr", "/var", "/etc", "/opt", "/bin", "/sbin", "/private",
    "/Applications", "/System", "/Library", "/Volumes",
    "/dev", "/run", "/proc", "/sys",
  ]);
}

function stripTrailingPunct(p: string): string {
  return p.replace(/[.,;:!?）、」』"'`]+$/g, "");
}

function looksLikeFile(lastSegment: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/.test(lastSegment);
}

function isProjectRoot(dir: string): boolean {
  try {
    return PROJECT_MARKERS.some((m) => existsSync(join(dir, m)));
  } catch {
    return false;
  }
}

/**
 * 从会话内容推断所属工作区：统计文本中出现的绝对路径的各级祖先目录频次，
 * 取出现 ≥2 次中频次最高的目录；并列时依次按「磁盘上是项目根（有标志文件）」
 * →「非常见代码目录名」→「更深」择优。纯聊天会话无路径，返回 null 保持「未分组」。
 */
export function inferWorkspaceFromContent(content: string): string | null {
  if (!content) return null;
  const excluded = excludedDirs();
  const counts = new Map<string, number>();

  const record = (rawPath: string, sep: string) => {
    let p = stripTrailingPunct(rawPath);
    if (sep === "\\") p = p.replace(/\\+/g, "\\");
    const segments = p.split(/[\\/]/).filter(Boolean);
    // 文件路径（末段带扩展名）只统计其目录祖先，不把文件本身当目录
    const dirLen = looksLikeFile(segments[segments.length - 1] ?? "") ? segments.length - 1 : segments.length;
    for (let i = 2; i <= dirLen; i++) {
      const dir = segments.slice(0, i).join(sep === "\\" ? "\\" : "/");
      const full = sep === "\\" ? dir : "/" + dir;
      if (excluded.has(full)) continue;
      counts.set(full, (counts.get(full) ?? 0) + 1);
    }
  };

  for (const m of content.match(POSIX_PATH_RE) ?? []) record(m, "/");
  for (const m of content.match(WIN_PATH_RE) ?? []) record(m, "\\");

  const maxCount = Math.max(0, ...counts.values());
  if (maxCount < 2) return null;
  let candidates = [...counts.entries()].filter(([, c]) => c === maxCount).map(([d]) => d);

  const deepest = (dirs: string[]): string | null =>
    dirs.length ? dirs.reduce((a, b) => (b.split(/[\\/]/).length > a.split(/[\\/]/).length ? b : a)) : null;

  // 1) 磁盘上的项目根（标志文件）
  const withMarkers = candidates.filter(isProjectRoot);
  if (withMarkers.length) return deepest(withMarkers);
  // 2) 排除常见代码子目录名
  const notCodeDir = candidates.filter((d) => !CODE_DIR_NAMES.has(d.split(/[\\/]/).pop()!.toLowerCase()));
  if (notCodeDir.length) candidates = notCodeDir;
  // 3) 并列取更深
  return deepest(candidates);
}
