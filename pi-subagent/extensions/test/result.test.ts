/**
 * Tests for parseStructuredResult — parent-side result extraction.
 */

import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { parseStructuredResult, extractSummary } from "../result.ts";

describe("parseStructuredResult", () => {
  it("returns summary + fullOutput for plain text", () => {
    const raw = "The auth flow uses JWT. Middleware validates the token on each request.";
    const r = parseStructuredResult(raw);
    assert.equal(r.summary, "The auth flow uses JWT.");
    assert.equal(r.fullOutput, raw);
    assert.equal(r.findings, undefined);
  });

  it("extracts sections from markdown headers", () => {
    const raw = [
      "## Summary",
      "Found the bug.",
      "",
      "## Findings",
      "The cache key was missing the tenant prefix.",
      "",
      "## Files",
      "- src/cache.ts",
      "",
      "## Caveats",
      "Only tested on Redis.",
    ].join("\n");
    const r = parseStructuredResult(raw);
    assert.equal(r.findings, "The cache key was missing the tenant prefix.");
    assert.equal(r.files, "- src/cache.ts");
    assert.equal(r.caveats, "Only tested on Redis.");
  });

  it("matches header aliases (Evidence -> findings, Changed files -> files)", () => {
    const raw = [
      "## Evidence",
      "line 42 in auth.ts",
      "",
      "## Changed files",
      "auth.ts",
      "",
      "## Recommendations",
      "Add tenant prefix.",
    ].join("\n");
    const r = parseStructuredResult(raw);
    assert.equal(r.findings, "line 42 in auth.ts");
    assert.equal(r.files, "auth.ts");
    assert.equal(r.nextSteps, "Add tenant prefix.");
  });

  it("handles empty output", () => {
    const r = parseStructuredResult("");
    assert.equal(r.summary, "");
    assert.equal(r.fullOutput, "");
  });

  it("handles whitespace-only output", () => {
    const r = parseStructuredResult("   \n  \n");
    assert.equal(r.summary, "");
  });

  it("ignores headers with no body (empty section not included)", () => {
    const raw = ["## Findings", "", "## Files", "a.ts"].join("\n");
    const r = parseStructuredResult(raw);
    assert.equal(r.findings, undefined); // empty body
    assert.equal(r.files, "a.ts");
  });

  it("caps summary to 200 chars", () => {
    const long = "x".repeat(300) + ". end.";
    const r = parseStructuredResult(long);
    assert.ok(r.summary.length <= 200, `summary too long: ${r.summary.length}`);
    assert.ok(r.summary.endsWith("…"));
  });

  it("takes first sentence as summary when present", () => {
    const r = parseStructuredResult("First sentence. Second sentence.");
    assert.equal(r.summary, "First sentence.");
  });

  it("takes whole line when no sentence punctuation", () => {
    const r = parseStructuredResult("no punctuation here");
    assert.equal(r.summary, "no punctuation here");
  });
});

describe("extractSummary", () => {
  it("skips leading markdown headers", () => {
    assert.equal(
      extractSummary("## Title\n\nActual content here."),
      "Actual content here.",
    );
  });

  it("skips blank lines", () => {
    assert.equal(
      extractSummary("\n\n\nReal content."),
      "Real content.",
    );
  });
});
