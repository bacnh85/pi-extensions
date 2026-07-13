import { expect } from "chai";

import {
	extractWithDiagnostics,
	type ExtractMode,
	type ExtractParams,
	type ExtractResult,
} from "../../lib/extract";

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

describe("ExtractParams and ExtractResult types", () => {
	it("accept expected fields", () => {
		const modes: ExtractMode[] = ["auto", "static", "dynamic", "full"];
		const params: ExtractParams = { url: "https://example.com", mode: modes[0], wait_for: 1000, mobile: true };
		const result: ExtractResult = { title: "Title", markdown: "Content", backend: "static", structured: { ok: true } };
		expect(params.mode).to.equal("auto");
		expect(result.structured).to.deep.equal({ ok: true });
	});
});

describe("extractWithDiagnostics", () => {
	beforeEach(() => {
		restoreEnv();
		process.env.FIRECRAWL_API_URL = "http://firecrawl.test/v2";
		process.env.CRAWL4AI_API_URL = "http://crawl4ai.test";
	});

	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH;
		restoreEnv();
	});

	it("uses static extraction when it returns useful content", async () => {
		installMockFetch((url) => {
			if (url === "https://example.com/static") {
				return htmlResponse("<html><head><title>Static</title></head><body><main><h1>Static</h1><p>This static article has enough readable text to pass the useful-content threshold in auto mode without falling back.</p><p>Additional words make it reliably longer than the minimum threshold.</p></main></body></html>");
			}
			throw new Error(`unexpected fetch ${url}`);
		});

		const diagnostics = await extractWithDiagnostics({ url: "https://example.com/static" });
		expect(diagnostics.selectedMode).to.equal("static");
		expect(diagnostics.fallbackUsed).to.be.false;
		expect(diagnostics.result.markdown).to.include("static article");
	});

	it("falls through from short static content to dynamic extraction", async () => {
		const calls = installMockFetch((url) => {
			if (url === "https://example.com/short") return htmlResponse("<html><body><main>short</main></body></html>");
			if (url === "http://firecrawl.test/v2/scrape") {
				return jsonResponse({ data: { markdown: "# Dynamic\n\nDynamic content from Firecrawl after static extraction was too short.", metadata: { title: "Dynamic", sourceURL: "https://example.com/short" } } });
			}
			throw new Error(`unexpected fetch ${url}`);
		});

		const diagnostics = await extractWithDiagnostics({ url: "https://example.com/short" });
		expect(diagnostics.selectedMode).to.equal("dynamic");
		expect(diagnostics.fallbackUsed).to.be.true;
		expect(diagnostics.attempts.map((a) => a.mode)).to.deep.equal(["static", "dynamic"]);
		expect(diagnostics.result.markdown).to.include("fell back to Firecrawl");
		expect(calls).to.deep.equal(["https://example.com/short", "http://firecrawl.test/v2/scrape"]);
	});

	it("explicit static mode does not fall through", async () => {
		installMockFetch((url) => {
			if (url === "https://example.com/short") return htmlResponse("<html><body><main>short</main></body></html>");
			throw new Error(`unexpected fetch ${url}`);
		});

		const diagnostics = await extractWithDiagnostics({ url: "https://example.com/short", mode: "static" });
		expect(diagnostics.selectedMode).to.equal("static");
		expect(diagnostics.result.markdown).to.include("short");
	});

	it("dynamic mode includes structured JSON output when present", async () => {
		installMockFetch((url, init) => {
			if (url === "http://firecrawl.test/v2/scrape") {
				const body = JSON.parse(String(init?.body));
				expect(body.formats).to.deep.equal(["markdown", "json"]);
				expect(body.jsonOptions).to.deep.equal({ prompt: "Extract title" });
				return jsonResponse({ data: { markdown: "# Dynamic\n\nBody", json: { title: "Structured" }, metadata: { title: "Dynamic" } } });
			}
			throw new Error(`unexpected fetch ${url}`);
		});

		const diagnostics = await extractWithDiagnostics({ url: "https://example.com/dynamic", mode: "dynamic", prompt: "Extract title" });
		expect(diagnostics.result.structured).to.deep.equal({ title: "Structured" });
		expect(diagnostics.result.markdown).to.include("## Structured extraction");
	});

	it("falls through to full mode when static and dynamic fail", async () => {
		installMockFetch((url) => {
			if (url === "https://example.com/full") return htmlResponse("<html><body><main>tiny</main></body></html>");
			if (url === "http://firecrawl.test/v2/scrape") return jsonResponse({ error: "blocked" }, 500);
			if (url === "http://crawl4ai.test/md") return jsonResponse({ success: true, markdown: "# Full\n\nCrawl4AI markdown content" });
			throw new Error(`unexpected fetch ${url}`);
		});

		const diagnostics = await extractWithDiagnostics({ url: "https://example.com/full" });
		expect(diagnostics.selectedMode).to.equal("full");
		expect(diagnostics.attempts.map((a) => a.mode)).to.deep.equal(["static", "dynamic", "full"]);
		expect(diagnostics.result.markdown).to.include("Crawl4AI");
	});

});
