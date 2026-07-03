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
} from "./lib/format";
import { searchWithDiagnostics, type SearchResult as UnifiedSearchResult } from "./lib/search";
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
	firecrawl_api_key: Type.Optional(Type.String({ description: "Firecrawl API key override. Prefer FIRECRAWL_API_KEY." })),
	firecrawl_api_url: Type.Optional(Type.String({ description: "Firecrawl API URL override. Defaults to FIRECRAWL_API_URL or hosted." })),
	timeout_ms: Type.Optional(Type.Number({ description: "Request timeout in milliseconds." })),
};

const crawl4aiControlSchema = {
	crawl4ai_api_url: Type.Optional(Type.String({ description: "Crawl4AI API URL override. Defaults to CRAWL4AI_API_URL or http://172.30.55.22:11235." })),
	crawl4ai_api_token: Type.Optional(Type.String({ description: "Crawl4AI API token override. Prefer CRAWL4AI_API_TOKEN." })),
	timeout_ms: Type.Optional(Type.Number({ description: "Request timeout in milliseconds." })),
};

// ---------------------------------------------------------------------------
// Helper: format unified search results for text output
// ---------------------------------------------------------------------------

function formatUnifiedSearchResults(results: UnifiedSearchResult[]): string {
	if (!results.length) return "No results found.";
	return results
		.map((r, i) =>
			[
				`--- Result ${i + 1} (backend: ${r.backend}) ---`,
				`Title: ${r.title || ""}`,
				`Link: ${r.url || ""}`,
				r.age ? `Age: ${r.age}` : "",
				r.snippet ? `Snippet: ${r.snippet}` : "",
				r.content ? `Content:\n${r.content}` : "",
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n\n");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function piWebExtension(pi: ExtensionAPI) {
	// ── web_search ────────────────────────────────────────────────────────
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web with adaptive backend selection. Uses SearXNG (self-hosted) for broad discovery, Brave (hosted API) for precision-sensitive queries and include_content, and Firecrawl as a last resort. Use backend to force a provider.",
		promptSnippet: "Search current web results",
		promptGuidelines: [
			"Use web_search for source discovery, documentation lookup, current facts, and general web search.",
			"Backend auto-selection is adaptive: broad discovery uses SearXNG first; precision queries, site: searches, docs/source lookups, and include_content use Brave first; Firecrawl is last resort.",
			"If auto-selection returns poor-quality results, force backend: 'brave' or backend: 'searxng' for a different search index.",
			"Use the backend parameter to force a specific search engine (e.g., backend: 'brave').",
			"Use engines parameter for SearXNG tuning (e.g., engines: 'google,github' for technical queries).",
			"include_content prefers Brave automatically because only Brave search fetches inline page content; for other result URLs, use web_extract.",
			"Note: Firecrawl Search has poor semantic accuracy on domain-specific/ambiguous queries; prefer SearXNG or Brave for precision.",
			"Cite result URLs when web results materially support the answer.",
		],
		parameters: Type.Object({
			query: Type.String(),
			count: Type.Optional(Type.Number({ default: 5 })),
			freshness: Type.Optional(Type.String({ description: "Time filter: e.g., 'pw' (past week), 'pm' (past month), 'py' (past year), or a date range like '2024-01-01to2024-06-30'." })),
			country: Type.Optional(Type.String({ default: "US" })),
			backend: Type.Optional(Type.Union(
				[Type.Literal("auto"), Type.Literal("searxng"), Type.Literal("brave"), Type.Literal("firecrawl")],
				{ default: "auto", description: "Search backend: auto (default), searxng, brave, or firecrawl." },
			)),
			engines: Type.Optional(Type.String({ description: "SearXNG engine override (e.g., 'google,github' for technical queries). Only used when backend is searxng or auto." })),
			include_content: Type.Optional(Type.Boolean({ default: false, description: "Fetch page content alongside search results. Slower but provides inline content." })),
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
			"Extract readable content from a URL with automatic backend selection. Tries static extraction (JSDOM+Readability, no API key) first, then dynamic extraction (Firecrawl Scrape, JS rendering), then full browser extraction (Crawl4AI, headless browser). Use the mode parameter for explicit control. If all modes fail, try web_screenshot for a visual snapshot.",
		promptSnippet: "Extract readable webpage content as markdown",
		promptGuidelines: [
			"Use web_extract to get clean markdown content from a known URL.",
			"Use mode: 'static' for simple static pages (fast, no API key needed, uses JSDOM+Readability).",
			"Use mode: 'dynamic' for JavaScript-rendered pages (uses Firecrawl Scrape).",
			"Use mode: 'full' for pages that need Crawl4AI rendering when other modes fail (resource-intensive).",
			"Default mode 'auto' tries static → dynamic → full. Successive fallbacks are noted in output.",
			"⚠️ Dynamic mode (Firecrawl Scrape) may fail on bot-protected sites (Ansible docs, CDN-backed doc sites). Full mode (Crawl4AI) handles more sites but is heavier.",
			"If all extraction modes fail, try web_screenshot for a visual snapshot, or the page may require interactive login.",
			"Use the prompt and schema parameters for structured JSON extraction (dynamic mode only); structured JSON is returned in details and text when available.",
			"Cite the source URL when using extracted content in an answer.",
		],
		parameters: Type.Object({
			url: Type.String(),
			mode: Type.Optional(Type.Union(
				[Type.Literal("auto"), Type.Literal("static"), Type.Literal("dynamic"), Type.Literal("full")],
				{ default: "auto", description: "Extraction mode: auto (default), static, dynamic, or full." },
			)),
			prompt: Type.Optional(Type.String({ description: "Prompt for structured JSON extraction (dynamic mode only)." })),
			schema: Type.Optional(Type.Any({ description: "JSON schema for structured extraction (dynamic mode only)." })),
			content_chars: Type.Optional(Type.Number({ default: 20000 })),
			wait_for: Type.Optional(Type.Number({ description: "Milliseconds to wait for Firecrawl dynamic rendering before extraction. Full mode uses Crawl4AI /md and may ignore this." })),
			mobile: Type.Optional(Type.Boolean({ default: false, description: "Emulate mobile viewport (dynamic mode only)." })),
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
			"Discover URLs from a site using Firecrawl Map. Best for finding candidate pages from a site or docs section before targeted extraction. Works best on base domains; may return empty results on sub-paths.",
		promptSnippet: "Map site URLs",
		promptGuidelines: [
			"Use web_map to discover URLs from a site before crawling or targeted extraction.",
			"Works best on base domains (e.g., https://example.com). Returns fewer results on sub-paths; use sitemap: 'only' for sitemap-only discovery on sub-paths.",
			"Use sitemap: 'only' for sitemap-only discovery.",
			"Use mapped URLs with web_extract for targeted extraction instead of web_crawl when only a few pages are needed.",
			"Keep limits small unless broad site discovery is explicitly requested.",
		],
		parameters: Type.Object({
			url: Type.String(),
			limit: Type.Optional(Type.Number({ default: 100 })),
			include_subdomains: Type.Optional(Type.Boolean({ default: false })),
			search: Type.Optional(Type.String({ description: "Optional search query to guide URL discovery (semantic map)." })),
			sitemap: Type.Optional(Type.Union([Type.Literal("only"), Type.Literal("include"), Type.Literal("skip")], { description: "Sitemap mode: include (default), only (sitemap-only), or skip." })),
			use_index: Type.Optional(Type.Boolean({ default: true, description: "Whether to use the Firecrawl search index for URL discovery." })),
			ignore_cache: Type.Optional(Type.Boolean({ default: false, description: "Ignore cached map results." })),
			...firecrawlControlSchema,
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
			const result = await firecrawlRequest(config, "POST", "/map", body, true, signal);
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
			"Crawl one or more pages from a site. Uses Firecrawl Crawl in 'light' mode (conservative, doc-focused) or Crawl4AI in 'full' mode (headless browser, rendered data, media, links). Accepts a single URL for Firecrawl-style crawling or multiple URLs for Crawl4AI-style crawling.",
		promptSnippet: "Crawl a small site section",
		promptGuidelines: [
			"Use web_crawl only when multiple pages from a site are truly needed; prefer web_map + web_extract for small numbers of pages.",
			"Use mode: 'light' (default) for conservative Firecrawl crawling of docs/sites.",
			"Use mode: 'full' for Crawl4AI crawling with full rendered data (JS, media, links). More resource-intensive.",
			"For Firecrawl mode ('light'), use the url parameter with optional include_paths/exclude_paths.",
			"For Crawl4AI mode ('full'), use the urls (array) parameter for batch crawling up to 100 URLs.",
			"Keep limits conservative (default 10) unless the user explicitly requests large crawls.",
			"Try web_map first to identify candidate URLs and pass them to web_extract before resorting to a full crawl.",
		],
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "URL for Firecrawl-style single-page crawl (mode: 'light')." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "URLs for Crawl4AI-style multi-URL crawl (mode: 'full'), up to 100." })),
			mode: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("full")], { default: "light", description: "Crawl mode: 'light' (Firecrawl, conservative) or 'full' (Crawl4AI, rendered data)." })),
			limit: Type.Optional(Type.Number({ default: 10 })),
			include_paths: Type.Optional(Type.String({ description: "Comma-separated path patterns to include (Firecrawl mode only)." })),
			exclude_paths: Type.Optional(Type.String({ description: "Comma-separated path patterns to exclude (Firecrawl mode only)." })),
			poll: Type.Optional(Type.Boolean({ default: false, description: "Poll for crawl completion (Firecrawl mode only)." })),
			browser_config: Type.Optional(Type.Any({ description: "Optional BrowserConfig JSON object (Crawl4AI mode only)." })),
			crawler_config: Type.Optional(Type.Any({ description: "Optional CrawlerRunConfig JSON object (Crawl4AI mode only)." })),
			content_chars: Type.Optional(Type.Number({ default: 20000 })),
			...firecrawlControlSchema,
			...crawl4aiControlSchema,
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
				true,
				signal,
			);
			const id = result.id || (result.data as Record<string, unknown> | undefined)?.id;
			if (params.poll && id && !Array.isArray(result.data)) {
				const { abortableSleep } = await import("./lib/retry");
				for (let i = 0; i < 60; i++) {
					result = await firecrawlRequest(fcConfig, "GET", `/crawl/${id}`, undefined, true, signal);
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
			"Capture a full-page PNG screenshot of a URL using Crawl4AI's headless browser. Returns a base64-encoded PNG image suitable for visual inspection.",
		promptSnippet: "Screenshot a webpage",
		promptGuidelines: [
			"Use web_screenshot when a visual snapshot of a rendered page is needed, or when web_extract fails on a heavily JS-dependent or bot-protected page.",
			"The screenshot is returned as a base64-encoded PNG string.",
			"Use wait_for to delay capture for dynamic content to render (default 2 seconds).",
			"Use wait_for_images to ensure images are loaded before capture.",
		],
		parameters: Type.Object({
			url: Type.String(),
			wait_for: Type.Optional(Type.Number({ default: 2, description: "Seconds to wait before capturing screenshot." })),
			wait_for_images: Type.Optional(Type.Boolean({ default: false, description: "Wait for images to load before capture." })),
			...crawl4aiControlSchema,
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
			"Generate a PDF document of a URL using Crawl4AI's headless browser. Returns a base64-encoded PDF suitable for saving or archiving.",
		promptSnippet: "PDF a webpage",
		promptGuidelines: [
			"Use web_pdf when a printable or archivable snapshot of a page is needed.",
			"The PDF is returned as a base64-encoded string.",
		],
		parameters: Type.Object({
			url: Type.String(),
			...crawl4aiControlSchema,
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
			"Show all web provider configuration status (Brave, SearXNG, Firecrawl, Crawl4AI) without printing secrets. Includes Crawl4AI server health check. Use when web tools fail due to missing credentials or configuration issues.",
		promptSnippet: "Check web provider configuration and server status",
		promptGuidelines: [
			"Use web_status when web tools fail due to missing credentials/config or to verify which backends are available.",
			"The output shows which backends are configured; if a backend is missing, configure its env vars.",
			"Never print API key values; this tool reports only presence and source.",
			"Shows Crawl4AI server health, version, and auth status when the server is reachable.",
			"For Firecrawl, `apiKeyFound: false` is normal for self-hosted instances without auth. Use the `ready` field to check whether Firecrawl is actually usable.",
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

	// ── /web-status command ──────────────────────────────────────────────
	pi.registerCommand("web-status", {
		description: "Show web provider configuration status",
		handler: async (_args: string, ctx: any) => {
			const cwd = cwdFromContext(ctx);
			const trusted = includeProjectEnv(ctx);
			const braveKey = findEnvValue("BRAVE_API_KEY", cwd, trusted);
			const searxngUrl = findEnvValue("SEARXNG_BASE_URL", cwd, trusted);
			const fireKey = findEnvValue("FIRECRAWL_API_KEY", cwd, trusted);
			const fireUrl = findEnvValue("FIRECRAWL_API_URL", cwd, trusted);
			const c4aiUrl = findEnvValue("CRAWL4AI_API_URL", cwd, trusted);
			const c4aiToken = findEnvValue("CRAWL4AI_API_TOKEN", cwd, trusted);
			ctx.ui.notify(
				[
					`Brave API key: ${braveKey.value ? `found (${braveKey.source})` : "not set"}`,
					`SearXNG base URL: ${normalizeSearxngBaseUrl(searxngUrl.value)} (${searxngUrl.source || "default local"})`,
					`Firecrawl base URL: ${normalizeFirecrawlBaseUrl(fireUrl.value)}`,
					`Firecrawl API key: ${fireKey.value ? `found (${fireKey.source})` : "not set"}`,
					`Crawl4AI API URL: ${normalizeCrawl4aiApiUrl(c4aiUrl.value)} (${c4aiUrl.source || "default"})`,
					`Crawl4AI API token: ${c4aiToken.value ? `found (${c4aiToken.source})` : "not set"}`,
				].join("\n"),
				"info",
			);
		},
	});
}
