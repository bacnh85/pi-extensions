import { expect } from "chai";

import {
	searchWithDiagnostics,
	selectSearchBackendOrder,
	type SearchParams,
	type SearchResult,
} from "../../lib/search";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "text/html" },
	});
}

function installMockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): string[] {
	const calls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		return handler(url, init);
	}) as typeof fetch;
	return calls;
}

function restoreEnv(): void {
	process.env = { ...ORIGINAL_ENV };
}

describe("SearchParams and SearchResult types", () => {
	it("accept expected fields", () => {
		const params: SearchParams = { query: "test", backend: "auto", signal: new AbortController().signal };
		const result: SearchResult = { title: "T", url: "https://example.com", snippet: "S", age: "", content: "", backend: "brave" };
		expect(params.backend).to.equal("auto");
		expect(result.backend).to.equal("brave");
	});
});

describe("selectSearchBackendOrder", () => {
	it("selects Brave first for include_content", () => {
		expect(selectSearchBackendOrder({ query: "homelab ansible", include_content: true })).to.deep.equal(["brave", "searxng", "firecrawl"]);
	});

	it("selects Brave first for site: and precision queries", () => {
		expect(selectSearchBackendOrder({ query: "site:docs.ansible.com podman quadlet" })).to.deep.equal(["brave", "searxng", "firecrawl"]);
		expect(selectSearchBackendOrder({ query: '"exact phrase" release notes' })).to.deep.equal(["brave", "searxng", "firecrawl"]);
	});

	it("keeps SearXNG first for broad discovery and explicit engines", () => {
		expect(selectSearchBackendOrder({ query: "homelab ansible ideas" })).to.deep.equal(["searxng", "brave", "firecrawl"]);
		expect(selectSearchBackendOrder({ query: "docs api", engines: "google,github" })).to.deep.equal(["searxng", "brave", "firecrawl"]);
	});

	it("honors explicit backend", () => {
		expect(selectSearchBackendOrder({ query: "test", backend: "firecrawl" })).to.deep.equal(["firecrawl"]);
	});
});

describe("searchWithDiagnostics", () => {
	beforeEach(() => {
		restoreEnv();
		process.env.BRAVE_API_KEY = "test-brave-key";
		process.env.SEARXNG_BASE_URL = "http://searxng.test";
		process.env.FIRECRAWL_API_URL = "http://firecrawl.test/v2";
	});

	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH;
		restoreEnv();
	});

	it("uses Brave first for include_content and fetches inline content", async () => {
		const calls = installMockFetch((url) => {
			if (url.startsWith("https://api.search.brave.com/")) {
				return jsonResponse({ web: { results: [{ title: "Brave", url: "https://example.com/page", description: "Snippet" }] } });
			}
			if (url === "https://example.com/page") {
				return htmlResponse("<html><head><title>Page</title></head><body><main><h1>Page</h1><p>This is long enough readable content for the inline content fetch test.</p></main></body></html>");
			}
			throw new Error(`unexpected fetch ${url}`);
		});

		const result = await searchWithDiagnostics({ query: "homelab ansible", include_content: true });
		expect(result.selectedBackend).to.equal("brave");
		expect(result.backendOrder[0]).to.equal("brave");
		expect(result.results[0].content).to.include("readable content");
		expect(calls[0]).to.include("api.search.brave.com");
	});

	it("uses SearXNG first for broad discovery", async () => {
		const calls = installMockFetch((url) => {
			if (url.startsWith("http://searxng.test/search")) {
				return jsonResponse({ results: [{ title: "SearXNG", url: "https://example.com", content: "Snippet" }] });
			}
			throw new Error(`unexpected fetch ${url}`);
		});

		const result = await searchWithDiagnostics({ query: "homelab ansible ideas" });
		expect(result.selectedBackend).to.equal("searxng");
		expect(result.attempts).to.deep.include({ backend: "searxng", status: "success", message: "Selected searxng", resultCount: 1 });
		expect(calls[0]).to.include("searxng.test");
	});

	it("captures backend errors and falls through to Firecrawl last", async () => {
		installMockFetch((url) => {
			if (url.startsWith("http://searxng.test/search")) return jsonResponse({ results: [] });
			if (url.startsWith("https://api.search.brave.com/")) return jsonResponse({ error: "rate limited" }, 429);
			if (url.startsWith("http://firecrawl.test/v2/search")) {
				return jsonResponse({ data: { web: [{ title: "Fire", url: "https://fire.example", description: "Fallback" }] } });
			}
			throw new Error(`unexpected fetch ${url}`);
		});

		const result = await searchWithDiagnostics({ query: "homelab ansible ideas" });
		expect(result.selectedBackend).to.equal("firecrawl");
		expect(result.attempts.map((a) => a.backend)).to.deep.equal(["searxng", "brave", "firecrawl"]);
		expect(result.attempts[1].status).to.equal("error");
		expect(result.attempts[1].message).not.to.include("test-brave-key");
	});

	it("explicit backend tries only that backend", async () => {
		const calls = installMockFetch((url) => {
			if (url.startsWith("http://searxng.test/search")) return jsonResponse({ results: [] });
			throw new Error(`unexpected fetch ${url}`);
		});

		const result = await searchWithDiagnostics({ query: "nothing", backend: "searxng" });
		expect(result.results).to.deep.equal([]);
		expect(result.attempts).to.deep.include({ backend: "searxng", status: "empty", message: "searxng returned 0 results", resultCount: 0 });
		expect(calls).to.have.length(1);
	});

});
