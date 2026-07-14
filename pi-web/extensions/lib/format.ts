// Text formatting and result formatting helpers for pi-web.

const OUTPUT_MAX_BYTES = 50 * 1024;
const OUTPUT_MAX_LINES = 2_000;

// ---------------------------------------------------------------------------
// Search result item types
// ---------------------------------------------------------------------------

export interface SearchResultItem {
	title: string;
	url: string;
	snippet?: string;
	age?: string;
	description?: string;
	content?: string;
	markdown?: string;
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

export function sanitizeSnippet(text = ""): string {
	return text
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&#x27;/gi, "'")
		.replace(/&#(\d+);/g, (_: string, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_: string, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Sanitize an error message — redact sensitive tokens and truncate length.
 */
export function sanitizeError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/X-Subscription-Token\s*[:=]\s*[^\s]+/gi, "X-Subscription-Token: [REDACTED]")
		.replace(/api[_-]?key[=:][^\s&]+/gi, "api_key=[REDACTED]")
		.slice(0, 500);
}

export function truncateText(text: string): string {
	const lines = text.split("\n");
	const lineTruncated = lines.slice(0, OUTPUT_MAX_LINES).join("\n");
	const buf = Buffer.from(lineTruncated, "utf8");
	if (buf.length <= OUTPUT_MAX_BYTES && lines.length <= OUTPUT_MAX_LINES) return text;
	const truncated = buf.slice(0, OUTPUT_MAX_BYTES).toString("utf8").replace(/\uFFFD+$/g, "");
	return truncated + `\n\n[Web output truncated to ${OUTPUT_MAX_LINES} lines / ${OUTPUT_MAX_BYTES} bytes.]`;
}

// ---------------------------------------------------------------------------
// Unified search result formatting
// ---------------------------------------------------------------------------

export interface UnifiedSearchResult {
	title: string;
	url: string;
	snippet: string;
	age: string;
	content: string;
	backend: string;
}

export function formatUnifiedSearchResults(results: UnifiedSearchResult[]): string {
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
// Firecrawl scrape formatting
// ---------------------------------------------------------------------------

export function formatFirecrawlScrape(data: Record<string, unknown>, maxChars = 20000): string {
	const page = (data.data as Record<string, unknown>) || data;
	const meta = (page.metadata as Record<string, unknown>) || {};
	const parts: string[] = [];
	if (meta.title) parts.push(`# ${meta.title}`);
	if (meta.sourceURL || meta.url) parts.push(`Source: ${(meta.sourceURL || meta.url) as string}`);
	if (meta.statusCode) parts.push(`Status: ${meta.statusCode}`);
	const warning = (data.warning || page.warning) as string | undefined;
	if (warning) parts.push(`Warning: ${warning}`);
	const body = (page.markdown || page.summary || page.answer || page.html || page.rawHtml) as string | undefined;
	if (body) parts.push(String(body).slice(0, maxChars));
	if (Array.isArray(page.links)) {
		parts.push(["## Links", ...(page.links as string[]).slice(0, 100).map((l: string) => `- ${l}`)].join("\n"));
	}
	return parts.join("\n\n") || JSON.stringify(data, null, 2);
}

// ---------------------------------------------------------------------------
// Crawl4AI result formatting
// ---------------------------------------------------------------------------

function extractMarkdown(md: unknown): string {
	if (!md) return "";
	if (typeof md === "string") return md;
	if (typeof md === "object") {
		const obj = md as Record<string, unknown>;
		return (obj.fit_markdown as string) || (obj.raw_markdown as string) || "";
	}
	return "";
}

function extractLinks(links: unknown): string[] {
	if (!links) return [];
	const arr = Array.isArray(links) ? links : typeof links === "object" ? Object.values(links) : [];
	return arr.flatMap((item: any) => {
		if (typeof item === "string") return [item];
		if (item?.href) return [item.href];
		if (item?.url) return [item.url];
		return [];
	});
}

export function formatCrawl4aiResult(data: Record<string, unknown>, maxChars = 20000): string {
	// Handle wrapped response: { results: [...] }
	const rawResults = (data.results as unknown[]) || [data];
	return rawResults
		.map((raw: any, i: number) => {
			const parts: string[] = [];
			const url = raw.url || raw.redirected_url || "";
			const success = raw.success !== false;
			const statusCode = raw.status_code || raw.metadata?.statusCode;

			if (rawResults.length > 1) parts.push(`=== Result ${i + 1} ===`);
			if (url) parts.push(`URL: ${url}`);
			if (statusCode) parts.push(`Status: ${statusCode}`);
			if (!success) {
				parts.push(`Error: ${raw.error_message || "Crawl failed"}`);
				return parts.join("\n");
			}

			// Markdown content
			const md = extractMarkdown(raw.markdown);
			if (md) {
				const truncated = md.slice(0, maxChars);
				parts.push(truncated);
				if (truncated.length < md.length) parts.push("[Markdown truncated...]");
			} else if (raw.extracted_content) {
				const ec =
					typeof raw.extracted_content === "string"
						? raw.extracted_content
						: JSON.stringify(raw.extracted_content, null, 2);
				parts.push(ec.slice(0, maxChars));
			} else if (raw.cleaned_html) {
				parts.push(`(Cleaned HTML: ${raw.cleaned_html.length} chars)`);
			}

			// Links
			const links = raw.links as Record<string, unknown> | undefined;
			if (links) {
				const internalLinks = extractLinks(links.internal);
				const externalLinks = extractLinks(links.external);
				const allLinks = [...internalLinks, ...externalLinks];
				if (allLinks.length) {
					parts.push(`Links (${allLinks.length}): ${allLinks.slice(0, 50).join(", ")}`);
				}
			}

			// Media
			const media = raw.media as Record<string, unknown> | undefined;
			if (media) {
				const imageCount = (media.images as unknown[])?.length || 0;
				const videoCount = (media.videos as unknown[])?.length || 0;
				if (imageCount || videoCount) {
					parts.push(`Media: ${imageCount} images, ${videoCount} videos`);
				}
			}

			return parts.join("\n\n");
		})
		.join("\n\n---\n\n") || "(No data)";
}

