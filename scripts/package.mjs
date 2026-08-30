#!/usr/bin/env node
// ARONA 一键打包器：把便携版 Python 3.13（python-build-standalone）、官方 Node 22、
// 全量 node_modules（含 Electron dist）和应用代码打成一个自包含 zip。
// 收到包的人什么都不用装、不用跑——解压后运行启动脚本即用（默认启动 GUI）。
//
// Windows 优先：默认 --target win 在当前机器交叉打出 Windows x64 包（全部依赖走
// 预编译 wheel，无需 Windows 机器）；--target native 打当前平台的原生包。
//
// 用法：npm run package [-- --target win --out-dir dist ...]
// 详见 scripts/package.mjs --help。

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { platform, arch } from "node:process";

// ---------- 常量 ----------

const APP_DIR_NAME = "arona-agent";
const PYTHON_MINOR = "3.13";
// Node 版本解析失败时的兜底（满足 engines >=22.19.0）
const NODE_VERSION_FALLBACK = "22.19.0";
// pip 清华源（与 src/setup.ts、src/gpt_sovits_local.ts 一致）
const PIP_TSINGHUA = "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple";
// python-build-standalone 仓库。GitHub 直连国内基本不通，默认走 npmmirror 同步镜像；
// 传 --pbs-mirror github 可切回 GitHub Releases（可再配 --gh-proxy 代理前缀）
const PBS_REPO = "astral-sh/python-build-standalone";
const PBS_NPMMIRROR = "https://registry.npmmirror.com/-/binary/python-build-standalone";
// Node / Electron 默认镜像：华为云（electron_bin.ts 的 Electron 下载同源）
const NODE_DEFAULT_MIRROR = "https://mirrors.huaweicloud.com/nodejs";
const ELECTRON_MIRROR = "https://mirrors.huaweicloud.com/electron/";

const require = createRequire(import.meta.url);
const pkgVersion = require(join(projectRoot(), "package.json")).version;

function projectRoot() {
  return resolve(import.meta.dirname, "..");
}

// ---------- CLI 参数 ----------

function parseArgs(argv) {
  const opts = {
    outDir: join(projectRoot(), "dist"),
    target: "win", // Windows 优先：默认交叉打 Windows x64 包；"native" 打当前平台包
    nodeMirror: process.env.NODE_MIRROR || NODE_DEFAULT_MIRROR,
    pbsMirror: process.env.PBS_MIRROR || PBS_NPMMIRROR, // 传 "github" 走 GitHub Releases
    electronMirror: process.env.ELECTRON_MIRROR || ELECTRON_MIRROR,
    ghProxy: process.env.GH_PROXY || "",
    pythonTriple: null,
    nodeVersion: null,
    skipPip: false,
    skipZip: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--out-dir") opts.outDir = resolve(val());
    else if (a === "--target") opts.target = val();
    else if (a === "--node-mirror") opts.nodeMirror = val().replace(/\/$/, "");
    else if (a === "--pbs-mirror") opts.pbsMirror = val().replace(/\/$/, "");
    else if (a === "--electron-mirror") opts.electronMirror = val().replace(/\/$/, "");
    else if (a === "--gh-proxy") opts.ghProxy = val().replace(/\/$/, "");
    else if (a === "--python-triple") opts.pythonTriple = val();
    else if (a === "--node-version") opts.nodeVersion = val();
    else if (a === "--skip-pip") opts.skipPip = true;
    else if (a === "--skip-zip") opts.skipZip = true;
    else if (a === "--help" || a === "-h") {
      console.log(`用法: node scripts/package.mjs [选项]

产物为自包含 zip：目标机器解压后运行启动脚本即用（无参数默认启动 GUI），无需安装任何环境。

选项:
  --target <t>           产物平台：win（默认，交叉打 Windows x64 包）| native（打当前平台包）
  --out-dir <dir>        产物输出目录（默认 dist/）
  --node-mirror <url>    Node 镜像（默认华为云）
  --pbs-mirror <url>     python-build-standalone 镜像（默认 npmmirror；传 github 走 GitHub）
  --electron-mirror <url> Electron 二进制镜像（默认华为云，交叉打包时换 Windows dist 用）
  --gh-proxy <prefix>    GitHub 下载代理前缀（配合 --pbs-mirror github）
  --python-triple <t>    强制指定 python-build-standalone 平台三元组
  --node-version <ver>   指定 Node 版本（默认自动取 22.x 最新且 >= 22.19.0）
  --skip-pip             跳过 Python 依赖安装
  --skip-zip             只组装 staging 目录不压缩`);
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}（--help 查看用法）`);
      process.exit(1);
    }
  }
  return opts;
}

// ---------- 目标平台解析 ----------

function targetPlatform(opts) {
  if (!opts.target || opts.target === "native") return platform;
  const map = { win: "win32", win32: "win32", darwin: "darwin", mac: "darwin", linux: "linux" };
  const tp = map[opts.target];
  if (!tp) throw new Error(`未知 --target: ${opts.target}（可选 win / native）`);
  return tp;
}

/** 交叉打包 = 目标平台与当前构建机不同 */
function isCross(tp) {
  return tp !== platform;
}

function pbsTriple(tp) {
  if (tp === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (tp === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  if (tp === "win32") return "x86_64-pc-windows-msvc";
  throw new Error(`不支持的目标平台: ${tp}`);
}

function nodeOs(tp) {
  return tp === "win32" ? "win" : tp; // darwin | linux | win
}

function nodeCpu(tp) {
  if (tp === "win32") return "x64"; // Windows 交叉包固定 x64
  return arch === "arm64" ? "arm64" : "x64";
}

function platformName(tp) {
  return tp === "win32" ? "windows" : tp;
}

// ---------- 下载 / 解压（走系统 curl/tar，天然跟随代理与重定向） ----------

function run(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd, shell: platform === "win32" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 退出码 ${r.status}`);
}

function fetchText(url) {
  const r = spawnSync("curl", ["-fsSL", "--retry", "3", url], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`curl ${url} 退出码 ${r.status}`);
  return r.stdout;
}

function download(url, dest) {
  console.log(`  ↓ 下载 ${basename(url)}`);
  run("curl", ["-fL", "--retry", "3", "--progress-bar", "-o", dest, url]);
}

/** 解包 tar.gz / tar.xz / zip 到 destDir，stripTopLayers 为 1 时去掉顶层目录 */
function extract(archivePath, destDir, { stripTop = 1 } = {}) {
  mkdirSync(destDir, { recursive: true });
  const hostWin = platform === "win32";
  const isZip = archivePath.endsWith(".zip");
  // Windows 自带 bsdtar；macOS/Linux 的 tar 同样支持 zip（bsdtar）或至少 tar.gz/xz
  if (isZip && (hostWin || stripTop === 0)) {
    if (hostWin && stripTop === 1) {
      // Windows bsdtar 解 zip 不支持 strip-components：先解到临时目录再挪
      const tmp = destDir + ".extract";
      rmSync(tmp, { recursive: true, force: true });
      run("tar", ["-xf", archivePath, "-C", tmp]);
      const entries = readdirSync(tmp);
      const inner = entries.length === 1 && statSync(join(tmp, entries[0])).isDirectory() ? join(tmp, entries[0]) : tmp;
      cpSync(inner, destDir, { recursive: true });
      rmSync(tmp, { recursive: true, force: true });
      return;
    }
    run("tar", ["-xf", archivePath, "-C", destDir]);
    return;
  }
  run("tar", ["-xf", archivePath, ...(stripTop ? ["--strip-components", "1"] : []), "-C", destDir]);
}

// ---------- python-build-standalone ----------

/** 从资产名列表里挑 cpython-3.13.x install_only 包（排除 stripped/freethreaded） */
function pickPbsAsset(names, triple) {
  return names
    .filter((n) => n.startsWith(`cpython-${PYTHON_MINOR}.`) && n.includes(triple) && n.endsWith("install_only.tar.gz"))
    .sort()
    .at(-1);
}

/** npmmirror 风格镜像：/ 为 tag 列表，/<tag>/ 为资产列表（均为 JSON 数组）。从最新 tag 往前找第一个有匹配资产的。 */
function resolvePbsViaMirror(mirror, triple) {
  const tags = JSON.parse(fetchText(`${mirror}/`))
    .map((e) => e.name.replace(/\/$/, ""))
    .filter((n) => /^\d{8}$/.test(n))
    .sort()
    .reverse();
  for (const tag of tags.slice(0, 8)) {
    let listing;
    try {
      listing = JSON.parse(fetchText(`${mirror}/${tag}/`));
    } catch {
      continue;
    }
    const asset = pickPbsAsset(listing.map((e) => e.name), triple);
    if (asset) {
      const entry = listing.find((e) => e.name === asset);
      return { tag, asset, url: entry?.url || `${mirror}/${tag}/${encodeURIComponent(asset)}` };
    }
  }
  return null;
}

/** GitHub Releases：API 取最新 release 再挑资产 */
function resolvePbsViaGitHub(ghProxy, triple) {
  const api = `https://api.github.com/repos/${PBS_REPO}/releases/latest`;
  const release = JSON.parse(fetchText(api));
  const asset = pickPbsAsset((release.assets || []).map((a) => a.name), triple);
  if (!asset) return null;
  const url = `${ghProxy ? ghProxy + "/" : ""}https://github.com/${PBS_REPO}/releases/download/${release.tag_name}/${asset}`;
  return { tag: release.tag_name, asset, url };
}

function preparePython(cacheDir, opts, tp) {
  const triple = opts.pythonTriple || pbsTriple(tp);
  console.log(`\n[2/5] Python 3.13（python-build-standalone，${triple}）`);

  let resolved = null;
  if (opts.pbsMirror !== "github") {
    try {
      resolved = resolvePbsViaMirror(opts.pbsMirror, triple);
    } catch (err) {
      console.log(`  ! 镜像 ${opts.pbsMirror} 获取失败（${err.message}），回退 GitHub`);
    }
  }
  if (!resolved) {
    try {
      resolved = resolvePbsViaGitHub(opts.ghProxy, triple);
    } catch (err) {
      throw new Error(
        `无法解析 python-build-standalone 资产（${err.message}）。\n` +
          `请检查网络，或用 --pbs-mirror <url> / --gh-proxy <prefix> 指定镜像或代理。`,
      );
    }
  }
  if (!resolved) throw new Error(`没有找到 cpython-${PYTHON_MINOR}.x + ${triple} 的 install_only 资产。`);
  console.log(`  版本 ${resolved.asset.replace(/-install_only\.tar\.gz$/, "")}（release ${resolved.tag}）`);

  const archive = join(cacheDir, resolved.asset);
  if (!existsSync(archive)) download(resolved.url, archive);
  else console.log(`  ↺ 使用缓存 ${resolved.asset}`);

  const dest = join(stagingDir(opts), "runtime", "python");
  rmSync(dest, { recursive: true, force: true });
  extract(archive, dest);
  return dest;
}

// ---------- Node ----------

function resolveNodeVersion(opts) {
  if (opts.nodeVersion) return opts.nodeVersion;
  try {
    const index = JSON.parse(fetchText(`${opts.nodeMirror}/index.json`));
    const v22 = index
      .map((e) => e.version) // 形如 "v22.21.1"
      .filter((v) => /^v22\.\d+\.\d+$/.test(v))
      .sort((a, b) =>
        (parseInt(b.split(".")[1]) - parseInt(a.split(".")[1])) ||
        (parseInt(b.split(".")[2]) - parseInt(a.split(".")[2])));
    if (v22.length) return v22[0].slice(1);
  } catch {
    console.log("  ! Node 版本索引获取失败，回退内置版本");
  }
  return NODE_VERSION_FALLBACK;
}

function prepareNode(cacheDir, opts, tp) {
  console.log(`\n[3/5] Node 运行时`);
  const version = resolveNodeVersion(opts);
  const os = nodeOs(tp);
  const cpu = nodeCpu(tp);
  const ext = os === "win" ? "zip" : "tar.xz";
  const filename = `node-v${version}-${os}-${cpu}.${ext}`;
  const url = `${opts.nodeMirror}/v${version}/${filename}`;
  console.log(`  Node v${version} (${os}-${cpu})`);

  const archive = join(cacheDir, filename);
  if (!existsSync(archive)) download(url, archive);
  else console.log(`  ↺ 使用缓存 ${filename}`);

  const dest = join(stagingDir(opts), "runtime", "node");
  rmSync(dest, { recursive: true, force: true });
  extract(archive, dest);
  return dest;
}

// ---------- Python 依赖 ----------

/** 目标平台 site-packages 路径（Windows 布局为大写 Lib） */
function sitePackagesDir(pyRoot, tp) {
  if (tp === "win32") return join(pyRoot, "Lib", "site-packages");
  const verDir = readdirSync(join(pyRoot, "lib")).find((d) => /^python\d+\.\d+$/.test(d));
  return join(pyRoot, "lib", verDir, "site-packages");
}

function installPythonDeps(pyRoot, opts, tp) {
  const sp = sitePackagesDir(pyRoot, tp);
  if (opts.skipPip) {
    console.log("\n[4/5] 跳过 pip 依赖安装（--skip-pip）");
    return sp;
  }
  const req = join(projectRoot(), "requirements.txt");
  if (!isCross(tp)) {
    console.log("\n[4/5] 安装 Python 依赖（requirements.txt，清华源）");
    const pyBin = platform === "win32" ? join(pyRoot, "python.exe") : join(pyRoot, "bin", "python3");
    run(pyBin, ["-m", "pip", "install", "-r", req, "-i", PIP_TSINGHUA, "--no-compile"], { cwd: stagingDir(opts) });
  } else if (tp === "win32" && (platform === "darwin" || platform === "linux")) {
    // 交叉打 Windows 包：全部走预编译 wheel，不需要 Windows 机器。
    // 必须用 uv——pip 只按宿主机平台评估环境标记（pynput 在 darwin 上声明 pyobjc 依赖，
    // 无 Windows wheel，直接炸）；uv 会按 --python-platform 重新评估标记。
    console.log("\n[4/5] 交叉安装 Windows Python 依赖（uv，仅预编译 wheel，清华源）");
    const uvBin = ensureUv();
    run(uvBin, [
      "pip", "install",
      "-r", req,
      "--index-url", PIP_TSINGHUA,
      "--python-platform", "windows",
      "--python-version", PYTHON_MINOR,
      "--only-binary", ":all:",
      "--target", sp,
    ]);
  } else {
    throw new Error(`无法在 ${platform} 上交叉打 ${tp} 包（仅支持从 mac/linux 交叉打 win）`);
  }
  return sp;
}

/** 确保 uv 可用：优先 PATH，缺则经清华源 pip 安装到用户目录 */
function ensureUv() {
  const probe = spawnSync("uv", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return "uv";
  console.log("  未找到 uv，经清华源安装到用户目录…");
  run("python3", ["-m", "pip", "install", "--quiet", "uv", "-i", PIP_TSINGHUA]);
  for (const candidate of [
    join(spawnSync("python3", ["-m", "site", "--user-base"], { encoding: "utf8" }).stdout.trim(), "bin", "uv"),
    spawnSync("bash", ["-lc", "command -v uv"], { encoding: "utf8" }).stdout.trim(),
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error("uv 安装成功但未定位到可执行文件，请手动安装 uv 后重试");
}

// ---------- Electron dist 换平台（交叉打 Windows 包时） ----------

function swapElectronDistToWin(cacheDir, opts) {
  console.log("  换装 Windows 版 Electron dist…");
  const electronDir = join(stagingDir(opts), "node_modules", "electron");
  const version = JSON.parse(readFileSync(join(electronDir, "package.json"), "utf8")).version;
  const cpu = "x64";
  const filename = `electron-v${version}-win32-${cpu}.zip`;
  const archive = join(cacheDir, filename);
  if (!existsSync(archive)) download(`${opts.electronMirror}/${version}/${filename}`, archive);
  else console.log(`  ↺ 使用缓存 ${filename}`);

  rmSync(join(electronDir, "dist"), { recursive: true, force: true });
  extract(archive, join(electronDir, "dist"), { stripTop: 0 });
  // electron npm 包按 path.txt 定位二进制
  writeFileSync(join(electronDir, "path.txt"), "electron.exe");
}

// ---------- 精简 ----------

const PYTHON_TRIM_DIRS = ["test", "tests", "idlelib", "turtledemo", "tkinter", "config-3.13-*"];
const PYTHON_TRIM_TOP = ["include", "Tools", "Scripts", "tcl", "share", "libs"];

/** 删除 dir 下（最多 depth 层内）名为 test/tests/testing 的子目录与 __pycache__ */
function pruneDirsDeep(dir, names, depth = 3) {
  if (depth <= 0 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (names.has(entry.name) || entry.name === "__pycache__") {
        rmSync(p, { recursive: true, force: true });
      } else {
        pruneDirsDeep(p, names, depth - 1);
      }
    }
  }
}

function trimPackage(opts, tp, sp) {
  console.log("\n精简（移除 stdlib 测试/IDLE/tkinter、依赖包测试目录等）…");
  const pyRoot = join(stagingDir(opts), "runtime", "python");
  const libDir = tp === "win32" ? join(pyRoot, "Lib") : join(pyRoot, "lib");
  const patterns = PYTHON_TRIM_DIRS.filter((d) => !d.includes("*"));
  if (existsSync(libDir)) {
    for (const name of readdirSync(libDir)) {
      if (patterns.includes(name) || name.startsWith("config-3.13-")) {
        rmSync(join(libDir, name), { recursive: true, force: true });
      }
    }
  }
  for (const top of PYTHON_TRIM_TOP) {
    rmSync(join(pyRoot, top), { recursive: true, force: true });
  }
  // 依赖包内的测试目录 + __pycache__（--no-compile 已避免大部分）
  pruneDirsDeep(sp, new Set(["test", "tests", "testing"]), 3);
  // 交叉安装时环境标记可能带入 mac 专属包（pyobjc 全家桶），且 pip 可能写出 host 脚本目录
  if (tp === "win32" && platform === "darwin") {
    for (const name of readdirSync(sp)) {
      if (name.startsWith("pyobjc") || name === "bin" || name === "Scripts") {
        rmSync(join(sp, name), { recursive: true, force: true });
      }
    }
  }
  // node_modules：目标平台用不到的原生二进制 + Windows 包里的符号链接 shim
  const nm = join(stagingDir(opts), "node_modules");
  if (existsSync(nm)) {
    const incompatible = tp === "win32" ? /(darwin|linux|macos|freebsd|android)/ : /(win32|windows|linux|freebsd|android)/;
    const pruneIfNative = (dir, name) => {
      if (name === "electron") return; // dist 换平台时另行处理，包本体保留
      if (name === "fsevents" || incompatible.test(name)) {
        rmSync(join(dir, name), { recursive: true, force: true });
      }
    };
    for (const entry of readdirSync(nm, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        const scoped = join(nm, entry.name);
        for (const sub of readdirSync(scoped, { withFileTypes: true })) {
          if (sub.isDirectory()) pruneIfNative(scoped, sub.name);
        }
      } else {
        pruneIfNative(nm, entry.name);
      }
    }
    // 嵌套包里的 .bin 同样全是符号链接 shim，一并清掉
    if (tp === "win32") {
      const walk = (dir, depth) => {
        if (depth <= 0 || !existsSync(dir)) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          if (e.name === ".bin") rmSync(join(dir, e.name), { recursive: true, force: true });
          else walk(join(dir, e.name), depth - 1);
        }
      };
      walk(nm, 4);
    }
  }
}

// ---------- 组装 staging ----------

const EXCLUDE_DIR_NAMES = new Set(["__pycache__", ".git", ".zcode", ".trae", ".workbuddy"]);
const EXCLUDE_FILES = new Set([".DS_Store", ".env"]);

function stagingDir(opts) {
  return join(resolve(opts.outDir), APP_DIR_NAME);
}

function makeCopyFilter(opts, tp) {
  const crossWin = tp === "win32" && platform !== "win32";
  return (src) => {
    const base = basename(src);
    if (EXCLUDE_FILES.has(base) || EXCLUDE_DIR_NAMES.has(base)) return false;
    if (base.endsWith(".pyc")) return false;
    // 交叉打 Windows 包时，构建机的 darwin Electron dist（294MB）直接不复制
    if (crossWin && src.includes("node_modules/electron/dist")) return false;
    return true;
  };
}

function assembleStaging(opts, tp) {
  console.log(`\n[1/5] 组装应用文件（node_modules 全量，需要一会儿）`);
  const root = projectRoot();
  const staging = stagingDir(opts);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const dirs = ["src", "python", "pet", "gui", "assets", "bin", "node_modules"];
  const files = ["package.json", "requirements.txt", "README.md", "README_en.md", "LICENSE", "tsconfig.json"];
  const filter = makeCopyFilter(opts, tp);
  for (const d of dirs) {
    const from = join(root, d);
    if (!existsSync(from)) continue;
    cpSync(from, join(staging, d), { recursive: true, filter, verbatimSymlinks: true });
  }
  for (const f of files) {
    const from = join(root, f);
    if (existsSync(from)) cpSync(from, join(staging, f));
  }
  return staging;
}

// ---------- 启动脚本（无参数默认启动 GUI，由 src/index.ts 分流；启动前自检包内运行时） ----------

const AROMA_SH = `#!/bin/bash
# ARONA 自包含启动脚本（npm run package 生成）：只用包内 Node/Python，启动前自检
DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$DIR/runtime/node/bin:$DIR/runtime/python/bin:$PATH"

NODE_BIN="$DIR/runtime/node/bin/node"
PY_BIN="$DIR/runtime/python/bin/python3"
[ -x "$NODE_BIN" ] || { echo "✗ 包内 Node 缺失：$NODE_BIN（压缩包可能不完整）" >&2; exit 1; }
[ -x "$PY_BIN" ]   || { echo "✗ 包内 Python 缺失：$PY_BIN（压缩包可能不完整）" >&2; exit 1; }
NODE_VER="$("$NODE_BIN" --version 2>/dev/null)" || { echo "✗ 包内 Node 无法运行（架构不匹配？）" >&2; exit 1; }
PY_VER="$("$PY_BIN" --version 2>/dev/null)" || { echo "✗ 包内 Python 无法运行（架构不匹配？）" >&2; exit 1; }
echo "ARONA 自包含运行时：$NODE_VER / $PY_VER" >&2
exec "$NODE_BIN" "$DIR/bin/arona.mjs" "$@"
`;

const AROMA_BAT = `@echo off
rem ARONA 自包含启动脚本（npm run package 生成）：只用包内 Node/Python，启动前自检
setlocal
set "DIR=%~dp0"
set "PATH=%DIR%runtime\\node;%DIR%runtime\\python;%PATH%"

if not exist "%DIR%runtime\\node\\node.exe" (
  echo ✗ 包内 Node 缺失：runtime\\node\\node.exe（压缩包可能不完整） 1>&2
  exit /b 1
)
if not exist "%DIR%runtime\\python\\python.exe" (
  echo ✗ 包内 Python 缺失：runtime\\python\\python.exe（压缩包可能不完整） 1>&2
  exit /b 1
)
"%DIR%runtime\\node\\node.exe" --version >nul 2>&1
if errorlevel 1 ( echo ✗ 包内 Node 无法运行 1>&2 & exit /b 1 )
"%DIR%runtime\\python\\python.exe" --version >nul 2>&1
if errorlevel 1 ( echo ✗ 包内 Python 无法运行 1>&2 & exit /b 1 )
for /f "delims=" %%v in ('"%DIR%runtime\\node\\node.exe" --version') do echo ARONA 自包含运行时：%%v 1>&2

rem 无参数时默认启动 GUI（由 src/index.ts 分流）
"%DIR%runtime\\node\\node.exe" "%DIR%bin\\arona.mjs" %*
`;

const AROMA_COMMAND = `#!/bin/bash
# macOS 双击启动（npm run package 生成）
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/arona.sh" "$@"
`;

const USAGE_TXT = `ARONA Agent 自包含包（Windows x64）
=====================================

启动方式：
  双击 arona.bat —— 默认打开 GUI 图形界面（附带一个控制台黑窗，属正常，可最小化）
  命令行用法：在 cmd/PowerShell 里运行 arona.bat，参数原样传给 arona，例如：
      arona.bat setup     重新初始化
      arona.bat doctor    环境自检
      arona.bat --no-voice  关闭语音启动

本包完全自包含（Node、Python、Electron、全部依赖均已内置），目标机器无需安装任何环境。
配置与数据存放在 C:\\Users\\<用户名>\\.arona\\（settings.json），首次启动无配置会自动进入初始化向导。
`;

function writeLaunchers(staging, tp) {
  if (tp === "win32") {
    writeFileSync(join(staging, "arona.bat"), AROMA_BAT.replace(/\n/g, "\r\n"));
    writeFileSync(join(staging, "使用说明.txt"), USAGE_TXT.replace(/\n/g, "\r\n"));
    return;
  }
  writeFileSync(join(staging, "arona.sh"), AROMA_SH);
  chmodSync(join(staging, "arona.sh"), 0o755);
  if (tp === "darwin") {
    writeFileSync(join(staging, "启动 ARONA.command"), AROMA_COMMAND);
    chmodSync(join(staging, "启动 ARONA.command"), 0o755);
  }
}

// ---------- macOS 动态库自包含修复（仅原生构建） ----------

/**
 * pip 源码编译的原生扩展（如 pyaudio）会硬链接构建机 Homebrew 的 dylib
 * （/opt/homebrew/...），zip 到别的机器就挂。这里把这类 dylib 收进
 * site-packages/pyaudio/lib/，扩展的引用改写为 @loader_path 相对路径并重签名。
 * 其他平台或没有此类链接时是 no-op。
 */
function fixDarwinDylibs(staging) {
  if (platform !== "darwin") return;
  const spRoot = join(staging, "runtime", "python", "lib");
  const pyDir = readdirSync(spRoot).find((d) => /^python\d+\.\d+$/.test(d));
  if (!pyDir) return;
  const pkgDir = join(spRoot, pyDir, "site-packages", "pyaudio");
  if (!existsSync(pkgDir)) return;

  const machO = readdirSync(pkgDir).filter((f) => f.endsWith(".so"));
  const libDir = join(pkgDir, "lib");
  let changed = 0;

  const externalDeps = (file) =>
    fetchOtool(file)
      .filter((p) => p.startsWith("/opt/homebrew/") || p.startsWith("/usr/local/"))
      .filter((p, i, arr) => arr.indexOf(p) === i);

  for (const so of machO) {
    const soPath = join(pkgDir, so);
    for (const dep of externalDeps(soPath)) {
      mkdirSync(libDir, { recursive: true });
      const local = join(libDir, basename(dep));
      if (!existsSync(local)) {
        cpSync(dep, local);
        for (const dep2 of externalDeps(local)) {
          mkdirSync(libDir, { recursive: true });
          const local2 = join(libDir, basename(dep2));
          if (!existsSync(local2)) cpSync(dep2, local2);
          run("install_name_tool", ["-change", dep2, `@loader_path/${basename(dep2)}`, local]);
        }
        run("codesign", ["--force", "--sign", "-", local]);
      }
      run("install_name_tool", ["-change", dep, `@loader_path/lib/${basename(dep)}`, soPath]);
      changed++;
    }
    if (changed) run("codesign", ["--force", "--sign", "-", soPath]);
  }
  if (changed) console.log(`  ✓ 已捆绑 ${changed} 个外部 dylib 并改写为包内相对引用`);

  function fetchOtool(file) {
    const r = spawnSync("otool", ["-L", file], { encoding: "utf8" });
    if (r.status !== 0) return [];
    return r.stdout
      .split("\n")
      .map((l) => l.trim().split(" ")[0])
      .filter((p) => p.startsWith("/"));
  }
}

// ---------- 自检 + 压缩 ----------

function verifyNative(pyRoot) {
  console.log("\n[5/5] 自检");
  const pyBin = platform === "win32" ? join(pyRoot, "python.exe") : join(pyRoot, "bin", "python3");
  run(pyBin, ["--version"]);
  for (const mod of ["numpy", "pyaudio", "dashscope", "websockets"]) {
    run(pyBin, ["-c", `import ${mod}`]);
  }
  console.log("  ✓ Python 依赖导入自检通过");
}

function makeZip(opts, tp) {
  if (opts.skipZip) {
    console.log("\n（--skip-zip：跳过压缩，staging 目录已就绪）");
    return null;
  }
  const outDir = resolve(opts.outDir);
  const cpu = nodeCpu(tp);
  const zipName = `arona-agent-${pkgVersion}-${platformName(tp)}-${cpu}.zip`;
  const zipPath = join(outDir, zipName);
  rmSync(zipPath, { force: true });
  console.log(`\n压缩（保留符号链接，需几分钟）…`);
  if (platform === "win32") {
    run("powershell", [
      "-NoProfile", "-Command",
      `Compress-Archive -Path '${stagingDir(opts)}' -DestinationPath '${zipPath}' -CompressionLevel Optimal`,
    ]);
  } else {
    // -y 保留符号链接（mac 包的 node_modules/.bin、python 目录内链接）
    run("zip", ["-qry", zipPath, APP_DIR_NAME, "-x", "*.DS_Store", "-x", "*__pycache__*", "-x", "*.pyc"], { cwd: outDir });
  }
  const sizeMB = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`\n✓ 打包完成：${zipPath}（${sizeMB} MB）`);
  return zipPath;
}

// ---------- main ----------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tp = targetPlatform(opts);
  const cacheDir = join(resolve(opts.outDir), ".cache");
  mkdirSync(cacheDir, { recursive: true });
  console.log(`目标平台：${platformName(tp)}-${nodeCpu(tp)}${isCross(tp) ? "（交叉打包）" : "（原生）"}`);

  // 顺序很重要：assembleStaging 会清空 staging 目录，必须先于 runtime 解压
  assembleStaging(opts, tp);
  writeLaunchers(stagingDir(opts), tp);
  const pyRoot = preparePython(cacheDir, opts, tp);
  prepareNode(cacheDir, opts, tp);
  const sp = installPythonDeps(pyRoot, opts, tp);
  if (isCross(tp) && tp === "win32") swapElectronDistToWin(cacheDir, opts);
  trimPackage(opts, tp, sp);
  if (!isCross(tp)) {
    if (platform === "darwin") fixDarwinDylibs(stagingDir(opts));
    verifyNative(pyRoot);
  } else {
    // 交叉包：静态检查关键二进制就位
    console.log("\n[5/5] 自检（交叉打包：静态检查目标文件）");
    const checks = [
      join(pyRoot, "python.exe"),
      join(stagingDir(opts), "runtime", "node", "node.exe"),
      join(stagingDir(opts), "node_modules", "electron", "dist", "electron.exe"),
      join(sp, "pyaudio"),
      join(sp, "numpy"),
      join(sp, "dashscope"),
    ];
    for (const c of checks) {
      if (!existsSync(c)) throw new Error(`交叉包缺关键文件：${c}`);
    }
    console.log("  ✓ 关键文件齐备（python.exe / node.exe / electron.exe / pyaudio / numpy / dashscope）");
  }
  makeZip(opts, tp);
  console.log(`\n目标机器使用：解压后运行 arona.bat（Windows）或 arona.sh（mac/linux），无参数默认启动 GUI；无需安装任何环境。`);
}

main();
