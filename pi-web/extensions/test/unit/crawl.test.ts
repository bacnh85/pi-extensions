/**
 * Unit tests for web_crawl light-mode poll loop deadline handling.
 *
 * The loop must honor timeout_ms (stop polling + report incomplete state)
 * instead of always running its full 60×2s iteration cap.
 */

import { expect } from "chai";
import piWebExtension from "../../index";

function harness(): Record<string, any> {
  const tools: Record<string, any> = {};
  const pi: any = {
    registerTool(tool: any) { tools[tool.name] = tool; },
    on() {},
  };
  piWebExtension(pi);
  return tools;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("web_crawl light-mode poll loop", () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  const SAVED_URL = process.env.FIRECRAWL_API_URL;
  const SAVED_KEY = process.env.FIRECRAWL_API_KEY;

  beforeEach(() => {
    process.env.FIRECRAWL_API_URL = "http://firecrawl.test/v2";
    process.env.FIRECRAWL_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (SAVED_URL === undefined) delete process.env.FIRECRAWL_API_URL;
    else process.env.FIRECRAWL_API_URL = SAVED_URL;
    if (SAVED_KEY === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = SAVED_KEY;
  });

  it("stops polling at timeout_ms and returns an honest incomplete-state note", async () => {
    let getCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/crawl")) return jsonResponse({ id: "c1" });
      if (url.endsWith("/crawl/c1")) {
        getCalls += 1;
        return jsonResponse({ status: "scraping" });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const tools = harness();
    const res = await tools.web_crawl.execute(
      "t1",
      { url: "https://example.com", mode: "light", poll: true, timeout_ms: 1000 },
      new AbortController().signal,
      undefined,
      {},
    );
    // Exited on the deadline after one poll, not the 60-iteration cap.
    expect(getCalls).to.equal(1);
    expect(res.content[0].text).to.include("timeout_ms");
    expect(res.content[0].text).to.include("scraping");
    expect(res.content[0].text).to.include("incomplete");
  });

  it("still returns immediately when the crawl is already completed (no timeout_ms)", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/crawl")) return jsonResponse({ id: "c2" });
      if (url.endsWith("/crawl/c2")) {
        return jsonResponse({ status: "completed", data: [{ markdown: "# Page", url: "https://example.com" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const tools = harness();
    const res = await tools.web_crawl.execute(
      "t2",
      { url: "https://example.com", mode: "light", poll: true },
      new AbortController().signal,
      undefined,
      {},
    );
    expect(res.content[0].text).to.not.include("incomplete");
    expect(res.content[0].text).to.include("Page");
  });
});
