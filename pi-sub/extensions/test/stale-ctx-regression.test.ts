import assert from "node:assert/strict";
import { test } from "node:test";
import extension, { REFRESH_DEBOUNCE_MS, REFRESH_INTERVAL_MS, scheduleRefresh, type State } from "../index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake ctx whose ui throws once `invalidate()` is called — mimics Pi's
 *  ExtensionRunner.invalidate() after session replacement. `message` lets
 *  tests pin the disarm matcher to wording, not to this fake's default. */
function makeCtx(message = "This extension ctx is stale after session replacement or reload.") {
  const ctx = {
    invalidated: false,
    statusCalls: [] as string[],
    signal: undefined,
    staleMessage: message,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      setStatus(_key: string, _value?: string) {
        if (ctx.invalidated) throw new Error(message);
        ctx.statusCalls.push(_value ?? "");
      },
      notify() {
        if (ctx.invalidated) throw new Error(message);
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

test("stale ctx still installed when the deferred refresh fires is caught and self-disarms, not an unhandled rejection", async () => {
  const ctxA = makeCtx();
  const state = makeState(ctxA);

  scheduleRefresh(state);
  // pi 0.85.1 hole: the ctx is invalidated WITHOUT session_shutdown being
  // delivered, so state.ctx stays installed and stale. The 0.1.18/0.1.37
  // guards (fire-time ctx resolution, identity-guarded shutdown) cannot help:
  // refreshUsage hits ctx.ui, throws, and its void-discarded rejection used
  // to exit pi. deferRefresh must catch it and self-disarm.
  ctxA.invalidate();

  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await sleep(REFRESH_DEBOUNCE_MS + 100);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(unhandled, undefined, "stale-ctx throw must be caught, not left unhandled");
  assert.equal(state.debounceTimer, undefined, "self-disarm must stop the debounce timer");
  assert.equal(state.ctx, undefined, "self-disarm must drop the stale ctx");
  assert.ok(state.refreshGeneration > 0, "self-disarm must invalidate in-flight state");
});

function makePi() {
  const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void> | void> = {};
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  return {
    handlers,
    commands,
    on(type: string, fn: (event: unknown, ctx: unknown) => Promise<void> | void) {
      handlers[type] = fn;
    },
    registerCommand(name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands[name] = opts;
    },
  } as never;
}

function makePiHarness() {
  const pi = makePi() as {
    handlers: Record<string, (event: unknown, ctx: never) => Promise<void> | void>;
    commands: Record<string, { handler: (args: string, ctx: never) => Promise<void> }>;
  };
  const state = extension(pi) as State;
  return { pi, state };
}

function stubFetch() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { headers: { "content-type": "application/json" } })) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

function startLiveSession(harness: ReturnType<typeof makePiHarness>, reason: string) {
  const ctxB = makeCtx();
  (ctxB as unknown as { model: unknown }).model = { provider: "zai", id: "glm-5.3" };
  return harness.pi.handlers.session_start({ reason }, ctxB as never).then(() => ctxB);
}

test("60s interval fires against an orphaned stale ctx and self-disarms (pi-exit repro)", async (t) => {
  const restoreFetch = stubFetch();
  try {
    const { pi, state } = makePiHarness();
    t.mock.timers.enable({ apis: ["setInterval"] });
    const ctxB = await startLiveSession({ pi, state }, "new");
    assert.ok(state.refreshTimer, "session_start must arm the refresh interval");
    await sleep(20); // let session_start's immediate refresh settle (60s later it always has)
    // Open the TTL gate so the tick renders + fetches instead of early-returning.
    state.snapshot = undefined;
    state.lastRefreshAt = 0;
    ctxB.invalidate(); // orphaned invalidation, no session_shutdown delivered

    let unhandled: unknown;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      t.mock.timers.tick(REFRESH_INTERVAL_MS);
      await sleep(10); // flush rejection microtasks
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.equal(unhandled, undefined, "interval stale-ctx throw must be caught, not unhandled");
    assert.equal(state.refreshTimer, undefined, "self-disarm must stop the interval");
    assert.equal(state.ctx, undefined, "self-disarm must drop the stale ctx");
  } finally {
    restoreFetch();
  }
});

test("/sub against an orphaned stale ctx disarms instead of throwing into the dispatcher", async () => {
  const restoreFetch = stubFetch();
  try {
    const { pi, state } = makePiHarness();
    const ctxB = await startLiveSession({ pi, state }, "new");
    assert.ok(state.refreshTimer);
    ctxB.invalidate(); // orphaned invalidation, no session_shutdown delivered

    await pi.commands.sub.handler("", ctxB as never); // must not throw

    assert.equal(state.ctx, undefined, "stale /sub must disarm");
    assert.equal(state.refreshTimer, undefined, "stale /sub must stop the interval");
  } finally {
    restoreFetch();
  }
});

test("disarm does not depend on pi's exact stale-error wording", async () => {
  const ctxA = makeCtx("Extension context invalidated by the host.");
  const state = makeState(ctxA);

  scheduleRefresh(state);
  ctxA.invalidate();

  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await sleep(REFRESH_DEBOUNCE_MS + 100);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(unhandled, undefined);
  assert.equal(state.debounceTimer, undefined);
  assert.equal(state.ctx, undefined);
});

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
