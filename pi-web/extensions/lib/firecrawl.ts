// Firecrawl API client (search, scrape, map, crawl).

import type { FirecrawlConfig } from "./config";
import { signalWithTimeout, withRetry } from "./retry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FirecrawlResult {
	success: boolean;
	data?: Record<string, unknown>;
	warning?: string;
	id?: string;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class FirecrawlHttpError extends Error {
	status: number;
	constructor(status: number, statusText: string, text: string) {
		super(`HTTP ${status}: ${statusText}${text ? `\n${text}` : ""}`);
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// Low-level HTTP helpers
// ---------------------------------------------------------------------------

async function firecrawlRequestJson(
	config: FirecrawlConfig,
	method: string,
	endpoint: string,
	body?: unknown,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
	const response = await fetch(`${config.baseUrl}${endpoint}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: signalWithTimeout(config.timeoutMs, signal),
	});
	const text = await response.text();
	if (!response.ok) throw new FirecrawlHttpError(response.status, response.statusText, text);
	return text ? JSON.parse(text) : { success: true };
}

/**
 * Firecrawl API request with retry.
 */
export async function firecrawlRequest(
	config: FirecrawlConfig,
	method: string,
	endpoint: string,
	body?: unknown,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	return withRetry(() => firecrawlRequestJson(config, method, endpoint, body, signal));
}
