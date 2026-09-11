import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "mocha";
import { createRuntime, reviewTurn, SYSTEM, type WatcherHost, type IsolatedCall } from "../lib/watcher";
import type { AdvisorConfig } from "../lib/config";

// Injectable fake isolated-model call — tests never hit a provider.
// failFrom[n] fails the nth candidate (0-based) to simulate per-model errors.
let reply = "";
let failWith: Error | undefined;
let calls = 0;
const fake: IsolatedCall = async (_ctx, models) => {
  calls++;
  if (failWith) throw failWith;
  return { text: reply, model: models[0] ?? "" };
};

let host: any;
function makeHost(): any {
  const h = {
    cards: [] as any[],
    asides: [] as any[],
    userMessages: [] as any[],
    notifications: [] as string[],
    appendEntry: (customType: string, data: any) => h.cards.push({ customType, data }),
    sendMessage: (message: { customType: string; content: string; display: boolean; details?: unknown }, options?: any) => h.asides.push({ message, options }),
    sendUserMessage: (content: string, options?: any) => h.userMessages.push({ content, options }),
    notify: (message: string) => h.notifications.push(message),
  };
  return h;
}

function entries(toolCalls: number, startId = 1): any[] {
  const list: any[] = [{ type: "message", id: `m${startId}`, parentId: null, timestamp: `${startId}`, message: { role: "user", content: [{ type: "text", text: "do the thing" }], timestamp: startId } }];
  for (let i = 0; i < toolCalls; i++) {
    list.push({ type: "message", id: `t${startId}-${i}`, parentId: list[list.length - 1].id, timestamp: `${startId}${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `tc${startId}-${i}`, name: "read", arguments: {} }], timestamp: startId * 10 + i } });
    list.push({ type: "message", id: `r${startId}-${i}`, parentId: `t${startId}-${i}`, timestamp: `${startId}${i}r`, message: { role: "toolResult", toolCallId: `tc${startId}-${i}`, toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: startId * 10 + i + 0.5 } });
  }
  list.push({ type: "message", id: `a${startId}`, parentId: list[list.length - 1].id, timestamp: `${startId}a`, message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: startId * 10 + 9 } });
  return list;
}

function ctx(ents: any[], notifications?: { count: number }): any {
  return {
    sessionManager: {
      getEntries: () => ents,
      getLeafId: () => ents[ents.length - 1]?.id,
    },
    getSystemPrompt: () => "PRIMARY PROMPT",
    modelRegistry: { getAvailable: () => [], find: () => ({ contextWindow: 32_768 }) },
    ui: { notify: () => { if (notifications) notifications.count++; } },
  };
}

function config(over: Partial<AdvisorConfig["watch"]> = {}): AdvisorConfig {
  return { models: ["prov/reviewer", "prov/reviewer-backup"], watch: { enabled: true, minToolCalls: 3, immuneTurns: 3, ...over } };
}

function setup(toolCallCount: number, c: AdvisorConfig = config()) {
  return { rt: createRuntime(c, c.models), e: entries(toolCallCount) };
}

const asHost = (h: any): WatcherHost => h;

describe("reviewTurn", () => {
  beforeEach(() => {
    reply = "";
    failWith = undefined;
    calls = 0;
    host = makeHost();
  });

  it("never reviews when no advisor model is configured (primary model must not self-review)", async () => {
    const rt = createRuntime(config(), []);
    await reviewTurn(rt, ctx(entries(5)), asHost(host), fake);
    assert.equal(calls, 0);
    assert.equal(rt.stats.reviews, 0);
  });

  it("records the serving model from the chain on success", async () => {
    reply = '{"severity":"nit","note":"unused import in foo.ts"}';
    const { rt, e } = setup(5);
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    assert.equal(rt.stats.lastModel, "prov/reviewer", "first chain entry serves and is recorded");
  });

  it("skips trivial turns below minToolCalls without a model call", async () => {
    const { rt, e } = setup(2);
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    assert.equal(calls, 0);
    assert.equal(rt.stats.skippedTrivial, 1);
    assert.equal(rt.stats.reviews, 0);
  });

  it("threshold 0 reviews every turn", async () => {
    const { rt, e } = setup(1, config({ minToolCalls: 0 }));
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    assert.equal(calls, 1);
    assert.equal(rt.stats.reviews, 1);
  });

  it("second distinct concern within cooldown still steers (concerns never defer)", async () => {
    reply = '{"severity":"concern","note":"first concern about imports"}';
    const { rt, e } = setup(5);
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    assert.equal(host.userMessages.length, 1, "first concern steers");
    assert.equal(rt.steerCooldownTurns, 3, "steer arms the cooldown");
    // second distinct concern arrives inside the cooldown window → still steers:
    // concerns carry a must-address contract, only nits defer
    reply = '{"severity":"concern","note":"second distinct concern about tests"}';
    await reviewTurn(rt, ctx([...e, ...entries(4, 2)]), asHost(host), fake);
    assert.equal(host.userMessages.length, 2, "second concern steers despite cooldown");
    assert.equal(host.asides.length, 0, "no deferral for concerns");
    assert.equal(host.cards.length, 0, "no deferred card for concerns");
    assert.equal(rt.stats.concerns, 2, "still counted once per accepted note");
  });

  it("second distinct nit within cooldown is deferred to a next-turn aside", async () => {
    reply = '{"severity":"nit","note":"first nit about imports"}';
    const { rt, e } = setup(5);
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    assert.equal(host.userMessages.length, 1, "first nit steers");
    // second distinct nit arrives inside the cooldown window → deferred aside
    reply = '{"severity":"nit","note":"second distinct nit about tests"}';
    await reviewTurn(rt, ctx([...e, ...entries(4, 2)]), asHost(host), fake);
    assert.equal(host.userMessages.length, 1, "no second steer while on cooldown");
    assert.equal(host.asides.length, 1, "deferred as LLM-visible next-turn aside");
    assert.equal(host.asides[0].options?.deliverAs, "nextTurn");
    assert.equal(host.asides[0].message.display, false, "deferred LLM message is not displayed — the immediate card is the visible surface");
    assert.equal(host.asides[0].message.details.deferred, true, "message details carry the deferred flag (message-renderer label parity)");
    assert.equal(host.cards.length, 1, "deferred note gets an immediate display card");
    assert.equal(host.cards[0].data.deferred, true, "card marked deferred");
    assert.equal(host.cards[0].data.severity, "nit");
    assert.equal(host.cards[0].data.timestamp, host.asides[0].message.details.timestamp, "card and message share one timestamp");
    assert.ok(host.asides[0].message.content.includes("tests"));
    assert.equal(rt.stats.nits, 2, "still counted once per accepted note");
  });

  it("nit steers via sendUserMessage followUp (accepted notes all wake the idle agent)", async () => {
    reply = '{"severity":"nit","note":"unused import in foo.ts"}';
    const { rt, e } = setup(5);
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    // agent_settled is idle — there is no next step boundary, so a nit that
    // doesn't wake the agent is never acted on. All accepted notes steer.
    assert.equal(host.cards.length, 0);
    assert.equal(host.asides.length, 0, "nits no longer go to a non-interrupting aside at settle");
    assert.equal(host.userMessages.length, 1);
    assert.equal(host.userMessages[0].options?.deliverAs, "followUp");
    assert.ok(host.userMessages[0].content.includes("unused import in foo.ts"));
    assert.equal(rt.stats.nits, 1);
  });

  it("concern steers via sendUserMessage followUp", async () => {
    reply = '{"severity":"concern","note":"edit went to the wrong file"}';
    const { rt, e } = setup(5);
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    assert.equal(host.userMessages.length, 1);
    assert.equal(host.userMessages[0].options?.deliverAs, "followUp");
    assert.ok(host.userMessages[0].content.includes("wrong file"));
    assert.equal(rt.stats.concerns, 1);
  });

  it("nit after cooldown expires steers again (cooldown recovery cycle)", async () => {
    reply = '{"severity":"nit","note":"first nit about imports"}';
    const { rt, e } = setup(5);
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    assert.equal(host.userMessages.length, 1);
    assert.equal(rt.steerCooldownTurns, 3, "steer arms the cooldown (immuneTurns)");
    // Distinct nit inside the cooldown window → deferred aside
    reply = '{"severity":"nit","note":"second distinct nit about tests"}';
    await reviewTurn(rt, ctx([...e, ...entries(4, 2)]), asHost(host), fake);
    assert.equal(host.userMessages.length, 1, "second nit deferred while on cooldown");
    assert.equal(host.asides.length, 1, "deferred as next-turn aside");
    assert.equal(host.cards.length, 1, "deferred note gets an immediate display card");
    assert.equal(rt.stats.nits, 2);
    assert.equal(rt.steerCooldownTurns, 2, "cooldown ticks once per settled turn (deferral does not double-tick)");
    // Two more settled turns tick the cooldown 2→1→0 → the next nit steers.
    reply = '{"severity":"nit","note":"third distinct nit after cooldown"}';
    await reviewTurn(rt, ctx([...e, ...entries(4, 2), ...entries(4, 3)]), asHost(host), fake);
    assert.equal(host.userMessages.length, 1, "still deferred (cooldown 1 > 0)");
    reply = '{"severity":"nit","note":"fourth distinct nit after cooldown"}';
    await reviewTurn(rt, ctx([...e, ...entries(4, 2), ...entries(4, 3), ...entries(4, 4)]), asHost(host), fake);
    assert.equal(host.userMessages.length, 2, "nit steers again after cooldown expired");
    assert.equal(rt.steerCooldownTurns, 3, "steer re-arms cooldown");
  });

  it("blocker steers via followUp", async () => {
    reply = '{"severity":"concern","note":"first concern about imports"}';
    const { rt, e } = setup(5);
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    reply = '{"severity":"blocker","note":"escalation: the migration drops data"}';
    await reviewTurn(rt, ctx([...e, ...entries(4, 2)]), asHost(host), fake);
    assert.equal(host.userMessages.length, 2, "blocker steers");
    assert.equal(host.asides.length, 0);
    assert.equal((host.userMessages[1].content as any).includes("(blocker"), true);
    assert.equal(rt.stats.blockers, 1);
  });

  it("duplicate note is suppressed by the guard", async () => {
    reply = '{"severity":"nit","note":"unused import in foo.ts"}';
    const { rt, e } = setup(5);
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    await reviewTurn(rt, ctx([...e, ...entries(4, 2)]), asHost(host), fake);
    assert.equal(host.userMessages.length, 1, "identical note not repeated");
    assert.equal(rt.guard.counts.suppressed, 1);
  });

  it("empty and unparseable output are no-ops, unparseable counted", async () => {
    const { rt, e } = setup(5);
    reply = "";
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    assert.equal(rt.stats.reviews, 1);
    assert.equal(rt.stats.parseFailures, 0);
    reply = "I think everything is fine!";
    await reviewTurn(rt, ctx([...e, ...entries(4, 2)]), asHost(host), fake);
    assert.equal(rt.stats.parseFailures, 1);
    assert.equal(host.cards.length + host.userMessages.length, 0);
  });

  it("pauses after 3 consecutive model failures and notifies once", async () => {
    failWith = new Error("boom");
    const { rt, e } = setup(5);
    let list = e;
    for (let turn = 1; turn <= 4; turn++) {
      await reviewTurn(rt, ctx(list), asHost(host), fake);
      if (turn < 4) list = [...list, ...entries(4, turn + 1)];
    }
    assert.equal(rt.stats.modelFailures, 3, "third failure pauses; fourth skipped");
    assert.equal(rt.stats.paused, true);
    assert.equal(host.notifications.length, 1, "one pause notification via the liveness-gated host");
  });

  it("resumes after enableWatch clears pause", async () => {
    failWith = new Error("boom");
    const { rt, e } = setup(5);
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    await reviewTurn(rt, ctx([...e, ...entries(4, 2)]), asHost(host), fake);
    await reviewTurn(rt, ctx([...e, ...entries(4, 2), ...entries(4, 3)]), asHost(host), fake);
    assert.equal(rt.stats.paused, true);
    rt.stats.paused = false; rt.failures = 0; // what enableWatch does
    failWith = undefined;
    reply = '{"severity":"nit","note":"fresh note after recovery"}';
    await reviewTurn(rt, ctx([...e, ...entries(4, 2), ...entries(4, 3), ...entries(4, 4)]), asHost(host), fake);
    assert.equal(rt.stats.reviews, 1);
  });

  it("cursor still advances past the failed review", async () => {
    failWith = new Error("quota");
    const { rt, e } = setup(5);
    await reviewTurn(rt, ctx(e), asHost(host), fake);
    assert.equal(rt.cursor, e[e.length - 1].id);
  });

  it("chain exhaustion from per-model failures counts as ONE failure per turn", async () => {
    // Fake chain runner: both candidates fail → the chain throws once.
    const exhausting: IsolatedCall = async () => { throw new Error("429 rate limited"); };
    const { rt, e } = setup(5);
    await reviewTurn(rt, ctx(e), asHost(host), exhausting);
    assert.equal(rt.stats.modelFailures, 1, "whole-chain failure counts once");
    assert.equal(rt.stats.paused, false, "single turn failure does not pause");
  });

  it("runIsolatedChain: abort does not fall through to the next candidate", async () => {
    const { runIsolatedChain } = await import("../lib/isolated-model");
    const controller = new AbortController();
    controller.abort();
    // Pre-aborted signal → the chain refuses to start any candidate.
    await assert.rejects(
      runIsolatedChain({ modelRegistry: { getAvailable: () => [] } } as any, ["prov/a", "prov/b"], { systemPrompt: "", messages: [] }, undefined, controller.signal),
      /aborted/,
    );
  });
});

describe("cursor semantics", () => {
  beforeEach(() => {
    reply = "";
    failWith = undefined;
    calls = 0;
    host = makeHost();
  });

  it("counts only new tool calls since the previous review", async () => {
    const rt = createRuntime(config({ minToolCalls: 3 }), ["prov/reviewer"]);
    const first = entries(4);
    await reviewTurn(rt, ctx(first), asHost(host), fake);
    assert.equal(calls, 1);
    const second = [...first, ...entries(1, 2)]; // only 1 new tool call
    await reviewTurn(rt, ctx(second), asHost(host), fake);
    assert.equal(calls, 1, "second turn below threshold — no review");
    assert.equal(rt.stats.skippedTrivial, 1);
    const third = [...second, ...entries(5, 3)]; // 5 new tool calls
    await reviewTurn(rt, ctx(third), asHost(host), fake);
    assert.equal(calls, 2);
  });

  it("reviewer SYSTEM prompt matches delivery: every accepted note reaches the agent, nobody is card-only", () => {
    // Regression: a prompt claiming some severity is "surfaced as a card / does
    // not interrupt" would mis-calibrate the reviewer LLM against reviewTurn's
    // delivery (steer, or deferred LLM-visible next-turn aside during cooldown).
    // Pin the invariant: every accepted note is delivered and the agent responds.
    assert.ok(SYSTEM.includes("Every accepted note is delivered to the primary agent and it will respond"),
      "prompt must state every accepted note reaches the agent and it responds");
    assert.ok(/steering/.test(SYSTEM) && /deferred to the next turn as a visible note/.test(SYSTEM),
      "prompt must describe both steer and cooldown-deferred delivery");
    assert.ok(!/surfaced as a card|does not interrupt/.test(SYSTEM),
      "prompt must not claim any severity is non-interrupting / card-only");
  });
});
