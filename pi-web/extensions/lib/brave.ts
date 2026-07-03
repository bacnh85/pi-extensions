// Brave Search API client.

import { sanitizeSnippet, type SearchResultItem } from "./format";

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
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
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
		} catch (e) {
			if (attempt === 2) throw e;
			await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
		}
	}
	throw new Error("unreachable");
}
