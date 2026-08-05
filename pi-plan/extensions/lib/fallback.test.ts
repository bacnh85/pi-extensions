import assert from "node:assert/strict";
import { describe, it } from "mocha";

import { isOverloadError, OVERLOAD_PATTERNS } from "./fallback";

function assistantError(errorMessage: string) {
  return { role: "assistant", stopReason: "error", errorMessage };
}

describe("isOverloadError pattern coverage", () => {
  it("matches provider overload/rate-limit signals", () => {
    const positives = [
      "429 Too Many Requests",
      "529 origin is overloaded",
      "rate limit exceeded",
      "ratelimit hit",
      "too many requests",
      "quota exhausted",
      "quota exceeded for the month",
      "insufficient_quota",
      "resource exhausted",
      "capacity exceeded",
      "usage limit reached",
      "model overloaded",
      "server overloaded",
      "temporarily unavailable",
      "please try again later",
      "service busy",
      "server busy",
      "load shedding in progress",
      "503 Service Unavailable",
    ];
    for (const text of positives) {
      assert.equal(isOverloadError(assistantError(text)), true, `should match: ${text}`);
    }
  });

  it("does not match non-overload errors or innocent text", () => {
    const negatives = [
      "context_length_exceeded",
      "Context window exceeded",
      "unknown error",
      "connection refused",
      "the user is busy, ignore them",
      "I was busy thinking",
      "busy signal on the bus",
      "invalid api key",
      "timeout after 30000ms",
    ];
    for (const text of negatives) {
      assert.equal(isOverloadError(assistantError(text)), false, `should NOT match: ${text}`);
    }
  });

  it("requires assistant role and error stop reason", () => {
    assert.equal(isOverloadError({ role: "user", stopReason: "error", errorMessage: "429 Too Many Requests" }), false);
    assert.equal(isOverloadError({ role: "assistant", stopReason: "end_turn", errorMessage: "429 Too Many Requests" }), false);
    assert.equal(isOverloadError(undefined as any), false);
  });

  it("pattern list is stable and non-empty", () => {
    assert.ok(OVERLOAD_PATTERNS.length > 10, "pattern list is populated");
  });
});
