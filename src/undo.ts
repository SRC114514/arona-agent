/**
 * 本地快照式撤销/重做 —— 完全不依赖 git。
 *
 * 工作模型:
 *   - 每个 ARONA Agent 回合(processInput 一次完整 prompt)结束时,
 *     扫描工作目录,与上一回合结束时的状态对比,产出 changed files 的 diff
 *   - 每个 diff 同时记录 before 与 after 的完整内容,作为 undo/redo 的最小单元
 *   - undo():反向应用栈顶 diff → pointer--
 *   - redo():正向应用 pointer+1 处的 diff → pointer++
 *   - 跨进程持久化:状态写到 ~/.arona/undo/<cwd-hash>/{state.json,snapshots/}
 *
 * 排除规则(硬编码):node_modules、.git、.venv、__pycache__、.DS_Store、
 * .trae、.workbuddy、dist、build、.cache。
 * 大小上限:单文件 > 5MB 不存内容(只记 hash 用于检测删除,无法 undo 二进制改动)。
 */

import { homedir } from "os";
import { join, relative, resolve } from "path";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { ARONA_DIR } from "./config.ts";
import { t } from "./locale.ts";

const UNDO_ROOT = join(ARONA_DIR, "undo");
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
// 单次快照最多扫描的文件数（超出即截断）：防止在 ~/、/ 等巨型目录下全盘递归把启动/回合拖死。
const MAX_SCAN_FILES = 20000;
// 递归深度上限，防御深目录/符号链接循环。
const MAX_SCAN_DEPTH = 12;
// 每处理这么多文件让出一次事件循环，避免阻塞 CLI 渲染/输入。
const SCAN_YIELD_EVERY = 400;

const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "__pycache__",
  ".trae",
  ".workbuddy",
  "dist",
  "build",
  ".cache",
  // 系统/巨型目录：undo 无意义，递归扫会拖垮启动（~/Library、/System、/usr 等）
  "Library",
  "Applications",
  "System",
  "private",
  "dev",
  "proc",
  "sys",
  "cores",
  "Volumes",
  "Network",
  "bin",
  "sbin",
  "usr",
  "var",
  "etc",
  "opt",
  "tmp",
  ".Trash",
]);

const DEFAULT_IGNORE_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
]);

interface FileEntry {
  /** 该文件在快照时刻是否存在于工作目录 */
  existed: boolean;
  /** UTF-8 文本原文;二进制文件用 base64;超过大小上限或读取失败时为 null */
  content: string | null;
  /** 是否二进制(用 base64 存);用于 restore 时区分写入方式 */
  isBinary: boolean;
  /** content 的 sha1;用于扫描时检测变更 */
  hash: string;
  /** 文件大小(字节) */
  size: number;
}

interface TurnDiff {
  /** 该回合的时间戳 */
  timestamp: number;
  /** 该回合内被改的文件: abs path → { before, after } */
  files: Record<string, { before: FileEntry; after: FileEntry }>;
}

interface PersistedState {
  cwd: string;
  pointer: number;
  turns: Array<{ timestamp: number; snapshotFile: string; fileCount: number }>;
}

function cwdHash(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 16);
}

export class UndoManager {
  private cwd: string;
  private storeDir: string;
  private snapshotsDir: string;
  private stateFile: string;
  /** turns 索引元数据(不含内容) */
  private turns: PersistedState["turns"] = [];
  /** 指针: -1 = 仅基线(无任何应用过的回合);0 = 已应用 turns[0];N = 已应用 turns[N] */
  private pointer = -1;
  /** 回合开始前的快照(等回合结束后做 diff) */
  private pendingBefore: Map<string, FileEntry> | null = null;
  /** 当前基线快照(= pointer 指向的回合结束时的状态,或初始状态) */
  private baseline: Map<string, FileEntry> = new Map();
  /** 后台基线快照 in-flight（load() 启动；beforeTurn 会先等它，避免与首回合扫描并发/双扫） */
  private baselinePromise: Promise<void> | null = null;
  private ready = false;

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
    const hash = cwdHash(this.cwd);
    this.storeDir = join(UNDO_ROOT, hash);
    this.snapshotsDir = join(this.storeDir, "snapshots");
    this.stateFile = join(this.storeDir, "state.json");
    mkdirSync(this.snapshotsDir, { recursive: true });
  }

  /**
   * 启动时调用:加载持久化状态(如有),并在后台异步刷新基线为当前工作目录真实状态。
   * 基线扫描为后台异步 + 有界(MAX_SCAN_FILES/深度/系统目录):在 ~/、/ 等巨型目录下
   * 同步全盘递归会卡死启动。
   */
  load(): void {
    try {
      if (existsSync(this.stateFile)) {
        const raw = readFileSync(this.stateFile, "utf-8");
        const data = JSON.parse(raw) as PersistedState;
        if (data.cwd === this.cwd) {
          this.turns = data.turns ?? [];
          this.pointer = typeof data.pointer === "number" ? data.pointer : -1;
        } else {
          this.turns = [];
          this.pointer = -1;
        }
      }
    } catch {
      // 状态文件损坏,从空开始
      this.turns = [];
      this.pointer = -1;
    }
    // 重新扫描当前状态,作为新一回合的 baseline
    // (跨 ARONA 重启时:用户在 ARONA 之外可能改过文件,
    //  原有 turns 已与新基线脱钩,清掉 redo 段以避免错乱)
    if (this.pointer < this.turns.length - 1) {
      this.turns = this.turns.slice(0, this.pointer + 1);
    }
    this.pendingBefore = null;
    this.ready = false;
    // 后台异步建基线;失败也放行(空基线,undo 退化为不可用但不卡启动)
    this.baselinePromise = this.takeSnapshot()
      .then((snap) => {
        this.baseline = snap;
        this.ready = true;
      })
      .catch(() => {
        this.ready = true;
      });
  }

  /** 等待后台基线快照完成（beforeTurn 调用，避免与首回合扫描并发/双扫）。 */
  private async ensureBaselineReady(): Promise<void> {
    if (this.baselinePromise) {
      const p = this.baselinePromise;
      this.baselinePromise = null;
      try {
        await p;
      } catch {
        // 基线失败:忽略,继续
      }
    }
  }

  /**
   * 每个 Agent 回合开始前调用,记录 before 快照。
   * 与 load() 配合:回合开始时 baseline = load 时扫的;这里再扫一次 = "before"
   * (一般等同 baseline,除非用户在回合间隙手动改了文件)。
   */
  async beforeTurn(): Promise<void> {
    await this.ensureBaselineReady();
    this.pendingBefore = await this.takeSnapshot();
  }

  /**
   * 每个 Agent 回合结束后调用,与 before 对比,产出 diff 入栈。
   * 没有任何变化时跳过(不污染栈)。
   */
  async afterTurn(): Promise<void> {
    if (!this.ready) return; // 基线未就绪(后台仍在扫):跳过本回合 undo 记录
    if (!this.pendingBefore) {
      // 没 beforeTurn 直接 afterTurn:退化为只对 baseline 做对比
      this.pendingBefore = new Map(this.baseline);
    }
    const after = await this.takeSnapshot();
    const diff = this.computeDiff(this.pendingBefore, after);
    this.pendingBefore = null;
    if (diff === null) {
      // 没有任何变化:不污染栈,但更新 baseline 防止下回合做无意义 diff
      this.baseline = after;
      return;
    }
    // 截断 redo 段(用户在中途发新消息,后续 redo 失效)
    if (this.pointer < this.turns.length - 1) {
      this.turns = this.turns.slice(0, this.pointer + 1);
    }
    const turnId = this.turns.length;
    const snapshotFile = `turn-${String(turnId).padStart(4, "0")}.json`;
    writeFileSync(
      join(this.snapshotsDir, snapshotFile),
      JSON.stringify(diff),
      "utf-8",
    );
    this.turns.push({
      timestamp: diff.timestamp,
      snapshotFile,
      fileCount: Object.keys(diff.files).length,
    });
    this.pointer = this.turns.length - 1;
    this.baseline = after;
    this.persist();
  }

  /**
   * 撤销上一步。返回 { ok, message } 给命令调用方展示。
   */
  async undo(): Promise<{ ok: boolean; message: string }> {
    if (!this.ready) return { ok: false, message: t("撤销系统未就绪。", "Undo system is not ready.") };
    if (this.pointer < 0) {
      return { ok: false, message: t("无内容可撤销。", "Nothing to undo.") };
    }
    const turnMeta = this.turns[this.pointer];
    const diff = this.loadSnapshot(turnMeta.snapshotFile);
    if (!diff) {
      return { ok: false, message: t(`撤销快照 ${turnMeta.snapshotFile} 已损坏。`, `Undo snapshot ${turnMeta.snapshotFile} is corrupted.`) };
    }
    try {
      this.applyReverse(diff);
    } catch (err) {
      return {
        ok: false,
        message: t(`撤销失败:${err instanceof Error ? err.message : String(err)}`, `Undo failed: ${err instanceof Error ? err.message : String(err)}`),
      };
    }
    this.pointer--;
    // 更新 baseline 为"撤销后的状态"——直接重扫一次最稳
    this.baseline = await this.takeSnapshot();
    this.persist();
    return {
      ok: true,
      message: t(
        `已撤销第 ${this.pointer + 2} 回合的 ${Object.keys(diff.files).length} 个文件改动。使用 /redo 重做。`,
        `Undid ${Object.keys(diff.files).length} file change(s) from turn ${this.pointer + 2}. Use /redo to redo.`,
      ),
    };
  }

  /**
   * 重做下一步(已撤销的回合)。
   */
  async redo(): Promise<{ ok: boolean; message: string }> {
    if (!this.ready) return { ok: false, message: t("撤销系统未就绪。", "Undo system is not ready.") };
    if (this.pointer >= this.turns.length - 1) {
      return { ok: false, message: t("无内容可重做。", "Nothing to redo.") };
    }
    const turnMeta = this.turns[this.pointer + 1];
    const diff = this.loadSnapshot(turnMeta.snapshotFile);
    if (!diff) {
      return { ok: false, message: t(`重做快照 ${turnMeta.snapshotFile} 已损坏。`, `Redo snapshot ${turnMeta.snapshotFile} is corrupted.`) };
    }
    try {
      this.applyForward(diff);
    } catch (err) {
      return {
        ok: false,
        message: t(`重做失败:${err instanceof Error ? err.message : String(err)}`, `Redo failed: ${err instanceof Error ? err.message : String(err)}`),
      };
    }
    this.pointer++;
    this.baseline = await this.takeSnapshot();
    this.persist();
    return {
      ok: true,
      message: t(
        `已重做第 ${this.pointer + 1} 回合的 ${Object.keys(diff.files).length} 个文件改动。`,
        `Redid ${Object.keys(diff.files).length} file change(s) from turn ${this.pointer + 1}.`,
      ),
    };
  }

  // ---------------------------------------------------------------- private

  /**
   * 扫描工作目录,返回 path → FileEntry 的快照。
   * 对 ≤ MAX_FILE_BYTES 的文件,同时读出完整 content(二进制 base64,文本 utf-8),
   * 这样 diff 阶段无需再回读文件——回合内文件可能已被 Agent 改写,
   * 回读出来的就不再是 before 内容。
   * 异步 + 有界:每 SCAN_YIELD_EVERY 个文件让出一次事件循环;超过 MAX_SCAN_FILES 截断
   * (巨型目录如 ~/、/ 下不至于全盘递归卡死)。
   */
  private async takeSnapshot(): Promise<Map<string, FileEntry>> {
    const out = new Map<string, FileEntry>();
    const ctx = { count: 0, stop: false };
    await this.walk(this.cwd, (abs) => {
      try {
        const stat = statSync(abs);
        if (!stat.isFile()) return;
        const size = stat.size;
        if (size > MAX_FILE_BYTES) {
          // 太大:只记 size + hash(用流式哈希避免读全文入内存)
          const hash = this.hashLargeFile(abs);
          out.set(abs, { existed: true, content: null, isBinary: true, hash, size });
          return;
        }
        const buf = readFileSync(abs);
        const isBinary = this.looksBinary(buf);
        const hash = createHash("sha1").update(buf).digest("hex");
        const content = isBinary ? buf.toString("base64") : buf.toString("utf-8");
        out.set(abs, { existed: true, content, isBinary, hash, size });
      } catch {
        // 读失败:当作不存在
      }
    }, ctx, 0);
    return out;
  }

  private async walk(dir: string, cb: (abs: string) => void, ctx: { count: number; stop: boolean }, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || ctx.stop) return;
    let entries: { name: string; isDir: boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
      }));
    } catch {
      return;
    }
    for (const { name, isDir } of entries) {
      if (ctx.stop) return;
      if (isDir) {
        if (DEFAULT_IGNORE_DIRS.has(name)) continue;
        // 跳过隐藏目录(以 . 开头)避免污染,但不强制(允许 .config 之类)
        // 这里维持简单:仅排除默认列表中的隐藏目录
        await this.walk(join(dir, name), cb, ctx, depth + 1);
      } else {
        if (DEFAULT_IGNORE_FILES.has(name)) continue;
        const abs = join(dir, name);
        cb(abs);
        ctx.count++;
        if (ctx.count >= MAX_SCAN_FILES) {
          ctx.stop = true; // 巨型目录:截断,快照只覆盖已扫到的文件
          return;
        }
        if (ctx.count % SCAN_YIELD_EVERY === 0) {
          // 让出事件循环,避免同步全盘扫描阻塞 CLI 渲染/输入
          await new Promise<void>((r) => setImmediate(r));
        }
      }
    }
  }

  private hashLargeFile(abs: string): string {
    // 只读 4KB 头 + 4KB 尾 + size 当 hash 近似(够用于检测删除)
    // 用 fd 流式读取,避免把整个大文件读入内存
    let fd: number | null = null;
    try {
      const stat = statSync(abs);
      const size = stat.size;
      fd = openSync(abs, "r");
      const headLen = Math.min(4096, size);
      const tailLen = Math.min(4096, size);
      const head = Buffer.alloc(headLen);
      const tail = Buffer.alloc(tailLen);
      if (headLen > 0) readSync(fd, head, 0, headLen, 0);
      if (tailLen > 0) readSync(fd, tail, 0, tailLen, Math.max(0, size - tailLen));
      return createHash("sha1")
        .update(`${size}:`)
        .update(head)
        .update(":")
        .update(tail)
        .digest("hex");
    } catch {
      return "unreadable";
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
    }
  }

  private looksBinary(buf: Buffer): boolean {
    // 简单二进制检测:含 NUL 字节 → 二进制
    for (let i = 0; i < Math.min(buf.length, 8192); i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  }

  private writeFileEntry(abs: string, entry: FileEntry): void {
    if (entry.content === null) {
      throw new Error(t(
        `无法恢复 ${relative(this.cwd, abs)}:快照中未保存内容(可能过大)。`,
        `Cannot restore ${relative(this.cwd, abs)}: content was not saved in the snapshot (file too large?).`,
      ));
    }
    mkdirSync(resolve(abs, ".."), { recursive: true });
    const buf = entry.isBinary
      ? Buffer.from(entry.content, "base64")
      : Buffer.from(entry.content, "utf-8");
    writeFileSync(abs, buf);
  }

  private deleteFileEntry(abs: string): void {
    try {
      unlinkSync(abs);
    } catch {
      // 不存在就算了
    }
  }

  /**
   * 把 before / after 两个 snapshot 对比,产出 changed files 的 diff。
   * content 直接取自 snapshot（takeSnapshot 已读出）。
   * 无变化返回 null。
   */
  private computeDiff(
    before: Map<string, FileEntry>,
    after: Map<string, FileEntry>,
  ): TurnDiff | null {
    const files: TurnDiff["files"] = {};
    const allPaths = new Set<string>([...before.keys(), ...after.keys()]);
    for (const p of allPaths) {
      const b = before.get(p);
      const a = after.get(p);
      const bHash = b?.hash ?? "";
      const aHash = a?.hash ?? "";
      const bExisted = b?.existed ?? false;
      const aExisted = a?.existed ?? false;
      if (bHash === aHash && bExisted === aExisted) {
        continue; // 没变
      }
      const beforeEntry: FileEntry = b
        ? { ...b }
        : { existed: false, content: null, isBinary: false, hash: "", size: 0 };
      const afterEntry: FileEntry = a
        ? { ...a }
        : { existed: false, content: null, isBinary: false, hash: "", size: 0 };
      files[p] = { before: beforeEntry, after: afterEntry };
    }
    if (Object.keys(files).length === 0) return null;
    return { timestamp: Date.now(), files };
  }

  /**
   * 正向应用 diff(before → after)。
   */
  private applyForward(diff: TurnDiff): void {
    for (const [p, { after }] of Object.entries(diff.files)) {
      if (after.existed) {
        this.writeFileEntry(p, after);
      } else {
        this.deleteFileEntry(p);
      }
    }
  }

  /**
   * 反向应用 diff(after → before)。
   */
  private applyReverse(diff: TurnDiff): void {
    for (const [p, { before }] of Object.entries(diff.files)) {
      if (before.existed) {
        this.writeFileEntry(p, before);
      } else {
        this.deleteFileEntry(p);
      }
    }
  }

  private loadSnapshot(name: string): TurnDiff | null {
    const p = join(this.snapshotsDir, name);
    try {
      const raw = readFileSync(p, "utf-8");
      return JSON.parse(raw) as TurnDiff;
    } catch {
      return null;
    }
  }

  private persist(): void {
    const data: PersistedState = {
      cwd: this.cwd,
      pointer: this.pointer,
      turns: this.turns,
    };
    writeFileSync(this.stateFile, JSON.stringify(data, null, 2), "utf-8");
  }
}
