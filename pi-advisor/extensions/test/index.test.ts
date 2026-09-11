import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, before, after } from "mocha";
import piAdvisor, { __setIsolatedForTest } from "../index";

// Redirect the homedir so config writes never touch real user settings.
let realHome: string | undefined;
let TMP: string;

function createFakePi() {
  const state: any = {
    activeTools: new Set<string>(),
    tools: new Map(),
    commands: new Map(),
    entryRenderers: new Map(),
    eventHandlers: new Map<string, ((event: any, ctx: any) => void)[]>(),
    entries: [] as any[],
    userMessages: [] as any[],
    sendMessageCalls: 0,
  };
  const pi: any = {
    registerTool: (tool: any) => { state.tools.set(tool.name, tool); },
    registerCommand: (name: string, def: any) => { state.commands.set(name, def); },
    getActiveTools: () => [...state.activeTools],
    setActiveTools: (tools: string[]) => { state.activeTools = new Set(tools); },
    registerEntryRenderer: (type: string, renderer: any) => { state.entryRenderers.set(type, renderer); },
    appendEntry: (customType: string, data: unknown) => { state.entries.push({ type: "custom", customType, data }); },
    sendMessage: () => { state.sendMessageCalls++; }, // would enter LLM context — must never be used for cards
    sendUserMessage: (content: string, options?: any) => { state.userMessages.push({ content, options }); },
    on: (channel: string, handler: (event: any, ctx: any) => void) => {
      const list = state.eventHandlers.get(channel) ?? [];
      list.push(handler);
      state.eventHandlers.set(channel, list);
      return () => {};
    },
  };
  return { pi, state };
}

function toolCalls(n: number): any[] {
  const list: any[] = [{ type: "message", id: "e0", parentId: null, timestamp: "0", message: { role: "user", content: [{ type: "text", text: "task" }], timestamp: 0 } }];
  for (let i = 1; i <= n; i++) {
    list.push({ type: "message", id: `t${i}`, parentId: list[list.length - 1].id, timestamp: `${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `tc${i}`, name: "read", arguments: {} }], timestamp: i } });
    list.push({ type: "message", id: `r${i}`, parentId: `t${i}`, timestamp: `${i}r`, message: { role: "toolResult", toolCallId: `tc${i}`, toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: i + 0.5 } });
  }
  list.push({ type: "message", id: `a${n}`, parentId: list[list.length - 1].id, timestamp: `${n}a`, message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: n + 1 } });
  return list;
}

function fakeCtx(entries: any[], sessionId = "test-session"): any {
  return {
    cwd: TMP,
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => false,
    model: { provider: "test", id: "main-model" },
    modelRegistry: {
      getAvailable: () => [],
      refresh: async () => {},
      find: () => ({ provider: "test", id: "advisor-model", contextWindow: 32_768 }),
      getError: () => undefined,
    },
    getSystemPrompt: () => "Primary system prompt",
    sessionManager: { getEntries: () => entries, getLeafId: () => entries[entries.length - 1]?.id, getSessionId: () => sessionId },
    ui: { notify: () => {} },
  };
}

async function fire(pi: any, state: any, channel: string, ctx: any): Promise<void> {
  const handlers = state.eventHandlers.get(channel) ?? [];
  for (const h of handlers) await h({}, ctx);
  // agent_settled schedules the review fire-and-forget (never blocks the
  // settle) — drain the event loop so a floating review settles before
  // assertions.
  await new Promise((r) => setImmediate(r));
}

describe("index wiring", () => {
  before(async () => {
    realHome = process.env.HOME;
    TMP = await mkdtemp(path.join(tmpdir(), "pi-advisor-index-"));
    process.env.HOME = TMP;
    __setIsolatedForTest(undefined);
  });
  after(() => {
    __setIsolatedForTest(undefined);
    if (realHome) process.env.HOME = realHome;
  });

  it("registers the advisor tool, /advisor command, and card renderer", () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    assert.ok(state.tools.has("advisor"), "advisor tool registered");
    assert.ok(state.commands.has("advisor"), "/advisor command registered");
    assert.ok(state.entryRenderers.has("pi-advisor"), "card renderer registered");
    assert.ok(state.eventHandlers.has("agent_settled"), "agent_settled hook registered");
  });

  it("nit flow steers via sendUserMessage (accepted notes all trigger a turn at settle)", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({
      "pi-advisor": { model: "test/advisor-model" },
    }));
    let isolatedCalled = false;
    __setIsolatedForTest(async (_ctx, models) => { isolatedCalled = true; return { text: '{"severity":"nit","note":"unused import in foo.ts"}', model: models[0] }; });
    await fire(pi, state, "session_start", fakeCtx([]));
    await fire(pi, state, "agent_settled", { ...fakeCtx(toolCalls(4)), mode: "tui" });
    assert.ok(isolatedCalled, "review executed");
    assert.equal(state.sendMessageCalls, 0, "nit no longer goes through a non-interrupting sendMessage aside at settle");
    assert.equal(state.entries.length, 0, "nit is NOT a display-only appendEntry card");
    assert.equal(state.userMessages.length, 1, "nit triggers a follow-up turn (agent_settled is idle, no step boundary)");
  });

  it("concern steers via sendUserMessage and arms cooldown", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({
      "pi-advisor": { model: "test/advisor-model" },
    }));
    __setIsolatedForTest(async (_ctx, models) => ({ text: '{"severity":"concern","note":"edit went to the wrong file"}', model: models[0] }));
    await fire(pi, state, "session_start", fakeCtx([]));
    await fire(pi, state, "agent_settled", { ...fakeCtx(toolCalls(4)), mode: "tui" });
    assert.equal(state.userMessages.length, 1);
    assert.equal(state.userMessages[0].options.deliverAs, "followUp");
    assert.equal(state.entries.length, 0, "concern is a steer, not a card");
  });

  it("agent_settled does not block on the review (fire-and-forget)", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({
      "pi-advisor": { model: "test/advisor-model" },
    }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setIsolatedForTest(async (_ctx, models) => { await gate; return { text: '{"severity":"nit","note":"pending note"}', model: models[0] }; });
    await fire(pi, state, "session_start", fakeCtx([]));
    await fire(pi, state, "agent_settled", { ...fakeCtx(toolCalls(4)), mode: "tui" });
    assert.equal(state.userMessages.length, 0, "handler returned while the review is still in flight");
    release();
    await new Promise((r) => setImmediate(r)); // drain the floating review
    assert.equal(state.userMessages.length, 1, "note delivered once the review finishes");
  });

  it("headless mode (print) skips the watch review entirely", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({
      "pi-advisor": { model: "test/advisor-model" },
    }));
    let calls = 0;
    __setIsolatedForTest(async (_ctx, models) => { calls++; return { text: "", model: models[0] }; });
    await fire(pi, state, "session_start", fakeCtx([]));
    await fire(pi, state, "agent_settled", fakeCtx(toolCalls(4))); // default fake mode is "print"
    assert.equal(calls, 0, "no review dispatched in print mode");
  });

  it("mode-less ctx is treated as headless (fail-safe skip)", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({
      "pi-advisor": { model: "test/advisor-model" },
    }));
    let calls = 0;
    __setIsolatedForTest(async (_ctx, models) => { calls++; return { text: "", model: models[0] }; });
    await fire(pi, state, "session_start", fakeCtx([]));
    const ctx = fakeCtx(toolCalls(4));
    delete ctx.mode;
    await fire(pi, state, "agent_settled", ctx);
    assert.equal(calls, 0, "no review dispatched without a known mode");
  });

  it("a review in flight across /new delivers nothing into the new session", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({
      "pi-advisor": { model: "test/advisor-model" },
    }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setIsolatedForTest(async (_ctx, models) => { await gate; return { text: '{"severity":"nit","note":"stale note"}', model: models[0] }; });
    await fire(pi, state, "session_start", fakeCtx([], "s1"));
    await fire(pi, state, "agent_settled", { ...fakeCtx(toolCalls(4), "s1"), mode: "tui" });
    assert.equal(state.userMessages.length, 0, "review still in flight");
    await fire(pi, state, "session_start", fakeCtx([], "s2")); // /new — runtime replaced
    release();
    await fire(pi, state, "agent_settled", { ...fakeCtx(toolCalls(4), "s2"), mode: "tui" });
    assert.equal(state.userMessages.length, 1, "stale note dropped; new session's own review delivered");
  });

  it("before_agent_start injects the authority line only in tui", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({
      "pi-advisor": { model: "test/advisor-model" },
    }));
    await fire(pi, state, "session_start", fakeCtx([]));
    const handler = state.eventHandlers.get("before_agent_start")[0];
    const evt = { systemPrompt: "base" };
    assert.equal(handler(evt, fakeCtx([])), undefined, "no authority line in headless modes");
    const out = handler(evt, { ...fakeCtx([]), mode: "tui" });
    assert.ok(out && out.systemPrompt.includes("Advisor notes:"), "authority line injected in tui");
  });

  it("session_shutdown disarms an in-flight review (silent discard, no toast)", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({
      "pi-advisor": { model: "test/advisor-model" },
    }));
    const notifies: string[] = [];
    const ctx: any = { ...fakeCtx(toolCalls(4)), mode: "tui", ui: { notify: (m: string) => notifies.push(m) } };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setIsolatedForTest(async (_c, models) => { await gate; return { text: '{"severity":"nit","note":"late note"}', model: models[0] }; });
    await fire(pi, state, "session_start", fakeCtx([]));
    await fire(pi, state, "agent_settled", ctx);
    await fire(pi, state, "session_shutdown", ctx); // SDK teardown — awaited before invalidation
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(state.userMessages.length, 0, "no delivery after teardown");
    assert.equal(notifies.length, 0, "no spurious error toast in the replaced session");
  });

  it("a delivery-time throw while live is caught and reported (no unhandled rejection)", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({
      "pi-advisor": { model: "test/advisor-model" },
    }));
    const notifies: string[] = [];
    pi.sendUserMessage = () => { throw new Error("This extension ctx is stale"); };
    __setIsolatedForTest(async (_c, models) => ({ text: '{"severity":"nit","note":"boom note"}', model: models[0] }));
    await fire(pi, state, "session_start", fakeCtx([]));
    await fire(pi, state, "agent_settled", { ...fakeCtx(toolCalls(4)), mode: "tui", ui: { notify: (m: string) => notifies.push(m) } });
    assert.equal(state.userMessages.length, 0, "throwing delivery never recorded");
    assert.ok(notifies.some((m) => m.includes("Advisor review failed")), "failure reported via notify while live");
  });

  it("/advisor off during an in-flight review suppresses delivery", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({
      "pi-advisor": { model: "test/advisor-model" },
    }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setIsolatedForTest(async (_ctx, models) => { await gate; return { text: '{"severity":"nit","note":"late note"}', model: models[0] }; });
    await fire(pi, state, "session_start", fakeCtx([]));
    await fire(pi, state, "agent_settled", { ...fakeCtx(toolCalls(4)), mode: "tui" });
    const cmd = state.commands.get("advisor");
    await cmd.handler("off", fakeCtx([])); // clears rt.models mid-flight
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(state.userMessages.length, 0, "a disabled watch must not fire a follow-up run");
    assert.equal(state.entries.length, 0, "and must not append a card");
  });

  it("skipped overlap returns before cursor advance (next review still counts those calls)", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({
      "pi-advisor": { model: "test/advisor-model" },
    }));
    const base = toolCalls(4);
    const extra = [1, 2, 3, 4].map((i) => ({ type: "message", id: `x${i}`, parentId: "a4", timestamp: `${i}x`, message: { role: "assistant", content: [{ type: "toolCall", id: `xc${i}`, name: "read", arguments: {} }], timestamp: i } }));
    const extended = [...base, ...extra];
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setIsolatedForTest(async (_ctx, models) => { calls++; await gate; return { text: '{"severity":"nit","note":"n"}', model: models[0] }; });
    await fire(pi, state, "session_start", fakeCtx([]));
    await fire(pi, state, "agent_settled", { ...fakeCtx(base), mode: "tui" });
    assert.equal(calls, 1, "first review dispatched");
    await fire(pi, state, "agent_settled", { ...fakeCtx(extended), mode: "tui" });
    assert.equal(calls, 1, "overlapped settle skipped while the first review is in flight");
    release();
    await new Promise((r) => setImmediate(r));
    await fire(pi, state, "agent_settled", { ...fakeCtx(extended), mode: "tui" });
    assert.equal(calls, 2, "cursor untouched by the skipped settle — the +4 calls still trigger a review");
  });

  it("no advisor model → no review call at all", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({ "pi-advisor": {} }));
    let calls = 0;
    __setIsolatedForTest(async () => { calls++; return { text: '{"severity":"nit","note":"x"}', model: "" }; });
    const ctx = fakeCtx(toolCalls(4));
    await fire(pi, state, "session_start", ctx);
    await fire(pi, state, "agent_settled", { ...ctx, mode: "tui" });
    assert.equal(calls, 0, "no isolated call without a model");
    assert.equal(state.entries.length, 0);
  });

  it("migration is one-shot: disable then restart does not resurrect legacy model", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    // legacy pi-plan preference exists
    await mkdir(path.join(TMP, ".pi", "agent", "pi-plan"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "pi-plan", "preferences.json"), JSON.stringify({ advisorModel: "test/legacy-model" }));
    const ctx = fakeCtx([]);
    await fire(pi, state, "session_start", ctx); // migrates test/legacy-model
    const migrated = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(TMP, ".pi", "agent", "settings.json"), "utf8"));
    assert.equal(migrated["pi-advisor"].model, "test/legacy-model");

    // user runs /advisor off → model cleared
    const cmd = state.commands.get("advisor");
    await cmd.handler("off", ctx);

    // restart: session_start again — must NOT re-migrate
    await fire(pi, state, "session_start", fakeCtx([]));
    const rt = state.commands.get("advisor");
    void rt;
    // observable: settled turn with a configured-but-cleared chain must not review
    let calls = 0;
    __setIsolatedForTest(async () => { calls++; return { text: '{"severity":"nit","note":"x"}', model: "" }; });
    await fire(pi, state, "agent_settled", { ...fakeCtx(toolCalls(4)), mode: "tui" });
    assert.equal(calls, 0, "legacy model not resurrected after explicit disable");
  });

  it("/advisor completions offer keywords ahead of models, filtered by prefix", () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    const ctx = fakeCtx([]);
    ctx.modelRegistry.getAvailable = () => [
      { provider: "p", id: "m1", contextWindow: 8_000 },
      { provider: "p", id: "m2", contextWindow: 8_000 },
    ] as any;
    const cmd = state.commands.get("advisor");
    cmd.handler("status", ctx); // seeds the module-level registry from ctx
    const all = cmd.getArgumentCompletions("");
    const values = all.map((i: any) => i.value);
    for (const kw of ["on", "off", "status", "models", "watch-off"]) {
      assert.ok(values.includes(kw), `keyword ${kw} offered at empty prefix`);
      assert.ok(values.indexOf(kw) < values.findIndex((v: string) => v.includes("/")), `keyword ${kw} sorts before model items`);
    }
    const o = cmd.getArgumentCompletions("o").map((i: any) => i.value);
    assert.ok(o.includes("on") && o.includes("off"), "keywords survive prefix filtering");
    assert.ok(!o.includes("status"), "non-matching keyword filtered out");
    const none = cmd.getArgumentCompletions("zzz");
    assert.equal(none, null, "no matches → null (popup suppressed)");
  });

  it("/advisor a, b sets the full chain (comma argument)", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({ "pi-advisor": {} }));
    const ctx = fakeCtx([]);
    ctx.modelRegistry.getAvailable = () => [
      { provider: "p", id: "m1", contextWindow: 8_000 },
      { provider: "p", id: "m2", contextWindow: 8_000 },
    ] as any;
    const cmd = state.commands.get("advisor");
    await cmd.handler("p/m1, p/m2", ctx);
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(TMP, ".pi", "agent", "settings.json"), "utf8"));
    assert.deepEqual(raw["pi-advisor"].models, ["p/m1", "p/m2"], "whole chain persisted");
    // completion after a comma carries the typed head (kernel replaces the whole argument)
    const comps = cmd.getArgumentCompletions("p/m1,").map((i: any) => i.value);
    assert.deepEqual(comps, ["p/m1, p/m1", "p/m1, p/m2"], "post-comma completion preserves the typed prefix");
  });

  it("trailing comma is a single model (picker path), not an explicit chain; canonicalized chain dedupes", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    await mkdir(path.join(TMP, ".pi", "agent"), { recursive: true });
    await writeFile(path.join(TMP, ".pi", "agent", "settings.json"), JSON.stringify({ "pi-advisor": {} }));
    const ctx = fakeCtx([]);
    ctx.modelRegistry.getAvailable = () => [
      { provider: "p", id: "m1", contextWindow: 8_000 },
      { provider: "p", id: "m2", contextWindow: 8_000 },
    ] as any;
    const cmd = state.commands.get("advisor");
    // trailing comma → not the explicit-chain branch: unresolvable entry falls through to picker (throws in print mode)
    await assert.rejects(cmd.handler("p/m9,", ctx), /Usage:/);
    // two entries resolving to the same ref dedupe to one (bare id + full ref)
    await cmd.handler("p/m1, m1", ctx);
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(TMP, ".pi", "agent", "settings.json"), "utf8"));
    assert.deepEqual(raw["pi-advisor"].models, ["p/m1"], "canonicalized duplicates removed at the call site");
  });

  it("parseChainArgument trims, drops blanks, and dedupes chain entries", async () => {
    const { parseChainArgument } = await import("../commands/advisor");
    assert.deepEqual(parseChainArgument(" a/b , c/d ,, "), ["a/b", "c/d"]);
    assert.deepEqual(parseChainArgument("a/b"), ["a/b"]);
    assert.deepEqual(parseChainArgument(""), []);
    assert.deepEqual(parseChainArgument("a/b, a/b"), ["a/b"]);
  });

  it("completion helpers split comma arguments (via completion surface)", async () => {
    const { pi, state } = createFakePi();
    piAdvisor(pi);
    const ctx = fakeCtx([]);
    ctx.modelRegistry.getAvailable = () => [
      { provider: "p", id: "m1", contextWindow: 8_000 },
      { provider: "p", id: "m2", contextWindow: 8_000 },
    ] as any;
    const cmd = state.commands.get("advisor");
    cmd.handler("status", ctx); // seeds the module-level registry
    // bare prefix → keywords + model refs
    const bare = cmd.getArgumentCompletions("gl");
    assert.ok(bare === null || bare.every((i: any) => !String(i.value).includes(",")), "no comma-carried prefix at top level");
    // typed head + fuzzy tail → every item value carries "head, " so the
    // kernel's whole-argument replacement preserves the first entry
    const chained = cmd.getArgumentCompletions("p/m1, m2").map((i: any) => i.value);
    assert.deepEqual(chained, ["p/m1, p/m2"], "post-comma completion preserves the typed head");
  });
});
