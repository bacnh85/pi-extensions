// Brave Search API client.

import { sanitizeSnippet, type SearchResultItem } from "./format";
import { withRetry } from "./retry";

export interface BraveResult extends SearchResultItem {
  age: string;
}

export async function fetchBraveResults(
  query: string,
  count: number,
  country: string,
  freshness: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<BraveResult[]> {
  return withRetry(async () => {
    if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted.");
    const params = new URLSearchParams({ q: query, count: String(count), country });
    if (freshness) params.append("freshness", freshness);
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}\n${await response.text()}`);
    const data: any = await response.json();
    return (data.web?.results || [])
      .slice(0, count)
      .map((r: any) => ({
        title: sanitizeSnippet(r.title || ""),
        url: r.url || "",
        snippet: sanitizeSnippet(r.description || ""),
        age: sanitizeSnippet(r.age || r.page_age || ""),
      }));
  }, undefined, signal);
}
