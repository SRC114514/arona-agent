import chalk from "chalk";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { t } from "../locale.ts";
import { config } from "../config.ts";

/**
 * Tavily 搜索工具集。
 *
 * 认证策略：~/.arona/settings.json 配置 tavilyApiKey 时走 Bearer 认证；
 * 未配置时自动降级 keyless 共享池（X-Tavily-Access-Mode: keyless，免费限流）。
 * 两种模式响应格式一致。参考 https://docs.tavily.com/documentation/keyless
 *
 * 工具分层：
 * - web_search / web_extract：keyless 与 key 均可用，主/子 Agent 恒注册；
 * - web_crawl / web_map / web_research（premiumTavilyTools）：仅 /crawl /map /research
 *   端点需要 API Key，故只在配置了 tavilyApiKey 时注册（见 agent.ts）。
 *
 * 限流处理：429（rate limited）/ 432（quota exhausted）时在终端打印红字提示，
 * 指数退避（1s 起翻倍、封顶 10s）自动重试，最多 5 次；仍失败则把"建议配 Key/稍后重试"
 * 的提示返回给 Agent。
 */

const TAVILY_BASE = "https://api.tavily.com";
const TIMEOUT_MS = 15000;
const EXTRACT_MAX_CHARS = 8000;
const CRAWL_PAGE_MAX_CHARS = 4000;
const CRAWL_MAX_PAGES = 10;
const RESEARCH_MAX_CHARS = 12000;
const RESEARCH_POLL_INTERVAL_MS = 5000;
const RESEARCH_POLL_TIMEOUT_MS = 180000; // 研究任务轮询上限 3 分钟
const RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_INITIAL_DELAY_MS = 1000;
const RATE_LIMIT_MAX_DELAY_MS = 10000;

interface TavilySearchResult {
  url: string;
  title?: string;
  content?: string;
  score?: number;
}

interface TavilyExtractResult {
  url: string;
  raw_content?: string | null;
  content?: string | null;
}

interface TavilyResponse<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  /** 因限流触发的重试次数（0 = 未触发） */
  retries: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 429 = 限流；432 = 额度耗尽。 */
function isRateLimited(status: number): boolean {
  return status === 429 || status === 432;
}

/** 终端红字提示（在 REPL 会话中直接可见）。 */
function printRateLimitNotice(retryCount: number): void {
  process.stderr.write(
    chalk.red(
      t(
        `· 触发Tavily限流，建议填写API Key以规避（重试次数 ${retryCount}/${RATE_LIMIT_RETRIES}）`,
        `· Tavily rate-limited; consider adding an API Key (retry ${retryCount}/${RATE_LIMIT_RETRIES})`,
      ),
    ) + "\n",
  );
}

/** 有 key → Bearer；无 key → keyless 共享池。 */
function tavilyHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.tavilyApiKey) {
    headers.Authorization = `Bearer ${config.tavilyApiKey}`;
  } else {
    headers["X-Tavily-Access-Mode"] = "keyless";
  }
  return headers;
}

async function rawRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    const res = await fetch(`${TAVILY_BASE}${path}`, {
      method,
      headers: tavilyHeaders(),
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = "";
      try {
        const j = JSON.parse(text) as { detail?: unknown; error?: unknown };
        detail = typeof j.detail === "string" ? j.detail : typeof j.error === "string" ? j.error : text;
      } catch {
        detail = text.slice(0, 300);
      }
      return { ok: false, status: res.status, error: detail };
    }
    return { ok: true, status: res.status, data: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 带限流重试的请求：429/432 时红字提示 + 指数退避（1s→2s→4s→8s→10s 封顶）重试，
 * 最多 RATE_LIMIT_RETRIES 次；5 次仍失败返回最后一次结果（retries=5）。
 */
async function tavilyRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<TavilyResponse<T>> {
  let delay = RATE_LIMIT_INITIAL_DELAY_MS;
  let retries = 0;
  for (;;) {
    const res = await rawRequest<T>(method, path, body);
    if (res.ok || !isRateLimited(res.status)) {
      return { ...res, retries };
    }
    retries++;
    printRateLimitNotice(retries);
    if (retries >= RATE_LIMIT_RETRIES) {
      return { ...res, retries };
    }
    await sleep(delay);
    delay = Math.min(delay * 2, RATE_LIMIT_MAX_DELAY_MS);
  }
}

function textResult(text: string) {
  return { content: [{ type: "text", text } as const], details: {} };
}

/** 非限流错误的通用文案（限流已在 tavilyRequest 内重试，走到这里多半是网络/其他错误）。 */
function errorText(status: number, detail: string): string {
  const detailHint = detail ? `：${detail}` : "";
  return status === 0
    ? t(`Tavily 网络请求失败（${detailHint}），请稍后重试。`, `Tavily network request failed (${detailHint}); please retry later.`)
    : t(`Tavily 请求失败（HTTP ${status}${detailHint}）。`, `Tavily request failed (HTTP ${status}${detailHint}).`);
}

/** 限流重试 5 次仍失败 → 给 Agent 的可操作建议。 */
function rateLimitExhaustedText(): string {
  return t(
    "Tavily 触发限流，自动重试 5 次仍失败。建议：1) 在 ~/.arona/settings.json 配置 tavilyApiKey 以提升额度（免费计划每月 1000 credits，无需信用卡）；2) 稍后重试。",
    "Tavily is rate-limiting; 5 auto-retries failed. Suggest: 1) configure tavilyApiKey in ~/.arona/settings.json for higher quota (free plan: 1000 credits/month, no credit card); 2) retry later.",
  );
}

/** 统一失败文案：重试耗尽 → 限流建议；否则 → 通用错误。 */
function failText(toolName: string, res: TavilyResponse<unknown>): string {
  if (res.retries >= RATE_LIMIT_RETRIES && res.ok === false) return `${toolName} 失败：${rateLimitExhaustedText()}`;
  return `${toolName} 失败：${errorText(res.status, res.error || "")}`;
}

// ============================================================
// web_search / web_extract —— keyless 与 key 均可用
// ============================================================

export const webSearchTool = defineTool({
  name: "web_search",
  label: "Web Search",
  description: t(
    "实时网页搜索（Tavily 驱动）。需要最新信息、事实核查、查找资料时调用。返回带标题、URL 与内容摘要的排序结果列表。未配置 API Key 时自动走免费共享池（有限流）。",
    "Real-time web search powered by Tavily. Use it for up-to-date information, fact-checking, or research. Returns a ranked list of results with titles, URLs, and content snippets. Falls back to the free shared pool when no API key is configured (rate-limited).",
  ),
  parameters: Type.Object({
    query: Type.String({ description: t("搜索关键词", "Search query") }),
    max_results: Type.Optional(
      Type.Number({ description: t("返回结果数，1-10，默认 5", "Number of results, 1-10, default 5") }),
    ),
    search_depth: Type.Optional(
      Type.Unsafe<"basic" | "advanced">({
        type: "string",
        enum: ["basic", "advanced"],
        description: t(
          "搜索深度：basic 快、advanced 更准（消耗更多额度），默认 basic",
          "Search depth: basic is fast, advanced is more accurate (costs more credits); default basic",
        ),
      }),
    ),
  }),
  execute: async (_id, params: { query: string; max_results?: number; search_depth?: "basic" | "advanced" }) => {
    const maxResults = Math.min(10, Math.max(1, Math.floor(params.max_results ?? 5)));
    const depth = params.search_depth ?? "basic";

    const res = await tavilyRequest<{ results?: TavilySearchResult[] }>("POST", "/search", {
      query: params.query,
      max_results: maxResults,
      search_depth: depth,
    });
    if (!res.ok) {
      return textResult(failText("web_search", res));
    }

    const results = res.data?.results ?? [];
    if (results.length === 0) {
      return textResult(t("没有搜到相关结果，换个关键词试试。", "No relevant results found; try different keywords."));
    }

    const lines = results.map((r, i) => {
      const title = r.title || "(no title)";
      const snippet = (r.content || "").trim();
      const score = typeof r.score === "number" ? ` （相关度 ${(r.score * 100).toFixed(0)}%）` : "";
      return `#${i + 1}. ${title}${score}\nURL: ${r.url}\n${snippet}`;
    });
    return textResult(t(`搜到 ${results.length} 条结果：\n\n`, `Found ${results.length} results:\n\n`) + lines.join("\n\n"));
  },
});

export const webExtractTool = defineTool({
  name: "web_extract",
  label: "Web Extract",
  description: t(
    "抓取网页正文内容（Tavily 驱动）。已拿到 URL（如 web_search 结果中的链接）时调用，获取页面正文用于深入阅读。正文过长时会截断。未配置 API Key 时自动走免费共享池（有限流）。",
    "Extract the main text content of a web page, powered by Tavily. Use it when you already have a URL (e.g. from web_search results) and need the full page content to read in depth. Long content is truncated. Falls back to the free shared pool when no API key is configured (rate-limited).",
  ),
  parameters: Type.Object({
    url: Type.String({ description: t("要抓取的网页 URL", "URL of the page to extract") }),
  }),
  execute: async (_id, params: { url: string }) => {
    const res = await tavilyRequest<{ results?: TavilyExtractResult[] }>("POST", "/extract", {
      urls: [params.url],
    });
    if (!res.ok) {
      return textResult(failText("web_extract", res));
    }

    const result = res.data?.results?.[0];
    const text = (result?.raw_content || result?.content || "").trim();
    if (!result || !text) {
      return textResult(t("未能从该 URL 提取到正文内容。", "Failed to extract content from that URL."));
    }

    const truncated =
      text.length > EXTRACT_MAX_CHARS
        ? `${text.slice(0, EXTRACT_MAX_CHARS)}\n\n…（已截断，全文共 ${text.length} 字符，仅显示前 ${EXTRACT_MAX_CHARS}）`
        : text;
    return textResult(`来源: ${result.url}\n\n${truncated}`);
  },
});

// ============================================================
// web_crawl / web_map / web_research —— 仅 key 模式（/crawl /map /research 需要 API Key）
// ============================================================

/** 无 key 时防御性拦截（正常流程中这些工具不会注册，双保险）。 */
function requireApiKey(toolName: string): string | null {
  if (config.tavilyApiKey) return null;
  return t(
    `${toolName} 需要配置 Tavily API Key 才能使用（~/.arona/settings.json 的 tavilyApiKey）。`,
    `${toolName} requires a Tavily API key (tavilyApiKey in ~/.arona/settings.json).`,
  );
}

export const webCrawlTool = defineTool({
  name: "web_crawl",
  label: "Web Crawl",
  description: t(
    "爬取网站页面内容（Tavily 驱动，需 API Key）。已了解站点结构、需要批量读取多页（如文档站）时调用。按页返回正文，可限制深度与页数。",
    "Crawl website pages and extract their content (Tavily; requires API key). Use when you know the site structure and need to read many pages in bulk (e.g. docs sites). Returns per-page body text; depth and page limit are configurable.",
  ),
  parameters: Type.Object({
    url: Type.String({ description: t("爬取的根 URL", "Root URL to crawl") }),
    max_depth: Type.Optional(
      Type.Number({ description: t("爬取深度 1-5，默认 1", "Crawl depth 1-5, default 1") }),
    ),
    limit: Type.Optional(
      Type.Number({ description: t("最多处理的页数，默认 10，上限 50", "Max pages to process, default 10, max 50") }),
    ),
  }),
  execute: async (_id, params: { url: string; max_depth?: number; limit?: number }) => {
    const keyErr = requireApiKey("web_crawl");
    if (keyErr) return textResult(keyErr);
    const maxDepth = Math.min(5, Math.max(1, Math.floor(params.max_depth ?? 1)));
    const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 10)));

    const res = await tavilyRequest<{ results?: { url: string; raw_content?: string | null }[] }>(
      "POST",
      "/crawl",
      { url: params.url, max_depth: maxDepth, limit },
    );
    if (!res.ok) {
      return textResult(failText("web_crawl", res));
    }

    const results = (res.data?.results ?? []).slice(0, CRAWL_MAX_PAGES);
    if (results.length === 0) {
      return textResult(t("没有爬取到任何页面，检查 URL 或调整深度/页数。", "No pages crawled; check the URL or adjust depth/limit."));
    }

    const lines = results.map((r, i) => {
      const body = (r.raw_content || "").trim();
      const truncated =
        body.length > CRAWL_PAGE_MAX_CHARS
          ? `${body.slice(0, CRAWL_PAGE_MAX_CHARS)}\n…（已截断，该页共 ${body.length} 字符）`
          : body;
      return `[${i + 1}] ${r.url}\n${truncated}`;
    });
    return textResult(t(`爬取了 ${results.length} 个页面：\n\n`, `Crawled ${results.length} pages:\n\n`) + lines.join("\n\n"));
  },
});

export const webMapTool = defineTool({
  name: "web_map",
  label: "Web Map",
  description: t(
    "绘制网站结构图（Tavily 驱动，需 API Key）。想了解某个站点包含哪些页面时调用，返回站点内发现的 URL 列表。",
    "Map a website's structure (Tavily; requires API key). Use to discover which pages a site contains; returns the list of URLs found.",
  ),
  parameters: Type.Object({
    url: Type.String({ description: t("要映射的根 URL", "Root URL to map") }),
    limit: Type.Optional(
      Type.Number({ description: t("最多返回的链接数，默认 50", "Max links to return, default 50") }),
    ),
  }),
  execute: async (_id, params: { url: string; limit?: number }) => {
    const keyErr = requireApiKey("web_map");
    if (keyErr) return textResult(keyErr);
    const limit = Math.min(200, Math.max(1, Math.floor(params.limit ?? 50)));

    const res = await tavilyRequest<{ results?: string[] }>("POST", "/map", { url: params.url, limit });
    if (!res.ok) {
      return textResult(failText("web_map", res));
    }

    const urls = res.data?.results ?? [];
    if (urls.length === 0) {
      return textResult(t("没有发现任何页面，检查 URL 或调整限制。", "No URLs found; check the URL or adjust the limit."));
    }
    const shown = urls.slice(0, 100);
    const lines = shown.map((u, i) => `- ${u}`).join("\n");
    const more = urls.length > shown.length ? `\n…（共 ${urls.length} 个，仅显示前 ${shown.length} 个）` : "";
    return textResult(t(`站点结构（${urls.length} 个页面）：\n`, `Site map (${urls.length} pages):\n`) + lines + more);
  },
});

export const webResearchTool = defineTool({
  name: "web_research",
  label: "Web Research",
  description: t(
    "深度研究并生成带引用的综合报告（Tavily 驱动，需 API Key，异步任务）。适合需要多角度综合、结论性答案的复杂问题。会执行多次搜索并汇总，耗时约几十秒到几分钟。",
    "Deep research producing a cited synthesis report (Tavily; requires API key; async). Best for complex questions needing multi-angle synthesis and a conclusive answer. Runs multiple searches and aggregates; takes tens of seconds to a few minutes.",
  ),
  parameters: Type.Object({
    query: Type.String({ description: t("研究问题/任务", "Research question or task") }),
    model: Type.Optional(
      Type.Unsafe<"auto" | "mini" | "pro">({
        type: "string",
        enum: ["auto", "mini", "pro"],
        description: t(
          "研究模型：mini 快（窄问题）、pro 全面（复杂多子题）、auto 自动，默认 auto",
          "Research model: mini fast (narrow), pro comprehensive (complex), auto default",
        ),
      }),
    ),
  }),
  execute: async (_id, params: { query: string; model?: "auto" | "mini" | "pro" }) => {
    const keyErr = requireApiKey("web_research");
    if (keyErr) return textResult(keyErr);
    const model = params.model ?? "auto";

    // 1. 创建研究任务
    const res = await tavilyRequest<{ request_id?: string }>("POST", "/research", {
      input: params.query,
      model,
      stream: false,
    });
    if (!res.ok) {
      return textResult(failText("web_research", res));
    }
    const requestId = res.data?.request_id;
    if (!requestId) {
      return textResult(t("研究任务创建失败（未返回 request_id），请稍后重试。", "Failed to create research task (no request_id); retry later."));
    }

    // 2. 轮询直至完成（最多 3 分钟）
    process.stderr.write(chalk.dim(t("（Tavily 研究进行中…）", "(Tavily research in progress…)") + "\n"));
    const deadline = Date.now() + RESEARCH_POLL_TIMEOUT_MS;
    for (;;) {
      await sleep(RESEARCH_POLL_INTERVAL_MS);
      const poll = await tavilyRequest<{ status?: string; content?: string; sources?: { title?: string; url?: string }[] }>(
        "GET",
        `/research/${requestId}`,
      );
      if (!poll.ok) {
        return textResult(failText("web_research", poll));
      }
      const status = poll.data?.status;
      if (status === "completed") {
        const content = (poll.data?.content || "").trim();
        const sources = poll.data?.sources ?? [];
        if (!content) {
          return textResult(t("研究任务完成但没有生成报告内容。", "Research completed but produced no report content."));
        }
        const truncated =
          content.length > RESEARCH_MAX_CHARS
            ? `${content.slice(0, RESEARCH_MAX_CHARS)}\n\n…（报告过长，已截断，全文共 ${content.length} 字符）`
            : content;
        const sourceLines = sources.length > 0
          ? `\n\n来源（${sources.length}）：\n` + sources.map((s) => `- ${s.title || ""}: ${s.url || ""}`).join("\n")
          : "";
        return textResult(truncated + sourceLines);
      }
      if (status === "failed") {
        return textResult(t("研究任务失败，请调整问题后重试。", "Research task failed; adjust the question and retry."));
      }
      if (Date.now() > deadline) {
        return textResult(t("研究任务超过 3 分钟仍未完成，请稍后重试。", "Research task did not finish within 3 minutes; retry later."));
      }
    }
  },
});

/** 仅配置了 tavilyApiKey 时才注册的深度工具（见 agent.ts 条件展开）。 */
export const premiumTavilyTools = [webCrawlTool, webMapTool, webResearchTool];
