import assert from "node:assert/strict";
import { test } from "node:test";
import { redactedError, supportedAdapter } from "../index.ts";

test("zai-anthropic model maps to the Z.ai (Anthropic) usage adapter", () => {
  const a = supportedAdapter({ provider: "zai-anthropic", id: "glm-5.3-flash" });
  assert.ok(a);
  assert.equal(a.id, "zai-anthropic");
  assert.equal(a.displayName, "Z.ai (Anthropic)");
  assert.equal(typeof a.fetchUsage, "function");
});

test("sibling zai legs unchanged (regression guard)", () => {
  assert.equal(supportedAdapter({ provider: "zai", id: "glm-5.3" })?.id, "zai");
  assert.equal(supportedAdapter({ provider: "zai-coding-cn", id: "glm-5.3" })?.id, "zai-coding-cn");
  assert.equal(supportedAdapter({ provider: "acme", id: "whatever" }), undefined);
});

// Live finding 2026-09-07: api.z.ai monitor returned HTTP 200 with
// {"code":500,"msg":"Internal service error"} — a server-side outage. The
// footer must show the server's message, not a generic "usage unavailable".
test("structured API errors surface the server message; auth ones stay redacted", () => {
  assert.equal(
    redactedError(new Error("Z.ai (Anthropic) API error: Internal service error"), "Z.ai (Anthropic)"),
    "Z.ai (Anthropic) API error: Internal service error",
  );
  assert.equal(
    redactedError(new Error("Z.ai (Anthropic) API error: token expired or incorrect"), "Z.ai (Anthropic)"),
    "Z.ai (Anthropic) auth unavailable",
  );
  assert.equal(redactedError(new Error("something odd"), "Z.ai (Anthropic)"), "Z.ai (Anthropic) usage unavailable");
});

test("credential-shaped material in server messages is scrubbed", () => {
  const shown = redactedError(new Error("Z.ai (Anthropic) API error: invalid api key sk-ant-abc123"), "Z.ai (Anthropic)");
  assert.ok(!shown.includes("sk-ant-abc123"), "must not leak key material");
  assert.ok(shown.includes("[REDACTED]"));
  const bearer = redactedError(new Error("Z.ai (Anthropic) API error: rejected Bearer eyJhbGciOi.payload.sig"), "Z.ai (Anthropic)");
  assert.ok(!bearer.includes("eyJhbGciOi"), "must not leak JWT material");
});
