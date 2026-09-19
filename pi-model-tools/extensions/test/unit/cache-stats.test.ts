// turn_end cache-stats guard: usage fields that are missing, undefined, or NaN
// must fall back to 0 — never poison the session sums or the hit-rate display.
import assert from "node:assert";
import { describe, it } from "node:test";
import ext from "../../index.ts";

type Hook = (event: any, ctx: any) => any;

function makeHarness() {
  const hooks = new Map<string, Hook[]>();
  const commands: Record<string, any> = {};
  const stub = {
    registerTool: () => {},
    registerCommand: (name: string, def: any) => { commands[name] = def; },
    on: (name: string, fn: Hook) => { (hooks.get(name) ?? hooks.set(name, []).get(name)!).push(fn); },
    getActiveTools: () => ["bash", "read", "edit", "str_replace_editor"],
    getAllTools: () => ["bash", "read", "edit", "str_replace_editor"].map((name) => ({ name })),
    sendMessage: () => {},
  };
  ext(stub as any);
  const ctx = () => ({ model: { id: "glm-5.2", provider: "test" }, cwd: "/tmp", ui: { notify: () => {} } });
  const fire = (name: string, event: any) => { let last: any; for (const h of hooks.get(name) ?? []) last = h(event, ctx()) ?? last; return last; };
  const status = () => { let text = ""; commands["model-tools-status"].handler({}, { model: ctx().model, ui: { notify: (t: string) => { text = t; } } }); return text; };
  return { fire, status };
}

describe("turn_end cache stats", () => {
  it("missing usage fields fall back to 0 (counts as a miss turn)", () => {
    const h = makeHarness();
    h.fire("session_start", {});
    h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", usage: { input: 100 } }, toolResults: [] });
    const text = h.status();
    assert.ok(text.includes("Input: 100 · cached: 0 · written: 0"), `missing fields → zeros, got: ${text.split("Prompt cache")[1]}`);
    assert.ok(text.includes("0 hit turns · 1 miss turns"), "no cacheRead → miss turn");
  });

  it("NaN usage fields fall back to 0 (no NaN poisoning)", () => {
    const h = makeHarness();
    h.fire("session_start", {});
    h.fire("turn_end", { turnIndex: 0, message: { role: "assistant", usage: { input: 50, cacheRead: NaN, cacheWrite: undefined } }, toolResults: [] });
    h.fire("turn_end", { turnIndex: 1, message: { role: "assistant", usage: { input: NaN, cacheRead: 80, cacheWrite: "7" as unknown as number } }, toolResults: [] });
    const text = h.status();
    const cacheBlock = text.split("**Prompt cache (this session):**")[1] ?? "";
    assert.ok(cacheBlock.length > 0, "cache block still shown (input > 0 survives the guard)");
    assert.ok(!cacheBlock.includes("NaN"), `no NaN in status, got: ${cacheBlock}`);
    assert.ok(cacheBlock.includes("Input: 50 · cached: 80 · written: 0"), `NaN fields contribute 0, got: ${cacheBlock}`);
    assert.ok(cacheBlock.includes("1 hit turns · 1 miss turns"), "NaN cacheRead counts as miss, real cacheRead as hit");
  });
});
