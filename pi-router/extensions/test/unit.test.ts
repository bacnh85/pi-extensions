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
