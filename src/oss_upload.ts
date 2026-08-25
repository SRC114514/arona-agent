// 本地文件 → 阿里云 DashScope 托管 OSS 的工具：上传换取可长期引用的 URL，供云端 GPT-SoVITS
// 作为 ref_audio_path 引用（复用 python/oss_upload.py，与 voice_clone.py 同一 DashScope 通道）。
//
// - 同一本地路径会话内只上传一次（URL 长期有效），缓存于 urlCache；并发上传共享同一 in-flight Promise。
// - ensureOssUrlAlive 用 Range GET 探测 URL 有效性，失效则 invalidate 触发下次重传
//   （"发现无效→重新走上传流程"）。
// - promptText 若为 URL 用 fetchTextFromUrl 抓内容；joinPromptLines 把多行文字合并为一行，
//   行尾缺句末标点时按中英文智能补「。」或「.」。
import { verbose } from "./config.ts";
import { t } from "./locale.ts";
import { runPython } from "./utils/python.ts";

const urlCache = new Map<string, string>(); // 本地源路径 → OSS URL（会话内复用）
const inflight = new Map<string, Promise<string>>(); // 在途上传（并发去重）
const verifiedSet = new Set<string>(); // 已校验且仍有效的源路径（避免每 drain 重复探测）

/** 是否 http(s) URL（用于区分"本地路径"与"远端 URL"输入）。 */
export function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

/** 上传本地文件到 DashScope 托管 OSS，返回长期有效的 URL（同源路径会话内缓存，只上传一次）。 */
export function uploadToOss(path: string, apiKey: string): Promise<string> {
  const cached = urlCache.get(path);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(path);
  if (pending) return pending;
  const task = runPython("oss_upload.py", [], JSON.stringify({ path, apiKey }), {}, 120_000)
    .then((out) => {
      let parsed: { url?: string; error?: string };
      try {
        parsed = JSON.parse(out);
      } catch {
        throw new Error(t(`OSS 上传输出解析失败: ${out}`, `OSS upload parse failed: ${out}`));
      }
      if (!parsed.url) {
        throw new Error(parsed.error || t("OSS 上传未返回 URL", "OSS upload returned no URL"));
      }
      urlCache.set(path, parsed.url);
      if (verbose) console.error(`[oss] uploaded ${path} -> ${parsed.url}`);
      return parsed.url;
    })
    .finally(() => {
      inflight.delete(path);
    });
  inflight.set(path, task);
  return task;
}

/** 作废某源路径的缓存 URL（发现无效时调用，下次上传会重新走上传流程）。 */
export function invalidateOssUrl(path: string): void {
  urlCache.delete(path);
  verifiedSet.delete(path);
}

/** Range GET 探测 URL 是否仍可访问（OSS 支持 range，200/206/304 均视为有效）。 */
async function checkUrlAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(6000),
    });
    return res.status === 200 || res.status === 206 || res.status === 304;
  } catch {
    return false;
  }
}

/**
 * 校验 OSS URL 有效性；失效则强制重传并返回新 URL（"发现无效→重新走上传流程"）。
 * 会话内每个源路径只校验一次（URL 长期有效，无需每 drain 都探测）。
 */
export async function ensureOssUrlAlive(sourcePath: string, url: string, apiKey: string): Promise<string> {
  if (verifiedSet.has(sourcePath)) return url;
  if (await checkUrlAlive(url)) {
    verifiedSet.add(sourcePath);
    return url;
  }
  if (verbose) console.error(`[oss] URL 失效，重新上传: ${url}`);
  invalidateOssUrl(sourcePath);
  const fresh = await uploadToOss(sourcePath, apiKey);
  verifiedSet.add(sourcePath);
  return fresh;
}

/** 抓取 URL 文本内容（promptText 为 URL 时使用）。 */
export async function fetchTextFromUrl(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(t(`拉取文字失败 (HTTP ${res.status})`, `Fetch text failed (HTTP ${res.status})`));
  }
  return await res.text();
}

/**
 * 把多行文字合并为一行：丢弃空行；行尾缺少句末标点（。．.!?！？…）时，按该行是否含
 * 中日韩字符智能补「。」或「.」；最后一行不补（官方会自动补全）。单行输入原样返回。
 */
export function joinPromptLines(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length <= 1) return lines[0] || "";
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const END = /[。．.!?！？…]$/;
  return lines
    .map((line, i) => {
      if (i === lines.length - 1) return line; // 最后一行不补标点
      if (END.test(line)) return line;
      return line + (CJK.test(line) ? "。" : ".");
    })
    .join(" ");
}
