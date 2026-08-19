// Lifecycle test: wire the real extension into a stub ExtensionAPI and drive the
// anchor lifecycle: session_start → before_agent_start (#1 bootstrap) →
// before_provider_request (tool filter) → tool_call (guards) → turn_end
// (promote) → before_agent_start #2 (full prompt path).

import assert from "node:assert";
import ext from "../../index.ts";

type Hook = (event: any, ctx: any) => any;
const hooks = new Map<string, Hook[]>();
const stub = {
  registerTool: () => {},
  registerCommand: () => {},
  on: (name: string, fn: Hook) => { (hooks.get(name) ?? hooks.set(name, []).get(name)!).push(fn); },
  getActiveTools: () => ["bash", "read", "edit", "grep"],
  getAllTools: () => ["bash", "read", "edit", "grep"].map((name) => ({ name })),
  sendMessage: () => {},
};
ext(stub as any);

const ctx = (id: string) => ({
  model: { id, provider: "test" },
  sessionManager: { getEntries: () => entries },
  cwd: "/tmp",
  ui: { notify: () => {} },
});
let entries: any[] = [];
const fire = (name: string, event: any, c: any) => { let last: any; for (const h of hooks.get(name) ?? []) last = h(event, c) ?? last; return last; };

const PRO = "deepseek-v4-pro-0813";

// 1. session_start with a target model, empty durable history
fire("session_start", {}, ctx(PRO));

// 2. first agent run → bootstrap: minimal prompt, no guidance
const r1 = fire("before_agent_start", { prompt: "do a task", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, ctx(PRO));
assert.equal(r1?.systemPrompt, "You are a helpful software engineer assistant.", "request #1 gets the Minimal prompt");

// 3. provider request → tools replaced with the byte-exact DSH Minimal pair
const payload = { model: PRO, messages: [], tools: [
  { name: "bash", parameters: {} }, { name: "str_replace_editor", parameters: {} },
  { name: "edit", parameters: {} }, { name: "read", parameters: {} }, { name: "grep", parameters: {} },
] };
const out = fire("before_provider_request", { payload }, ctx(PRO));
assert.deepEqual(out.tools.map((t: any) => t?.function?.name ?? t?.name), ["bash", "str_replace_editor"], "payload tools replaced with the DSH Minimal pair (flat shape preserved)");
assert.equal(out.tools[0].description.length > 100, true, "DSH bash description is present");
assert.equal(out.tools[1].parameters.properties.command.enum.length, 4, "str_replace_editor command enum present");
assert.equal(out.tools[1].strict, undefined, "no strict field (DSH schema has none)");
assert.equal(out.max_tokens, 256000, "bootstrap budget matches DSH's captured payload");

// 4. tool_call during bootstrap: hidden tool blocked, bash + editor allowed
const blocked = fire("tool_call", { toolName: "read", input: {} }, ctx(PRO));
assert.equal(blocked?.block, true, "hidden tool (read) blocked during bootstrap");
const blockedEdit = fire("tool_call", { toolName: "edit", input: {} }, ctx(PRO));
assert.equal(blockedEdit?.block, true, "hidden tool (edit) blocked during bootstrap");
const okBash = fire("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx(PRO));
assert.equal(okBash, undefined, "bash allowed during bootstrap");
const okEditor = fire("tool_call", { toolName: "str_replace_editor", input: { command: "view", path: "/x" } }, ctx(PRO));
assert.equal(okEditor, undefined, "str_replace_editor allowed during bootstrap");

// 5. assistant reply lands durably → turn_end promotes
entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall" }] } });
fire("turn_end", { turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] }, ctx(PRO));

// 6. second agent run → NOT minimal; full-prompt path (returns undefined when unchanged)
const r2 = fire("before_agent_start", { prompt: "next task", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, ctx(PRO));
assert.notEqual(r2?.systemPrompt, "You are a helpful software engineer assistant.", "request #2 uses the full prompt");

// 7. provider request #2 → tools NOT filtered, budget NOT pinned
const out2 = fire("before_provider_request", { payload }, ctx(PRO));
assert.equal(out2?.tools, undefined, "no tool filtering after promotion (payload untouched or guidance-only)");
assert.notEqual(out2?.max_tokens, 256000, "budget pin is bootstrap-only");

// 8. non-target model: anchor inert from the start
entries = [];
fire("session_start", {}, ctx("deepseek-v4-flash"));
const rFlash = fire("before_agent_start", { prompt: "x", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, ctx("deepseek-v4-flash"));
assert.notEqual(rFlash?.systemPrompt, "You are a helpful software engineer assistant.", "flash model: normal guidance path, no anchor");
assert.ok(rFlash.systemPrompt.includes("FULL PI PROMPT"), "flash keeps the full prompt");

// 9. resume edge: target session with existing assistant reply → instantly promoted
entries = [{ type: "message", message: { role: "assistant", content: [{ type: "text" }] } }];
fire("session_start", {}, ctx(PRO));
const rResume = fire("before_agent_start", { prompt: "continue", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, ctx(PRO));
assert.notEqual(rResume?.systemPrompt, "You are a helpful software engineer assistant.", "resumed session with replies: no bootstrap");
assert.ok(rResume.systemPrompt.includes("FULL PI PROMPT"), "resumed session keeps the full prompt");

// 10. REGRESSION: session starts as FLASH (a2a gateway agent config), proxy
// silently serves deepseek-v4-pro — model_select NEVER fires. The anchor must
// still engage on the first agent run (live failure: anchorReady was latched
// only at session_start/model_select, so the bootstrap silently skipped).
entries = []; // genuinely fresh session — no durable replies yet
const ctxServed = { model: { id: "deepseek/deepseek-v4-pro", provider: "opencode-go" }, sessionManager: { getEntries: () => entries }, cwd: "/tmp", ui: { notify: () => {} } };
fire("session_start", {}, ctx("opencode-go/deepseek-v4-flash"));
const rRewritten = fire("before_agent_start", { prompt: "task", systemPrompt: "FULL PI PROMPT", systemPromptOptions: {} }, ctxServed);
assert.equal(rRewritten?.systemPrompt, "You are a helpful software engineer assistant.", "served-pro session bootstraps even though session started as flash");
const outRewritten = fire("before_provider_request", { payload }, ctxServed);
assert.deepEqual(outRewritten.tools.map((t: any) => t?.function?.name ?? t?.name), ["bash", "str_replace_editor"], "rewritten session gets the DSH Minimal pair");

// 11. anchor trace surfaces in the status command output
const hooks2 = new Map<string, Hook[]>();
const commands2: Record<string, any> = {};
const stub2 = {
  registerTool: () => {},
  registerCommand: (name: string, def: any) => { commands2[name] = def; },
  on: (name: string, fn: Hook) => { (hooks2.get(name) ?? hooks2.set(name, []).get(name)!).push(fn); },
  getActiveTools: () => ["bash", "read", "edit", "str_replace_editor"],
  getAllTools: () => ["bash", "read", "edit", "str_replace_editor"].map((name) => ({ name })),
  sendMessage: () => {},
};
ext(stub2 as any);
const entries2: any[] = [];
const ctx2 = { model: { id: "deepseek-v4-pro" }, sessionManager: { getEntries: () => entries2 }, cwd: "/tmp", ui: { notify: () => {} } };
const fire2 = (name: string, event: any, c: any) => { let last: any; for (const h of hooks2.get(name) ?? []) last = h(event, c) ?? last; return last; };
fire2("session_start", {}, ctx2);
fire2("before_agent_start", { prompt: "x", systemPrompt: "FULL", systemPromptOptions: {} }, ctx2);
fire2("before_provider_request", { payload: { tools: [{ name: "bash" }, { name: "str_replace_editor" }] } }, ctx2);
let statusText = "";
commands2["model-tools-status"].handler({}, { model: ctx2.model, ui: { notify: (t: string) => { statusText = t; } } });
assert.match(statusText, /bootstrap: minimal prompt engaged/, "trace shows bootstrap engagement");
assert.match(statusText, /payload: tools=\[bash,str_replace_editor\] \+ max_tokens=256000/, "trace shows the bootstrap payload + DSH budget");

console.log("ds-anchor wiring: all lifecycle checks passed");
