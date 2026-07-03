// Text formatting and result formatting helpers for pi-web.

import { OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES } from "./config";

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

export function truncateText(text: string): string {
	const lines = text.split("\n");
	let output = lines.slice(0, OUTPUT_MAX_LINES).join("\n");
	while (Buffer.byteLength(output, "utf8") > OUTPUT_MAX_BYTES) {
		output = output.slice(0, Math.max(0, output.length - 1024));
	}
	if (lines.length > OUTPUT_MAX_LINES || output.length < text.length) {
		output += `\n\n[Web output truncated to ${OUTPUT_MAX_LINES} lines / ${OUTPUT_MAX_BYTES} bytes.]`;
	}
	return output;
}

// ---------------------------------------------------------------------------
// Search result formatting
// ---------------------------------------------------------------------------

export function formatSearchResults(results: SearchResultItem[]): string {
	if (!results.length) return "No results found.";
	return results
		.map((r, i) =>
			[
				`--- Result ${i + 1} ---`,
				`Title: ${r.title || ""}`,
				`Link: ${r.url || ""}`,
				r.age ? `Age: ${r.age}` : "",
				r.snippet || r.description ? `Snippet: ${r.snippet || r.description}` : "",
				r.content || r.markdown ? `Content:\n${r.content || r.markdown}` : "",
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

export function formatFirecrawlSearch(data: Record<string, unknown>, maxChars = 5000): string {
	const rootData = data.data as Record<string, unknown> | undefined;
	const web = (rootData?.web as unknown[]) || [];
	const news = (rootData?.news as unknown[]) || [];
	const images = (rootData?.images as unknown[]) || [];
	const results: SearchResultItem[] = [...web, ...news].map((r: any) => ({
		title: r.title || r.metadata?.title || "",
		url: r.url || r.metadata?.sourceURL || "",
		snippet: r.description || r.snippet || "",
		markdown: r.markdown ? String(r.markdown).slice(0, maxChars) : "",
	}));
	let text = formatSearchResults(results);
	if (images.length) {
		text +=
			"\n\n" +
			images
				.map((img: any, i: number) =>
					[
						`--- Image ${i + 1} ---`,
						`Title: ${img.title || ""}`,
						`Image: ${img.imageUrl || ""}`,
						`Page: ${img.url || ""}`,
					].join("\n"),
				)
				.join("\n\n");
	}
	if (data.warning) text += `\n\nWarning: ${data.warning}`;
	return text;
}
