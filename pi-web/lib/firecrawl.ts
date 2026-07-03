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
 * Firecrawl API request with optional v2→v1 fallback on 404.
 * Returns the response data and optionally logs fallback via console.warn.
 */
export async function firecrawlRequest(
	config: FirecrawlConfig,
	method: string,
	endpoint: string,
	body?: unknown,
	allowFallback = true,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	return withRetry(async () => {
		try {
			return await firecrawlRequestJson(config, method, endpoint, body, signal);
		} catch (e) {
			if (
				!allowFallback ||
				config.isHosted ||
				!config.baseUrl.endsWith("/v2") ||
				!(e instanceof FirecrawlHttpError) ||
				e.status !== 404
			)
				throw e;
			const v1Config = { ...config, baseUrl: config.baseUrl.replace(/\/v2$/, "/v1") };
			console.warn(
				`[pi-web] Firecrawl v2 endpoint returned 404, falling back to v1 at ${v1Config.baseUrl}`,
			);
			return await firecrawlRequestJson(v1Config, method, endpoint, body, signal);
		}
	}, { maxRetries: 2, retryableErrors: ["timeout", "econn", "etimedout", "network", "socket"] });
}
