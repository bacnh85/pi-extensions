// SearXNG metasearch client.

import { sanitizeSnippet } from "./format";
import { signalWithTimeout, withRetry } from "./retry";

export interface SearxngResultItem {
	title: string;
	url: string;
	snippet: string;
	engine: string;
	category: string;
	score?: number;
	publishedDate: string;
}

export interface SearxngResponse {
	results: SearxngResultItem[];
	[key: string]: unknown;
}

export async function fetchSearxngResults(
	params: Record<string, unknown>,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<SearxngResponse> {
	return withRetry(async () => {
		const limit = Math.min(50, Math.max(1, (params.count as number) ?? 5));
		const url = new URL(`${baseUrl}/search`);
		url.searchParams.set("q", params.query as string);
		url.searchParams.set("format", "json");
		url.searchParams.set("pageno", String(Math.max(1, (params.pageno as number) ?? 1)));
		for (const key of ["categories", "engines", "language", "time_range", "safesearch"] as const) {
			const val = params[key];
			if (val !== undefined && val !== "") url.searchParams.set(key, String(val));
		}
		const timeoutMs = (params.timeout_ms as number) || 15000;
		const response = await fetch(url, {
			headers: { Accept: "application/json", "User-Agent": "pi-web/0.1 SearXNG" },
			signal: signalWithTimeout(timeoutMs, signal),
		});
		const text = await response.text();
		if (!response.ok) {
			const hint =
				response.status === 403
					? "\nHint: enable JSON output in SearXNG settings.yml with search.formats including json."
					: "";
			throw new Error(`HTTP ${response.status}: ${response.statusText}${hint}${text ? `\n${text}` : ""}`);
		}
		const data: any = text ? JSON.parse(text) : {};
		const results = (data.results || [])
			.slice(0, limit)
			.map((r: any) => ({
				title: sanitizeSnippet(r.title || ""),
				url: r.url || "",
				snippet: sanitizeSnippet(r.content || r.snippet || ""),
				engine: r.engine || "",
				category: r.category || "",
				score: r.score,
				publishedDate: r.publishedDate || r.published_date || "",
			}));
		return { ...data, results };
	}, undefined, signal);
}
