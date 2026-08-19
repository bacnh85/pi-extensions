/**
 * Project-agent approval gate tests — Allow once / Trust for this session / Deny,
 * fail-closed on dismissed dialog and headless sessions, session_start clearing.
 * Runs the real subagent tool execute against a temp project agents dir; the
 * Deny/dismiss paths return before any SDK child-session machinery is needed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "mocha";
import subagentExtension from "../index.ts";

// index.ts resolves its bundled agents dir via __dirname (CJS target); under
// mocha/tsx ESM it's undefined — provide the module-local fallback.
if (typeof (globalThis as any).__dirname === "undefined") {
  (globalThis as any).__dirname = path.dirname(new URL(import.meta.url).pathname);
}

function harness(ui: { select?: (t: string, o: string[]) => Promise<string | undefined> }) {
  const handlers: Record<string, any[]> = {};
  const tools: any[] = [];
  const pi: any = {
    on: (e: string, h: any) => { (handlers[e] ??= []).push(h); },
    registerTool: (def: any) => { tools.push(def); },
    registerCommand: () => {},
    registerFlag: () => {},
    registerShortcut: () => {},
    getAllTools: () => [],
    getFlag: () => undefined,
    events: { on: () => {} },
  };
  subagentExtension(pi);
  const tool = tools.find((t) => t.name === "subagent");
  const ctx: any = {
    cwd: undefined, // set per test
    hasUI: true,
    isProjectTrusted: () => false,
    ui: { notify: () => {}, ...(ui.select ? { select: ui.select } : {}) },
  };
  return { handlers, tool, ctx };
}

function makeProjectAgentDir() {
  const root = mkdtempSync(path.join(os.tmpdir(), "subagent-gate-"));
  const dir = path.join(root, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "proj-worker.md"), "---\nname: proj-worker\ndescription: project test agent\n---\nDo the thing.");
  return { root, dir };
}

describe("project-agent approval gate", () => {
  it("Deny refuses execution", async () => {
    const { root } = makeProjectAgentDir();
    try {
      const { tool, ctx } = harness({ select: async () => "Deny" });
      ctx.cwd = root;
      const r = await tool.execute("id", { agent: "proj-worker", task: "x", agentScope: "project" }, new AbortController().signal, undefined, ctx);
      assert.match(r.content[0].text, /not approved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("dismissed dialog (Esc) fails closed", async () => {
    const { root } = makeProjectAgentDir();
    try {
      const { tool, ctx } = harness({ select: async () => undefined });
      ctx.cwd = root;
      const r = await tool.execute("id", { agent: "proj-worker", task: "x", agentScope: "project" }, new AbortController().signal, undefined, ctx);
      assert.match(r.content[0].text, /not approved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("headless session fails closed", async () => {
    const { root } = makeProjectAgentDir();
    try {
      const { tool, ctx } = harness({});
      ctx.cwd = root;
      ctx.hasUI = false;
      const r = await tool.execute("id", { agent: "proj-worker", task: "x", agentScope: "project" }, new AbortController().signal, undefined, ctx);
      assert.match(r.content[0].text, /require explicit user approval/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("'Trust for this session' suppresses re-prompts for the same dir; session_start clears", async () => {
    const { root } = makeProjectAgentDir();
    try {
      let prompts = 0;
      const choices = ["Trust for this session", "Deny"];
      const { tool, ctx, handlers } = harness({ select: async () => { prompts++; return choices.shift() ?? "Deny"; } });
      ctx.cwd = root;
      // First call: trust the dir. It will proceed past the gate and fail on
      // missing child-session machinery — irrelevant; the gate result is what we assert.
      await tool.execute("id", { agent: "proj-worker", task: "x", agentScope: "project" }, new AbortController().signal, undefined, ctx).catch(() => {});
      assert.equal(prompts, 1);
      // Second call: same dir → remembered, no prompt (would be "Deny" if asked).
      await tool.execute("id", { agent: "proj-worker", task: "y", agentScope: "project" }, new AbortController().signal, undefined, ctx).catch(() => {});
      assert.equal(prompts, 1, "trusted dir skips re-prompt");
      // session_start clears trust.
      await handlers.session_start[0]({ reason: "new" }, ctx);
      await tool.execute("id", { agent: "proj-worker", task: "z", agentScope: "project" }, new AbortController().signal, undefined, ctx).catch(() => {});
      assert.equal(prompts, 2, "session_start cleared trusted dirs");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
