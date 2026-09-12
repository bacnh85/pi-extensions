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
import {
  capturePdf as captureLocalPdf,
  captureScreenshot as captureLocalScreenshot,
  findChromeBinary,
  isSsrfBlocked,
  resolveEngine,
} from "./lib/chrome";

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

const engineSchema = {
  engine: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("local"),
    Type.Literal("daemon"),
  ], { default: "auto", description: "auto routes localhost/private/file URLs to local Chrome, the rest to the Crawl4AI daemon; local/daemon force one." })),
};

// ---------------------------------------------------------------------------
// Always-on routing guidance (injected only when a web_* tool is active)
// ---------------------------------------------------------------------------

// Portable home for the pi-web backend-selection protocol. Previously forced
// always-on via ~/.pi/agent/AGENTS.md; now self-injected by this extension so
// the guidance travels with the package and disappears when pi-web is absent.
const WEB_ROUTING_GUIDANCE = `## Web Tool Routing (pi-web)

- **web_search** — web search (auto: SearXNG → Brave → Firecrawl; force via \`backend\`, tune via \`engines\`).
- **web_extract** — URL → markdown (auto: static JSDOM → dynamic Firecrawl → full Crawl4AI → agy; force via \`mode\`; prompt+schema for JSON extraction).
- **web_map** — discover site URLs (Firecrawl Map).
- **web_crawl** — multi-page crawl: \`mode: "light"\` (Firecrawl, url) or \`mode: "full"\` (Crawl4AI, urls[]).
- **web_screenshot** / **web_pdf** — page capture (Crawl4AI).
- **web_status** — provider config + health.

Rules: Firecrawl Search is weak on domain-specific queries — prefer SearXNG/Brave; Firecrawl Scrape fails on bot-protected sites — use Crawl4AI (\`mode: "full"\`) then agy (\`mode: "agy"\`); cite source URLs.`;


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
    promptGuidelines: ["Source discovery, docs, facts. Precision/site/docs → Brave via backend:'brave'; tune SearXNG via engines.", "Cite source URLs."],
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
      "Extract readable content from a URL. Auto mode: static\u2192dynamic\u2192full\u2192agy.",
    promptSnippet: "Extract readable webpage content as markdown",
    promptGuidelines: ["Markdown from a known URL; prompt+schema for structured JSON extraction.", "Cite the source URL."],
    parameters: Type.Object({
      url: Type.String(),
      mode: Type.Optional(Type.Union(
        [Type.Literal("auto"), Type.Literal("static"), Type.Literal("dynamic"), Type.Literal("full"), Type.Literal("agy")],
        { default: "auto", description: "auto, static, dynamic, full, agy." },
      )),
      prompt: Type.Optional(Type.String({ description: "Prompt for structured JSON extraction (dynamic/agy modes)." })),
      schema: Type.Optional(Type.Any({ description: "JSON schema for structured extraction (dynamic/agy modes)." })),
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
    promptGuidelines: ["URL discovery before crawling; prefer web_extract for small jobs."],
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
    promptGuidelines: ["'light'=Firecrawl (url), 'full'=Crawl4AI (urls[]). Prefer web_map + web_extract for small jobs."],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL for mode:'light' (Firecrawl)." })),
      urls: Type.Optional(Type.Array(Type.String(), { description: "URLs for mode:'full' (Crawl4AI), up to 100." })),
      mode: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("full")], { default: "light", description: "'light'(Firecrawl) or 'full'(Crawl4AI)." })),
      limit: Type.Optional(Type.Number({ default: 10 })),
      include_paths: Type.Optional(Type.String({ description: "Comma-separated include paths (light mode)." })),
      exclude_paths: Type.Optional(Type.String({ description: "Comma-separated exclude paths (light mode)." })),
      poll: Type.Optional(Type.Boolean({ default: false, description: "Poll until completion (light mode)." })),
      browser_config: Type.Optional(Type.Any({ description: "BrowserConfig JSON (full mode)." })),
      crawler_config: Type.Optional(Type.Any({ description: "CrawlerRunConfig JSON (full mode)." })),
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
      "Full-page PNG screenshot via the Crawl4AI daemon, or via local headless Chrome for localhost/private/file URLs (auto-detected, engine overridable). The PNG is returned inline as an image block.",
    promptSnippet: "Screenshot a webpage",
    promptGuidelines: ["PNG returned inline (multimodal models see it); use when web_extract fails on JS-heavy pages, or to visually inspect a built UI. Local dev servers (localhost/LAN/file://) capture automatically via local Chrome."],
    parameters: Type.Object({
      url: Type.String(),
      wait_for: Type.Optional(Type.Number({ default: 2, description: "Seconds to wait before capture." })),
      wait_for_images: Type.Optional(Type.Boolean({ default: false })),
      engine: Type.Optional(engineSchema.engine),
      width: Type.Optional(Type.Number({ default: 1280, description: "Local engine: viewport width." })),
      height: Type.Optional(Type.Number({ default: 800, description: "Local engine: viewport height (full_page uses 8000)." })),
      full_page: Type.Optional(Type.Boolean({ default: false, description: "Local engine: capture a tall 8000px window to approximate full page." })),
      ...crawl4aiControlSchema,
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const url = params.url as string;
      let engine = resolveEngine(params.engine as string | undefined, url);
      let screenshot: string | undefined;
      let mime: string | undefined;
      let size: number | undefined;
      let artifactUrl: string | undefined;
      let details: Record<string, unknown> = {};

      if (engine === "local") {
        const cap = await captureLocalScreenshot({
          url,
          width: params.width as number | undefined,
          height: params.height as number | undefined,
          fullPage: params.full_page as boolean | undefined,
          waitForSec: params.wait_for as number | undefined,
          signal,
        });
        screenshot = cap.base64;
        mime = cap.mime;
        size = cap.size;
        details = { mime: cap.mime, size: cap.size };
      } else {
        const config = loadCrawl4aiConfig(params as Record<string, unknown>, cwdFromContext(ctx), includeProjectEnv(ctx));
        try {
          const result = await fetchCrawl4aiScreenshot(
            config,
            url,
            params.wait_for as number | undefined,
            params.wait_for_images as boolean | undefined,
            signal,
          );
          if (result.success === false) {
            throw new Error(String(result.error_message ?? "Crawl4AI screenshot failed"));
          }
          screenshot = result.screenshot as string | undefined;
          artifactUrl = result.url as string | undefined;
          mime = result.mime as string | undefined;
          size = result.size as number | undefined;
          details = { ...result };
        } catch (err) {
          // Daemon can't render this URL (SSRF-blocked); retry via local Chrome.
          if (!isSsrfBlocked(err) || !findChromeBinary()) throw err;
          engine = "local";
          const cap = await captureLocalScreenshot({
            url,
            width: params.width as number | undefined,
            height: params.height as number | undefined,
            fullPage: params.full_page as boolean | undefined,
            waitForSec: params.wait_for as number | undefined,
            signal,
          });
          screenshot = cap.base64;
          mime = cap.mime;
          size = cap.size;
          details = { mime: cap.mime, size: cap.size, fallback: "daemon SSRF-blocked this URL" };
        }
      }

      let text = `Screenshot: ${url}\nEngine: ${engine === "local" ? "local-chrome" : "crawl4ai"}\n`;
      if (artifactUrl) text += `Artifact: ${artifactUrl}\n`;
      if (mime) text += `MIME: ${mime}\n`;
      if (size) text += `Size: ${size} bytes\n`;
      // Return the PNG as a real image block so multimodal models see it.
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: truncateText(text) },
      ];
      if (screenshot) content.push({ type: "image", data: screenshot, mimeType: mime || "image/png" });
      return { content, details: { ...details, url, engine } };
    },
  });

  // ── web_pdf ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_pdf",
    label: "Web Page PDF",
    description:
      "PDF document via the Crawl4AI daemon, or via local headless Chrome for localhost/private/file URLs (auto-detected, engine overridable).",
    promptSnippet: "PDF a webpage",
    promptGuidelines: ["Printable/archivable page snapshot; returns base64 PDF. Local dev servers capture automatically via local Chrome."],
    parameters: Type.Object({
      url: Type.String(),
      engine: Type.Optional(engineSchema.engine),
      ...crawl4aiControlSchema,
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const url = params.url as string;
      let engine = resolveEngine(params.engine as string | undefined, url);
      let pdf: string | undefined;
      let artifactUrl: string | undefined;
      let size: number | undefined;
      let details: Record<string, unknown> = {};

      if (engine === "local") {
        const cap = await captureLocalPdf({ url, signal });
        pdf = cap.base64;
        size = cap.size;
        details = { mime: cap.mime, size: cap.size };
      } else {
        const config = loadCrawl4aiConfig(params as Record<string, unknown>, cwdFromContext(ctx), includeProjectEnv(ctx));
        try {
          const result = await fetchCrawl4aiPdf(config, url, signal);
          pdf = result.pdf as string | undefined;
          artifactUrl = result.url as string | undefined;
          size = result.size as number | undefined;
          details = { ...result };
        } catch (err) {
          if (!isSsrfBlocked(err) || !findChromeBinary()) throw err;
          engine = "local";
          const cap = await captureLocalPdf({ url, signal });
          pdf = cap.base64;
          size = cap.size;
          details = { mime: cap.mime, size: cap.size, fallback: "daemon SSRF-blocked this URL" };
        }
      }

      let text = `PDF: ${url}\nEngine: ${engine === "local" ? "local-chrome" : "crawl4ai"}\n`;
      if (pdf) text += `Data: base64 PDF (${pdf.length} chars)\n`;
      if (artifactUrl) text += `Artifact: ${artifactUrl}\n`;
      if (size) text += `Size: ${size} bytes\n`;
      return { content: [{ type: "text" as const, text: truncateText(text) }], details: { ...details, url, engine } };
    },
  });

  // ── web_status ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_status",
    label: "Web Provider Status",
    description:
      "Show web provider config status without printing secrets.",
    promptSnippet: "Check web provider config and server status",
    promptGuidelines: ["Reports backend presence/health; never prints secrets."],
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

      const { isAgyInstalled } = await import("./lib/agy");

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
        agy: { installed: isAgyInstalled() },
        localChrome: { path: findChromeBinary() ?? "not found" },
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
    const active = event.systemPromptOptions?.selectedTools ?? pi.getActiveTools();
    if (!active.some((t) => t.startsWith("web_"))) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${WEB_ROUTING_GUIDANCE}` };
  });

}
