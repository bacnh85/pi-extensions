// Firecrawl API client (search, scrape, map, crawl).

import type { FirecrawlConfig } from "./config";
import { signalWithTimeout, withRetry, HttpError } from "./retry";

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
  if (!response.ok) throw new HttpError(response.status, response.statusText, text);
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
  return withRetry(() => firecrawlRequestJson(config, method, endpoint, body, signal), undefined, signal);
}
