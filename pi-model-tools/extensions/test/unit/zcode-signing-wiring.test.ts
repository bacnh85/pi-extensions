import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyZcodeSigningHeaders, setZcodeSigningManager, ClientSigningManager, pickZcodeCredential } from "../../lib/zcode-signing.ts";

const CRED = "abc123.secret456";

describe("zcode-signing wiring", () => {
  it("pickZcodeCredential: header wins, then env, then lazy auth lookup; never logs", () => {
    const stored = () => "stored.key.value";
    assert.equal(pickZcodeCredential({ "x-api-key": "h.key" }, {}, stored), "h.key");
    assert.equal(pickZcodeCredential({}, { ZAI_ANTHROPIC_API_KEY: "e.key" }, stored), "e.key");
    assert.equal(pickZcodeCredential({}, {}, stored), "stored.key.value");
    let lookedUp = false;
    assert.equal(
      pickZcodeCredential({ "X-Api-Key": "case.key" }, { ZAI_ANTHROPIC_API_KEY: "e.key" }, () => {
        lookedUp = true;
        return "stored";
      }),
      "case.key",
      "case-insensitive header beats env",
    );
    assert.equal(lookedUp, false, "auth lookup stays lazy when header resolves");
    assert.equal(pickZcodeCredential({}, {}, () => undefined), undefined);
  });

  it("opt-out regression: ZAI_ANTHROPIC_SIGNING=0 → handler no-ops, headers untouched (deep-equal)", async () => {
    const headers = { "x-api-key": CRED, "anthropic-version": "2023-06-01" };
    const snapshot = { ...headers };
    const ok = await applyZcodeSigningHeaders(headers, {
      provider: "zai-anthropic",
      baseUrl: "https://api.z.ai/api/anthropic",
      sessionId: "sess_x",
      credential: CRED,
      env: { ZAI_ANTHROPIC_SIGNING: "0" },
    });
    assert.equal(ok, false);
    assert.deepEqual(headers, snapshot);
  });

  it("default-on: env {} → identity headers merged (signing itself may fail-open without network)", async () => {
    const stub = new ClientSigningManager({
      identity: { appVersion: "3.10.2", sourceTitle: "electron", refererOrigin: "https://zcode.z.ai" },
      fetchImpl: (async () => {
        throw new Error("no network in this test");
      }) as typeof fetch,
    });
    setZcodeSigningManager(stub);
    try {
      const headers: Record<string, string | null | undefined> = { "x-api-key": CRED };
      await applyZcodeSigningHeaders(headers, {
        provider: "zai-anthropic",
        baseUrl: "https://zcode.z.ai/api/v1/ultra-zai/anthropic",
        sessionId: "sess_default",
        credential: CRED,
        env: {}, // no env var at all → default ON
      });
      assert.equal(headers["User-Agent"], "ZCode/3.10.2");
      assert.equal(headers["x-session-id"], "sess_default", "fail-open path keeps lowercase session id");
      assert.ok(!headers["X-Client-Sig"], "fail-open: gate unreachable → unsigned, identity still merged");
    } finally {
      setZcodeSigningManager(undefined);
    }
  });

  it("non-zai-anthropic provider → no-op even when enabled", async () => {
    const headers = { "x-api-key": CRED, "x-session-id": "sess_x" };
    const snapshot = { ...headers };
    const ok = await applyZcodeSigningHeaders(headers, {
      provider: "openrouter",
      baseUrl: "https://api.z.ai/api/anthropic",
      sessionId: "sess_x",
      credential: CRED,
      env: { ZAI_ANTHROPIC_SIGNING: "1" },
    });
    assert.equal(ok, false);
    assert.deepEqual(headers, snapshot);
  });

  it("enabled + manager skipped (no session id / bad cred) → identity headers still merged, fail-open", async () => {
    // manager stub that reports skipped so we can observe the merge semantics alone
    const stub = new ClientSigningManager({
      identity: { appVersion: "3.10.2", sourceTitle: "electron", refererOrigin: "https://zcode.z.ai" },
      fetchImpl: (async () => {
        throw new Error("no network in this test");
      }) as typeof fetch,
    });
    setZcodeSigningManager(stub);
    try {
      const headers: Record<string, string | null | undefined> = { "x-api-key": CRED };
      const ok = await applyZcodeSigningHeaders(headers, {
        provider: "zai-anthropic",
        baseUrl: "https://zcode.z.ai/api/v1/ultra-zai/anthropic",
        sessionId: undefined, // missing → signing skips (its own rule)
        credential: CRED,
        env: { ZAI_ANTHROPIC_SIGNING: "1" },
      });
      assert.equal(ok, false);
      assert.equal(headers["User-Agent"], "ZCode/3.10.2");
      assert.equal(headers["X-ZCode-Agent"], "glm");
      assert.ok(!headers["X-Client-Sig"], "unsigned — no signature without session id");
    } finally {
      setZcodeSigningManager(undefined);
    }
  });
});
