import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Isolation ────────────────────────────────────────────────────────────────
// Point PI_CODING_AGENT_DIR at a temp dir so tests never touch the user's live
// ~/.pi/agent (settings.json / auth.json / 9router-config.json).
const TMP_HOME = join(tmpdir(), "pi-router-test-" + process.pid);
before(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = TMP_HOME;
});
after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── config ───────────────────────────────────────────────────────────────────

describe("config", () => {
  const settingsPath = () => join(TMP_HOME, "settings.json");

  function writeSettings(router: unknown): void {
    writeFileSync(settingsPath(), JSON.stringify({ other: true, router }), null as never);
  }

  it("getSettings reads router.baseUrl from global settings.json", async () => {
    try { unlinkSync(settingsPath()); } catch { /* ignore */ }
    writeSettings({ baseUrl: "http://localhost:20128/v1/" });
    const { getSettings } = await import("../lib/config.js");
    const s = getSettings();
    assert.equal(s.baseUrl, "http://localhost:20128/v1"); // normalized
    assert.equal(s.enableReasoning, true); // default
  });

  it("enableReasoning: false is respected from settings", async () => {
    writeSettings({ baseUrl: "http://x", enableReasoning: false });
    const { getSettings } = await import("../lib/config.js");
    assert.equal(getSettings().enableReasoning, false);
  });

  it("env ROUTER_BASE_URL overrides settings.json", async () => {
    writeSettings({ baseUrl: "http://from-settings" });
    process.env.ROUTER_BASE_URL = "http://from-env/";
    try {
      const { getSettings } = await import("../lib/config.js");
      assert.equal(getSettings().baseUrl, "http://from-env");
    } finally {
      delete process.env.ROUTER_BASE_URL;
    }
  });

  it("legacy NINE_ROUTER_BASE_URL still works", async () => {
    try { unlinkSync(settingsPath()); } catch { /* ignore */ }
    process.env.NINE_ROUTER_BASE_URL = "http://legacy-env";
    try {
      const { getSettings } = await import("../lib/config.js");
      assert.equal(getSettings().baseUrl, "http://legacy-env");
    } finally {
      delete process.env.NINE_ROUTER_BASE_URL;
    }
  });

  it("readStoredApiKey reads router credential from auth.json", async () => {
    writeFileSync(join(TMP_HOME, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "sk-other" }, router: { type: "api_key", key: "sk-mine" } }));
    const { readStoredApiKey } = await import("../lib/config.js");
    assert.equal(readStoredApiKey(), "sk-mine");
  });

  it("maskApiKey masks middle characters", async () => {
    const { maskApiKey } = await import("../lib/config.js");
    const key = "sk-12345678";
    assert.equal(maskApiKey(key), key.slice(0, 4) + "●".repeat(key.length - 8) + key.slice(-4));
    assert.equal(maskApiKey(undefined), "(not set)");
    assert.equal(maskApiKey("short"), "short");
  });
});

// ── migration ────────────────────────────────────────────────────────────────

describe("migration", () => {
  it("migrates 9router-config.json → settings.json + auth.json, renames legacy file", async () => {
    const legacy = join(TMP_HOME, "9router-config.json");
    const settingsPath = join(TMP_HOME, "settings.json");
    const authPath = join(TMP_HOME, "auth.json");
    for (const p of [legacy, settingsPath, authPath, legacy + ".migrated"]) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark" })); // existing unrelated settings
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "sk-x" } }));
    writeFileSync(legacy, JSON.stringify({
      baseUrl: "http://localhost:20128/v1",
      apiKey: "sk-legacy",
      enableReasoning: false,
      configVersion: 1,
    }));

    const { migrateLegacyConfig } = await import("../lib/migrate.js");
    assert.equal(migrateLegacyConfig(), true);

    // settings.json: router section merged, unrelated keys preserved
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.router.baseUrl, "http://localhost:20128/v1");
    assert.equal(settings.router.enableReasoning, false);

    // auth.json: router credential added, openai preserved
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    assert.equal(auth.openai.key, "sk-x");
    assert.equal(auth.router.type, "api_key");
    assert.equal(auth.router.key, "sk-legacy");

    // legacy file renamed, not deleted
    assert.ok(!existsSync(legacy));
    assert.ok(existsSync(legacy + ".migrated"));

    // Idempotent: second run does nothing
    assert.equal(migrateLegacyConfig(), false);
  });

  it("never overwrites existing router settings/auth entries", async () => {
    const legacy = join(TMP_HOME, "9router-config.json");
    const settingsPath = join(TMP_HOME, "settings.json");
    const authPath = join(TMP_HOME, "auth.json");
    for (const p of [legacy, legacy + ".migrated"]) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
    writeFileSync(settingsPath, JSON.stringify({ router: { baseUrl: "http://existing" } }));
    writeFileSync(authPath, JSON.stringify({ router: { type: "api_key", key: "sk-existing" } }));
    writeFileSync(legacy, JSON.stringify({ baseUrl: "http://old", apiKey: "sk-old" }));

    const { migrateLegacyConfig } = await import("../lib/migrate.js");
    migrateLegacyConfig();

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(settings.router.baseUrl, "http://existing");
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    assert.equal(auth.router.key, "sk-existing");
  });

  it("consumes unreadable legacy config without writing anything", async () => {
    const legacy = join(TMP_HOME, "9router-config.json");
    const settingsPath = join(TMP_HOME, "settings.json");
    for (const p of [legacy, legacy + ".migrated", settingsPath]) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
    writeFileSync(legacy, "{not json");

    const { migrateLegacyConfig } = await import("../lib/migrate.js");
    assert.equal(migrateLegacyConfig(), false);
    assert.ok(!existsSync(settingsPath)); // nothing written
    assert.ok(existsSync(legacy + ".migrated"));
  });

  it("never wipes an unparseable settings.json during migration", async () => {
    const legacy = join(TMP_HOME, "9router-config.json");
    const settingsPath = join(TMP_HOME, "settings.json");
    for (const p of [legacy, legacy + ".migrated"]) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
    writeFileSync(settingsPath, "{corrupt settings");
    writeFileSync(legacy, JSON.stringify({ baseUrl: "http://x", apiKey: "sk-k" }));

    const { migrateLegacyConfig } = await import("../lib/migrate.js");
    assert.equal(migrateLegacyConfig(), false); // bails — leaves legacy for retry
    assert.equal(readFileSync(settingsPath, "utf8"), "{corrupt settings"); // untouched
    assert.ok(existsSync(legacy)); // legacy file NOT consumed — retried next load
  });

  it("never wipes an unparseable auth.json during migration", async () => {
    const legacy = join(TMP_HOME, "9router-config.json");
    const authPath = join(TMP_HOME, "auth.json");
    const settingsPath = join(TMP_HOME, "settings.json");
    for (const p of [legacy, legacy + ".migrated", settingsPath, authPath]) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
    writeFileSync(authPath, "{corrupt auth");
    writeFileSync(legacy, JSON.stringify({ baseUrl: "http://x", apiKey: "sk-k" }));

    const { migrateLegacyConfig } = await import("../lib/migrate.js");
    migrateLegacyConfig();
    assert.equal(readFileSync(authPath, "utf8"), "{corrupt auth"); // untouched
    // settings migration still completed and legacy was consumed
    assert.ok(existsSync(legacy + ".migrated"));
  });
});

// ── client (mapModel + applyReasoning) ───────────────────────────────────────

describe("client", () => {
  it("mapModel maps capabilities and honors context overrides", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel({ id: "zai-coding/glm-5.2", capabilities: { contextWindow: 128000, maxOutput: 8192, vision: true } }, true);
    assert.equal(m.id, "zai-coding/glm-5.2");
    assert.equal(m.contextWindow, 1_000_000); // GLM-5.2 override
    assert.equal(m.maxTokens, 131_072);
    assert.deepEqual(m.input, ["text", "image"]);
    assert.equal(m.reasoning, true);
    assert.ok(m.thinkingLevelMap); // zai map
  });

  it("mapModel without reasoning flag has no thinkingLevelMap", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel({ id: "gpt-5.2" }, false);
    assert.equal(m.reasoning, false);
    assert.equal(m.thinkingLevelMap, undefined);
    assert.equal(m.compat?.supportsReasoningEffort, false);
  });

  it("mapModel vision: probe-verified routes gain image input, verified strips lose it", async () => {
    const { mapModel } = await import("../lib/client.js");
    // VISION_OVERRIDES: probe-verified PASS route, no router vision flag
    const gemini = mapModel({ id: "cmd/google/gemini-3.7-flash" }, true);
    assert.deepEqual(gemini.input, ["text", "image"]);
    // effort-tier variants of a probed base are covered by the suffix group
    const geminiHigh = mapModel({ id: "cmd/google/gemini-3.7-flash-high" }, true);
    assert.deepEqual(geminiHigh.input, ["text", "image"]);
    // unprobed sibling variants stay text-only (anchored patterns)
    const geminiPreview = mapModel({ id: "cmd/google/gemini-3.7-flash-preview" }, true);
    assert.deepEqual(geminiPreview.input, ["text"]);
    // VISION_DOWNGRADES: router claims vision:true but probe verified STRIP
    const or = mapModel({ id: "openrouter/z-ai/glm-5.3-flash", capabilities: { vision: true } }, true);
    assert.deepEqual(or.input, ["text"]);
    // unverified route without flag stays text-only (no blanket enable)
    const glm = mapModel({ id: "glm-cn/glm-5.3-flash" }, true);
    assert.deepEqual(glm.input, ["text"]);
  });

  it("applyReasoning toggles the flag on an already-mapped model", async () => {
    const { mapModel, applyReasoning } = await import("../lib/client.js");
    const on = mapModel({ id: "deepseek-v4" }, true);
    assert.equal(on.thinkingLevelMap?.high, "high");
    const off = applyReasoning(on, false);
    assert.equal(off.reasoning, false);
    assert.equal(off.compat?.supportsReasoningEffort, false);
    const back = applyReasoning(off, true);
    assert.equal(back.reasoning, true);
    assert.ok(back.thinkingLevelMap);
  });

  it("combo models get the 🔀 name prefix", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel({ id: "x", owned_by: "combo" }, false);
    assert.equal(m.name, "🔀 x");
  });

  it("fetchModels never doubles the /v1 segment", async () => {
    const { fetchModels } = await import("../lib/client.js");
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await fetchModels({ baseUrl: "http://h:20128/v1", enableReasoning: true });
      await fetchModels({ baseUrl: "http://h:20128/v1/", enableReasoning: true });
      await fetchModels({ baseUrl: "http://h:20128", enableReasoning: true });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(urls, [
      "http://h:20128/v1/models",
      "http://h:20128/v1/models",
      "http://h:20128/v1/models",
    ]);
  });

  it("fetchModels sends NINE_ROUTER_API_KEY as Bearer fallback", async () => {
    const { fetchModels } = await import("../lib/client.js");
    let auth: string | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
    }) as typeof fetch;
    process.env.NINE_ROUTER_API_KEY = "sk-legacy-env";
    try {
      await fetchModels({ baseUrl: "http://h/v1", enableReasoning: true });
      assert.equal(auth, "Bearer sk-legacy-env");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.NINE_ROUTER_API_KEY;
    }
  });

  it("claude 3-5/3-7 use budget thinking; 4-6/4.6/5/sonnet-5 use adaptive", async () => {
    const { mapModel } = await import("../lib/client.js");
    const xhigh = (id: string) => (mapModel({ id }, true).thinkingLevelMap ?? {}).xhigh;
    assert.equal(xhigh("claude-3-5-sonnet"), "xhigh"); // budget: xhigh native
    assert.equal(xhigh("claude-3-7-opus"), "xhigh");   // budget
    assert.equal(xhigh("claude-sonnet-5"), "max");    // adaptive: xhigh → max
    assert.equal(xhigh("claude-4-6-opus"), "max");    // adaptive (dash form → 4.6)
    assert.equal(xhigh("claude-opus-4.6"), "max");    // adaptive (dot form)
    assert.equal(xhigh("claude-haiku-4.5"), "xhigh"); // 4.5 < 4.6 — budget boundary
    assert.equal(xhigh("claude-3-5-haiku-20241022"), "xhigh"); // dated id, still 3.5 budget
  });

  it("mapModel reads top-level context_length / max_output_tokens (omniroute shape)", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel(
      { id: "cmd/meta/muse-spark-1.2-contributor", context_length: 1048576, max_output_tokens: 131072, capabilities: { vision: true } } as never,
      false,
    );
    assert.equal(m.contextWindow, 1048576);
    assert.equal(m.maxTokens, 131072);
  });

  it("top-level context_length is authoritative over the override table (no inflation)", async () => {
    const { mapModel } = await import("../lib/client.js");
    // zai-coding/glm-5.2 has a 1M override — a stale 1M must not inflate a
    // router that truthfully reports a smaller window at the top level.
    const m = mapModel({ id: "zai-coding/glm-5.2", context_length: 256000, capabilities: {} } as never, false);
    assert.equal(m.contextWindow, 256000);
  });

  it("one top-level field gates the override for the OTHER field (no mixed provenance)", async () => {
    const { mapModel } = await import("../lib/client.js");
    // Direction A: context_length present, max_output_tokens absent — the stale
    // 131072 override must NOT apply over the router's truthful capabilities.maxOutput.
    const a = mapModel({ id: "zai-coding/glm-5.2", context_length: 256000, capabilities: { maxOutput: 32768 } } as never, false);
    assert.equal(a.contextWindow, 256000);
    assert.equal(a.maxTokens, 32768, "override maxTokens bypassed when any top-level field is present");
    // Direction B: max_output_tokens present, context_length absent — stale 1M
    // override must NOT override a truthful capabilities.contextWindow.
    const b = mapModel({ id: "zai-coding/glm-5.2", max_output_tokens: 65536, capabilities: { contextWindow: 262144 } } as never, false);
    assert.equal(b.contextWindow, 262144, "override contextWindow bypassed when any top-level field is present");
    assert.equal(b.maxTokens, 65536);
  });

  it("numeric-string top-level fields are parsed (heterogeneous gateways)", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel({ id: "cmd/meta/muse-spark-1.2-contributor", context_length: "1048576", max_output_tokens: "131072" } as never, false);
    assert.equal(m.contextWindow, 1048576);
    assert.equal(m.maxTokens, 131072);
  });

  it("present-but-invalid top-level values still suppress the override (no resurrection)", async () => {
    const { mapModel } = await import("../lib/client.js");
    // context_length present with 0 → override must NOT apply; value falls to caps.
    const zero = mapModel({ id: "zai-coding/glm-5.2", context_length: 0, capabilities: { contextWindow: 262144, maxOutput: 32768 } } as never, false);
    assert.equal(zero.contextWindow, 262144, "0 context_length suppresses the 1M override");
    assert.equal(zero.maxTokens, 32768);
    // "unknown" string present → override suppressed, falls through to caps.
    const unk = mapModel({ id: "zai-coding/glm-5.2", context_length: "unknown", capabilities: { contextWindow: 262144 } } as never, false);
    assert.equal(unk.contextWindow, 262144);
  });

  it("explicit null top-level fields count as absent (override still applies for 9router)", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel({ id: "zai-coding/glm-5.2", context_length: null, max_output_tokens: null, capabilities: { contextWindow: 128000, maxOutput: 8192 } } as never, false);
    assert.equal(m.contextWindow, 1_000_000, "null top-level = absent → GLM-5.2 override applies");
    assert.equal(m.maxTokens, 131_072);
  });

  it("9router capabilities.contextWindow still honored when no top-level field", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel({ id: "generic/model-a", capabilities: { contextWindow: 200000, maxOutput: 16384 } } as never, false);
    assert.equal(m.contextWindow, 200000);
    assert.equal(m.maxTokens, 16384);
  });

  // ── floor-aware override (DEFAULT_CAPABILITIES de-poisoning) ───────────────
  // Omniroute (9router fork) intermittently emits top-level `context_length: 200000,
  // max_output_tokens: 128000` — its DEFAULT_CAPABILITIES floor — for unprofiled
  // models like GLM-5.3. pi-router 1.1.1's single-tier provenance trusted that pair
  // as router truth, bypassing the verified override. The fix de-poisons the
  // floor pair only when an override exceeds the floor; above-floor values are
  // still router-trusted (no inflation of e.g. openrouter/z-ai/glm-5.2:free = 256K).

  it("floor pair on a matched-override model lets the override win (the user's exact case)", async () => {
    const { mapModel } = await import("../lib/client.js");
    // Live omniroute response shape for glm-cn/glm-5.3 when its capabilities cache is warm.
    const m = mapModel({ id: "glm-cn/glm-5.3", context_length: 200000, max_output_tokens: 128000 } as never, false);
    assert.equal(m.contextWindow, 1_000_000);
    assert.equal(m.maxTokens, 131_072);
  });

  it("floor value without an override entry stays verbatim (genuine 200K models unaffected)", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel({ id: "some/200k-model", context_length: 200000, max_output_tokens: 128000 } as never, false);
    assert.equal(m.contextWindow, 200000, "no override match → router value kept");
    assert.equal(m.maxTokens, 128000);
  });

  it("above-floor truthful values stay verbatim (no inflation of e.g. glm-5.2:free)", async () => {
    const { mapModel } = await import("../lib/client.js");
    // openrouter/z-ai/glm-5.2:free truthfully reports 256000 — above floor, override suppressed.
    const m = mapModel({ id: "openrouter/z-ai/glm-5.2:free", context_length: 256000, max_output_tokens: 230400 } as never, false);
    assert.equal(m.contextWindow, 256000);
    assert.equal(m.maxTokens, 230400);
  });

  it("deepseek-v4 floor pair: override has no maxTokens so pair rule doesn't fire → router values kept", async () => {
    const { mapModel } = await import("../lib/client.js");
    // deepseek-v[34] override has only contextWindow (no maxTokens). When omniroute
    // stamps the floor pair (200000/128000), maxFloorPoisoned is false (override.max
    // undefined), so the strict pair rule doesn't fire and the override is bypassed
    // (1.1.1 single-tier back-compat). Both fields stay router. The override's value
    // for ctx is correct (1M) but cannot apply until either (a) the override entry
    // gains maxTokens so the pair rule matches, or (b) omniroute drops the top-level
    // fields entirely (next test) — then override fires.
    const m = mapModel({ id: "opencode-go/deepseek-v4-flash", context_length: 200000, max_output_tokens: 128000 } as never, false);
    assert.equal(m.contextWindow, 200_000, "override bypassed (pair rule needs both fields poisoned)");
    assert.equal(m.maxTokens, 128_000);
  });

  it("deepseek-v4 metadata-less path (no top-level) → override 1M/384K", async () => {
    const { mapModel } = await import("../lib/client.js");
    // When omniroute omits top-level fields entirely for opencode-go/deepseek-v4-flash,
    // both fields are absent → useOverride=true → override fires for ctx only
    // (no maxTokens in entry → falls to caps.maxOutput=undefined → FALLBACK 4096).
    // The 1M context correction is the critical fix; the 4096 max is the pre-existing
    // behavior (override entry has always omitted maxTokens — a separate gap if the
    // user wants 384K output, add maxTokens to the override entry).
    const m = mapModel({ id: "opencode-go/deepseek-v4-flash" } as never, false);
    assert.equal(m.contextWindow, 1_000_000);
    assert.equal(m.maxTokens, 4_096, "FALLBACK (override has no maxTokens entry — pre-existing)");
  });

  it("above-floor glm-5.1 value is not overridden (200000 is the override's own value too)", async () => {
    const { mapModel } = await import("../lib/client.js");
    // 204800 from router (matches Z.ai official) — above the floor, override suppressed.
    const m = mapModel({ id: "glm-cn/glm-5.1", context_length: 204800, max_output_tokens: 131072 } as never, false);
    assert.equal(m.contextWindow, 204800);
    assert.equal(m.maxTokens, 131072);
  });

  it("floor poison on glm-5.1 (router stale 200000) → override 200000/131072 still applied", async () => {
    const { mapModel } = await import("../lib/client.js");
    // When router reports the 9router floor (200000/128000) for glm-5.1, override fires.
    // Both fields equal the floor so both are corrected; values match the override entry.
    const m = mapModel({ id: "glm-cn/glm-5.1", context_length: 200000, max_output_tokens: 128000 } as never, false);
    assert.equal(m.contextWindow, 200_000);
    assert.equal(m.maxTokens, 131_072);
  });

  it("kimi-k3 floor poison → override 1M/131072 (no blanket-override inflation of kimi-k2.7)", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel({ id: "opencode-go/kimi-k3", context_length: 200000, max_output_tokens: 128000 } as never, false);
    assert.equal(m.contextWindow, 1_048_576);
    assert.equal(m.maxTokens, 131_072);
  });

  it("kimi-k2.7-code above floor stays verbatim (specific kimi-k3 pattern does not match)", async () => {
    const { mapModel } = await import("../lib/client.js");
    // Real kimi-k2.7-code context = 262144 (above floor) — the kimi-k3 pattern must not match.
    const m = mapModel({ id: "opencode-go/kimi-k2.7-code", context_length: 262144, max_output_tokens: 262144 } as never, false);
    assert.equal(m.contextWindow, 262144);
    assert.equal(m.maxTokens, 262144);
  });

  it("glm-4.6 floor poison → override 200K/131072", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel({ id: "glm-cn/glm-4.6", context_length: 200000, max_output_tokens: 128000 } as never, false);
    assert.equal(m.contextWindow, 200_000);
    assert.equal(m.maxTokens, 131_072);
  });

  it("no top-level + no caps → override applies (kimi-k3 metadata-less path)", async () => {
    const { mapModel } = await import("../lib/client.js");
    // Live omniroute shape when glm-cn/kimi-k3 has no top-level fields at all.
    const m = mapModel({ id: "opencode-go/kimi-k3" } as never, false);
    assert.equal(m.contextWindow, 1_048_576);
    assert.equal(m.maxTokens, 131_072);
  });

  it("present-but-invalid ctx (0) still suppresses the override (no resurrection)", async () => {
    const { mapModel } = await import("../lib/client.js");
    // 0 fails parsePositiveInt (n>0) → undefined → ctxFloorPoisoned false → override suppressed.
    // Falls through to caps (262144) — preserves the 1.1.1 guarantee.
    const m = mapModel({ id: "zai-coding/glm-5.2", context_length: 0, capabilities: { contextWindow: 262144, maxOutput: 32768 } } as never, false);
    assert.equal(m.contextWindow, 262144);
    assert.equal(m.maxTokens, 32768);
  });
});

// ── no-disable prefix (command-code upstream bug class) ──────────────────────

describe("client thinkingLevelMap no-disable prefix override", () => {
  it("command-code/ minimax model: off and minimal are nulled, low/medium/high/xhigh retained", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel({ id: "command-code/MiniMaxAI/MiniMax-M3" }, true);
    assert.equal(m.thinkingLevelMap?.off, null);
    assert.equal(m.thinkingLevelMap?.minimal, null);
    // Format-detection (contains "minimax") keeps the rest of the minimax map intact
    // so interactive "low"/"medium"/"high"/"xhigh" still send valid values.
    assert.equal(m.thinkingLevelMap?.low, "low");
    assert.equal(m.thinkingLevelMap?.medium, "medium");
    assert.equal(m.thinkingLevelMap?.high, "high");
    assert.equal(m.thinkingLevelMap?.xhigh, "xhigh");
  });

  it("glm-cn/ zai model: off stays \"none\" (not a command-code route — untouched)", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel({ id: "glm-cn/glm-5.3" }, true);
    // zai format: off="none" by design (GLM upstream accepts none via its executor).
    assert.equal(m.thinkingLevelMap?.off, "none");
  });

  it("cmd/ alias prefix also nulls off/minimal", async () => {
    const { mapModel } = await import("../lib/client.js");
    const m = mapModel({ id: "cmd/MiniMaxAI/MiniMax-M3" }, true);
    assert.equal(m.thinkingLevelMap?.off, null);
    assert.equal(m.thinkingLevelMap?.minimal, null);
  });

  it("applyReasoning re-derives nulls on a stored command-code model (restart path)", async () => {
    const { mapModel, applyReasoning } = await import("../lib/client.js");
    // Simulate a stored model from models-store.json that was mapped before the fix
    // (off:"none"). applyReasoning re-runs getThinkingLevelMap from the id, so after
    // the fix a Pi restart re-applies the override without a network refresh.
    const stale = mapModel({ id: "command-code/MiniMaxAI/MiniMax-M3" }, false);
    // sanity: before-fix maps would have off:"none" — but with the fix in place we
    // already null it; the meaningful assertion is that re-derivation produces the
    // same nulls as the network path.
    const remapped = applyReasoning(stale, true);
    assert.equal(remapped.thinkingLevelMap?.off, null);
    assert.equal(remapped.thinkingLevelMap?.minimal, null);
    assert.equal(remapped.thinkingLevelMap?.low, "low");
  });
});

// ── provider registration shape ──────────────────────────────────────────────

describe("provider", () => {
  it("registers with dynamic refreshModels and $ROUTER_API_KEY", async () => {
    const { registerProvider, PROVIDER_ID } = await import("../lib/provider.js");
    let registered: { name: string; config: Record<string, unknown> } | null = null;
    const fakePi = {
      registerProvider: (name: string, config: Record<string, unknown>) => { registered = { name, config }; },
    };
    registerProvider(fakePi as never, { baseUrl: "http://localhost:20128/v1", enableReasoning: true });
    assert.ok(registered);
    assert.equal((registered as never as { name: string }).name, PROVIDER_ID);
    const cfg = (registered as { config: Record<string, unknown> }).config;
    assert.equal(cfg.apiKey, "$ROUTER_API_KEY");
    assert.equal(cfg.api, "openai-completions");
    assert.equal(cfg.baseUrl, "http://localhost:20128/v1");
    assert.ok(Array.isArray(cfg.models));
    assert.equal(cfg.models!.length, 0);
    assert.equal(typeof cfg.refreshModels, "function");
  });

  it("refreshModels offline restores stored models remapped with reasoning flag", async () => {
    const { mapModel } = await import("../lib/client.js");
    const { registerProvider } = await import("../lib/provider.js");
    let refreshModels: (ctx: unknown) => Promise<unknown>;
    registerProvider({
      registerProvider: (_n: string, config: { refreshModels: (ctx: unknown) => Promise<unknown> }) => { refreshModels = config.refreshModels; },
    } as never, { baseUrl: "http://x", enableReasoning: false });

    const stored = { id: "m1", name: "m1" } as never; // shape of a mapped model
    const ctx = { stored: { models: [mapModel({ id: "m1" }, true)] }, allowNetwork: false, signal: new AbortController().signal };
    void stored;
    const result = (await refreshModels!(ctx)) as { reasoning: boolean; id: string }[];
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "m1");
    assert.equal(result[0].reasoning, false); // remapped with settings flag
  });

  it("refreshModels offline restore re-resolves vision (stale flags self-heal)", async () => {
    const { registerProvider } = await import("../lib/provider.js");
    let refreshModels: (ctx: unknown) => Promise<unknown>;
    registerProvider({
      registerProvider: (_n: string, config: { refreshModels: (ctx: unknown) => Promise<unknown> }) => { refreshModels = config.refreshModels; },
    } as never, { baseUrl: "http://x", enableReasoning: false });
    const ctx = {
      stored: {
        models: [
          { id: "cmd/google/gemini-3.7-flash", name: "g", reasoning: false, input: ["text"], cost: {}, contextWindow: 1, maxTokens: 1 },
          { id: "openrouter/z-ai/glm-5.3-flash", name: "o", reasoning: false, input: ["text", "image"], cost: {}, contextWindow: 1, maxTokens: 1 },
          // pattern-unmatched: persisted router metadata must survive the restore
          { id: "other/vision-model", name: "v", reasoning: false, input: ["text", "image"], cost: {}, contextWindow: 1, maxTokens: 1 },
          // legacy/malformed entry without input: must not throw, degrades to text-only
          { id: "legacy/entry", name: "l", reasoning: false, cost: {}, contextWindow: 1, maxTokens: 1 },
        ],
      },
      allowNetwork: false,
      signal: new AbortController().signal,
    };
    const result = (await refreshModels!(ctx)) as { id: string; input: string[] }[];
    assert.deepEqual(result[0].input, ["text", "image"]); // override upgrades stale entry
    assert.deepEqual(result[1].input, ["text"]);          // downgrade strips lying flag
    assert.deepEqual(result[2].input, ["text", "image"]); // unmatched: metadata preserved
    assert.deepEqual(result[3].input, ["text"]);          // malformed: text-only, no crash
  });

  it("refreshModels network path fetches, persists, and returns models", async () => {
    const { registerProvider } = await import("../lib/provider.js");
    let refreshModels: (ctx: unknown) => Promise<unknown>;
    let emitted: { channel: string; count: number } | undefined;
    registerProvider({
      registerProvider: (_n: string, config: { refreshModels: (ctx: unknown) => Promise<unknown> }) => { refreshModels = config.refreshModels; },
      events: { emit: (c: string, d: { count: number }) => { emitted = { channel: c, count: d.count }; } },
    } as never, { baseUrl: "http://x", enableReasoning: true });

    let persisted: unknown;
    const ctx = {
      stored: undefined,
      allowNetwork: true,
      signal: new AbortController().signal,
      credential: { type: "api_key", key: "sk-from-login" },
      publish: async (pub: { persist?: unknown }) => { persisted = pub.persist; },
    };
    let authHeader: string | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      authHeader = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ object: "list", data: [{ id: "net-model" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = (await refreshModels!(ctx)) as { id: string; reasoning: boolean }[];
      assert.equal(result.length, 1);
      assert.equal(result[0].id, "net-model");
      assert.equal(result[0].reasoning, true);
      assert.ok(persisted); // persisted to models-store
      assert.equal(authHeader, "Bearer sk-from-login"); // /login credential drives discovery
      assert.ok(emitted && emitted.channel === "router:models-loaded" && emitted.count === 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refreshModels keeps restored models when network fetch returns empty", async () => {
    const { registerProvider } = await import("../lib/provider.js");
    let refreshModels: (ctx: unknown) => Promise<unknown>;
    registerProvider({
      registerProvider: (_n: string, config: { refreshModels: (ctx: unknown) => Promise<unknown> }) => { refreshModels = config.refreshModels; },
    } as never, { baseUrl: "http://x", enableReasoning: true });

    const ctx = {
      stored: { models: [{ id: "old", name: "old", reasoning: false, input: ["text"], cost: {}, contextWindow: 1, maxTokens: 1 }] },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => {},
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;
    try {
      const result = await refreshModels!(ctx);
      assert.equal(result, undefined); // keeps current list — no wipe
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
