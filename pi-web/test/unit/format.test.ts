/**
 * Unit tests for pi-web format module.
 */

import { expect } from "chai";
import {
	sanitizeSnippet,
	truncateText,
	formatSearchResults,
	formatFirecrawlScrape,
	formatFirecrawlSearch,
	formatCrawl4aiResult,
	type SearchResultItem,
} from "../../lib/format";
import { OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES } from "../../lib/config";

describe("sanitizeSnippet", () => {
	it("returns empty string for empty input", () => {
		expect(sanitizeSnippet()).to.equal("");
		expect(sanitizeSnippet("")).to.equal("");
	});

	it("strips HTML tags", () => {
		expect(sanitizeSnippet("<b>hello</b> world")).to.equal("hello world");
	});

	it("decodes HTML entities", () => {
		expect(sanitizeSnippet("foo &amp; bar")).to.equal("foo & bar");
		expect(sanitizeSnippet("&lt;tag&gt;")).to.equal("<tag>");
		expect(sanitizeSnippet("&quot;quoted&quot;")).to.equal('"quoted"');
		expect(sanitizeSnippet("hello&nbsp;world")).to.equal("hello world");
	});

	it("decodes numeric HTML entities", () => {
		expect(sanitizeSnippet("&#65;")).to.equal("A");
		expect(sanitizeSnippet("&#x41;")).to.equal("A");
	});

	it("collapses whitespace", () => {
		expect(sanitizeSnippet("hello   world")).to.equal("hello world");
		expect(sanitizeSnippet("  hello  ")).to.equal("hello");
	});
});

describe("truncateText", () => {
	it("returns short text as-is", () => {
		const text = "hello world";
		expect(truncateText(text)).to.equal(text);
	});

	it("truncates by line count when exceeding OUTPUT_MAX_LINES", () => {
		const lines = Array.from({ length: OUTPUT_MAX_LINES + 10 }, (_, i) => `line ${i}`);
		const text = lines.join("\n");
		const result = truncateText(text);
		expect(result).to.include("[Web output truncated to");
		expect(result.split("\n").length).to.be.lessThan(OUTPUT_MAX_LINES + 15);
	});

	it("truncates by byte count when exceeding OUTPUT_MAX_BYTES", () => {
		const text = "x".repeat(OUTPUT_MAX_BYTES + 50000);
		const result = truncateText(text);
		expect(result).to.include("[Web output truncated to");
	});

	it("handles empty string", () => {
		expect(truncateText("")).to.equal("");
	});
});

describe("formatSearchResults", () => {
	it('returns "No results found." for empty array', () => {
		expect(formatSearchResults([])).to.equal("No results found.");
	});

	it("formats a single result", () => {
		const results: SearchResultItem[] = [
			{ title: "Test Title", url: "https://example.com", snippet: "A test snippet" },
		];
		const output = formatSearchResults(results);
		expect(output).to.include("--- Result 1 ---");
		expect(output).to.include("Title: Test Title");
		expect(output).to.include("Link: https://example.com");
		expect(output).to.include("Snippet: A test snippet");
	});

	it("formats multiple results", () => {
		const results: SearchResultItem[] = [
			{ title: "First", url: "https://a.com" },
			{ title: "Second", url: "https://b.com" },
		];
		const output = formatSearchResults(results);
		expect(output).to.include("--- Result 1 ---");
		expect(output).to.include("--- Result 2 ---");
		expect(output).to.include("Title: First");
		expect(output).to.include("Title: Second");
	});

	it("includes age when present", () => {
		const results: SearchResultItem[] = [
			{ title: "T", url: "https://x.com", age: "2 days ago" },
		];
		const output = formatSearchResults(results);
		expect(output).to.include("Age: 2 days ago");
	});

	it("includes content when present", () => {
		const results: SearchResultItem[] = [
			{ title: "T", url: "https://x.com", content: "Full content here" },
		];
		const output = formatSearchResults(results);
		expect(output).to.include("Content:\nFull content here");
	});
});

describe("formatFirecrawlScrape", () => {
	it("formats scrape data with metadata", () => {
		const data = {
			data: {
				metadata: {
					title: "Test Page",
					sourceURL: "https://example.com",
					statusCode: 200,
				},
				markdown: "# Hello\n\nThis is content.",
			},
		};
		const output = formatFirecrawlScrape(data);
		expect(output).to.include("# Test Page");
		expect(output).to.include("Source: https://example.com");
		expect(output).to.include("Status: 200");
		expect(output).to.include("# Hello");
		expect(output).to.include("This is content.");
	});

	it("resolves data at top level when no nested data", () => {
		const data = {
			metadata: { title: "Direct" },
			markdown: "Content",
		};
		const output = formatFirecrawlScrape(data);
		expect(output).to.include("# Direct");
		expect(output).to.include("Content");
	});

	it("includes warning when present", () => {
		const data = { data: { markdown: "x" }, warning: "Rate limited" };
		const output = formatFirecrawlScrape(data);
		expect(output).to.include("Warning: Rate limited");
	});

	it("includes links when present", () => {
		const data = {
			data: {
				markdown: "body",
				links: ["https://a.com", "https://b.com"],
			},
		};
		const output = formatFirecrawlScrape(data);
		expect(output).to.include("## Links");
		expect(output).to.include("- https://a.com");
	});

	it("returns JSON stringify fallback for empty data", () => {
		const data = { foo: "bar" };
		const output = formatFirecrawlScrape(data);
		expect(output).to.include("foo");
	});
});

describe("formatFirecrawlSearch", () => {
	it("formats web results", () => {
		const data = {
			data: {
				web: [
					{ title: "Result A", url: "https://a.com", description: "Desc A" },
					{ title: "Result B", url: "https://b.com", description: "Desc B" },
				],
			},
		};
		const output = formatFirecrawlSearch(data);
		expect(output).to.include("--- Result 1 ---");
		expect(output).to.include("Result A");
		expect(output).to.include("Result B");
	});

	it("formats news results combined with web results", () => {
		const data = {
			data: {
				web: [{ title: "Web", url: "https://w.com", description: "W" }],
				news: [{ title: "News", url: "https://n.com", description: "N" }],
			},
		};
		const output = formatFirecrawlSearch(data);
		expect(output).to.include("--- Result 1 ---");
		expect(output).to.include("--- Result 2 ---");
	});

	it("includes images section", () => {
		const data = {
			data: {
				images: [{ title: "Pic", imageUrl: "https://img.com/pic.png", url: "https://page.com" }],
			},
		};
		const output = formatFirecrawlSearch(data);
		expect(output).to.include("--- Image 1 ---");
		expect(output).to.include("Pic");
		expect(output).to.include("https://img.com/pic.png");
	});

	it("includes top-level warning", () => {
		const data = { data: {}, warning: "Partial results" };
		const output = formatFirecrawlSearch(data);
		expect(output).to.include("Warning: Partial results");
	});
});

describe("formatCrawl4aiResult", () => {
	it("formats a single successful crawl result with markdown", () => {
		const data = {
			url: "https://example.com",
			success: true,
			status_code: 200,
			markdown: { fit_markdown: "# Hello\n\nWorld content." },
		};
		const output = formatCrawl4aiResult(data);
		expect(output).to.include("URL: https://example.com");
		expect(output).to.include("Status: 200");
		expect(output).to.include("# Hello");
	});

	it("shows error for failed crawl", () => {
		const data = {
			url: "https://example.com/404",
			success: false,
			error_message: "Not Found",
		};
		const output = formatCrawl4aiResult(data);
		expect(output).to.include("Error: Not Found");
		expect(output).to.include("URL: https://example.com/404");
	});

	it("formats multiple results from wrapped response", () => {
		const data = {
			results: [
				{ url: "https://a.com", success: true, markdown: { raw_markdown: "Page A" } },
				{ url: "https://b.com", success: true, markdown: { raw_markdown: "Page B" } },
			],
		};
		const output = formatCrawl4aiResult(data);
		expect(output).to.include("=== Result 1 ===");
		expect(output).to.include("=== Result 2 ===");
		expect(output).to.include("Page A");
		expect(output).to.include("Page B");
	});

	it("falls back to raw_markdown when fit_markdown is absent", () => {
		const data = {
			url: "https://example.com",
			success: true,
			markdown: { raw_markdown: "Raw content only" },
		};
		const output = formatCrawl4aiResult(data);
		expect(output).to.include("Raw content only");
	});

	it("includes links when present", () => {
		const data = {
			url: "https://example.com",
			success: true,
			markdown: { fit_markdown: "body" },
			links: {
				internal: [{ href: "https://example.com/about" }],
				external: [{ href: "https://other.com" }],
			},
		};
		const output = formatCrawl4aiResult(data);
		expect(output).to.include("Links");
		expect(output).to.include("https://example.com/about");
	});

	it("returns fallback for empty data", () => {
		expect(formatCrawl4aiResult({})).to.equal("(No data)");
	});
});


