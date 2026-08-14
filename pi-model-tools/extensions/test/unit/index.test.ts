import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import extension from "../../index.ts";

// Stub harness: the extension must compose with the host's OWN tool
// registrations, so this fake ExtensionAPI records what pi-model-tools
// registers and lets tests drive the hooks it subscribed to. Host built-ins
// carry sourceInfo.source === "builtin"; apply_patch defaults to our package
// identity. Options simulate a sandboxing extension: `withSandbox` makes it own
// the host file tools, `withForeignApplyPatch` makes the live apply_patch
// belong to the sandbox (host first-registration-per-name), `withRequestAccess`
// adds the access-granting tool.
function createHarness(opts: { withSandbox?: boolean; withForeignApplyPatch?: boolean; withRequestAccess?: boolean } = {}) {
  const registeredTools: string[] = [];
  const commands: Record<string, unknown> = {};
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const sentMessages: Array<{ type: string; content: string }> = [];

  const readSchema = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer()), limit: Type.Optional(Type.Integer()) });
  const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });
  const editSchema = Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })) });
  const genericSchema = Type.Object({ pattern: Type.String(), path: Type.String() });
  const schemas: Record<string, unknown> = { read: readSchema, write: writeSchema, edit: editSchema, grep: genericSchema, find: genericSchema, ls: genericSchema, bash: Type.Object({ command: Type.String() }) };

  const toolInfos: unknown[] = [];
  const base = ["read", "write", "edit", "grep", "find", "ls", "bash", "apply_patch"];
  const hostBuiltins = new Set(["read", "write", "edit", "grep", "find", "ls", "bash"]);
  if (opts.withRequestAccess) base.push("request_access");
  for (const name of base) {
    let source = hostBuiltins.has(name) ? "builtin" : "@bacnh85/pi-model-tools";
    if (hostBuiltins.has(name) && opts.withSandbox) source = "some-sandbox";
    if (name === "apply_patch" && opts.withForeignApplyPatch) source = "some-sandbox";
    toolInfos.push({
      name,
      description: name,
      parameters: schemas[name],
      promptGuidelines: [],
      promptSnippet: name,
      sourceInfo: { source },
    });
  }

  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: (tool: { name: string }) => { registeredTools.push(tool.name); },
    registerCommand: (name: string, options: unknown) => { commands[name] = options; },
    getAllTools: () => toolInfos,
    getActiveTools: () => base,
    sendMessage: (msg: { customType: string; content: unknown }) => { sentMessages.push({ type: msg.customType, content: String(msg.content) }); },
  } as unknown as ExtensionAPI;

  return {
    pi,
    registeredTools,
    commands,
    sentMessages,
    emit: async (event: string, ...args: unknown[]): Promise<unknown[]> => {
      const out: unknown[] = [];
      for (const h of handlers.get(event) ?? []) out.push(await (h as (...a: unknown[]) => unknown)(...args));
      return out;
    },
  };
}

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) { saved.set(k, process.env[k]); process.env[k] = v; }
  try { await fn(); } finally { for (const [k] of Object.entries(env)) process.env[k] = saved.get(k); }
}

describe("pi-model-tools hook-only registration", () => {
  it("does NOT re-register the built-in tools (only apply_patch by default)", async () => {
    await withEnv({ PI_MODEL_TOOLS_APPLY_PATCH: "1" }, () => {
      const h = createHarness();
      extension(h.pi);
      assert.deepStrictEqual([...h.registeredTools].sort(), ["apply_patch"]);
    });
  });

  it("skips apply_patch registration when PI_MODEL_TOOLS_APPLY_PATCH=0", async () => {
    await withEnv({ PI_MODEL_TOOLS_APPLY_PATCH: "0" }, () => {
      const h = createHarness();
      extension(h.pi);
      assert.deepStrictEqual(h.registeredTools, []);
    });
  });

  it("registers the /model-tools-status command", () => {
    const h = createHarness();
    extension(h.pi);
    assert.ok(h.commands["model-tools-status"], "expected model-tools-status command");
  });
});

describe("session_start sandbox detection (generic, extension-agnostic)", () => {
  it("auto-detects a sandbox when an extension owns the host file tools", async () => {
    await withEnv({ PI_MODEL_TOOLS_APPLY_PATCH: "1" }, async () => {
      const h = createHarness({ withSandbox: true });
      extension(h.pi);
      await h.emit("session_start", {}, { model: { id: "deepseek-v4-flash", provider: "opencode-go" } });
      const [result] = await h.emit("tool_call", { toolName: "apply_patch", input: { patch: "*** Begin Patch" } }, { cwd: process.cwd() });
      assert.ok(result && typeof result === "object" && "block" in result, "expected a block result");
      assert.strictEqual((result as { block: boolean }).block, true);
    });
  });

  it("declares a sandbox via PI_TOOLS_ARE_SANDBOXED even without auto-detection", async () => {
    await withEnv({ PI_MODEL_TOOLS_APPLY_PATCH: "1", PI_TOOLS_ARE_SANDBOXED: "1" }, async () => {
      const h = createHarness();
      extension(h.pi);
      await h.emit("session_start", {}, { model: { id: "deepseek-v4-flash", provider: "opencode-go" } });
      const [result] = await h.emit("tool_call", { toolName: "apply_patch", input: { patch: "*** Begin Patch" } }, { cwd: process.cwd() });
      assert.strictEqual((result as { block: boolean }).block, true);
    });
  });

  it("PI_TOOLS_ARE_SANDBOXED=0 overrides auto-detection", async () => {
    await withEnv({ PI_MODEL_TOOLS_APPLY_PATCH: "1", PI_TOOLS_ARE_SANDBOXED: "0" }, async () => {
      const h = createHarness({ withSandbox: true });
      extension(h.pi);
      await h.emit("session_start", {}, { model: { id: "deepseek-v4-flash", provider: "opencode-go" } });
      const [result] = await h.emit("tool_call", { toolName: "apply_patch", input: { patch: "*** Begin Patch" } }, { cwd: process.cwd() });
      assert.strictEqual(result, undefined);
    });
  });

  it("allows apply_patch when no sandboxing extension is present", async () => {
    const h = createHarness();
    extension(h.pi);
    await h.emit("session_start", {}, { model: { id: "deepseek-v4-flash", provider: "opencode-go" } });
    const [result] = await h.emit("tool_call", { toolName: "apply_patch", input: { patch: "*** Begin Patch" } }, { cwd: process.cwd() });
    assert.strictEqual(result, undefined);
  });

  it("does NOT block a sandbox-owned apply_patch (host first-registration-per-name)", async () => {
    const h = createHarness({ withSandbox: true, withForeignApplyPatch: true });
    extension(h.pi);
    await h.emit("session_start", {}, { model: { id: "deepseek-v4-flash", provider: "opencode-go" } });
    const [result] = await h.emit("tool_call", { toolName: "apply_patch", input: { patch: "*** Begin Patch" } }, { cwd: process.cwd() });
    assert.strictEqual(result, undefined);
  });

  it("blocks apply_patch only AFTER session_start snapshotted the tools (load-order independence)", async () => {
    const h = createHarness({ withSandbox: true });
    extension(h.pi);
    const [before] = await h.emit("tool_call", { toolName: "apply_patch", input: { patch: "x" } }, { cwd: process.cwd() });
    assert.strictEqual(before, undefined, "no block before session_start snapshot");
    await h.emit("session_start", {}, { model: { id: "deepseek-v4-flash", provider: "opencode-go" } });
    const [after] = await h.emit("tool_call", { toolName: "apply_patch", input: { patch: "x" } }, { cwd: process.cwd() });
    assert.strictEqual((after as { block: boolean }).block, true);
  });
});

describe("apply_patch LLM steering in sandboxed sessions", () => {
  const deepseekCtx = { model: { id: "deepseek-v4-flash", provider: "opencode-go" } };
  const agentStartEvent = { systemPrompt: "BASE", prompt: "", systemPromptOptions: { selectedTools: [] } };

  it("suppresses apply_patch guidance while OUR apply_patch is blocked in a sandbox", async () => {
    await withEnv({ PI_MODEL_TOOLS_SELECTION_GUIDANCE: "0" }, async () => {
      const h = createHarness({ withSandbox: true });
      extension(h.pi);
      await h.emit("session_start", {}, deepseekCtx);
      const [result] = await h.emit("before_agent_start", agentStartEvent, deepseekCtx);
      assert.strictEqual(result, undefined, "no system-prompt change when the only possible edit hint is suppressed");
    });
  });

  it("still suggests a sandbox-owned apply_patch (usable, so guidance fires)", async () => {
    await withEnv({ PI_MODEL_TOOLS_SELECTION_GUIDANCE: "0" }, async () => {
      const h = createHarness({ withSandbox: true, withForeignApplyPatch: true });
      extension(h.pi);
      await h.emit("session_start", {}, deepseekCtx);
      const [result] = await h.emit("before_agent_start", agentStartEvent, deepseekCtx);
      const prompt = (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
      assert.match(prompt, /apply_patch/);
    });
  });

  it("suggests apply_patch normally outside a sandbox", async () => {
    await withEnv({ PI_MODEL_TOOLS_SELECTION_GUIDANCE: "0" }, async () => {
      const h = createHarness();
      extension(h.pi);
      await h.emit("session_start", {}, deepseekCtx);
      const [result] = await h.emit("before_agent_start", agentStartEvent, deepseekCtx);
      const prompt = (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
      assert.match(prompt, /apply_patch/);
    });
  });
});

describe("tool_call edit pre-flight (in-place mutation)", () => {
  it("rewrites indentation-drifted oldText to the file's real bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmt-prefly-"));
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "  a\n    b\n  c");
      const h = createHarness();
      extension(h.pi);
      await h.emit("session_start", {}, { model: undefined });
      const event = { toolName: "edit", input: { path: file, edits: [{ oldText: "a\nb", newText: "A\nB" }] } };
      const [result] = await h.emit("tool_call", event, { cwd: dir, model: undefined });
      assert.strictEqual(result, undefined, "pre-flight must not block");
      assert.deepStrictEqual(event.input.edits[0].oldText, "  a\n    b");
      assert.deepStrictEqual(event.input.edits[0].newText, "A\nB");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("tool_call argument repair (in-place mutation)", () => {
  it("repairs a degenerate markdown-link path on read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmt-repair-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "foo.ts"), "export const x = 1;\n");
      const h = createHarness();
      extension(h.pi);
      await h.emit("session_start", {}, { model: { id: "deepseek-v4-flash", provider: "opencode-go" } });
      const event = { toolName: "read", input: { path: "[src/foo.ts](https://src/foo.ts)", offset: 1, limit: 2000 } };
      await withEnv({ PI_MODEL_TOOLS_REPAIR_ENABLED: "1" }, async () => {
        const [result] = await h.emit("tool_call", event, { cwd: dir, model: undefined });
        assert.strictEqual(result, undefined);
      });
      assert.strictEqual(event.input.path, "src/foo.ts");
      assert.strictEqual(event.input.offset, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("leaves valid args untouched (no repair side effects)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmt-noop-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "foo.ts"), "export const x = 1;\n");
      const h = createHarness();
      extension(h.pi);
      await h.emit("session_start", {}, { model: { id: "deepseek-v4-flash", provider: "opencode-go" } });
      const event = { toolName: "read", input: { path: "src/foo.ts", offset: 1, limit: 2000 } };
      await withEnv({ PI_MODEL_TOOLS_REPAIR_ENABLED: "1" }, async () => {
        await h.emit("tool_call", event, { cwd: dir, model: undefined });
      });
      assert.deepStrictEqual(event.input, { path: "src/foo.ts", offset: 1, limit: 2000 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("tool_call dangerous-command guard", () => {
  it("blocks `rm -rf /` on bash regardless of family", async () => {
    await withEnv({ PI_MODEL_TOOLS_BLOCK_DANGEROUS_COMMANDS: "1" }, async () => {
      const h = createHarness();
      extension(h.pi);
      const [result] = await h.emit("tool_call", { toolName: "bash", input: { command: "rm -rf /" } }, { cwd: process.cwd() });
      assert.ok(result && (result as { block: boolean }).block, "expected a block");
    });
  });

  it("does not block ordinary bash commands", async () => {
    await withEnv({ PI_MODEL_TOOLS_BLOCK_DANGEROUS_COMMANDS: "1" }, async () => {
      const h = createHarness();
      extension(h.pi);
      const [result] = await h.emit("tool_call", { toolName: "bash", input: { command: "git status" } }, { cwd: process.cwd() });
      assert.strictEqual(result, undefined);
    });
  });
});

describe("tool_call read-on-guessed-path guard", () => {
  it("blocks reading a non-existent code path and suggests find", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmt-read-"));
    try {
      const h = createHarness();
      extension(h.pi);
      await h.emit("session_start", {}, { model: undefined });
      const event = { toolName: "read", input: { path: "src/foo.ts", offset: 1, limit: 2000 } };
      const [result] = await h.emit("tool_call", event, { cwd: dir, model: undefined });
      assert.ok(result && (result as { block: boolean }).block);
      assert.match((result as { reason: string }).reason, /Path not found/);
      assert.match((result as { reason: string }).reason, /find/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("tool_result edit-error enrichment", () => {
  it("appends the nearest region to an unresolvable mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmt-enrich-"));
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "alpha\nbeta\ngamma\ndelta");
      const h = createHarness();
      extension(h.pi);
      await h.emit("session_start", {}, { model: undefined });
      const [result] = await h.emit("tool_result", {
        toolName: "edit",
        toolCallId: "t1",
        input: { path: file, edits: [{ oldText: "beta\ngamma", newText: "B\nG" }] },
        content: [{ type: "text", text: "Could not find the exact text in a.ts." }],
        isError: true,
        details: undefined,
      }, { cwd: dir, model: undefined });
      const content = (result as { content?: Array<{ text: string }> })?.content;
      assert.ok(content && content[0]?.text, "expected enriched content");
      assert.match(content[0].text, /Could not find the exact text/);
      assert.match(content[0].text, /Nearest matching region/);
      assert.match(content[0].text, /\| beta/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("leaves non-mismatch results untouched", async () => {
    const h = createHarness();
    extension(h.pi);
    const [result] = await h.emit("tool_result", {
      toolName: "edit",
      toolCallId: "t1",
      input: { path: "a.ts", edits: [{ oldText: "beta", newText: "B" }] },
      content: [{ type: "text", text: "updated a.ts" }],
      isError: false,
      details: undefined,
    }, { cwd: process.cwd() });
    assert.strictEqual(result, undefined);
  });

  it("leaves non-mismatch ERRORS untouched", async () => {
    const h = createHarness();
    extension(h.pi);
    const [result] = await h.emit("tool_result", {
      toolName: "edit",
      toolCallId: "t1",
      input: { path: "a.ts", edits: [{ oldText: "beta", newText: "B" }] },
      content: [{ type: "text", text: "ENOENT: no such file or directory" }],
      isError: true,
      details: undefined,
    }, { cwd: process.cwd() });
    assert.strictEqual(result, undefined);
  });
});
