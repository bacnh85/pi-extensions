// Unified content extraction orchestrator.
// Modes:
//   "static"  → JSDOM+Readability (no external API)
//   "dynamic" → Firecrawl Scrape (JS rendering/structured JSON)
//   "full"    → Crawl4AI markdown endpoint
//   "auto"    → static → dynamic → full

import { cwdFromContext, includeProjectEnv } from "./config";
import { loadFirecrawlConfig, loadCrawl4aiConfig, type FirecrawlConfig, type Crawl4aiConfig } from "./config";
import { fetchReadableContent } from "./content";
import { firecrawlRequest, type FirecrawlResult } from "./firecrawl";
import { fetchCrawl4aiMarkdown } from "./crawl4ai";
import { formatFirecrawlScrape, sanitizeError } from "./format";

export type ExtractMode = "auto" | "static" | "dynamic" | "full";
export type ExtractAttemptStatus = "success" | "empty" | "error";

export interface ExtractParams {
	url: string;
	mode?: ExtractMode;
	prompt?: string;
	schema?: unknown;
	content_chars?: number;
	timeout_ms?: number;
	wait_for?: number;
	mobile?: boolean;
	crawl4ai_api_token?: string;
	crawl4ai_api_url?: string;
	signal?: AbortSignal;
	/** Internal: caller-provided ctx for env lookup. */
	_ctx?: Record<string, unknown>;
}

export interface ExtractResult {
	title: string;
	markdown: string;
	backend: string;
	links?: string[];
	structured?: unknown;
}

export interface ExtractAttempt {
	mode: Exclude<ExtractMode, "auto">;
	backend: string;
	status: ExtractAttemptStatus;
	message: string;
	contentLength: number;
}

export interface ExtractDiagnostics {
	result: ExtractResult;
	attempts: ExtractAttempt[];
	selectedMode: Exclude<ExtractMode, "auto">;
	fallbackUsed: boolean;
}

const MIN_USEFUL_MARKDOWN_CHARS = 120;

function isUseful(result: ExtractResult | null, mode: ExtractMode, explicit: boolean): result is ExtractResult {
	if (!result) return false;
	const length = result.markdown.trim().length;
	if (length === 0) return false;
	return explicit || mode !== "static" || length >= MIN_USEFUL_MARKDOWN_CHARS;
}

function structuredSection(value: unknown): string {
	if (value === undefined) return "";
	return `\n\n## Structured extraction\n\n\`\`\`json\n${JSON.stringify(value, null, 2).slice(0, 10000)}\n\`\`\``;
}

async function extractStatic(params: ExtractParams): Promise<ExtractResult | null> {
	const article = await fetchReadableContent(params.url, params.timeout_ms ?? 15000, params.signal);
	return {
		title: article.title ?? "",
		markdown: article.markdown.slice(0, params.content_chars ?? 20000),
		backend: "static",
	};
}

function findStructuredPayload(result: FirecrawlResult): unknown {
	const data = result.data as Record<string, unknown> | undefined;
	if (!data) return undefined;
	return data.json ?? data.extract ?? data.structuredData ?? data.llm_extraction;
}

async function extractDynamic(params: ExtractParams, ctx?: Record<string, unknown>): Promise<ExtractResult | null> {
	let fcConfig: FirecrawlConfig;
	try {
		fcConfig = loadFirecrawlConfig({}, cwdFromContext(ctx ?? {}), includeProjectEnv(ctx ?? {}));
	} catch (e) {
		throw new Error(`Firecrawl configuration unavailable: ${sanitizeError(e)}`);
	}

	const formats: string[] = ["markdown"];
	if (params.prompt || params.schema) {
		formats.push("json");
	}
	const body: Record<string, unknown> = {
		url: params.url,
		formats,
		onlyMainContent: true,
		...(params.wait_for ? { waitFor: params.wait_for } : {}),
		...(params.mobile ? { mobile: true } : {}),
	};
	if (params.prompt || params.schema) {
		const jsonOptions: Record<string, unknown> = {};
		if (params.prompt) jsonOptions.prompt = params.prompt;
		if (params.schema) jsonOptions.schema = params.schema;
		body.jsonOptions = jsonOptions;
	}
	const result = await firecrawlRequest(fcConfig, "POST", "/scrape", body, params.signal) as FirecrawlResult;
	const structured = findStructuredPayload(result);
	const raw = `${formatFirecrawlScrape(result as Record<string, unknown>, params.content_chars ?? 20000)}${structuredSection(structured)}`;
	const titleMatch = raw.match(/^# (.+)$/m);
	return {
		title: titleMatch ? titleMatch[1] : "",
		markdown: raw,
		backend: "dynamic",
		structured,
	};
}

async function extractFull(params: ExtractParams, ctx?: Record<string, unknown>): Promise<ExtractResult | null> {
	let c4aiConfig: Crawl4aiConfig;
	try {
		c4aiConfig = loadCrawl4aiConfig(
		{ crawl4ai_api_token: params.crawl4ai_api_token, crawl4ai_api_url: params.crawl4ai_api_url, timeout_ms: params.timeout_ms },
		cwdFromContext(ctx ?? {}),
		includeProjectEnv(ctx ?? {}),
	);
	} catch (e) {
		throw new Error(`Crawl4AI configuration unavailable: ${sanitizeError(e)}`);
	}
	const result = await fetchCrawl4aiMarkdown(c4aiConfig, params.url, "fit", undefined, params.signal);
	return {
		title: "",
		markdown: result.markdown.slice(0, params.content_chars ?? 20000),
		backend: "full",
	};
}

function modesFor(params: ExtractParams): Array<Exclude<ExtractMode, "auto">> {
	const mode = params.mode ?? "auto";
	if (mode !== "auto") return [mode];
	return ["static", "dynamic", "full"];
}

async function runExtractor(mode: Exclude<ExtractMode, "auto">, params: ExtractParams, ctx?: Record<string, unknown>): Promise<ExtractResult | null> {
	if (mode === "static") return extractStatic(params);
	if (mode === "dynamic") return extractDynamic(params, ctx);
	return extractFull(params, ctx);
}

export async function extractWithDiagnostics(params: ExtractParams): Promise<ExtractDiagnostics> {
	const ctx = params._ctx;
	const explicit = (params.mode ?? "auto") !== "auto";
	const modes = modesFor(params);
	const attempts: ExtractAttempt[] = [];

	for (const mode of modes) {
		try {
			const result = await runExtractor(mode, params, ctx);
			if (isUseful(result, mode, explicit)) {
				if (!explicit && attempts.length > 0) {
					result.markdown = `[Extraction fell back to ${mode === "dynamic" ? "Firecrawl Scrape (dynamic mode)" : "Crawl4AI (full browser mode)"}]\n\n${result.markdown}`;
				}
				attempts.push({ mode, backend: result.backend, status: "success", message: `Selected ${mode}`, contentLength: result.markdown.length });
				return { result, attempts, selectedMode: mode, fallbackUsed: attempts.length > 1 };
			}
			const emptyResult = result as ExtractResult | null;
			const length = emptyResult?.markdown.trim().length ?? 0;
			attempts.push({ mode, backend: emptyResult?.backend ?? mode, status: "empty", message: `${mode} returned insufficient content`, contentLength: length });
		} catch (e) {
			attempts.push({ mode, backend: mode, status: "error", message: sanitizeError(e), contentLength: 0 });
			if (explicit) break;
		}
	}

	// All modes exhausted — return the best attempt with diagnostics instead of throwing
	const lastAttempt = attempts[attempts.length - 1];
	const bestResult: ExtractResult = {
		title: "",
		markdown: `[All extraction modes failed for ${params.url}]\n\n` +
			attempts.map((a) => `  ${a.mode}: ${a.status}${a.message ? ` (${a.message})` : ""}`).join("\n") +
			"\n\nTry web_screenshot for a visual snapshot, or verify the URL is accessible.",
		backend: lastAttempt?.backend ?? "none",
	};
	return {
		result: bestResult,
		attempts,
		selectedMode: lastAttempt?.mode ?? "static",
		fallbackUsed: true,
	};
}

