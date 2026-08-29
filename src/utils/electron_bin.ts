// Electron 二进制定位与按需预下载（pet 桥与 GUI 窗口共用）。
// Electron 42+ 移除 postinstall 自动下载：首次用时按 dist/version 判定是否就绪，
// 未就绪则以国内镜像执行 install.js 预下载（幂等）。
import { spawn, execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { PROJECT_ROOT, verbose } from "../config.ts";
import { t } from "../locale.ts";

const ELECTRON_DIR = join(PROJECT_ROOT, "node_modules", "electron");
// 国内源实测：华为云 mirrors.huaweicloud.com/electron/ 可用；npmmirror 亦可。
const ELECTRON_MIRROR = "https://mirrors.huaweicloud.com/electron/";
// 开发模式下菜单栏/Dock 显示的应用名来自 Electron.app 的 Info.plist（app.setName 改不了它）。
const APP_BUNDLE_NAME = "Arona Agent";

/** 与 electron/install.js getPlatformPath() 保持一致：各平台可执行文件的相对路径 */
export function electronPlatformPath(): string {
  if (process.platform === "win32") return "electron.exe";
  if (process.platform === "darwin") return "Electron.app/Contents/MacOS/Electron";
  return "electron";
}

/** dist 二进制是否已就绪（版本匹配 + 可执行文件存在），与 install.js 的 isInstalled() 判定一致 */
export function isElectronInstalled(): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(ELECTRON_DIR, "package.json"), "utf-8"));
    const version = readFileSync(join(ELECTRON_DIR, "dist", "version"), "utf-8").replace(/^v/, "");
    return version === pkg.version && existsSync(join(ELECTRON_DIR, "dist", electronPlatformPath()));
  } catch {
    return false;
  }
}

/**
 * 把 Electron.app 的 Info.plist 应用名改为 APP_BUNDLE_NAME 并临时重签名（仅 macOS）。
 * 幂等：已是目标名则跳过；任何失败只警告不阻塞启动（重装 electron 后会再次执行）。
 */
function patchMacAppName(): void {
  if (process.platform !== "darwin") return;
  const appDir = join(ELECTRON_DIR, "dist", "Electron.app");
  const plist = join(appDir, "Contents", "Info.plist");
  if (!existsSync(plist)) return;
  try {
    const current = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleName", plist], { encoding: "utf-8" }).trim();
    if (current === APP_BUNDLE_NAME) return;
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c", `Set :CFBundleName ${APP_BUNDLE_NAME}`,
      "-c", `Set :CFBundleDisplayName ${APP_BUNDLE_NAME}`,
      plist,
    ]);
    // 改 plist 会使原签名失效，临时 ad-hoc 重签（本地运行足够；正式分发应走打包）
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appDir], { stdio: "ignore" });
    console.log(chalk.gray(t(`  应用名已设为 "${APP_BUNDLE_NAME}"`, `  App name set to "${APP_BUNDLE_NAME}"`)));
  } catch (err) {
    if (verbose) {
      console.warn(chalk.yellow(t(
        `应用改名失败（不影响使用）：${err instanceof Error ? err.message : err}`,
        `Failed to rename app (harmless): ${err instanceof Error ? err.message : err}`,
      )));
    }
  }
}

/**
 * 确保 dist 二进制就绪：未就绪则用国内镜像手动执行预下载脚本。
 * @returns "missing" = electron npm 包未安装; true = 已就绪或下载成功; false = 下载失败
 */
export async function ensureElectronBinary(): Promise<true | false | "missing"> {
  if (!existsSync(join(ELECTRON_DIR, "package.json"))) return "missing";
  if (isElectronInstalled()) {
    patchMacAppName();
    return true;
  }

  console.log(chalk.cyan(t("  正在使用国内源下载Electron……", "  Downloading Electron from CN mirror…")));

  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(process.execPath, [join(ELECTRON_DIR, "install.js")], {
      env: { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? ELECTRON_MIRROR },
      stdio: verbose ? "inherit" : "ignore",
    });
    child.on("error", (err) => {
      console.warn(chalk.yellow(t(`无法启动 Electron 安装器（${err.message}）。`, `Failed to launch Electron installer (${err.message}).`)));
      resolve(false);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        console.warn(chalk.yellow(t("Electron 下载失败。", "Electron download failed.")));
        resolve(false);
        return;
      }
      console.log(chalk.green(t("  ✓ Electron 安装完成", "  ✓ Electron installed")));
      resolve(true);
    });
  });
  if (ok) patchMacAppName();
  return ok;
}

/** 二进制可执行文件路径（electron 包默认导出）；未安装/下载失败返回 null。 */
export async function getElectronPath(): Promise<string | null> {
  const state = await ensureElectronBinary();
  if (state !== true) return null;
  try {
    const mod = await import("electron");
    return mod.default as unknown as string;
  } catch {
    return null;
  }
}
