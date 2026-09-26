import assert from "node:assert/strict";
import test from "node:test";

// Orchestration tests for index.ts: availability gating, env bypass, and the
// safe-rewrite decision on the tool_call path, via a stubbed pi + ctx.
// Module-level cache state (rtkAvailable/rtkLastCheckedAt) persists across
// tests in this file — tests are ordered to lean on it, and session_start
// (which re-checks unconditionally) re-establishes availability where needed.

function createHarness() {
  const state = { versionCalls: 0, rewriteCalls: 0, rewritten: null, versionAvailable: false };
  const handlers = {};
  const ctx = {
    hasUI: false,
    cwd: process.cwd(),
    signal: { aborted: false },
    ui: { setStatus() {}, notify() {} },
  };
  const pi = {
    registerCommand() {},
    on(name, fn) {
      handlers[name] = fn;
    },
    exec(cmd, args) {
      if (args[0] === "--version") {
        state.versionCalls++;
        return state.versionAvailable
          ? Promise.resolve({ code: 0, stdout: "rtk 0.46.0\n" })
          : Promise.resolve({ code: 1, stdout: "" });
      }
      if (args[0] === "rewrite") {
        state.rewriteCalls++;
        return state.rewritten === null
          ? Promise.reject(new Error("spawn failed"))
          : Promise.resolve({ code: 3, stdout: state.rewritten + "\n", killed: false });
      }
      return Promise.resolve({ code: 0, stdout: "" });
    },
  };
  return { pi, ctx, handlers, state };
}

async function fireToolCall(h, command) {
  const event = { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command } };
  await h.handlers.tool_call(event, h.ctx);
  return event.input.command;
}

test("rtk unavailable: command passes through unchanged and availability is cached", async () => {
  const h = createHarness();
  h.state.versionAvailable = false;
  const ext = (await import("../index.ts")).default;
  ext(h.pi);

  // session_start performs the initial availability check (as in a real session).
  await h.handlers.session_start({}, h.ctx);

  const afterFirst = await fireToolCall(h, "git status");
  assert.equal(afterFirst, "git status");
  assert.equal(h.state.versionCalls, 1);

  // Second call within the 30s negative-cache window must not re-check.
  const afterSecond = await fireToolCall(h, "ls -la");
  assert.equal(afterSecond, "ls -la");
  assert.equal(h.state.versionCalls, 1);
  assert.equal(h.state.rewriteCalls, 0);
});

test("RTK_DISABLED=1: no rewrite even when rtk is available", async () => {
  const h = createHarness();
  h.state.versionAvailable = true;
  const ext = (await import("../index.ts")).default;
  ext(h.pi);

  // Fresh session check establishes availability first.
  await h.handlers.session_start({}, h.ctx);
  process.env.RTK_DISABLED = "1";
  try {
    const after = await fireToolCall(h, "git status");
    assert.equal(after, "git status");
    assert.equal(h.state.rewriteCalls, 0);
  } finally {
    delete process.env.RTK_DISABLED;
  }
});

test("safe rewrite path applies the rewritten command", async () => {
  const h = createHarness();
  h.state.versionAvailable = true;
  h.state.rewritten = "rtk git status";
  const ext = (await import("../index.ts")).default;
  ext(h.pi);

  await h.handlers.session_start({}, h.ctx);
  const after = await fireToolCall(h, "git status");
  assert.equal(after, "rtk git status");
  assert.equal(h.state.rewriteCalls, 1);
});

test("unsafe rewrite (isSafeRewrite false) keeps the original command", async () => {
  const h = createHarness();
  h.state.versionAvailable = true;
  h.state.rewritten = "evil -rf /";
  const ext = (await import("../index.ts")).default;
  ext(h.pi);

  await h.handlers.session_start({}, h.ctx);
  const after = await fireToolCall(h, "git status");
  assert.equal(after, "git status");
  assert.equal(h.state.rewriteCalls, 1);
});
