/**
 * Unit tests for pi-web Crawl4AI client.
 */

import { expect } from "chai";
import { HttpError } from "../../lib/retry";

describe("HttpError", () => {
  it("formats error message with status and text", () => {
    const err = new HttpError(401, "Unauthorized", '{"detail":"bad token"}');
    expect(err.status).to.equal(401);
    expect(err.message).to.include("HTTP 401: Unauthorized");
    expect(err.message).to.include('{"detail":"bad token"}');
  });

  it("handles empty response text", () => {
    const err = new HttpError(500, "Internal Server Error", "");
    expect(err.status).to.equal(500);
    expect(err.message).to.equal("HTTP 500: Internal Server Error");
  });

  it("is instance of Error", () => {
    const err = new HttpError(403, "Forbidden", "rate limit");
    expect(err).to.be.instanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Config + format integration: verify imported functions exist with correct sigs
// ---------------------------------------------------------------------------

import type { Crawl4aiConfig } from "../../lib/config";

describe("Crawl4aiConfig interface", () => {
  it("has expected shape", () => {
    const config: Crawl4aiConfig = {
      baseUrl: "http://localhost:11235",
      apiToken: "token123",
      timeoutMs: 30000,
    };
    expect(config.baseUrl).to.equal("http://localhost:11235");
    expect(config.apiToken).to.equal("token123");
    expect(config.timeoutMs).to.equal(30000);
  });
});

// ---------------------------------------------------------------------------
// Verify client exports exist
// ---------------------------------------------------------------------------

import {
  fetchCrawl4aiMarkdown,
  fetchCrawl4aiCrawl,
  fetchCrawl4aiScreenshot,
  fetchCrawl4aiPdf,
  fetchCrawl4aiHealth,
  crawl4aiRequest,
} from "../../lib/crawl4ai";

describe("Crawl4AI client exports", () => {
  it("exports all expected functions", () => {
    expect(fetchCrawl4aiMarkdown).to.be.a("function");
    expect(fetchCrawl4aiCrawl).to.be.a("function");
    expect(fetchCrawl4aiScreenshot).to.be.a("function");
    expect(fetchCrawl4aiPdf).to.be.a("function");
    expect(fetchCrawl4aiHealth).to.be.a("function");
    expect(crawl4aiRequest).to.be.a("function");
  });
});
