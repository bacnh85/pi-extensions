import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// ── Isolation ────────────────────────────────────────────────────────────────
// PI_CODING_AGENT_DIR → temp global settings.json; XDG_CACHE_HOME → temp model
// cache. Both must be set BEFORE the dynamic import: index.ts snapshots
// XDG_CACHE_HOME at module load into MODEL_CACHE_PATH.
const TMP_HOME = join(tmpdir(), "pi-commandcode-ix-test-" + process.pid);
const TMP_CACHE = join(TMP_HOME, "cache");
const MODEL_CACHE = join(TMP_CACHE, "pi", "commandcode-models.json");
const globalSettings = () => join(TMP_HOME, "settings.json");

before(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = TMP_HOME;
  process.env.XDG_CACHE_HOME = TMP_CACHE;
  delete process.env.COMMAND_CODE_BASE_URL;
  delete process.env.COMMAND_CODE_API_KEY;
});
after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.XDG_CACHE_HOME;
  delete process.env.COMMAND_CODE_API_KEY;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function load() {
  // Dynamic import AFTER env is set (module reads XDG_CACHE_HOME at load).
  return import("../index.js");
}

interface ProviderCfg {
  refreshModels: (ctx: unknown) => Promise<unknown>;
}

/** Harness a fresh registerProvider call and count re-registrations. */
async function harness() {
  const mod = await load();
  let provider: ProviderCfg | null = null;
  let registers = 0;
  mod.registerProvider(
    { registerProvider: (_n: string, cfg: ProviderCfg) => { provider = cfg; registers++; } } as never,
    { baseUrl: "http://localhost:9/v1" },
  );
  return { mod, provider: provider!, registers: () => registers };
}

const offlineCtx = () => ({ allowNetwork: false, signal: new AbortController().signal });

// ── provider registration + refreshModels ────────────────────────────────────

describe("provider", () => {
  it("registers with $COMMAND_CODE_API_KEY and openai-completions api", async () => {
    let registered: Record<string, unknown> | null = null;
    const mod = await load();
    mod.registerProvider(
      { registerProvider: (_n: string, cfg: unknown) => { registered = cfg as Record<string, unknown>; } } as never,
      { baseUrl: "http://x/v1" },
    );
    assert.equal(registered!.apiKey, "$COMMAND_CODE_API_KEY");
    assert.equal(registered!.api, "openai-completions");
    assert.equal(registered!.baseUrl, "http://x/v1");
    assert.equal(typeof registered!.refreshModels, "function");
  });

  it("offline refreshModels returns undefined with no/uncacheable cache (0.2.1: no catalog wipe)", async () => {
    const { provider } = await harness();
    // No cache file → undefined ("keep current"), not [] (a truthy wipe).
    rmSync(MODEL_CACHE, { force: true });
    assert.equal(await provider.refreshModels(offlineCtx()), undefined);
    // Corrupt cache file → same undefined bail.
    mkdirSync(dirname(MODEL_CACHE), { recursive: true });
    writeFileSync(MODEL_CACHE, "{ not json");
    assert.equal(await provider.refreshModels(offlineCtx()), undefined);
    // Aborted signal takes the same offline branch.
    const ac = new AbortController();
    ac.abort();
    assert.equal(await provider.refreshModels({ allowNetwork: true, signal: ac.signal }), undefined);
  });

  it("offline refreshModels restores disk cache remapped through mapModel", async () => {
    const { provider } = await harness();
    mkdirSync(dirname(MODEL_CACHE), { recursive: true });
    writeFileSync(MODEL_CACHE, JSON.stringify([{ id: "zai-org/glm-5.2" }]));
    const result = (await provider.refreshModels(offlineCtx())) as { id: string; contextWindow: number }[];
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "zai-org/glm-5.2");
    assert.equal(result[0].contextWindow, 1_000_000, "mapped, not raw cache passthrough");
  });

  it("reads COMMAND_CODE_API_KEY at call time; /login credential wins", async () => {
    const { provider } = await harness();
    const realFetch = globalThis.fetch;
    try {
      let auth: string | undefined;
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        auth = (init?.headers as Record<string, string>)?.Authorization;
        return new Response(JSON.stringify({ object: "list", data: [{ id: "net-model" }] }), { status: 200 });
      }) as typeof fetch;

      const netCtx = () => ({ allowNetwork: true, signal: new AbortController().signal });

      process.env.COMMAND_CODE_API_KEY = "env-key-one";
      await provider.refreshModels(netCtx());
      assert.equal(auth, "Bearer env-key-one");

      // Changed AFTER import — a load-time const would keep env-key-one.
      process.env.COMMAND_CODE_API_KEY = "env-key-two";
      await provider.refreshModels(netCtx());
      assert.equal(auth, "Bearer env-key-two");

      // Resolved /login credential beats env.
      await provider.refreshModels({ ...netCtx(), credential: { type: "api_key", key: "sk-login" } });
      assert.equal(auth, "Bearer sk-login");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.COMMAND_CODE_API_KEY;
    }
  });
});

// ── /commandcode-config save path ────────────────────────────────────────────

describe("commandcode-config save", () => {
  it("bails with an error notification when global settings.json is corrupt (0.2.1)", async () => {
    const { mod, registers } = await harness();
    writeFileSync(globalSettings(), "{ corrupt json");
    const before = readFileSync(globalSettings(), "utf8");

    let handler: ((args: unknown, ctx: unknown) => Promise<void>) | null = null;
    mod.registerConfigCommand({
      registerCommand: (_n: string, cmd: { handler: typeof handler }) => { handler = cmd.handler; },
    } as never);

    const notifications: { msg: string; level?: string }[] = [];
    const ctx = {
      cwd: TMP_HOME,
      mode: "tui",
      hasUI: true,
      modelRegistry: { refresh: async () => {} },
      ui: {
        notify: (msg: string, level?: string) => { notifications.push({ msg, level }); },
        // Drive the panel: edit the baseUrl row, mark dirty, close (Esc = save).
        custom: (render: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => {
          groups: { rows: { set: (v: string) => void }[] }[];
          dirty: boolean;
          onClose: (() => void) | null;
        }) =>
          new Promise<void>((resolve) => {
            const model = render({ requestRender() {} }, null, null, resolve);
            model.groups[0]!.rows[0]!.set("http://corrupt-test/v1");
            model.dirty = true;
            model.onClose!();
          }),
      },
    };

    await handler!("save", ctx);

    const note = notifications.find((n) => n.msg.startsWith("Not saved:"));
    assert.ok(note, "surfaces a Not saved error");
    assert.equal(note.level, "error");
    assert.match(note.msg, /not valid JSON/);
    assert.equal(readFileSync(globalSettings(), "utf8"), before, "corrupt file untouched");
    assert.equal(registers(), 1, "no re-register after bail");
    rmSync(globalSettings(), { force: true });
  });
});
