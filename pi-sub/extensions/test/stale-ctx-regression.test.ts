import assert from "node:assert/strict";
import { test } from "node:test";
import extension, { REFRESH_DEBOUNCE_MS, scheduleRefresh, type State } from "../index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake ctx whose ui throws once `invalidate()` is called — mimics Pi's
 *  ExtensionRunner.invalidate() after session replacement. */
function makeCtx() {
  const ctx = {
    invalidated: false,
    statusCalls: [] as string[],
    signal: undefined,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      setStatus(_key: string, _value?: string) {
        if (ctx.invalidated) throw new Error("This extension ctx is stale after session replacement or reload.");
        ctx.statusCalls.push(_value ?? "");
      },
      notify() {
        if (ctx.invalidated) throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    },
    invalidate() {
      ctx.invalidated = true;
    },
  };
  return ctx;
}

function makeState(ctx?: ReturnType<typeof makeCtx>): State {
  const fetchCalls: unknown[] = [];
  return {
    ctx,
    lastRefreshAt: 0,
    refreshGeneration: 0,
    cumulativeOutput: 0,
    cumulativeDurationMs: 0,
    cumulativeCost: 0,
    // ponytail: minimal adapter stub — the crash path must never reach fetchUsage
    // when state.ctx is unset, and the positive control only needs the call count.
    adapter: {
      id: "test",
      displayName: "Test",
      fetchUsage(signal?: AbortSignal) {
        fetchCalls.push(signal);
        return Promise.resolve({} as never);
      },
    },
  } as State & { adapter: { fetchCalls: unknown[] } };
}

test("debounce armed before session replacement no-ops after ctx is dropped (crash repro)", async () => {
  const ctxA = makeCtx();
  const state = makeState(ctxA);

  scheduleRefresh(state);
  // session_shutdown semantics: stopTimer can no longer help if the debounce was
  // re-armed by a late event afterwards — dropping state.ctx must be enough.
  state.ctx = undefined;
  ctxA.invalidate();

  await sleep(REFRESH_DEBOUNCE_MS + 100);
  assert.equal(ctxA.statusCalls.length, 0, "stale ctx must not be rendered into");
});

test("late old-session scheduling cannot reinstall a ctx (advisor nit)", async () => {
  const state = makeState(); // post-shutdown: state.ctx is undefined
  const ctxA = makeCtx();
  ctxA.invalidate();

  // scheduleRefresh takes no ctx — a late after_provider_response has nothing
  // stale to capture. The armed timer must still no-op.
  scheduleRefresh(state);
  await sleep(REFRESH_DEBOUNCE_MS + 100);
  assert.equal(state.ctx, undefined);
  assert.equal(ctxA.statusCalls.length, 0);
});

test("debounce fires with the ctx installed at fire time, not arm time", async () => {
  const ctxA = makeCtx();
  const state = makeState(ctxA);

  scheduleRefresh(state);
  // Session replaced: old ctx dead, new session started with ctxB.
  state.ctx = makeCtx();
  ctxA.invalidate();

  await sleep(REFRESH_DEBOUNCE_MS + 100);
  assert.notEqual(state.ctx, undefined);
  assert.equal(ctxA.statusCalls.length, 0, "stale ctx must not be rendered into");
  assert.equal((state.ctx as unknown as { statusCalls: string[] }).statusCalls.length > 0, true, "live ctx must be rendered into");
});

function makePi() {
  const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void> | void> = {};
  return {
    handlers,
    on(type: string, fn: (event: unknown, ctx: unknown) => Promise<void> | void) {
      handlers[type] = fn;
    },
    registerCommand(_name: string, _opts: unknown) {},
  } as never;
}

const UNSUPPORTED_MODEL = { provider: "ollama", id: "qwen3" };

test("late old-session shutdown does not drop the new session's ctx", async () => {
  const pi = makePi() as { handlers: Record<string, (event: unknown, ctx: never) => Promise<void> | void> };
  extension(pi);

  const ctxB = makeCtx();
  (ctxB as unknown as { model: unknown }).model = UNSUPPORTED_MODEL;
  await pi.handlers.session_start({ reason: "new" }, ctxB as never);
  const renders = ctxB.statusCalls.length;
  assert.ok(renders > 0, "session_start must render into the live ctx");

  // Cross-boundary late delivery: the PREVIOUS session's shutdown arrives
  // after the new session's session_start. It must only drop the ctx it was
  // handed, not the live one.
  const ctxA = makeCtx();
  await pi.handlers.session_shutdown({ reason: "new" }, ctxA as never);

  await pi.handlers.model_select({ model: UNSUPPORTED_MODEL }, ctxB as never);
  assert.equal(
    ctxB.statusCalls.length,
    renders + 1,
    "live session must still render after a late old-session shutdown",
  );
});

test("late old-session shutdown leaves the live interval, generation, and invalidated ctx untouched", async () => {
  const pi = makePi() as { handlers: Record<string, (event: unknown, ctx: never) => Promise<void> | void> };
  const state = extension(pi) as State;

  // Supported model → session_start arms the 60s refresh interval. Stub fetch
  // so the fired refresh never leaves the test process.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const ctxB = makeCtx();
    (ctxB as unknown as { model: unknown }).model = { provider: "zai", id: "glm-5.3" };
    await pi.handlers.session_start({ reason: "new" }, ctxB as never);
    assert.ok(state.refreshTimer, "session_start must arm the refresh interval");
    const gen = state.refreshGeneration;

    // Late shutdown of the PREVIOUS session, ctx already invalidated — the
    // handler must not touch it (no throw) and must not tear down the live
    // session's timer or bump its generation.
    const ctxA = makeCtx();
    ctxA.invalidate();
    await pi.handlers.session_shutdown({ reason: "new" }, ctxA as never);
    assert.ok(state.refreshTimer, "late shutdown must not kill the live interval");
    assert.equal(state.refreshGeneration, gen, "late shutdown must not bump the live generation");
    assert.equal(state.ctx, ctxB, "live ctx stays installed");

    // Matching shutdown still tears down fully.
    await pi.handlers.session_shutdown({ reason: "quit" }, ctxB as never);
    assert.equal(state.refreshTimer, undefined, "matching shutdown stops the interval");
    assert.equal(state.ctx, undefined, "matching shutdown drops the ctx");
  } finally {
    globalThis.fetch = realFetch;
  }
});
