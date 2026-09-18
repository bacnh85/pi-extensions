/// <reference path="./types.d.ts" />

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
import {
  loadGeminiWebConfig,
  geminiAsk,
  geminiResearch,
  describeGeminiError,
} from "./lib/gemini";
import { cookieStoreSnapshot } from "./lib/gemini-auth";
import {
  generateImageWithFallback,
  loadImageApiConfig,
  loadImageRateConfig,
  imageRateSnapshot,
  type ImageProvider,
} from "./lib/imageapi";
import {
  chatgptChat,
  describeChatApiError,
  loadChatConfig,
} from "./lib/chatapi";
import {
  chatgptAuthSnapshot,
  chatgptWebChat,
  describeChatGptError,
  loadChatGptAuth,
} from "./lib/chatgpt";
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
  FULL_PAGE_HEIGHT,
} from "./lib/chrome";
import {
  runInteraction,
  type InteractStep,
} from "./lib/cdp";

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

// Saved image file → inline image block (the 0.6.2 vision-loop lesson: the
// generating model should see its own output).
export async function toImageBlock(file: string): Promise<{ type: "image"; data: string; mimeType: string }> {
  const data = (await fs.promises.readFile(file)).toString("base64");
  const lower = file.toLowerCase();
  const mimeType = lower.endsWith(".jpg") || lower.endsWith(".jpeg")
    ? "image/jpeg"
    : lower.endsWith(".webp")
      ? "image/webp"
      : lower.endsWith(".gif")
        ? "image/gif"
      : "image/png";
  return { type: "image" as const, data, mimeType };
}

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
- **web_interact** — drive a real headless Chrome session: trusted click/type/press, JS evaluate, wait_for, screenshots + scrollWidth probe (use to verify UI behavior, not just looks).
- **web_research** — AI-synthesized research via Gemini web (mode "ask" = grounded answer, guest OK; mode "research" = Deep Research report — plan, autonomous web browsing, cited report; takes minutes when available).
- **web_image** — text→image generation (auto: Gemini web → ChatGPT web via CHATGPT_WEB_AUTH_KEY / codex login → Z.ai GLM-Image → custom OpenAI-images endpoint; \`model\`/\`n\`/\`size\` params).
- **web_chat** — one-off chat completion — ChatGPT web (CHATGPT_WEB_AUTH_KEY / codex login; default when configured) or an OpenAI-compatible gateway (\`WEB_CHAT_API_BASE_URL\`; non-streaming).
- **web_status** — provider config + health.

Rules: Firecrawl Search is weak on domain-specific queries — prefer SearXNG/Brave; Firecrawl Scrape fails on bot-protected sites — use Crawl4AI (\`mode: "full"\`) then agy (\`mode: "agy"\`); cite source URLs.`;


// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/** Validate a requested image size: WxH, 3-4 digits each. Present-but-invalid throws (never silently generates a square). */
function parseSizeParam(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const s = String(value);
  if (!/^\d{3,4}x\d{3,4}$/.test(s)) throw new Error(`invalid size "${s}": expected WxH with 3-4 digits each, e.g. 960x1728`);
  return s;
}

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
      reduced_motion: Type.Optional(Type.Boolean({ default: false, description: "Local engine: force prefers-reduced-motion. Staggered page-load reveals screenshot as blank sections otherwise; also doubles as a reduced-motion audit." })),
      ...crawl4aiControlSchema,
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const url = params.url as string;
      // Local capture with honest sub-500px handling: headless Chrome clamps
      // --window-size to 500px (a "390 capture" renders 500 and crops), so
      // widths below the clamp go through CDP device-metrics emulation and
      // report a scrollWidth/innerWidth probe beside the PNG.
      const captureLocalShot = async () => {
        const width = (params.width as number | undefined) ?? 1280;
        const reducedMotion = params.reduced_motion as boolean | undefined;
        const waitForSec = params.wait_for as number | undefined;
        const fullPage = params.full_page as boolean | undefined;
        if (width < 500) {
          const r = await runInteraction({
            url,
            viewport: { width, height: fullPage ? FULL_PAGE_HEIGHT : ((params.height as number | undefined) ?? 844) },
            reducedMotion,
            waitForSec,
            signal,
          });
          const base64 = r.screenshot ?? "";
          return { base64, mime: "image/png", size: Math.round((base64.length * 3) / 4), probe: r.probe, emulated: true, height: fullPage ? FULL_PAGE_HEIGHT : ((params.height as number | undefined) ?? 844) };
        }
        const cap = await captureLocalScreenshot({
          url,
          width,
          height: params.height as number | undefined,
          fullPage: params.full_page as boolean | undefined,
          reducedMotion,
          waitForSec,
          signal,
        });
        return { ...cap, probe: undefined as { scrollWidth?: number; innerWidth?: number } | undefined, emulated: false };
      };
      let engine = resolveEngine(params.engine as string | undefined, url);
      let screenshot: string | undefined;
      let mime: string | undefined;
      let size: number | undefined;
      let artifactUrl: string | undefined;
      let details: Record<string, unknown> = {};

      if (engine === "local") {
        const cap = await captureLocalShot();
        screenshot = cap.base64;
        mime = cap.mime;
        size = cap.size;
        details = { mime: cap.mime, size: cap.size, ...(cap.probe ? { probe: cap.probe, emulated: true, emulatedHeight: (cap as { height?: number }).height } : {}) };
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
          const cap = await captureLocalShot();
          screenshot = cap.base64;
          mime = cap.mime;
          size = cap.size;
          details = { mime: cap.mime, size: cap.size, ...(cap.probe ? { probe: cap.probe, emulated: true, emulatedHeight: (cap as { height?: number }).height } : {}), fallback: "daemon SSRF-blocked this URL" };
        }
      }

      let text = `Screenshot: ${url}\nEngine: ${engine === "local" ? "local-chrome" : "crawl4ai"}\n`;
      if (details.probe) {
        const probe = details.probe as { scrollWidth?: number; innerWidth?: number };
        const emuHeight = (details.emulatedHeight as number | undefined) ?? (params.height as number | undefined) ?? 844;
        text += `Viewport: ${params.width}x${emuHeight} (device-emulated${params.full_page ? ", full page" : ""})\n`;
        text += `Probe: scrollWidth ${probe.scrollWidth ?? "?"} / innerWidth ${probe.innerWidth ?? "?"}${typeof probe.scrollWidth === "number" && typeof params.width === "number" && probe.scrollWidth > params.width ? " — CONTENT OVERFLOWS" : ""}\n`;
      }
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
      reduced_motion: Type.Optional(Type.Boolean({ default: false, description: "Local engine: force prefers-reduced-motion before printing." })),
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
        const cap = await captureLocalPdf({ url, reducedMotion: params.reduced_motion as boolean | undefined, signal });
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
          const cap = await captureLocalPdf({ url, reducedMotion: params.reduced_motion as boolean | undefined, signal });
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

  // ── web_interact ────────────────────────────────────────────────
  pi.registerTool({
    name: "web_interact",
    label: "Web Page Interaction",
    description:
      "Drive a real headless Chrome session: open a URL and run steps in one call — trusted clicks (CDP mouse events, so user activation works: clipboard, login), typing, key presses, JS evaluate (value correctly unwrapped), wait_for selector/milliseconds, native dialog answer (dialog step), screenshots. Native confirm()/alert()/prompt()/beforeunload are auto-DISMISSED and reported per step; each step has a timeout_ms budget (default 60s, clamped 1s–600s) that fails loudly instead of hanging. Returns per-step results, a final inline PNG, and a scrollWidth/innerWidth probe. Local Chrome only (any http/https/file URL the local machine can reach). One call = one browser lifecycle; re-call with adjusted steps for exploratory flows.",
    promptSnippet: "Interact with a webpage (click/type/evaluate) in headless Chrome",
    promptGuidelines: [
      "Use to VERIFY your own UI builds in the UX render-inspect loop: click the primary CTA, submit the form, read back state with evaluate — a screenshot alone proves nothing about behavior.",
      "click/type go through CDP trusted input (user activation), so clipboard writes and gated APIs work — document.execCommand('copy') under a trusted click returns true.",
      "Native confirm()/alert() dialogs are auto-DISMISSED (destructive actions stay blocked) and reported on the step result; to ACCEPT one, arm {\"dialog\":\"accept\"} before the triggering click.",
      "A step stuck longer than timeout_ms (default 60s) fails with the reason instead of hanging the call — raise timeout_ms for legitimately slow evaluate steps.",
      "Set viewport {width:390,height:844} for mobile briefs — honest device-metrics emulation (the CLI --window-size path clamps at 500px); the probe's scrollWidth reveals overflow (scrollWidth > width means broken CSS).",
      "Steps run in order and stop at the first failure, so a broken selector surfaces loudly instead of silently no-op'ing later steps.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Page to open (http://, https://, or file://)." }),
      // Wire format is a FLAT object with optional action fields, not a union of
      // object variants: Z.ai's anthropic-compatible endpoint rejects anyOf nested
      // inside anyOf with 400/1210, and the wait_for string|number union inside the
      // step union is exactly that. Runtime still accepts the union shape.
      steps: Type.Optional(
        Type.Array(
          Type.Object({
            click: Type.Optional(Type.String({ description: "Selector to trusted-click (scrolled into view, clicked at center via CDP mouse events)." })),
            type: Type.Optional(Type.Object({ selector: Type.String(), text: Type.String() }, { description: "Focus selector, then insert text." })),
            press: Type.Optional(Type.String({ description: "Key to press: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Space, or a single character." })),
            evaluate: Type.Optional(Type.String({ description: "JS expression to evaluate; resolved value returned (awaitPromise on)." })),
            wait_for: Type.Optional(Type.String({ description: "Selector to wait for (5s budget)." })),
            wait_ms: Type.Optional(Type.Number({ description: "Milliseconds to sleep." })),
            screenshot: Type.Optional(Type.Boolean({ description: "Capture a PNG now; the last screenshot is returned inline. false = no-op here (the automatic final screenshot still runs)." })),
            dialog: Type.Optional(Type.String({ description: '"accept" or "dismiss" — the answer for the NEXT native dialog (confirm/alert/prompt/beforeunload); default auto-dismiss.' })),
            label: Type.Optional(Type.String({ description: "Optional label shown on the step's result line." })),
          }, { description: "One action per step object — set exactly one action field. Actions run in order and stop at the first failure. Omit for open + screenshot + probe only." })),
      ),
      viewport: Type.Optional(
        Type.Object({
          width: Type.Number({ description: "Viewport width in CSS px (e.g. 390 for a phone)." }),
          height: Type.Optional(Type.Number({ description: "Viewport height (default 800)." })),
          device_scale_factor: Type.Optional(Type.Number({ description: "Device scale factor (default 1; 2 for retina-style captures)." })),
        }),
      ),
      reduced_motion: Type.Optional(Type.Boolean({ default: false, description: "Emulate prefers-reduced-motion: reduce so staggered load reveals don't screenshot as blank sections." })),
      grant: Type.Optional(Type.Array(Type.String(), { description: "Browser permissions to grant, e.g. [\"clipboardReadWrite\", \"clipboardSanitizedWrite\"] (CDP names). Friendly aliases \"clipboard-read\"/\"clipboard-write\" are mapped automatically." })),
      wait_for: Type.Optional(Type.Number({ default: 2, description: "Seconds to settle after load before steps run." })),
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, _ctx: any) {
      const url = params.url as string;
      // Flatten wait_ms back onto the union shape runInteraction validates
      // ({ wait_for: number }); the schema is flat only because of the
      // Z.ai anyOf-in-anyOf limit (see schema comment above).
      const steps = ((params.steps ?? []) as Record<string, unknown>[]).map((s) => {
        if (!("wait_ms" in s)) return s as InteractStep;
        const { wait_ms, ...rest } = s;
        return { ...rest, wait_for: wait_ms } as InteractStep;
      });
      const result = await runInteraction({
        url,
        steps,
        viewport: params.viewport as { width: number; height?: number; device_scale_factor?: number } | undefined,
        reducedMotion: params.reduced_motion as boolean | undefined,
        grant: params.grant as string[] | undefined,
        waitForSec: params.wait_for as number | undefined,
        // Per-step budget, clamped to a sane range — 0/negative would fail every step.
        stepTimeoutMs:
          typeof params.timeout_ms === "number" ? Math.min(Math.max(params.timeout_ms, 1_000), 600_000) : undefined,
        signal,
      });
      const lines = [`Interaction: ${url}`];
      result.outcomes.forEach((o, i) => {
        const value = o.ok && o.value !== undefined ? ` = ${JSON.stringify(o.value)}` : "";
        lines.push(`${i + 1}. ${o.label} → ${o.ok ? `ok${value}` : `FAILED: ${o.error}`}${o.dialogs ? ` [${o.dialogs.join("; ")}]` : ""}`);
      });
      if (result.outcomes.some((o) => !o.ok)) lines.push("Stopped at the first failed step.");
      if (result.navigatedTo) {
        lines.push(`⚠ A step navigated the page to ${result.navigatedTo} — later steps ran against the NEW document.`);
      }
      if (result.dialogs?.length) lines.push(`Native dialogs: ${result.dialogs.join("; ")}`);
      const p = result.probe;
      const overflow =
        typeof p.scrollWidth === "number" && typeof params.viewport === "object" && params.viewport !== null
          ? p.scrollWidth > (params.viewport as { width: number }).width
          : false;
      lines.push(
        `Probe: scrollWidth ${p.scrollWidth ?? "?"} / innerWidth ${p.innerWidth ?? "?"}${overflow ? " — CONTENT OVERFLOWS the viewport" : ""}`,
      );
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: truncateText(lines.join("\n")) },
      ];
      if (result.screenshot) content.push({ type: "image", data: result.screenshot, mimeType: "image/png" });
      return {
        content,
        details: {
          url,
          probe: result.probe,
          ...(result.navigatedTo ? { navigatedTo: result.navigatedTo } : {}),
          ...(result.dialogs?.length ? { dialogs: result.dialogs } : {}),
          outcomes: result.outcomes.map(({ label, ok, value, error, dialogs }) => ({ label, ok, value, error, dialogs })),
        },
      };
    },
  });

  // ── web_research ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_research",
    label: "Web Research (Gemini)",
    description:
      "AI-synthesized web research via Gemini (gemini.google.com web tier, cookie auth). Mode 'ask' returns a quick grounded answer with source links (works guest-mode, Flash only). Mode 'research' runs Gemini Deep Research — plan turn, 'Start research' confirm, then polls until the cited report lands. Requires GEMINI_WEB_SECURE_1PSID (+ fresh __Secure-1PSIDTS); the plan turn runs over plain Node, but confirm (execution start) and report polling are gated server-side and may refuse from this transport (verified 2026-09-14: confirm needs a browser-grade TLS fingerprint) — refusals return an honest partial result (plan + transcript + note) instead of the report. Takes minutes when available.",
    promptSnippet: "AI-synthesized research with citations",
    promptGuidelines: [
      "Use for AI-synthesized research with sources (mode ask = quick grounded answer; mode research = multi-minute Deep Research report). NOT for URL-list searches (web_search) or single-URL extraction (web_extract). Cite the returned source URLs.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Research question or topic." }),
        mode: Type.Optional(Type.Union(
          [Type.Literal("ask"), Type.Literal("research")],
          { default: "ask", description: "ask = quick grounded answer (guest OK); research = full Deep Research report (cookie required; runs the pure-Node DR client — plan/confirm execute on live sessions, degraded sessions return an honest partial result)." },
        )),
      model: Type.Optional(Type.String({ description: "Gemini model for ask mode (e.g. gemini-3-flash). Discovered from the account by default." })),
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const config = loadGeminiWebConfig(cwdFromContext(ctx), includeProjectEnv(ctx));
      const mode = (params.mode as string) || "ask";
      const query = params.query as string;
      try {
        if (mode === "research") {
          const timeoutMs = Math.min(Math.max((params.timeout_ms as number) ?? 600_000, 30_000), 1_800_000);
          const result = await geminiResearch(query, { config, timeoutMs, signal });
          const meta = [
            "Mode: research (Gemini Deep Research)",
            result.title ? `Title: ${result.title}` : null,
            result.eta ? `ETA: ${result.eta}` : null,
          ].filter(Boolean).join("\n");
          const sources = result.sources.length ? result.sources.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(none found in report text)";
          const text = `${meta}\n\n${result.text}\n\n--- Sources (extracted from report) ---\n${sources}`;
          return { content: [{ type: "text" as const, text: truncateText(text) }], details: { mode, ...result } };
        }
        const askTimeoutMs = Math.min(Math.max((params.timeout_ms as number) ?? 120_000, 30_000), 600_000);
        const result = await geminiAsk(query, { config, model: params.model as string | undefined, timeoutMs: askTimeoutMs, signal });
        const meta = [
          "Mode: ask",
          `Model: ${result.model ?? "unknown"}`,
          result.guest ? "Guest mode (no cookie — Flash only; set GEMINI_WEB_SECURE_1PSID for full access)" : "Cookie auth",
        ].join("\n");
        const sources = result.sources.length ? result.sources.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(none found in answer text)";
        const text = `${meta}\n\n${result.text}\n\n--- Sources (extracted from answer) ---\n${sources}`;
        return { content: [{ type: "text" as const, text: truncateText(text) }], details: { mode, ...result } };
      } catch (err) {
        throw new Error(describeGeminiError(err));
      }
    },
  });

  // ── web_image ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_image",
    label: "Web Image Generation",
    description:
      "Generate images from text via free upstream providers, with fallback: Gemini web (gemini.google.com, guest or cookie auth), ChatGPT web (subscription via CHATGPT_WEB_AUTH_KEY / codex login, image_generation tool), Z.ai official API (GLM-Image via ZAI_API_KEY), or any custom OpenAI-compatible images endpoint (WEB_IMAGE_API_BASE_URL). Optional size=WxH for zai/custom (glm-image enums incl. 960x1728 portrait; omit = server default, usually square). Returns saved file paths plus the images inline.",
    promptSnippet: "Generate images via free upstreams (Gemini web, ChatGPT web, Z.ai GLM-Image)",
    promptGuidelines: [
      "Use for image GENERATION from a text prompt. provider auto falls back gemini → chatgpt → zai → custom. Portrait/aspect-sensitive prompts: pass size (zai/custom), e.g. 960x1728 — default is square. Capturing an EXISTING page is web_screenshot, not this.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Image description." }),
      provider: Type.Optional(Type.Union(
        [Type.Literal("auto"), Type.Literal("gemini"), Type.Literal("chatgpt"), Type.Literal("zai"), Type.Literal("custom")],
        { default: "auto", description: "auto = gemini → chatgpt (if CHATGPT_WEB_AUTH_KEY/codex login) → zai (if ZAI_API_KEY) → custom (if WEB_IMAGE_API_BASE_URL); pin one to skip fallback." },
      )),
      model: Type.Optional(Type.String({ description: "Provider-specific model (e.g. glm-image, or a Gemini image-capable model id). Omit for the provider default." })),
      n: Type.Optional(Type.Number({ default: 1, description: "Number of images, 1-4 (applies to zai/custom; the gemini web tier returns its own count)." })),
      size: Type.Optional(Type.String({ pattern: "^\\d{3,4}x\\d{3,4}$", description: "Image size as WxH (zai/custom only). glm-image enums: 1280x1280 (default), 1568x1056, 1056x1568, 1472x1088, 1088x1472, 1728x960, 960x1728. Omit for the provider default." })),
      out_dir: Type.Optional(Type.String({ description: "Directory for saved images (default: fresh temp dir)." })),
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const cwd = cwdFromContext(ctx);
      const trusted = includeProjectEnv(ctx);
      const prompt = params.prompt as string;
      const n = Math.min(Math.max(Math.trunc((params.n as number) ?? 1) || 1, 1), 4);
      const timeoutMs = Math.min(Math.max((params.timeout_ms as number) ?? 180_000, 10_000), 600_000);
      const outDir = params.out_dir
        ? path.resolve(cwd, String(params.out_dir))
        : await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-web-image-"));
      const result = await generateImageWithFallback({
        prompt,
        model: params.model as string | undefined,
        n,
        size: parseSizeParam(params.size),
        outDir,
        provider: (params.provider as "auto" | ImageProvider) ?? "auto",
        geminiConfig: loadGeminiWebConfig(cwd, trusted),
        apiConfig: loadImageApiConfig(cwd, trusted),
        rateConfig: loadImageRateConfig(cwd, trusted),
        ...(() => {
          const cgpt = loadChatGptAuth(cwd, trusted);
          return { chatgptAuth: cgpt.auth, ...(cgpt.problem ? { chatgptProblem: cgpt.problem } : {}) };
        })(),
        timeoutMs,
        signal,
      });
      const blocks = await Promise.all(result.paths.map(toImageBlock));
      const text = [
        `Provider: ${result.provider}${result.model ? ` (${result.model})` : ""}`,
        `Saved: ${result.paths.length} image(s)`,
        ...result.paths.map((p) => `  ${p}`),
        ...(result.urls.length
          ? [
              "Not saved (download failed — URL openable directly):",
              ...result.urls.map((u, i) => `  ${u}${result.downloadErrors?.[i] ? `  (${result.downloadErrors[i]})` : ""}`),
            ]
          : []),
        result.attempts.length ? `Provider notes: ${result.attempts.join(" | ")}` : null,
        result.note ?? null,
      ].filter(Boolean).join("\n");
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text" as const, text },
        ...blocks,
      ];
      return { content, details: { provider: result.provider, model: result.model, paths: result.paths, urls: result.urls, downloadErrors: result.downloadErrors, attempts: result.attempts } };
    },
  });

  // ── web_chat ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_chat",
    label: "Web Chat (ChatGPT web / gateway)",
    description:
      "One-off chat completion — ChatGPT web tier (subscription, via CHATGPT_WEB_AUTH_KEY / codex login; default when configured) or any OpenAI-compatible gateway (WEB_CHAT_API_BASE_URL). Non-streaming Q&A; not a provider — use /model to switch your main model.",
    promptSnippet: "One-off chat via ChatGPT web or an OpenAI-compatible gateway",
    promptGuidelines: [
      "Use for a quick one-off second opinion, classification, or short generation call. Grounded research with sources → web_research; switching your main chat model → /model.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The question or instruction." }),
      provider: Type.Optional(Type.Union(
        [Type.Literal("chatgpt"), Type.Literal("gateway")],
        { description: "chatgpt = ChatGPT web (CHATGPT_WEB_AUTH_KEY / codex login); gateway = WEB_CHAT_API_BASE_URL. Default: chatgpt when configured, else gateway." },
      )),
      model: Type.Optional(Type.String({ description: "Model id (chatgpt: e.g. gpt-5.5; gateway: e.g. gpt-5.3-mini). Omit for the provider default." })),
      system: Type.Optional(Type.String({ description: "Optional system prompt." })),
      ...sharedControlSchema,
    }),
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const cwd = cwdFromContext(ctx);
      const trusted = includeProjectEnv(ctx);
      const wantChatGpt = params.provider === "chatgpt" || (params.provider === undefined && Boolean(loadChatGptAuth(cwd, trusted).auth));
      if (wantChatGpt) {
        const cgpt = loadChatGptAuth(cwd, trusted);
        if (!cgpt.auth) {
          throw new Error(
            `ChatGPT web chat is not configured. ${cgpt.problem ?? "Set CHATGPT_WEB_AUTH_KEY (the tokens JSON from ~/.codex/auth.json after `codex login`, or a bare access-token JWT) in ~/.pi/agent/.env.local"} — or run codex login — then restart pi. provider=gateway uses WEB_CHAT_API_BASE_URL instead.`,
          );
        }
        const timeoutMs = Math.min(Math.max((params.timeout_ms as number) ?? 120_000, 10_000), 300_000);
        try {
          const result = await chatgptWebChat({
            auth: cgpt.auth,
            prompt: params.prompt as string,
            system: params.system as string | undefined,
            model: params.model as string | undefined,
            cwd,
            includeCwdEnv: trusted,
            timeoutMs,
            signal,
          });
          const text = `Model: ${result.model ?? "chatgpt default"}\n\n${result.text}`;
          return { content: [{ type: "text" as const, text: truncateText(text) }], details: { model: result.model, usage: result.usage } };
        } catch (err) {
          if ((err as Error)?.name === "AbortError") throw err;
          throw new Error(describeChatGptError(err));
        }
      }
      const config = loadChatConfig(cwd, trusted);
      if (!config) {
        throw new Error(
          "web_chat is not configured. Set WEB_CHAT_API_BASE_URL (and optional WEB_CHAT_API_KEY) in ~/.pi/agent/.env.local — any OpenAI-compatible /chat/completions gateway works (a ChatGPT web bridge, https://api.openai.com/v1, …) — then restart pi.",
        );
      }
      const timeoutMs = Math.min(Math.max((params.timeout_ms as number) ?? 120_000, 10_000), 300_000);
      try {
        const result = await chatgptChat({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          prompt: params.prompt as string,
          model: params.model as string | undefined,
          system: params.system as string | undefined,
          timeoutMs,
          signal,
        });
        const text = `Model: ${result.model ?? "gateway default"}\n\n${result.text}`;
        return { content: [{ type: "text" as const, text: truncateText(text) }], details: { model: result.model, usage: undefined } };
      } catch (err) {
        if ((err as Error)?.name === "AbortError") throw err;
        throw new Error(describeChatApiError(err));
      }
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
      const geminiCfg = loadGeminiWebConfig(cwd, trusted);
      const imageApiCfg = loadImageApiConfig(cwd, trusted);
      const chatgptCfg = loadChatGptAuth(cwd, trusted);

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
        geminiWeb: {
          configured: Boolean(geminiCfg.psid),
          cookieSource: geminiCfg.psidSource,
          proxy: Boolean(geminiCfg.proxy),
          cookieStore: cookieStoreSnapshot(),
        },
        imageProviders: {
          gemini: { configured: Boolean(geminiCfg.psid), guestPossible: true },
          chatgpt: { configured: Boolean(chatgptCfg.auth) },
          zai: { configured: Boolean(imageApiCfg.zai) },
          custom: imageApiCfg.custom
            ? { configured: true, label: imageApiCfg.custom.label }
            : { configured: false },
          rate: imageRateSnapshot(),
        },
        webChat: (() => {
          const cfg = loadChatConfig(cwd, trusted);
          return {
            configured: Boolean(cfg),
            baseUrl: cfg?.baseUrl,
            keyFound: Boolean(cfg?.apiKey),
            source: cfg?.source ?? "not set",
            defaultProvider: loadChatGptAuth(cwd, trusted).auth ? "chatgpt" : "gateway",
          };
        })(),
        chatgptWeb: chatgptAuthSnapshot(chatgptCfg),
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
