import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";

type Language = "zh" | "en";
export type LanguageSetting = "auto" | "zh" | "en";

const SETTINGS_FILE = join(homedir(), ".arona", "settings.json");

/**
 * 读取 ~/.arona/settings.json 中的 language 字段（"auto"|"zh"|"en"）。
 * 不 import config.ts —— config 在模块加载时读 settings，locale 再依赖它会成环。
 * 解析失败或字段缺失返回 "auto"。
 */
function readSettingsLanguage(): LanguageSetting {
  try {
    if (!existsSync(SETTINGS_FILE)) return "auto";
    const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as { language?: unknown };
    const v = s.language;
    if (v === "zh" || v === "en") return v;
    return "auto";
  } catch {
    return "auto";
  }
}

/** 统一英文判定：locale 以 "en" 开头（大小写不敏感）。 */
function isEnglishLocale(locale: string): boolean {
  return /^en/i.test(locale.trim());
}

/** 平台系统偏好检测（仅当环境变量缺失/未命中时调用一次）。失败静默返回 null。 */
function detectSystemLocale(): string | null {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      // macOS: 系统语言列表，如 ["en-US", "zh-Hans"]，取首项
      const out = execFileSync("defaults", ["read", "-g", "AppleLanguages"], {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      const match = out.match(/["']([^"']+)["']/);
      return match ? match[1] : null;
    }
    if (platform === "win32") {
      // Windows: 注册表用户语言列表（分号分隔），取首个
      try {
        const out = execFileSync(
          "reg",
          ["query", "HKCU\\Control Panel\\International\\User Profile", "/v", "Languages"],
          { encoding: "utf-8", timeout: 3000 },
        );
        const m = out.match(/LANGUAGES\s+REG_SZ\s+([^\r\n]+)/i);
        if (m) {
          const first = m[1].trim().split(";")[0];
          if (first) return first;
        }
      } catch {
        // 回退 PowerShell
      }
      const ps = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", "[System.Globalization.CultureInfo]::CurrentUICulture.Name"],
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      return ps || null;
    }
    // Linux 等：LANG 已在环境变量步骤覆盖，无需额外命令
    return null;
  } catch {
    return null;
  }
}

/**
 * 检测当前语言。优先级链：
 *   1. settings.json 手动配置（zh/en 直接定型；auto 继续下探）
 *   2. 环境变量 LANG / LC_ALL（/^en/i 命中 → en）
 *   3. 平台系统偏好（macOS defaults / Windows 注册表 + CurrentUICulture）
 *   4. Intl 兜底
 *   5. 默认 zh
 */
function detectLanguage(): Language {
  // 1) 手动配置
  const setting = readSettingsLanguage();
  if (setting === "zh" || setting === "en") return setting;

  // 2) 环境变量
  const envLocale = process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || "";
  if (envLocale && isEnglishLocale(envLocale)) return "en";
  // 环境变量命中中文则直接定型，避免中文系统上再跑系统命令
  if (/^zh/i.test(envLocale)) return "zh";

  // 3) 平台系统偏好
  const systemLocale = detectSystemLocale();
  if (systemLocale) {
    if (isEnglishLocale(systemLocale)) return "en";
    if (/^zh/i.test(systemLocale)) return "zh";
  }

  // 4) Intl 兜底
  try {
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale || "";
    if (isEnglishLocale(intlLocale)) return "en";
    if (/^zh/i.test(intlLocale)) return "zh";
  } catch {
    // ignore
  }

  // 5) 默认
  return "zh";
}

// 模块加载时检测一次，全局缓存。运行时语言不热切换（符合"启动检测一次"的设计）。
let lang: Language = detectLanguage();

/** 按当前语言返回中英两版文案之一。 */
export function t(zh: string, en: string): string {
  return lang === "en" ? en : zh;
}

/** 当前语言（只读）。 */
export function getLang(): Language {
  return lang;
}

/** 手动切换语言（setup 向导改语言后即时生效）。 */
export function setLang(l: Language): void {
  lang = l;
}

/**
 * 按 settings.json 的 language 字段重新定型语言（首次运行引导 setup 完成后调用；
 * 不重新探测系统/环境，仅尊重向导写入的显式配置）。auto/缺失保持现状返回当前值。
 */
export function refreshLanguage(): Language {
  const setting = readSettingsLanguage();
  if (setting === "zh" || setting === "en") lang = setting;
  return lang;
}
