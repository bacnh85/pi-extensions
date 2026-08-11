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
    // API field wins when present (forward-compat).
    const vision = mapModel({ id: "moonshotai/Kimi-K3", capabilities: { vision: true } });
    assert.deepEqual(vision.input, ["text", "image"]);

    const noVision = mapModel({ id: "moonshotai/Kimi-K3", capabilities: { vision: false } });
    assert.deepEqual(noVision.input, ["text"]);
  });

  it("resolves vision from the override table when the API sends no capabilities", () => {
    // Kimi-K3 is vision-capable per the docs registry → image input even though
    // the Provider API sends no capabilities field.
    const k3 = mapModel({ id: "moonshotai/Kimi-K3" });
    assert.deepEqual(k3.input, ["text", "image"]);

    // DeepSeek V4 Flash is text-only per the docs registry.
    const ds = mapModel({ id: "deepseek/deepseek-v4-flash" });
    assert.deepEqual(ds.input, ["text"]);

    // Unknown model: safe text-only default.
    assert.deepEqual(mapModel({ id: "unknown/future-model" }).input, ["text"]);
  });

  it("resolves reasoning per-model from the override table", () => {
    // GLM-5 has no extended thinking.
    assert.equal(mapModel({ id: "zai-org/GLM-5" }).reasoning, false);
    // ...and is also text-only — locks in the vision=false + reasoning=false combo
    // so a table-value edit regression is caught on both fields.
    assert.deepEqual(mapModel({ id: "zai-org/GLM-5" }).input, ["text"]);
    // DeepSeek V4 Flash supports reasoning.
    assert.equal(mapModel({ id: "deepseek/deepseek-v4-flash" }).reasoning, true);
    // Dated API id normalizes to the registry key (claude-haiku-4-5).
    assert.equal(mapModel({ id: "claude-haiku-4-5-20251001" }).reasoning, false);
    assert.deepEqual(mapModel({ id: "claude-haiku-4-5-20251001" }).input, ["text", "image"]);
    // Unknown model: preserves prior reasoning-on default.
    assert.equal(mapModel({ id: "unknown/future-model" }).reasoning, true);
    // Forward-compat: an explicit API capabilities.reasoning wins over the table.
    assert.equal(mapModel({ id: "zai-org/GLM-5", capabilities: { reasoning: true } }).reasoning, true);
  });

  it("uses the API display name when present, falling back to the id", () => {
    assert.equal(
      mapModel({ id: "zai-org/glm-5.2", name: "GLM-5.2" }).name,
      "GLM-5.2",
    );
    assert.equal(mapModel({ id: "zai-org/glm-5.2" }).name, "zai-org/glm-5.2");
  });

  it("attaches a per-family thinkingLevelMap to reasoning models", () => {
    // DeepSeek V4: high + max only (low/medium normalize to high upstream,
    // xhigh maps to max per Command Code docs). off stays available.
    const ds = mapModel({ id: "deepseek/deepseek-v4-flash" });
    assert.deepEqual(ds.thinkingLevelMap, {
      off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max",
    });
    assert.deepEqual(mapModel({ id: "deepseek/deepseek-v4-pro" }).thinkingLevelMap, ds.thinkingLevelMap);

    // GLM-5.2: single thinking tier — low/medium/high all map to "high", max to "max".
    assert.deepEqual(mapModel({ id: "zai-org/glm-5.2" }).thinkingLevelMap, {
      off: "none", minimal: null, low: "high", medium: "high", high: "high", xhigh: null, max: "max",
    });

    // Kimi K3: native levels low/high/max (pi-core moonshotai catalog); no off/medium/xhigh.
    assert.deepEqual(mapModel({ id: "moonshotai/kimi-k3" }).thinkingLevelMap, {
      off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max",
    });

    // GPT-5.6-sol accepts a native max effort (pi-9router "openai-max").
    assert.deepEqual(mapModel({ id: "gpt-5.6-sol" }).thinkingLevelMap, {
      off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
    });

    // Qwen: low/medium/high only (xhigh/max unsupported).
    assert.deepEqual(mapModel({ id: "qwen/qwen3.7-max" }).thinkingLevelMap, {
      off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null,
    });

    // Unknown reasoning model: full OpenAI-style set (prior behavior preserved).
    assert.deepEqual(mapModel({ id: "unknown/future-model" }).thinkingLevelMap, {
      off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh",
    });
  });

  it("omits thinkingLevelMap for non-reasoning models", () => {
    // GLM-5 has no extended thinking → no map (Pi shows only "off").
    assert.equal(mapModel({ id: "zai-org/GLM-5" }).thinkingLevelMap, undefined);
    // Kimi K2.5/K2.6 are reasoning:false per the caps table (docs registry).
    assert.equal(mapModel({ id: "moonshotai/kimi-k2.5" }).thinkingLevelMap, undefined);
    assert.equal(mapModel({ id: "moonshotai/kimi-k2.6" }).thinkingLevelMap, undefined);
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
