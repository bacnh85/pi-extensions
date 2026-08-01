/// <reference path="./types.d.ts" />

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  findEnvValue,
  cwdFromContext,
  includeProjectEnv,
  normalizeSearxngBaseUrl,
  normalizeFirecrawlBaseUrl,
  normalizeCrawl4aiApiUrl,
  loadFirecrawlConfig,
  loadCrawl4aiConfig,
  HOSTED_FIRECRAWL_BASE_URL,
} from "./lib/config";
import {
  truncateText,
  formatFirecrawlScrape,
  formatCrawl4aiResult,
  formatUnifiedSearchResults,
} from "./lib/format";
import { searchWithDiagnostics } from "./lib/search";
import { extractWithDiagnostics, type ExtractMode } from "./lib/extract";
import { firecrawlRequest, type FirecrawlResult } from "./lib/firecrawl";
import {
  fetchCrawl4aiCrawl,
  fetchCrawl4aiScreenshot,
  fetchCrawl4aiPdf,
  fetchCrawl4aiHealth,
} from "./lib/crawl4ai";

// ---------------------------------------------------------------------------
// Shared schema fragment
// ---------------------------------------------------------------------------

const sharedControlSchema = {
  timeout_ms: Type.Optional(Type.Number({ description: "Request timeout in milliseconds." })),
};

const firecrawlControlSchema = {
  firecrawl_api_key: Type.Optional(Type.String({ description: "Override $FIRECRAWL_API_KEY." })),
  firecrawl_api_url: Type.Optional(Type.String({ description: "Override $FIRECRAWL_API_URL." })),
};

const crawl4aiControlSchema = {
  crawl4ai_api_url: Type.Optional(Type.String({ description: "Override $CRAWL4AI_API_URL." })),
  crawl4ai_api_token: Type.Optional(Type.String({ description: "Override $CRAWL4AI_API_TOKEN." })),
};

// ---------------------------------------------------------------------------
// Always-on routing guidance (injected only when a web_* tool is active)
// ---------------------------------------------------------------------------

// Portable home for the pi-web backend-selection protocol. Previously forced
// always-on via ~/.pi/agent/AGENTS.md; now self-injected by this extension so
// the guidance travels with the package and disappears when pi-web is absent.
const WEB_ROUTING_GUIDANCE = `## Web Tool Routing (pi-web)

The pi-web extension provides 7 unified tools that auto-select the best backend:

- **\`web_search\`** — Search the web (auto: SearXNG → Brave → Firecrawl). Use
  \`backend\` for explicit control, \`engines\` for SearXNG tuning.
- **\`web_extract\`** — Extract readable content from a URL (auto: static JSDOM
  → dynamic Firecrawl → full Crawl4AI). Use \`mode\` for explicit control.
- **\`web_map\`** — Discover URLs from a site (Firecrawl Map).
- **\`web_crawl\`** — Crawl multiple pages. \`mode: "light"\` (Firecrawl) or
  \`mode: "full"\` (Crawl4AI).
- **\`web_screenshot\`** / **\`web_pdf\`** — Visual/page capture (Crawl4AI).
- **\`web_status\`** — Check provider configuration and server health.

Backend selection rules:

- Firecrawl Search has poor semantic accuracy on domain-specific queries; prefer
  SearXNG or Brave for precision (force via \`backend\`).
- Firecrawl Scrape fails on bot-protected sites (e.g. Ansible docs); Crawl4AI
  handles those (force via \`mode: "full"\`).
- Always cite source URLs when web results materially support an answer.`;


// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function piWebExtension(pi: ExtensionAPI) {
  // ── web_search ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web. Auto-selects backends: SearXNG, Brave, Firecrawl.",
    promptSnippet: "Search current web results",
    promptGuidelines: [
      "Source discovery, docs, facts, and general search.",
      "Broad discovery uses SearXNG; precision/site/docs use Brave; Firecrawl is fallback.",
      "Force backend via backend:'brave'|'searxng' for poor auto results.",
      "Use engines='google,github' for SearXNG tuning.",
      "Cite source URLs.",
    ],
    parameters: Type.Object({
      query: Type.String(),
      count: Type.Optional(Type.Number({ default: 5 })),
      freshness: Type.Optional(Type.String({ description: "Time filter: pw/pm/py or YYYY-MM-DDtoYYYY-MM-DD." })),
      country: Type.Optional(Type.String({ default: "US" })),
      backend: Type.Optional(Type.Union(
        [Type.Literal("auto"), Type.Literal("searxng"), Type.Literal("brave"), Type.Literal("firecrawl")],
        { default: "auto", description: "auto, searxng, brave, firecrawl." },
      )),
      engines: Type.Optional(Type.String({ description: "SearXNG engine list (google,github). Only for searxng/auto backend." })),
      include_content: Type.Optional(Type.Boolean({ default: false, description: "Fetch inline page content (slower)." })),
      content_chars: Type.Optional(Type.Number({ default: 5000 })),
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const diagnostics = await searchWithDiagnostics({
        query: params.query as string,
        count: params.count as number | undefined,
        freshness: params.freshness as string | undefined,
        country: params.country as string | undefined,
        backend: params.backend as "auto" | "searxng" | "brave" | "firecrawl" | undefined,
        engines: params.engines as string | undefined,
        include_content: params.include_content as boolean | undefined,
        content_chars: params.content_chars as number | undefined,
        timeout_ms: params.timeout_ms as number | undefined,
        signal,
        _ctx: ctx,
      });
      const attempts = diagnostics.attempts.map((a) => `${a.backend}: ${a.status}${a.message ? ` (${a.message})` : ""}`).join("\n");
      const text = `${formatUnifiedSearchResults(diagnostics.results)}\n\n--- Search diagnostics ---\nSelected backend: ${diagnostics.selectedBackend}\n${attempts}`;
      return { content: [{ type: "text" as const, text: truncateText(text) }], details: diagnostics };
    },
  });

  // ── web_extract ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_extract",
    label: "Web Content Extraction",
    description:
      "Extract readable content from a URL. Auto mode: static\u2192dynamic\u2192full.",
    promptSnippet: "Extract readable webpage content as markdown",
    promptGuidelines: [
      "Clean markdown from a known URL.",
      "mode: 'static' (no API key, JSDOM), 'dynamic' (Firecrawl JS), 'full' (Crawl4AI).",
      "'auto' tries static\u2192dynamic\u2192full; see diagnostics for fallback chain.",
      "Use prompt+schema for structured JSON extraction (dynamic mode only).",
      "Cite the source URL.",
    ],
    parameters: Type.Object({
      url: Type.String(),
      mode: Type.Optional(Type.Union(
        [Type.Literal("auto"), Type.Literal("static"), Type.Literal("dynamic"), Type.Literal("full")],
        { default: "auto", description: "auto, static, dynamic, full." },
      )),
      prompt: Type.Optional(Type.String({ description: "Prompt for structured JSON extraction (dynamic mode only)." })),
      schema: Type.Optional(Type.Any({ description: "JSON schema for structured extraction (dynamic mode only)." })),
      content_chars: Type.Optional(Type.Number({ default: 20000 })),
      wait_for: Type.Optional(Type.Number({ description: "Ms to wait for Firecrawl render before extraction." })),
      mobile: Type.Optional(Type.Boolean({ default: false, description: "Mobile viewport (dynamic mode only)." })),
      ...crawl4aiControlSchema,
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const diagnostics = await extractWithDiagnostics({
        url: params.url as string,
        mode: params.mode as ExtractMode | undefined,
        prompt: params.prompt as string | undefined,
        schema: params.schema,
        content_chars: params.content_chars as number | undefined,
        timeout_ms: params.timeout_ms as number | undefined,
        wait_for: params.wait_for as number | undefined,
        mobile: params.mobile as boolean | undefined,
        crawl4ai_api_token: params.crawl4ai_api_token as string | undefined,
        crawl4ai_api_url: params.crawl4ai_api_url as string | undefined,
        signal,
        _ctx: ctx,
      });
      const result = diagnostics.result;
      const attempts = diagnostics.attempts.map((a) => `${a.mode}: ${a.status}${a.message ? ` (${a.message})` : ""}`).join("\n");
      const text = `${result.title ? `# ${result.title}\n\n` : ""}${result.markdown}\n\n--- Extraction diagnostics ---\nSelected mode: ${diagnostics.selectedMode}\nFallback used: ${diagnostics.fallbackUsed}\n${attempts}`;
      return { content: [{ type: "text" as const, text: truncateText(text) }], details: { url: params.url, ...diagnostics } };
    },
  });

  // ── web_map ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_map",
    label: "Site URL Discovery",
    description:
      "Discover site URLs via Firecrawl Map.",
    promptSnippet: "Map site URLs",
    promptGuidelines: [
      "Discover site URLs before crawling. Prefer web_extract for small jobs.",
      "Best on base domains. sitemap:'only' for sub-path discovery.",
      "Keep limits small unless broad discovery is requested.",
    ],
    parameters: Type.Object({
      url: Type.String(),
      limit: Type.Optional(Type.Number({ default: 100 })),
      include_subdomains: Type.Optional(Type.Boolean({ default: false })),
      search: Type.Optional(Type.String({ description: "Search query to guide URL discovery (semantic map)." })),
      sitemap: Type.Optional(Type.Union([Type.Literal("only"), Type.Literal("include"), Type.Literal("skip")], { description: "only, include(default), skip." })),
      use_index: Type.Optional(Type.Boolean({ default: true, description: "Use Firecrawl index for discovery." })),
      ignore_cache: Type.Optional(Type.Boolean({ default: false, description: "Ignore cached results." })),
      ...firecrawlControlSchema,
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const body: Record<string, unknown> = {
        url: params.url,
        limit: (params.limit as number) ?? 100,
        includeSubdomains: Boolean(params.include_subdomains),
      };
      if (params.search !== undefined) body.search = params.search;
      if (params.sitemap !== undefined) body.sitemap = params.sitemap;
      if (params.use_index !== undefined) body.useIndex = params.use_index;
      if (params.ignore_cache !== undefined) body.ignoreCache = params.ignore_cache;
      const config = loadFirecrawlConfig(params as Record<string, unknown>, cwdFromContext(ctx), includeProjectEnv(ctx));
      const result = await firecrawlRequest(config, "POST", "/map", body, signal);
      const urls = result.data || result.links || result.urls || [];
      const text = Array.isArray(urls) && urls.length > 0
        ? (urls as Array<Record<string, unknown> | string>).map((u: any) => u.url || u).join("\n")
        : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text: truncateText(text) }], details: result };
    },
  });

  // ── web_crawl ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_crawl",
    label: "Site Crawl",
    description:
      "Crawl pages. Firecrawl 'light' or Crawl4AI 'full' headless mode.",
    promptSnippet: "Crawl a small site section",
    promptGuidelines: [
      "Prefer web_map + web_extract over crawl for small jobs.",
      "'light'=Firecrawl (url param), 'full'=Crawl4AI (urls[] param).",
      "Keep limit low (default 10).",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL for Firecrawl-style crawl (mode:'light')." })),
      urls: Type.Optional(Type.Array(Type.String(), { description: "URLs for Crawl4AI-style crawl (mode:'full'), up to 100." })),
      mode: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("full")], { default: "light", description: "'light'(Firecrawl) or 'full'(Crawl4AI)." })),
      limit: Type.Optional(Type.Number({ default: 10 })),
      include_paths: Type.Optional(Type.String({ description: "Comma-separated paths to include (Firecrawl mode)." })),
      exclude_paths: Type.Optional(Type.String({ description: "Comma-separated paths to exclude (Firecrawl mode)." })),
      poll: Type.Optional(Type.Boolean({ default: false, description: "Poll for completion (Firecrawl mode)." })),
      browser_config: Type.Optional(Type.Any({ description: "BrowserConfig JSON (full mode only)." })),
      crawler_config: Type.Optional(Type.Any({ description: "CrawlerRunConfig JSON (full mode only)." })),
      content_chars: Type.Optional(Type.Number({ default: 20000 })),
      ...firecrawlControlSchema,
      ...crawl4aiControlSchema,
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const mode = (params.mode as string) || "light";
      const cwd = cwdFromContext(ctx);
      const trusted = includeProjectEnv(ctx);
      const maxChars = (params.content_chars as number) ?? 20000;

      if (mode === "full") {
        // Crawl4AI mode
        const urls = (params.urls as string[]) || (params.url ? [params.url as string] : []);
        if (!urls.length) throw new Error("Either url or urls parameter is required for crawl.");
        const config = loadCrawl4aiConfig(params as Record<string, unknown>, cwd, trusted);
        const browserConfig = params.browser_config as Record<string, unknown> | undefined;
        const crawlerConfig = params.crawler_config as Record<string, unknown> | undefined;
        const result = await fetchCrawl4aiCrawl(config, urls, browserConfig, crawlerConfig, signal);
        const text = formatCrawl4aiResult(result as unknown as Record<string, unknown>, maxChars);
        return { content: [{ type: "text" as const, text: truncateText(text) }], details: result };
      }

      // Firecrawl mode ("light")
      if (!params.url) throw new Error("The url parameter is required for Firecrawl mode ('light').");
      const fcConfig = loadFirecrawlConfig(params as Record<string, unknown>, cwd, trusted);
      let result = await firecrawlRequest(
        fcConfig,
        "POST",
        "/crawl",
        {
          url: params.url as string,
          limit: Math.min(10000, Math.max(1, (params.limit as number) ?? 10)),
          includePaths: params.include_paths
            ? String(params.include_paths).split(",").map((s: string) => s.trim()).filter(Boolean)
            : [],
          excludePaths: params.exclude_paths
            ? String(params.exclude_paths).split(",").map((s: string) => s.trim()).filter(Boolean)
            : [],
          scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
        },
        signal,
      );
      const id = result.id || (result.data as Record<string, unknown> | undefined)?.id;
      if (params.poll && id && !Array.isArray(result.data)) {
        const { abortableSleep } = await import("./lib/retry");
        for (let i = 0; i < 60; i++) {
          result = await firecrawlRequest(fcConfig, "GET", `/crawl/${id}`, undefined, signal);
          if (["completed", "failed", "cancelled"].includes(
            String(result.status || (result.data as Record<string, unknown> | undefined)?.status || ""),
          )) break;
          await abortableSleep(2000, signal);
        }
      }
      const pages = Array.isArray(result.data)
        ? (result.data as Record<string, unknown>[])
        : ((result.data as Record<string, unknown>)?.data as Record<string, unknown>[]) || [];
      const text = pages.length
        ? pages.map((p: Record<string, unknown>) => formatFirecrawlScrape({ data: p } as Record<string, unknown>, maxChars)).join("\n\n---\n\n")
        : id
          ? `Crawl started: ${id}\nUse poll=true or check Firecrawl status/dashboard.`
          : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text: truncateText(text) }], details: result };
    },
  });

  // ── web_screenshot ───────────────────────────────────────────────────
  pi.registerTool({
    name: "web_screenshot",
    label: "Web Page Screenshot",
    description:
      "Full-page PNG screenshot via Crawl4AI.",
    promptSnippet: "Screenshot a webpage",
    promptGuidelines: [
      "Use when web_extract fails on JS-heavy or bot-protected pages.",
      "wait_for (default 2s) delays capture for dynamic content.",
    ],
    parameters: Type.Object({
      url: Type.String(),
      wait_for: Type.Optional(Type.Number({ default: 2, description: "Seconds to wait before capture." })),
      wait_for_images: Type.Optional(Type.Boolean({ default: false, description: "Wait for images before capture." })),
      ...crawl4aiControlSchema,
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const config = loadCrawl4aiConfig(params as Record<string, unknown>, cwdFromContext(ctx), includeProjectEnv(ctx));
      const result = await fetchCrawl4aiScreenshot(
        config,
        params.url as string,
        params.wait_for as number | undefined,
        params.wait_for_images as boolean | undefined,
        signal,
      );
      const screenshot = result.screenshot as string | undefined;
      const artifactUrl = result.url as string | undefined;
      const mime = result.mime as string | undefined;
      const size = result.size as number | undefined;
      let text = `Screenshot: ${params.url}\n`;
      if (screenshot) text += `Data: base64 PNG (${screenshot.length} chars)\n`;
      if (artifactUrl) text += `Artifact: ${artifactUrl}\n`;
      if (mime) text += `MIME: ${mime}\n`;
      if (size) text += `Size: ${size} bytes\n`;
      return { content: [{ type: "text" as const, text: truncateText(text) }], details: { ...result, url: params.url } };
    },
  });

  // ── web_pdf ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_pdf",
    label: "Web Page PDF",
    description:
      "PDF document via Crawl4AI.",
    promptSnippet: "PDF a webpage",
    promptGuidelines: [
      "Printable or archivable page snapshot.",
      "Returns base64 PDF string.",
    ],
    parameters: Type.Object({
      url: Type.String(),
      ...crawl4aiControlSchema,
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const config = loadCrawl4aiConfig(params as Record<string, unknown>, cwdFromContext(ctx), includeProjectEnv(ctx));
      const result = await fetchCrawl4aiPdf(config, params.url as string, signal);
      const pdf = result.pdf as string | undefined;
      const artifactUrl = result.url as string | undefined;
      const size = result.size as number | undefined;
      let text = `PDF: ${params.url}\n`;
      if (pdf) text += `Data: base64 PDF (${pdf.length} chars)\n`;
      if (artifactUrl) text += `Artifact: ${artifactUrl}\n`;
      if (size) text += `Size: ${size} bytes\n`;
      return { content: [{ type: "text" as const, text: truncateText(text) }], details: { ...result, url: params.url } };
    },
  });

  // ── web_status ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_status",
    label: "Web Provider Status",
    description:
      "Show web provider config status without printing secrets.",
    promptSnippet: "Check web provider config and server status",
    promptGuidelines: [
      "Check which backends are configured and their server status.",
      "Never prints secrets — reports only presence and source.",
      "apiKeyFound:false is normal for self-hosted Firecrawl; check ready field.",
    ],
    parameters: Type.Object({}),
    async execute(_id: string, _params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const cwd = cwdFromContext(ctx);
      const trusted = includeProjectEnv(ctx);

      // Provider config status
      const braveKey = findEnvValue("BRAVE_API_KEY", cwd, trusted);
      const searxngUrl = findEnvValue("SEARXNG_BASE_URL", cwd, trusted);
      const fireKey = findEnvValue("FIRECRAWL_API_KEY", cwd, trusted);
      const fireUrl = findEnvValue("FIRECRAWL_API_URL", cwd, trusted);
      const c4aiUrl = findEnvValue("CRAWL4AI_API_URL", cwd, trusted);
      const c4aiToken = findEnvValue("CRAWL4AI_API_TOKEN", cwd, trusted);

      const fcBaseUrl = normalizeFirecrawlBaseUrl(fireUrl.value);
      const fcHosted = !fireUrl.value || fcBaseUrl.startsWith(HOSTED_FIRECRAWL_BASE_URL);

      const status: Record<string, unknown> = {
        brave: { apiKeyFound: Boolean(braveKey.value), apiKeySource: braveKey.value ? braveKey.source : "not set" },
        searxng: { baseUrl: normalizeSearxngBaseUrl(searxngUrl.value), baseUrlSource: searxngUrl.source || "default local" },
        firecrawl: {
          baseUrl: fcBaseUrl,
          apiUrlSource: fireUrl.source || "default hosted",
          apiKeyFound: Boolean(fireKey.value),
          apiKeySource: fireKey.value ? fireKey.source : "not set",
          hostedMode: fcHosted,
          ready: fcHosted ? Boolean(fireKey.value) : Boolean(fireUrl.value?.trim()),
        },
        crawl4ai: {
          baseUrl: normalizeCrawl4aiApiUrl(c4aiUrl.value),
          baseUrlSource: c4aiUrl.source || "default",
          apiTokenFound: Boolean(c4aiToken.value),
          apiTokenSource: c4aiToken.value ? c4aiToken.source : "not set",
        },
      };

      // Crawl4AI health check
      let c4aiHealth: Record<string, unknown> | undefined;
      try {
        const c4aiCfg = loadCrawl4aiConfig({}, cwd, trusted);
        c4aiHealth = await fetchCrawl4aiHealth(c4aiCfg, signal);
      } catch (e: any) {
        c4aiHealth = { status: "unreachable", error: e?.message ?? String(e) };
      }
      status.crawl4ai = { ...(status.crawl4ai as Record<string, unknown>), health: c4aiHealth };

      return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }], details: status };
    },
  });

  // ── Always-on routing guidance ──────────────────────────────────────────
  // Inject the backend-selection protocol only when a web_* tool is actually
  // active, so recon agents / sessions without pi-web carry zero overhead.
  pi.on("before_agent_start", async (event) => {
    const active = event.systemPromptOptions?.selectedTools ?? [];
    if (!active.some((t) => t.startsWith("web_"))) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${WEB_ROUTING_GUIDANCE}` };
  });

}
