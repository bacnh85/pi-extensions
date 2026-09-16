import assert from "node:assert/strict";
import { describe, it } from "mocha";

import { opencodeSessionHeaders, runIsolated } from "./isolated-model";

const SESSION = "ses_abc123";

function fakeCtx(model: Record<string, unknown>, authHeaders: Record<string, string> = {}, sessionId?: string) {
  const calls: Array<Record<string, any>> = [];
  const ctx: any = {
    model,
    modelRegistry: {
      find: () => model,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: authHeaders, env: {} }),
      getRegisteredProviderConfig: () => ({
        streamSimple: (_m: unknown, _c: unknown, options: Record<string, any>) => {
          calls.push(options);
          return {
            async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "ok" }; },
            result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "ok" }] }),
          };
        },
      }),
    },
    sessionManager: { getSessionId: () => sessionId },
  };
  return { ctx, headers: () => calls[0]?.headers ?? {} };
}

describe("opencodeSessionHeaders", () => {
  it("matches opencode providers and the opencode.ai host", () => {
    const expected = { "x-opencode-session": SESSION, "x-opencode-client": "pi" };
    assert.deepEqual(opencodeSessionHeaders({ provider: "opencode" }, SESSION), expected);
    assert.deepEqual(opencodeSessionHeaders({ provider: "opencode-go" }, SESSION), expected);
    assert.deepEqual(opencodeSessionHeaders({ provider: "custom", baseUrl: "https://opencode.ai/zen/go/v1" }, SESSION), expected);
  });

  it("returns nothing without a session id, for other providers, or for a non-URL baseUrl", () => {
    assert.equal(opencodeSessionHeaders({ provider: "opencode-go" }, undefined), undefined);
    assert.equal(opencodeSessionHeaders({ provider: "anthropic", baseUrl: "https://api.anthropic.com" }, SESSION), undefined);
    assert.equal(opencodeSessionHeaders({ provider: "zai", baseUrl: "not-a-url" }, SESSION), undefined);
  });
});

describe("runIsolated session headers", () => {
  it("sends x-opencode-session on opencode-go models (issue #38)", async () => {
    const { ctx, headers } = fakeCtx({ provider: "opencode-go", id: "omen-alpha", baseUrl: "https://opencode.ai/zen/go/v1" }, {}, SESSION);
    await runIsolated(ctx, undefined, { systemPrompt: "s", messages: [] });
    assert.equal(headers()["x-opencode-session"], SESSION);
    assert.equal(headers()["x-opencode-client"], "pi");
  });

  it("preserves existing auth headers and lets them win on conflict", async () => {
    const { ctx, headers } = fakeCtx(
      { provider: "opencode-go", id: "omen-alpha" },
      { authorization: "Bearer t", "x-opencode-client": "custom" },
      SESSION,
    );
    await runIsolated(ctx, undefined, { systemPrompt: "s", messages: [] });
    assert.equal(headers().authorization, "Bearer t");
    assert.equal(headers()["x-opencode-session"], SESSION);
    assert.equal(headers()["x-opencode-client"], "custom");
  });

  it("adds no session header for non-opencode models or when there is no session", async () => {
    const other = fakeCtx({ provider: "anthropic", id: "claude", baseUrl: "https://api.anthropic.com" }, {}, SESSION);
    await runIsolated(other.ctx, undefined, { systemPrompt: "s", messages: [] });
    assert.equal(other.headers()["x-opencode-session"], undefined);

    const noSession = fakeCtx({ provider: "opencode-go", id: "omen-alpha" });
    await runIsolated(noSession.ctx, undefined, { systemPrompt: "s", messages: [] });
    assert.equal(noSession.headers()["x-opencode-session"], undefined);
  });
});
