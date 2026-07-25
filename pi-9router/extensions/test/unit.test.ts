import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Config module tests ──────────────────────────────────────────────────────

describe("config", () => {
  const CONFIG_PATH = join(homedir(), ".pi", "agent", "9router-config.json");
  const BACKUP_PATH = CONFIG_PATH + ".bak";

  // Save existing config before tests, restore after
  before(() => {
    if (existsSync(CONFIG_PATH)) {
      writeFileSync(BACKUP_PATH, readFileSync(CONFIG_PATH));
    }
  });

  after(() => {
    try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
    if (existsSync(BACKUP_PATH)) {
      writeFileSync(CONFIG_PATH, readFileSync(BACKUP_PATH));
      try { unlinkSync(BACKUP_PATH); } catch { /* ignore */ }
    }
  });

  it("loadConfig returns null when no file exists", async () => {
    try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
    const { loadConfig } = await import("../lib/config.js");
    assert.equal(loadConfig(), null);
  });

  it("saveConfig + loadConfig round-trips correctly", async () => {
    try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
    const { saveConfig, loadConfig, normalizeUrl } = await import("../lib/config.js");

    const config = { baseUrl: "http://localhost:20128/v1", apiKey: "sk-test-key", enableReasoning: false };
    saveConfig(config);

    const loaded = loadConfig();
    assert.notEqual(loaded, null);
    assert.equal(loaded!.baseUrl, normalizeUrl(config.baseUrl));
    assert.equal(loaded!.apiKey, config.apiKey);
    assert.equal(loaded!.enableReasoning, false);
  });

  it("saveConfig stores config without API key when undefined", async () => {
    try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
    const { saveConfig, loadConfig } = await import("../lib/config.js");

    saveConfig({ baseUrl: "http://localhost:20128/v1", apiKey: undefined, enableReasoning: false });
    const loaded = loadConfig();
    assert.notEqual(loaded, null);
    assert.equal(loaded!.apiKey, undefined);
  });

  it("normalizeUrl strips trailing slashes", async () => {
    const { normalizeUrl } = await import("../lib/config.js");
    assert.equal(normalizeUrl("http://localhost:20128/v1/"), "http://localhost:20128/v1");
    assert.equal(normalizeUrl("http://localhost:20128/v1"), "http://localhost:20128/v1");
    assert.equal(normalizeUrl("http://localhost:20128"), "http://localhost:20128");
  });

  it("maskApiKey masks middle characters", async () => {
    const { maskApiKey } = await import("../lib/config.js");
    const key = "sk-12345678";
    assert.equal(maskApiKey(key), key.slice(0, 4) + "●".repeat(key.length - 8) + key.slice(-4));
    assert.equal(maskApiKey(undefined), "(not set)");
    // Short keys (≤8 chars) are returned as-is
    assert.equal(maskApiKey("short"), "short");
    assert.equal(maskApiKey(undefined), "(not set)");
    assert.equal(maskApiKey("short"), "short");
  });

  it("getEffectiveConfig returns saved config when no env vars set", async () => {
    // Set NO env vars — rely on saved config
    try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
    const { saveConfig, getEffectiveConfig } = await import("../lib/config.js");
    saveConfig({ baseUrl: "http://saved:8080/v1", apiKey: "saved-key", enableReasoning: false });
    const cfg = getEffectiveConfig();
    assert.ok(cfg.baseUrl.includes("saved:8080"));
    assert.equal(cfg.apiKey, "saved-key");
  });
});

// ── Client module tests ──────────────────────────────────────────────────────

describe("client", () => {
  it("mapModel produces correct Pi model shape", async () => {
    const { mapModel } = await import("../lib/client.js");

    // Model with no capabilities — uses fallback defaults
    const raw = { id: "cc/claude-sonnet-4", object: "model", owned_by: "claude" };
    const result = mapModel(raw, false);

    assert.equal(result.id, "cc/claude-sonnet-4");
    assert.equal(result.name, "cc/claude-sonnet-4");
    assert.equal(result.reasoning, false);
    assert.equal(result.thinkingLevelMap, undefined);
    assert.equal(result.compat?.supportsReasoningEffort, false);
    assert.equal(result.contextWindow, 128_000);
    assert.equal(result.maxTokens, 4_096);
    assert.deepEqual(result.input, ["text"]);
    assert.deepEqual(result.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("mapModel extracts capabilities from 9router response", async () => {
    const { mapModel } = await import("../lib/client.js");

    const raw = {
      id: "glm/glm-5.2",
      object: "model",
      owned_by: "glm",
      capabilities: { vision: false, contextWindow: 200_000, maxOutput: 128_000 },
    };
    const result = mapModel(raw, false);

    assert.equal(result.contextWindow, 200_000);
    assert.equal(result.maxTokens, 128_000);
    assert.deepEqual(result.input, ["text"]);
  });

  it("mapModel sets image input for vision-capable models", async () => {
    const { mapModel } = await import("../lib/client.js");

    const raw = {
      id: "ocg/kimi-k2.7-code",
      object: "model",
      owned_by: "ocg",
      capabilities: { vision: true, contextWindow: 262_144, maxOutput: 65536 },
    };
    const result = mapModel(raw, false);

    assert.equal(result.contextWindow, 262_144);
    assert.equal(result.maxTokens, 65536);
    assert.deepEqual(result.input, ["text", "image"]);
  });

  it("mapModel prefixes combo models with emoji", async () => {
    const { mapModel } = await import("../lib/client.js");
    const raw = { id: "my-combo", object: "model", owned_by: "combo" };
    const result = mapModel(raw, false);
    assert.equal(result.name, "🔀 my-combo");
  });

  it("mapModel sets reasoning=true + OpenAI-format thinkingLevelMap + compat when enableReasoning=true", async () => {
    const { mapModel } = await import("../lib/client.js");

    // GPT model → openai format: none, minimal, low, medium, high, xhigh (no max)
    const raw = { id: "cx/gpt-5.6-terra", object: "model", owned_by: "openai" };
    const result = mapModel(raw, true);

    assert.equal(result.reasoning, true);
    assert.notEqual(result.thinkingLevelMap, undefined);
    assert.equal(result.thinkingLevelMap!.off, "none");
    assert.equal(result.thinkingLevelMap!.minimal, "minimal");
    assert.equal(result.thinkingLevelMap!.low, "low");
    assert.equal(result.thinkingLevelMap!.medium, "medium");
    assert.equal(result.thinkingLevelMap!.high, "high");
    assert.equal(result.thinkingLevelMap!.xhigh, "xhigh");
    assert.equal(result.thinkingLevelMap!.max, "xhigh"); // openai has no max

    assert.notEqual(result.compat, undefined);
    assert.equal(result.compat!.supportsReasoningEffort, true);
    assert.equal(result.compat!.thinkingFormat, "openai");
    assert.equal(result.compat!.maxTokensField, "max_tokens");
    assert.equal(result.compat!.supportsStore, false);
    assert.equal(result.compat!.supportsDeveloperRole, false);
  });

  it("mapModel sets deepseek-format thinkingLevelMap — only off, high, max", async () => {
    const { mapModel } = await import("../lib/client.js");

    const raw = { id: "ocg/deepseek-v4-flash", object: "model", owned_by: "deepseek" };
    const result = mapModel(raw, true);

    // hiMax: none, high, max
    assert.equal(result.thinkingLevelMap!.off, "none");
    assert.equal(result.thinkingLevelMap!.minimal, null);
    assert.equal(result.thinkingLevelMap!.low, null);
    assert.equal(result.thinkingLevelMap!.medium, null);
    assert.equal(result.thinkingLevelMap!.high, "high");
    assert.equal(result.thinkingLevelMap!.xhigh, null); // not shown for deepseek
    assert.equal(result.thinkingLevelMap!.max, "max");
  });

  it("mapModel exposes usable thinking levels for GLM (zai) models when enableReasoning=true", async () => {
    const { mapModel } = await import("../lib/client.js");

    const result = mapModel({ id: "glm/glm-5.2", object: "model", owned_by: "glm" }, true);

    // Mirrors native zai-coding-cn/glm-5.2: off, low, medium, high, max selectable (no xhigh)
    assert.equal(result.reasoning, true);
    assert.equal(result.thinkingLevelMap!.off, "none");
    assert.equal(result.thinkingLevelMap!.low, "high");     // GLM: low→high (was null — the bug)
    assert.equal(result.thinkingLevelMap!.medium, "high");   // medium→high (was null)
    assert.equal(result.thinkingLevelMap!.high, "high");     // (was null)
    assert.equal(result.thinkingLevelMap!.max, "max");        // GLM max tier
    assert.equal(result.thinkingLevelMap!.xhigh, null);       // not a GLM level — hidden
    assert.equal(result.thinkingLevelMap!.minimal, null);     // hidden
  });

  it("mapModel sets reasoning=false + no thinkingLevelMap + supportsReasoningEffort=false when enableReasoning=false", async () => {
    const { mapModel } = await import("../lib/client.js");
    const raw = { id: "cx/gpt-5.3-codex", object: "model", owned_by: "codex" };
    const result = mapModel(raw, false);

    assert.equal(result.reasoning, false);
    assert.equal(result.thinkingLevelMap, undefined);
    assert.notEqual(result.compat, undefined);
    assert.equal(result.compat!.supportsReasoningEffort, false);
  });
});

// ── Provider module tests ────────────────────────────────────────────────────

describe("provider", () => {
  it("registerProvider and unregisterProvider exist and are functions", async () => {
    const { registerProvider, unregisterProvider } = await import("../lib/provider.js");
    assert.equal(typeof registerProvider, "function");
    assert.equal(typeof unregisterProvider, "function");
  });
});
