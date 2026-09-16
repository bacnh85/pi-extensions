import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_BASE_URL,
  FAST_MODE_BETA,
  PROVIDER_ID,
  zaiAnthropicBaseUrl,
  zaiAnthropicSpeed,
  zaiAnthropicModels,
  registerZaiAnthropicProvider,
  applyFastModeHeaders,
  applyFastModeBody,
} from "../../lib/zai-anthropic.ts";
import { detectFamily } from "../../lib/model-detection.ts";

describe("zai-anthropic provider", () => {
  it("detects glm family from zai-anthropic models (hooks gate correctly)", () => {
    assert.equal(detectFamily({ provider: "zai-anthropic", id: "glm-5.3" }), "glm");
    assert.equal(detectFamily({ provider: "zai-anthropic", id: "glm-5.3-flash" }), "glm");
  });

  it("baseUrl: default, env override, trailing slash trimmed", () => {
    assert.equal(zaiAnthropicBaseUrl({}), DEFAULT_BASE_URL);
    assert.equal(
      zaiAnthropicBaseUrl({ ZAI_ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic/" }),
      "https://open.bigmodel.cn/api/anthropic",
    );
  });

  it("speed: fast default, standard via env, garbage falls back to fast", () => {
    assert.equal(zaiAnthropicSpeed({}), "fast");
    assert.equal(zaiAnthropicSpeed({ ZAI_ANTHROPIC_SPEED: "standard" }), "standard");
    assert.equal(zaiAnthropicSpeed({ ZAI_ANTHROPIC_SPEED: "whatever" }), "fast");
  });

  it("models: anthropic-messages api, forceAdaptiveThinking, zcode effort variants", () => {
    const models = zaiAnthropicModels();
    assert.equal(models.length, 3);
    const glm53 = models.find((m) => m.id === "glm-5.3")!;
    assert.equal(glm53.api, "anthropic-messages");
    assert.equal(glm53.compat?.forceAdaptiveThinking, true);
    assert.equal(glm53.thinkingLevelMap?.max, "max");
    assert.equal(glm53.thinkingLevelMap?.low, "low");
    assert.equal(glm53.thinkingLevelMap?.high, "high");
    assert.equal(glm53.thinkingLevelMap?.medium, "high");
    const flash = models.find((m) => m.id === "glm-5.3-flash")!;
    assert.deepEqual(flash.input, ["text", "image"]);
  });

  it("registration is UNCONDITIONAL — env gating hides provider from /model and /login (regression)", () => {
    const registered: Array<{ name: string; config: any }> = [];
    const pi = { registerProvider: (name: string, config: any) => registered.push({ name, config }), unregisterProvider: () => {} } as any;

    // No key in env — must STILL register; /login (auth.json) supplies the key.
    const hadKey = process.env.ZAI_ANTHROPIC_API_KEY;
    delete process.env.ZAI_ANTHROPIC_API_KEY;
    registerZaiAnthropicProvider(pi);
    if (hadKey !== undefined) process.env.ZAI_ANTHROPIC_API_KEY = hadKey;

    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, PROVIDER_ID);
    assert.equal(registered[0].config.api, "anthropic-messages");
    assert.equal(registered[0].config.apiKey, "$ZAI_ANTHROPIC_API_KEY");
  });

  it("fast-mode headers: merge into existing beta list, no-op for other providers or standard", () => {
    const headers: Record<string, string | null | undefined> = { "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" };
    applyFastModeHeaders(headers, { provider: PROVIDER_ID, speed: "fast" });
    assert.equal(headers["anthropic-beta"], `fine-grained-tool-streaming-2025-05-14,${FAST_MODE_BETA}`);

    const fresh: Record<string, string | null | undefined> = {};
    applyFastModeHeaders(fresh, { provider: "openai", speed: "fast" });
    assert.equal(fresh["anthropic-beta"], undefined);
    applyFastModeHeaders(fresh, { provider: PROVIDER_ID, speed: "standard" });
    assert.equal(fresh["anthropic-beta"], undefined);

    const empty: Record<string, string | null | undefined> = {};
    applyFastModeHeaders(empty, { provider: PROVIDER_ID, speed: "fast" });
    assert.equal(empty["anthropic-beta"], FAST_MODE_BETA);

    // provider-id casing is normalized (reviewer finding: exact match silently skipped)
    const cased: Record<string, string | null | undefined> = {};
    applyFastModeHeaders(cased, { provider: "ZAI-Anthropic", speed: "fast" });
    assert.equal(cased["anthropic-beta"], FAST_MODE_BETA);
  });

  it("fast-mode body: adds top-level speed field, no-op for other providers or standard", () => {
    const payload = { model: "glm-5.3", messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } };
    const out = applyFastModeBody(payload, { provider: PROVIDER_ID, speed: "fast" }) as any;
    assert.equal(out.speed, "fast");
    assert.equal(out.model, "glm-5.3");
    assert.deepEqual(payload, { model: "glm-5.3", messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } }); // original untouched

    assert.equal(applyFastModeBody(payload, { provider: "router", speed: "fast" }), payload);
    assert.equal(applyFastModeBody(payload, { provider: PROVIDER_ID, speed: "standard" }), payload);

    // casing normalized
    const cased = applyFastModeBody(payload, { provider: "ZAI-ANTHROPIC", speed: "fast" }) as any;
    assert.equal(cased.speed, "fast");

    // shallow-copy contract: nested objects are shared with the original
    const nested = { messages: [{ role: "user" }] };
    const outNested = applyFastModeBody(nested, { provider: PROVIDER_ID, speed: "fast" }) as any;
    assert.equal(outNested.speed, "fast");
    assert.equal(outNested.messages, nested.messages); // same reference — documented contract
  });
});
