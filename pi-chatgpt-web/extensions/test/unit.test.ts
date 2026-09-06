import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Global config backup/restore ───────────────────────────────────────────
// Config tests write to the real chatgpt-web-config.json. Back up once before
// ALL tests and restore after, so the suite never clobbers a live config.
const CONFIG_PATH = join(homedir(), ".pi", "agent", "chatgpt-web-config.json");
const BACKUP_PATH = CONFIG_PATH + ".bak";
const ENV_FILES = [
  join(homedir(), ".pi", "agent", ".env.local"),
  join(homedir(), ".pi", "agent", ".env"),
  join(process.cwd(), ".env.local"),
  join(process.cwd(), ".env"),
];

before(() => {
  if (existsSync(CONFIG_PATH)) {
    writeFileSync(BACKUP_PATH, readFileSync(CONFIG_PATH));
  }
  for (const f of ENV_FILES) {
    try { writeFileSync(f + ".bak", readFileSync(f)); } catch { /* none */ }
    try { unlinkSync(f); } catch { /* none */ }
  }
  for (const k of ["CHATGPT_WEB_BASE_URL", "CHATGPT_WEB_AUTH_KEY", "CODEX_WEB_BASE_URL", "CODEX_WEB_AUTH_KEY"]) {
    if (process.env[k] !== undefined) (process.env as Record<string, string | undefined>)[k + "__BAK"] = process.env[k]!;
    delete process.env[k];
  }
});

after(() => {
  try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  if (existsSync(BACKUP_PATH)) {
    writeFileSync(CONFIG_PATH, readFileSync(BACKUP_PATH));
    try { unlinkSync(BACKUP_PATH); } catch { /* ignore */ }
  }
  for (const f of ENV_FILES) {
    if (existsSync(f + ".bak")) {
      writeFileSync(f, readFileSync(f + ".bak"));
      try { unlinkSync(f + ".bak"); } catch { /* ignore */ }
    }
  }
  for (const k of ["CHATGPT_WEB_BASE_URL", "CHATGPT_WEB_AUTH_KEY", "CODEX_WEB_BASE_URL", "CODEX_WEB_AUTH_KEY"]) {
    const bak = (process.env as Record<string, string | undefined>)[k + "__BAK"];
    if (bak !== undefined) process.env[k] = bak;
    delete (process.env as Record<string, string | undefined>)[k + "__BAK"];
  }
});

// ── Config module tests ──────────────────────────────────────────────────────

describe("config", () => {
  it("loadConfig returns null when no file exists", async () => {
    try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
    const { loadConfig } = await import("../lib/config.js");
    assert.equal(loadConfig(), null);
  });

  it("saveConfig + loadConfig round-trips correctly", async () => {
    try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
    const { saveConfig, loadConfig } = await import("../lib/config.js");

    const config = { baseUrl: "http://172.30.55.22:3001/v1", authKey: "test-key-123" };
    saveConfig(config);

    const loaded = loadConfig();
    assert.notEqual(loaded, null);
    assert.equal(loaded!.baseUrl, config.baseUrl);
    assert.equal(loaded!.authKey, config.authKey);
  });

  it("saveConfig stores config without auth key when undefined", async () => {
    try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
    const { saveConfig, loadConfig } = await import("../lib/config.js");

    saveConfig({ baseUrl: "http://172.30.55.22:3001/v1", authKey: undefined });
    const loaded = loadConfig();
    assert.notEqual(loaded, null);
    assert.equal(loaded!.authKey, undefined);
  });

  it("normalizeUrl strips trailing slashes but keeps /v1", async () => {
    const { normalizeUrl } = await import("../lib/config.js");
    assert.equal(normalizeUrl("http://172.30.55.22:3001/v1/"), "http://172.30.55.22:3001/v1");
    assert.equal(normalizeUrl("http://host:3000/v1"), "http://host:3000/v1");
  });

  it("maskAuthKey masks middle characters", async () => {
    const { maskAuthKey } = await import("../lib/config.js");
    const key = "abcdefgh12345678";
    assert.equal(maskAuthKey(key), key.slice(0, 4) + "●".repeat(key.length - 8) + key.slice(-4));
    assert.equal(maskAuthKey(undefined), "(not set)");
    assert.equal(maskAuthKey("short"), "short");
  });

  it("getEffectiveConfig defaults to the homelab bridge when unconfigured", async () => {
    try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
    const { getEffectiveConfig, DEFAULT_BASE_URL } = await import("../lib/config.js");
    const cfg = getEffectiveConfig();
    assert.equal(cfg.baseUrl, DEFAULT_BASE_URL);
    assert.ok(DEFAULT_BASE_URL.endsWith("/v1"), "default baseUrl must include /v1 — Pi appends /chat/completions verbatim");
    assert.equal(cfg.authKey, undefined);
  });

  it("getEffectiveConfig prefers saved config over default", async () => {
    const { saveConfig, getEffectiveConfig } = await import("../lib/config.js");
    saveConfig({ baseUrl: "http://other:3000/v1", authKey: "kkk" });
    const cfg = getEffectiveConfig();
    assert.equal(cfg.baseUrl, "http://other:3000/v1");
    assert.equal(cfg.authKey, "kkk");
    try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  });

  it("parseEnvValue extracts quoted and bare values, ignores other keys", async () => {
    const { parseEnvValue } = await import("../lib/config.js");
    const content = [
      "# comment",
      "CHATGPT_WEB_AUTH_KEY=\"vault-key-123\"",
      "OTHER=x",
      "CHATGPT_WEB_BASE_URL=http://z:9/v1",
      "EMPTY=",
    ].join("\n");
    assert.equal(parseEnvValue(content, "CHATGPT_WEB_AUTH_KEY"), "vault-key-123");
    assert.equal(parseEnvValue(content, "CHATGPT_WEB_BASE_URL"), "http://z:9/v1");
    assert.equal(parseEnvValue(content, "EMPTY"), undefined);
    assert.equal(parseEnvValue(content, "MISSING"), undefined);
  });

  it("getEffectiveConfig reads the auth key from ~/.pi/agent/.env.local (repo env chain)", async () => {
    // Regression: the key lives in the global .env.local which Pi does NOT
    // inject into process.env — the package must read the file itself.
    const { homedir: hd } = await import("node:os");
    const envPath = join(hd(), ".pi", "agent", ".env.local");
    let backup: string | null = null;
    try { backup = readFileSync(envPath, "utf8"); } catch { /* none */ }
    try {
      try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
      mkdirSync(join(hd(), ".pi", "agent"), { recursive: true });
      writeFileSync(envPath, "CHATGPT_WEB_AUTH_KEY=envfile-key-999\n", { mode: 0o600 });
      const { getEffectiveConfig } = await import("../lib/config.js");
      const cfg = getEffectiveConfig();
      assert.equal(cfg.authKey, "envfile-key-999", "key must come from the global .env.local chain");
    } finally {
      if (backup !== null) writeFileSync(envPath, backup);
      else try { unlinkSync(envPath); } catch { /* ignore */ }
    }
  });

  it("codex-web config: default base URL, env chain, and separate persistence", async () => {
    const { getEffectiveCodexConfig, saveCodexConfig, loadCodexConfig, CODEX_DEFAULT_BASE_URL } =
      await import("../lib/config.js");
    try { unlinkSync(join(homedir(), ".pi", "agent", "codex-web-config.json")); } catch { /* ignore */ }

    // default when unconfigured
    let cfg = getEffectiveCodexConfig();
    assert.equal(cfg.baseUrl, CODEX_DEFAULT_BASE_URL);
    assert.equal(cfg.authKey, undefined);

    // saved config persists separately from chatgpt-web config
    saveCodexConfig({ baseUrl: "http://x:8086/v1", authKey: "ck" });
    cfg = getEffectiveCodexConfig();
    assert.equal(cfg.baseUrl, "http://x:8086/v1");
    assert.equal(cfg.authKey, "ck");
    const loaded = loadCodexConfig();
    assert.notEqual(loaded, null);
    assert.equal(loaded!.authKey, "ck");
    try { unlinkSync(join(homedir(), ".pi", "agent", "codex-web-config.json")); } catch { /* ignore */ }
  });

  it("CODEX_WEB env vars (process + env chain) override saved codex config", async () => {
    const { homedir: hd } = await import("node:os");
    const envPath = join(hd(), ".pi", "agent", ".env.local");
    let backup: string | null = null;
    try { backup = readFileSync(envPath, "utf8"); } catch { /* none */ }
    try {
      writeFileSync(envPath, "CODEX_WEB_AUTH_KEY=codex-envfile-key\n", { mode: 0o600 });
      process.env.CODEX_WEB_BASE_URL = "http://envvar:8086/v1";
      const { getEffectiveCodexConfig } = await import("../lib/config.js");
      const cfg = getEffectiveCodexConfig();
      assert.equal(cfg.baseUrl, "http://envvar:8086/v1");
      assert.equal(cfg.authKey, "codex-envfile-key");
    } finally {
      if (backup !== null) writeFileSync(envPath, backup);
      else try { unlinkSync(envPath); } catch { /* ignore */ }
      delete process.env.CODEX_WEB_BASE_URL;
    }
  });
});

// ── Client module tests ──────────────────────────────────────────────────────

describe("client", () => {
  it("mapModel maps gpt-5 family to reasoning text models with zero cost", async () => {
    const { mapModel } = await import("../lib/client.js");
    const result = mapModel({ id: "gpt-5-5-mini", owned_by: "chatgpt" });

    assert.equal(result.id, "gpt-5-5-mini");
    assert.equal(result.name, "gpt-5-5-mini (chat only)");
    assert.equal(result.reasoning, true);
    assert.deepEqual(result.input, ["text"]);
    assert.deepEqual(result.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(result.contextWindow, 128_000);
    assert.equal(result.maxTokens, 4_096);
    assert.equal(result.compat?.supportsReasoningEffort, false);
    assert.equal(result.compat?.maxTokensField, "max_tokens");
  });

  it("mapModel maps auto to reasoning; unknown ids stay non-reasoning", async () => {
    const { mapModel } = await import("../lib/client.js");
    assert.equal(mapModel({ id: "auto" }).reasoning, true);
    assert.equal(mapModel({ id: "gpt-4o" }).reasoning, false);
  });

  it("mapCodexModel: gpt-5.4 gets reasoning, thinking map (off→low), real context window, NO chat-only suffix", async () => {
    const { mapCodexModel } = await import("../lib/client.js");
    const result = mapCodexModel({ id: "gpt-5.4" });

    assert.equal(result.id, "gpt-5.4");
    assert.equal(result.name, "gpt-5.4");
    assert.ok(!result.name.includes("chat only"), "codex models are tool-capable — no chat-only suffix");
    assert.equal(result.reasoning, true);
    assert.equal(result.thinkingLevelMap!.off, "low", "codex always reasons; off maps to lowest effort");
    assert.equal(result.thinkingLevelMap!.xhigh, "xhigh");
    assert.equal(result.thinkingLevelMap!.max, "xhigh");
    assert.equal(result.contextWindow, 272_000);
    assert.equal(result.maxTokens, 128_000);
    assert.equal(result.compat!.supportsReasoningEffort, true);
    assert.deepEqual(result.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("mapCodexModel prefers the proxy's own context_window metadata over the static table", async () => {
    const { mapCodexModel } = await import("../lib/client.js");
    // Live shape from the homelab proxy: gpt-5.6-terra ctx 272000, max 872000
    const result = mapCodexModel({ id: "gpt-5.6-terra", context_window: 272000, max_context_window: 872000 });
    assert.equal(result.contextWindow, 272000);
    assert.equal(result.reasoning, true);
    // codex-auto-review (special model) counts as reasoning too
    assert.equal(mapCodexModel({ id: "codex-auto-review", context_window: 272000 }).reasoning, true);
  });

  it("mapCodexModel: 400k family (gpt-5.4-mini, gpt-5.3-codex, gpt-5.2, gpt-5-codex)", async () => {
    const { mapCodexModel } = await import("../lib/client.js");
    for (const id of ["gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2", "gpt-5-codex"]) {
      const result = mapCodexModel({ id });
      assert.equal(result.contextWindow, 400_000, id);
      assert.equal(result.maxTokens, 128_000, id);
    }
  });

  it("mapCodexModel: gpt-oss models get reasoning but fallback context", async () => {
    const { mapCodexModel } = await import("../lib/client.js");
    const result = mapCodexModel({ id: "gpt-oss-120b" });
    assert.equal(result.reasoning, true);
    assert.equal(result.contextWindow, 131_072);
    assert.equal(result.name, "gpt-oss-120b");
  });

  it("fetchModels requests /models from the baseUrl INCLUDING /v1 and filters image models", async () => {
    // Regression guard for the pi-commandcode /v1-segment 404 bug: assert the
    // exact request URL, not just a mocked happy path.
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, _init?: RequestInit) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        object: "list",
        data: [
          { id: "auto", owned_by: "chatgpt" },
          { id: "gpt-5-5", owned_by: "chatgpt" },
          { id: "gpt-image-2", owned_by: "chatgpt" }, // must be filtered out
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    try {
      const { fetchModels } = await import("../lib/client.js");
      const models = await fetchModels({ baseUrl: "http://172.30.55.22:3001/v1", authKey: "k" });
      assert.equal(models.length, 2, "image models must be filtered out");
      assert.equal(models[0].id, "auto");
      assert.deepEqual(calls, ["http://172.30.55.22:3001/v1/models"], "request URL must include /v1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fetchModels throws with status on non-OK response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    try {
      const { fetchModels } = await import("../lib/client.js");
      await assert.rejects(
        () => fetchModels({ baseUrl: "http://x:1/v1", authKey: "k" }),
        /401/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fetchAccountPool strips /v1 and reads items length", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const { fetchAccountPool } = await import("../lib/client.js");
      const pool = await fetchAccountPool({ baseUrl: "http://172.30.55.22:3001/v1", authKey: "k" });
      assert.equal(pool.total, 0);
      assert.deepEqual(calls, ["http://172.30.55.22:3001/api/accounts"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Provider module tests ────────────────────────────────────────────────────

describe("provider", () => {
  it("registerProvider passes baseUrl incl. /v1 as provider baseUrl", async () => {
    const { registerProvider } = await import("../lib/provider.js");
    const registered: Array<[string, unknown]> = [];
    const fakePi = {
      registerProvider: (name: string, cfg: unknown) => { registered.push([name, cfg]); },
    };
    const { mapModel } = await import("../lib/client.js");
    registerProvider(fakePi as never, { baseUrl: "http://172.30.55.22:3001/v1", authKey: "k" },
      [mapModel({ id: "gpt-5-5" })]);

    assert.equal(registered.length, 1);
    assert.equal(registered[0][0], "chatgpt-web");
    const cfg = registered[0][1] as Record<string, unknown>;
    assert.equal(cfg.baseUrl, "http://172.30.55.22:3001/v1");
    assert.equal(cfg.api, "openai-completions");
    assert.equal(cfg.apiKey, "k");
  });

  it("registerCodexProvider registers codex-web with proxy baseUrl incl. /v1", async () => {
    const { registerCodexProvider } = await import("../lib/provider.js");
    const registered: Array<[string, unknown]> = [];
    const fakePi = {
      registerProvider: (name: string, cfg: unknown) => { registered.push([name, cfg]); },
    };
    const { mapCodexModel } = await import("../lib/client.js");
    registerCodexProvider(fakePi as never, { baseUrl: "http://172.30.55.22:8086/v1", authKey: "k" },
      [mapCodexModel({ id: "gpt-5.4" })]);

    assert.equal(registered[0][0], "codex-web");
    const cfg = registered[0][1] as Record<string, unknown>;
    assert.equal(cfg.baseUrl, "http://172.30.55.22:8086/v1");
    assert.equal(cfg.api, "openai-completions");
    assert.equal((cfg as { name?: string }).name, "Codex Web (proxy)");
  });
});

// ── Factory lifecycle tests ──────────────────────────────────────────────────

describe("factory lifecycle", () => {
  function fakePi() {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const providers = new Map<string, unknown>();
    return {
      pi: {
        events: {
          emit: (channel: string, data: unknown) => { emitted.push({ channel, data }); },
          on: (_channel: string, _handler: (data: unknown) => void) => () => {},
        },
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
        },
        registerProvider: (name: string, config: unknown) => { providers.set(name, config); },
        unregisterProvider: (name: string) => { providers.delete(name); },
        registerCommand: () => {},
        setModel: () => Promise.resolve(true),
      },
      emitted, providers, handlers,
      fire: async (event: string, eventData: unknown, ctxModel?: unknown) => {
        const ctx = { model: ctxModel, modelRegistry: { find: () => undefined } };
        for (const h of handlers.get(event) ?? []) await h(eventData, ctx);
      },
    };
  }

  it("factory registers provider and does not throw without cache", async () => {
    const { saveConfig } = await import("../lib/config.js");
    saveConfig({ baseUrl: "http://test:3001/v1", authKey: "k" });
    const { default: factory } = await import("../index.js");
    const harness = fakePi();
    await factory(harness.pi as never);
    assert.ok(harness.providers.has("chatgpt-web"), "provider must be registered");
    assert.ok(harness.providers.has("codex-web"), "codex provider must be registered too");
  });

  it("message_end normalizes upstream pool failures for chatgpt-web only", async () => {
    const { saveConfig } = await import("../lib/config.js");
    saveConfig({ baseUrl: "http://test:3001/v1", authKey: "k" });
    const { default: factory } = await import("../index.js");
    const harness = fakePi();
    await factory(harness.pi as never);

    const baseMessage = {
      role: "assistant", provider: "chatgpt-web", stopReason: "error",
      errorMessage: '/backend-anon/conversation failed: status=403, body=',
    };
    const result = (await Promise.all(
      (harness.handlers.get("message_end") ?? []).map((h) =>
        h({ message: baseMessage }, { model: { provider: "chatgpt-web", id: "gpt-5-5" } })),
    )).find((r) => r && typeof r === "object");
    void result; // re-checked below via explicit loop

    // Direct handler check: call via the returned value contract of pi.on
    // (a handler MAY return { message } to rewrite). Re-run explicitly:
    let rewritten: { message?: typeof baseMessage & { errorMessage: string } } | undefined;
    const handlers = harness.handlers.get("message_end") ?? [];
    for (const h of handlers) {
      const r = await h({ message: baseMessage }, { model: { provider: "chatgpt-web", id: "gpt-5-5" } });
      if (r && typeof r === "object" && "message" in r) rewritten = r as typeof rewritten;
    }
    assert.ok(rewritten, "message_end must return a rewrite for upstream pool failures");
    assert.ok(rewritten!.message!.errorMessage.startsWith("chatgpt-web bridge upstream failed"));
    assert.ok(rewritten!.message!.errorMessage.includes("account pool"));

    // Non-matching error (rate limit) must NOT be rewritten:
    const rateMessage = { ...baseMessage, errorMessage: "429 rate limit exceeded" };
    let rewrittenRate: unknown;
    for (const h of handlers) {
      const r = await h({ message: rateMessage }, { model: { provider: "chatgpt-web", id: "gpt-5-5" } });
      if (r && typeof r === "object") rewrittenRate = r;
    }
    assert.equal(rewrittenRate, undefined, "rate-limit errors must not be rewritten");

    // Other providers must be untouched:
    const otherMessage = { ...baseMessage, provider: "openai" };
    let rewrittenOther: unknown;
    for (const h of handlers) {
      const r = await h({ message: otherMessage }, { model: { provider: "openai", id: "gpt-5" } });
      if (r && typeof r === "object") rewrittenOther = r;
    }
    assert.equal(rewrittenOther, undefined, "other providers must not be rewritten");
  });

  it("refreshActiveModel is a no-op for non-chatgpt-web models", async () => {
    const { refreshActiveModel } = await import("../index.js");
    const calls: unknown[] = [];
    const fakePi = { setModel: (m: unknown) => { calls.push(m); return Promise.resolve(true); } };
    const ctx = { model: { provider: "anthropic", id: "claude" }, modelRegistry: { find: () => undefined } };
    await refreshActiveModel(fakePi as never, ctx as never);
    assert.equal(calls.length, 0);
  });
});
