import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchModels, mapModel, DEFAULT_BASE_URL, type CommandCodeModelRaw } from "../lib/client.js";

// ── mapModel ─────────────────────────────────────────────────────────────────

describe("mapModel", () => {
  it("maps a basic model with fallback context window", () => {
    const raw: CommandCodeModelRaw = { id: "deepseek/deepseek-v4-flash", object: "model", owned_by: "deepseek" };
    const model = mapModel(raw);
    assert.equal(model.id, "deepseek/deepseek-v4-flash");
    assert.equal(model.name, "deepseek/deepseek-v4-flash");
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(model.compat, {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
    });
    // deepseek-v4 override → 1M context
    assert.equal(model.contextWindow, 1_000_000);
    // no capabilities.vision advertised → text-only (don't over-advertise image input)
    assert.deepEqual(model.input, ["text"]);
  });

  it("applies glm-5.2 context + maxTokens override", () => {
    const raw: CommandCodeModelRaw = { id: "zai-org/GLM-5.2" };
    const model = mapModel(raw);
    assert.equal(model.contextWindow, 1_000_000);
    assert.equal(model.maxTokens, 131_072);
  });

  it("narrows Claude: only Opus/Sonnet/Fable 5 get 1M; a 3.5 model falls back", () => {
    // The broad /claude/i override was narrowed to Claude-5 family only.
    const sonnet35 = mapModel({ id: "anthropic/claude-3-5-sonnet" });
    assert.equal(sonnet35.contextWindow, 128_000, "claude-3.5 must NOT inherit the 1M override");

    const opus5 = mapModel({ id: "claude-opus-5" });
    assert.equal(opus5.contextWindow, 1_000_000, "claude-opus-5 gets the 1M override");
  });

  it("override is a floor: API context_length wins when it is >= the override", () => {
    // A model upgraded to a larger window must not be capped by a stale override.
    const raw: CommandCodeModelRaw = { id: "deepseek/deepseek-v4-flash", context_length: 2_000_000 };
    assert.equal(mapModel(raw).contextWindow, 2_000_000);
  });

  it("falls back to provided context_length when no override matches", () => {
    const raw: CommandCodeModelRaw = { id: "unknown/future-model", context_length: 65_000 };
    assert.equal(mapModel(raw).contextWindow, 65_000);
  });

  it("falls back to default context window when nothing is known", () => {
    const raw: CommandCodeModelRaw = { id: "unknown/future-model" };
    assert.equal(mapModel(raw).contextWindow, 128_000);
  });

  it("advertises image input only when capabilities.vision === true", () => {
    const vision = mapModel({ id: "moonshotai/Kimi-K3", capabilities: { vision: true } });
    assert.deepEqual(vision.input, ["text", "image"]);

    const noVision = mapModel({ id: "moonshotai/Kimi-K3", capabilities: { vision: false } });
    assert.deepEqual(noVision.input, ["text"]);

    const absent = mapModel({ id: "moonshotai/Kimi-K3" });
    assert.deepEqual(absent.input, ["text"]);
  });
});

// ── fetchModels ──────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(responses: { status?: number; body: unknown } | (() => Response)) {
  globalThis.fetch = (() => {
    if (typeof responses === "function") return responses;
    const status = responses.status ?? 200;
    return Promise.resolve(
      new Response(JSON.stringify(responses.body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

describe("fetchModels", () => {
  beforeEach(() => { globalThis.fetch = originalFetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("extracts the data array from a valid OpenAI-shaped response", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = ((input: any) => {
      capturedUrl = typeof input === "string" ? input : String(input);
      return Promise.resolve(new Response(JSON.stringify({
        object: "list",
        data: [
          { id: "deepseek/deepseek-v4-flash" },
          { id: "zai-org/GLM-5.2", context_length: 1_000_000 },
        ],
      }), { status: 200 }));
    }) as typeof fetch;
    const models = await fetchModels(DEFAULT_BASE_URL, "test-key");
    assert.equal(models.length, 2);
    assert.equal(models[0].id, "deepseek/deepseek-v4-flash");
    assert.equal(models[1].context_length, 1_000_000);
    // Regression guard: the /v1 segment must live in baseUrl exactly once.
    // Pre-fix this was /provider/v1/models via a separate /v1 add; a baseUrl
    // missing /v1 caused chat completions to 404.
    assert.match(capturedUrl ?? "", /\/provider\/v1\/models$/);
  });

  it("returns [] when data is missing or malformed", async () => {
    mockFetch({ body: { object: "list" } }); // no data field
    const models = await fetchModels(DEFAULT_BASE_URL);
    assert.deepEqual(models, []);
  });

  it("throws with the HTTP status on a non-OK response", async () => {
    mockFetch({ status: 500, body: { error: "upstream" } });
    await assert.rejects(
      () => fetchModels(DEFAULT_BASE_URL),
      /commandcode returned 500/,
    );
  });

  it("sends Authorization header when an API key is provided", async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = ((_url: any, init: any) => {
      capturedHeaders = new Headers(init?.headers);
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }) as typeof fetch;
    await fetchModels(DEFAULT_BASE_URL, "cmd_secret_123");
    assert.equal(capturedHeaders?.get("Authorization"), "Bearer cmd_secret_123");
  });

  it("strips a trailing slash from baseUrl before appending /models", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = ((input: any) => {
      capturedUrl = typeof input === "string" ? input : String(input);
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }) as typeof fetch;
    // Callers may override baseUrl with a trailing slash; it must not double up.
    await fetchModels(`${DEFAULT_BASE_URL}/`);
    assert.match(capturedUrl ?? "", /\/provider\/v1\/models$/);
    // No doubled slash in the path (ignore the `https://` scheme separator).
    const pathOnly = (capturedUrl ?? "").replace(/^https?:\/\//, "");
    assert.doesNotMatch(pathOnly, /\/\//);
  });
});
