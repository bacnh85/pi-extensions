import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "mocha";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { createRuntime, reviewTurn } from "../lib/watcher";

function toolCalls(n: number): any[] {
  const list: any[] = [{ type: "message", id: "e0", parentId: null, timestamp: "0", message: { role: "user", content: [{ type: "text", text: "task" }], timestamp: 0 } }];
  for (let i = 1; i <= n; i++) {
    list.push({ type: "message", id: `t${i}`, parentId: list[list.length - 1].id, timestamp: `${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `tc${i}`, name: "read", arguments: {} }], timestamp: i } });
    list.push({ type: "message", id: `r${i}`, parentId: `t${i}`, timestamp: `${i}r`, message: { role: "toolResult", toolCallId: `tc${i}`, toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: i + 0.5 } });
  }
  list.push({ type: "message", id: `a${n}`, parentId: list[list.length - 1].id, timestamp: `${n}a`, message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: n + 1 } });
  return list;
}

describe("advisor compliance", () => {
  let reply = "";
  const fake = async (_ctx: any, models: readonly string[]) => ({ text: reply, model: models[0] ?? "" });
  const cfg = { models: ["prov/reviewer"], watch: { enabled: true, minToolCalls: 3, immuneTurns: 3 } } as any;

  function ctxFor(entries: any[]): any {
    return {
      sessionManager: { getEntries: () => entries, getLeafId: () => entries[entries.length - 1]?.id },
      getSystemPrompt: () => "Primary system prompt",
      modelRegistry: { getAvailable: () => [], find: () => ({ contextWindow: 32_768 }) },
      ui: { notify: () => {} },
    };
  }

  // Capture all session entries the watcher produces, then rebuild the
  // next-turn LLM context with the real SDK. A compliant note MUST appear
  // as a user message there; a display-only entry proves it was ignored.
  function hostFor(capture: any[]): any {
    return {
      appendEntry: () => capture.push({ kind: "appendEntry" }),
      sendMessage: (message: { customType: string; content: string }) => capture.push({ kind: "custom_message", message }),
      sendUserMessage: (content: string) => capture.push({ kind: "user", message: { content } }),
    };
  }

  function contextHasNote(capture: any[], note: string, base: any[]): boolean {
    const entries: any[] = [...base];
    for (const item of capture) {
      if (item.kind === "custom_message") entries.push({ type: "custom_message", id: `adv-${entries.length}`, parentId: entries[entries.length - 1]?.id, timestamp: `${entries.length}`, customType: "pi-advisor", content: item.message.content, details: item.message.details, display: item.message.display });
      else if (item.kind === "appendEntry") entries.push({ type: "custom", id: `card-${entries.length}`, parentId: entries[entries.length - 1]?.id, timestamp: `${entries.length}`, customType: "pi-advisor", data: {} });
      else if (item.kind === "user") entries.push({ type: "message", id: `u-${entries.length}`, parentId: entries[entries.length - 1]?.id, timestamp: `${entries.length}`, message: { role: "user", content: [{ type: "text", text: item.message.content }], timestamp: entries.length } });
    }
    const snap = buildSessionContext(entries, entries[entries.length - 1]?.id ?? "");
    const llm = convertToLlm(snap.messages as any) as any[];
    return llm.some((m: any) => m.role === "user" && JSON.stringify(m.content ?? "").includes(note));
  }

  beforeEach(() => { reply = ""; });

  it("nit is in LLM context on the next turn (via sendUserMessage, not display-only card)", async () => {
    reply = '{"severity":"nit","note":"unused import in foo.ts"}';
    const rt = (await import("../lib/watcher")).createRuntime(cfg, cfg.models);
    const base = toolCalls(4);
    const capture: any[] = [];
    await reviewTurn(rt, ctxFor(base), hostFor(capture), fake as any);
    // At agent_settled the turn is idle — no next step boundary exists, so an
    // accepted note (any severity) must steer a turn to be acted on at all.
    assert.ok(capture.some((c: any) => c.kind === "user"), "nit delivered via sendUserMessage (steers a turn)");
    assert.ok(!capture.some((c: any) => c.kind === "appendEntry"), "no display-only appendEntry");
    assert.ok(!capture.some((c: any) => c.kind === "custom_message"), "no non-interrupting aside at settle");
    assert.ok(contextHasNote(capture, "unused import in foo.ts", base), "nit visible to LLM on next turn");
  });

  it("concern outside cooldown steers (user message, triggers turn)", async () => {
    reply = '{"severity":"concern","note":"edit went to the wrong file"}';
    const rt = (await import("../lib/watcher")).createRuntime(cfg, cfg.models);
    const base = toolCalls(4);
    const capture: any[] = [];
    await reviewTurn(rt, ctxFor(base), hostFor(capture), fake as any);
    assert.ok(capture.some((c: any) => c.kind === "user"), "concern steers via user message");
    assert.ok(contextHasNote(capture, "edit went to the wrong file", base));
  });

  it("second distinct concern inside cooldown still steers (concerns never defer)", async () => {
    const rt = (await import("../lib/watcher")).createRuntime(cfg, cfg.models);
    let base = toolCalls(4);
    reply = '{"severity":"concern","note":"first concern"}';
    await reviewTurn(rt, ctxFor(base), hostFor([]), fake as any);
    const extra = toolCalls(4).slice(1).map((e, i) => ({ ...e, id: `e2-${e.id}`, parentId: i === 0 ? base[base.length - 1].id : `e2-${toolCalls(4).slice(1)[i - 1].id}` })) as any[];
    const base2 = [...base, ...extra];
    reply = '{"severity":"concern","note":"second concern"}';
    const capture: any[] = [];
    await reviewTurn(rt, ctxFor(base2), hostFor(capture), fake as any);
    // Concerns carry a must-address contract — they steer even inside the
    // immuneTurns cooldown. Only nits defer (nit ping-pong guard).
    assert.ok(capture.some((c: any) => c.kind === "user"), "second concern steers despite cooldown");
    assert.ok(contextHasNote(capture, "second concern", base2), "concern visible to LLM via the steer");
  });

  it("second distinct nit inside cooldown is deferred to a next-turn aside", async () => {
    const rt = (await import("../lib/watcher")).createRuntime(cfg, cfg.models);
    let base = toolCalls(4);
    reply = '{"severity":"nit","note":"first nit"}';
    await reviewTurn(rt, ctxFor(base), hostFor([]), fake as any);
    const extra = toolCalls(4).slice(1).map((e, i) => ({ ...e, id: `e2-${e.id}`, parentId: i === 0 ? base[base.length - 1].id : `e2-${toolCalls(4).slice(1)[i - 1].id}` })) as any[];
    const base2 = [...base, ...extra];
    reply = '{"severity":"nit","note":"second nit"}';
    const capture: any[] = [];
    await reviewTurn(rt, ctxFor(base2), hostFor(capture), fake as any);
    // Nits inside the immuneTurns cooldown → deferred aside, LLM-visible next
    // turn, not a wake. Guards the nit ping-pong without delaying concerns.
    assert.ok(!capture.some((c: any) => c.kind === "user"), "second nit deferred while on cooldown");
    assert.ok(capture.some((c: any) => c.kind === "custom_message"), "deferred as LLM-visible next-turn aside");
    assert.ok(contextHasNote(capture, "second nit", base2), "deferred note visible to LLM on next turn");
  });

  it("steer content has severity-specific authority and no control/bidi chars", async () => {
    reply = '{"severity":"blocker","note":"hal\\u200Blo\\u202E"}';
    const rt = (await import("../lib/watcher")).createRuntime(cfg, cfg.models);
    const capture: any[] = [];
    await reviewTurn(rt, ctxFor(toolCalls(4)), hostFor(capture), fake as any);
    const text = capture[0]?.message?.content ?? capture[0]?.content ?? "";
    assert.ok(text.includes("(blocker — fix before continuing)"), "blocker template carries authority");
    assert.equal(text.includes("\u200B"), false, "zero-width stripped");
    assert.equal(text.includes("\u202E"), false, "bidi override stripped");
  });
});
