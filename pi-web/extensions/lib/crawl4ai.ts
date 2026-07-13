// Crawl4AI API client.
// Talks to a self-hosted Crawl4AI Docker server (unclecode/crawl4ai).
// Endpoints: /crawl, /crawl/stream, /md, /screenshot, /pdf, /health

import type { Crawl4aiConfig } from "./config";
import { signalWithTimeout, withRetry, HttpError } from "./retry";

// ---------------------------------------------------------------------------
// Low-level HTTP helpers
// ---------------------------------------------------------------------------

async function crawl4aiRequestJson(
	config: Crawl4aiConfig,
	method: string,
	endpoint: string,
	body?: unknown,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`;
	const response = await fetch(`${config.baseUrl}${endpoint}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: signalWithTimeout(config.timeoutMs, signal),
	});
	const text = await response.text();
	if (!response.ok) throw new HttpError(response.status, response.statusText, text);
	return text ? JSON.parse(text) : { success: true };
}

/**
 * Crawl4AI API request with retry.
 */
export async function crawl4aiRequest(
	config: Crawl4aiConfig,
	method: string,
	endpoint: string,
	body?: unknown,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	return withRetry(() => crawl4aiRequestJson(config, method, endpoint, body, signal), 3, signal);
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export interface Crawl4aiMediaItem {
	url?: string;
	src?: string;
	alt?: string;
	type?: string;
	score?: number;
}

export interface Crawl4aiLinkItem {
	href?: string;
	text?: string;
	domain?: string;
}

export interface Crawl4aiMarkdownResult {
	raw_markdown?: string;
	markdown_with_citations?: string;
	references_markdown?: string;
	fit_markdown?: string;
	fit_html?: string;
}

export interface Crawl4aiResult {
	url?: string;
	html?: string;
	success?: boolean;
	cleaned_html?: string;
	markdown?: string | Crawl4aiMarkdownResult;
	media?: { images?: Crawl4aiMediaItem[]; videos?: Crawl4aiMediaItem[] };
	links?: { internal?: Crawl4aiLinkItem[]; external?: Crawl4aiLinkItem[] };
	extracted_content?: string;
	screenshot?: string;
	pdf?: string;
	metadata?: Record<string, unknown>;
	error_message?: string;
	status_code?: number;
	redirected_url?: string;
	[key: string]: unknown;
}

/**
 * Fetch clean markdown via POST /md.
 * filter_ — one of "fit", "raw", "bm25", "llm"
 * query — optional query for bm25/llm filters
 */
export async function fetchCrawl4aiMarkdown(
	config: Crawl4aiConfig,
	url: string,
	filter_ = "fit",
	query?: string,
	signal?: AbortSignal,
): Promise<{ markdown: string; success: boolean }> {
	const body: Record<string, unknown> = { url, f: filter_ };
	if (query) body.q = query;
	const result = await crawl4aiRequest(config, "POST", "/md", body, signal);
	return {
		markdown: (result.markdown as string) || "",
		success: result.success as boolean,
	};
}

/**
 * Crawl one or more URLs via POST /crawl.
 */
export async function fetchCrawl4aiCrawl(
	config: Crawl4aiConfig,
	urls: string[],
	browserConfig?: Record<string, unknown>,
	crawlerConfig?: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ success: boolean; results?: Crawl4aiResult[] }> {
	const body: Record<string, unknown> = { urls };
	if (browserConfig) body.browser_config = browserConfig;
	if (crawlerConfig) body.crawler_config = crawlerConfig;
	const result = await crawl4aiRequest(config, "POST", "/crawl", body, signal);
	return {
		success: result.success as boolean,
		results: (result.results as Crawl4aiResult[]) || [],
	};
}

/**
 * Capture a screenshot via POST /screenshot.
 */
export async function fetchCrawl4aiScreenshot(
	config: Crawl4aiConfig,
	url: string,
	waitFor?: number,
	waitForImages?: boolean,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const body: Record<string, unknown> = { url };
	if (waitFor !== undefined) body.screenshot_wait_for = waitFor;
	if (waitForImages !== undefined) body.wait_for_images = waitForImages;
	return await crawl4aiRequest(config, "POST", "/screenshot", body, signal);
}

/**
 * Generate a PDF via POST /pdf.
 */
export async function fetchCrawl4aiPdf(
	config: Crawl4aiConfig,
	url: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	return await crawl4aiRequest(config, "POST", "/pdf", { url }, signal);
}

/**
 * Health check via GET /health.
 */
export async function fetchCrawl4aiHealth(
	config: Crawl4aiConfig,
	signal?: AbortSignal,
): Promise<{ status?: string; version?: string; timestamp?: number }> {
	const data = await crawl4aiRequest({ ...config, timeoutMs: Math.min(config.timeoutMs, 10000) }, "GET", "/health", undefined, signal);
	return {
		status: data.status as string | undefined,
		version: data.version as string | undefined,
		timestamp: data.timestamp as number | undefined,
	};
}
