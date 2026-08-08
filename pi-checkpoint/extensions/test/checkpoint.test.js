import assert from "node:assert/strict";
import test from "node:test";
import { rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import checkpointExtension, { isGitRepo } from "../index.js";

// ── isGitRepo ─────────────────────────────────────────────────────────────

test("isGitRepo: true when .git exists, false otherwise", () => {
  const d1 = mkdtempSync(join(tmpdir(), "ck-"));
  mkdirSync(join(d1, ".git"));
  const d2 = mkdtempSync(join(tmpdir(), "ck-"));
  try {
    assert.equal(isGitRepo(d1), true);
    assert.equal(isGitRepo(d2), false);
    assert.equal(isGitRepo(null), false);
    assert.equal(isGitRepo(undefined), false);
  } finally {
    rmSync(d1, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  }
});

// ── Command wiring ────────────────────────────────────────────────────────

function harness({ gitRepo = true, sessionStable = true } = {}) {
  const pi = {
    on() {},
    registerCommand(name) {
      this._cmds = this._cmds || {};
      this._cmds[name] = name;
    },
    execCalls: [],
    async exec(cmd, args, opts) {
      this.execCalls.push({ cmd, args, opts });
      // Simulate `git stash create`: return a fake tree the first time.
      if (args[0] === "stash" && args[1] === "create") {
        return { stdout: this.stashEmpty ? "" : "abc123\n", stderr: "" };
      }
      if (args[0] === "update-ref") return { stdout: "", stderr: "" };
      if (args[0] === "checkout") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    },
    stashEmpty: false,
    gitRepo,
    sessionStable,
  };
  checkpointExtension(pi);
  return pi;
}

const TEMP_CWDS = [];
function gitCwd() {
  const d = mkdtempSync(join(tmpdir(), "ck-"));
  mkdirSync(join(d, ".git"));
  TEMP_CWDS.push(d);
  return d;
}

function ctx({ cwd, sessionId = "s1" } = {}) {
  const realCwd = cwd || gitCwd();
  const notifies = [];
  return {
    cwd: realCwd,
    hasUI: true,
    notifies,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
    ui: {
      notify(m, t) {
        notifies.push({ m, t });
      },
    },
  };
}

test("snapshot captures refs on turn_start; /undo pops and restores", async () => {
  const pi = harness();
  // Capture the handler from registration by re-implementing the turn flow:
  // our harness stubs pi.on, so instead drive a fresh real extension instance.
  const calls = [];
  const realPi = {
    on(_evt, handler) {
      calls.push({ evt: _evt, handler });
    },
    registerCommand(name, opts) {
      calls.push({ cmd: name, opts });
    },
    execCalls: [],
    async exec(cmd, args, opts) {
      this.execCalls.push({ cmd, args });
      if (args[0] === "stash" && args[1] === "create") return { stdout: "tree1\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  checkpointExtension(realPi);
  const turnStart = calls.find((c) => c.evt === "turn_start").handler;
  const undoCmd = calls.find((c) => c.cmd === "undo").opts;
  const c = ctx();

  await turnStart({}, c); // snapshot 0 → tree1
  await turnStart({}, c); // snapshot 1 → tree1
  assert.equal(realPi.execCalls.filter((x) => x.args[0] === "update-ref").length, 2, "two refs created");

  await undoCmd.handler("1", c);
  // After undo: 1 checkout from the remaining top snapshot
  const checkouts = realPi.execCalls.filter((x) => x.args[0] === "checkout");
  assert.ok(checkouts.length >= 1, "git checkout called to restore");
  assert.match(c.notifies[c.notifies.length - 1].m, /Undid 1 turn/);
});

test("/undo on empty stack notifies and does nothing", async () => {
  const calls = [];
  const realPi = {
    on(_evt, handler) {
      calls.push({ evt: _evt, handler });
    },
    registerCommand(name, opts) {
      calls.push({ cmd: name, opts });
    },
    async exec() {
      return { stdout: "", stderr: "" };
    },
  };
  checkpointExtension(realPi);
  const undoCmd = calls.find((c) => c.cmd === "undo").opts;
  const c = ctx();
  await undoCmd.handler("1", c);
  assert.match(c.notifies[c.notifies.length - 1].m, /Nothing to undo/);
});

test("clean tree (stash empty) still records an empty checkpoint for depth", async () => {
  const calls = [];
  const realPi = {
    on(_evt, handler) {
      calls.push({ evt: _evt, handler });
    },
    registerCommand(name, opts) {
      calls.push({ cmd: name, opts });
    },
    execCalls: [],
    async exec(cmd, args) {
      this.execCalls.push({ cmd, args });
      if (args[0] === "stash" && args[1] === "create") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  checkpointExtension(realPi);
  const turnStart = calls.find((c) => c.evt === "turn_start").handler;
  const undoCmd = calls.find((c) => c.cmd === "undo").opts;
  const c = ctx();

  await turnStart({}, c); // clean → empty checkpoint 0
  await turnStart({}, c); // clean → empty checkpoint 1
  // Two empty checkpoints exist; /undo should succeed (depth tracked) but no
  // checkout happens because the restore target is null.
  await undoCmd.handler("1", c);
  assert.match(c.notifies[c.notifies.length - 1].m, /Undid 1 turn/);
  assert.equal(
    realPi.execCalls.filter((x) => x.args[0] === "checkout").length,
    0,
    "no checkout for empty (clean) checkpoints",
  );
});

test("/checkpoint lists the stack", async () => {
  const calls = [];
  const realPi = {
    on(_evt, handler) {
      calls.push({ evt: _evt, handler });
    },
    registerCommand(name, opts) {
      calls.push({ cmd: name, opts });
    },
    execCalls: [],
    async exec(cmd, args) {
      this.execCalls.push({ cmd, args });
      if (args[0] === "stash" && args[1] === "create") return { stdout: "tree1\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  checkpointExtension(realPi);
  const turnStart = calls.find((c) => c.evt === "turn_start").handler;
  const checkpointCmd = calls.find((c) => c.cmd === "checkpoint").opts;
  const c = ctx();
  await turnStart({}, c);
  await turnStart({}, c);

  await checkpointCmd.handler("", c);
  const report = c.notifies[c.notifies.length - 1].m;
  assert.match(report, /Checkpoints:/);
  assert.match(report, /turn 0/);
  assert.match(report, /turn 1/);
  assert.match(report, /head/);
});

test("commands no-op gracefully outside a git repo", async () => {
  const calls = [];
  const realPi = {
    on(_evt, handler) {
      calls.push({ evt: _evt, handler });
    },
    registerCommand(name, opts) {
      calls.push({ cmd: name, opts });
    },
    async exec() {
      return { stdout: "", stderr: "" };
    },
  };
  checkpointExtension(realPi);
  const undoCmd = calls.find((c) => c.cmd === "undo").opts;
  const c = ctx({ cwd: mkdtempSync(join(tmpdir(), "nogit-")) });
  await undoCmd.handler("1", c);
  assert.match(c.notifies[c.notifies.length - 1].m, /Not a git repo/);
});

// ── Review-fix regression tests ────────────────────────────────────────────

test("session_start eagerly clears stale stack so /undo can't cross sessions (review: MED)", async () => {
  // Session A: two turns populate the stack.
  // Then /new fires session_start. Session B's /undo with NO prior turns must
  // report "Nothing to undo", NOT pop A's checkpoints.
  const calls = [];
  const realPi = {
    on(_evt, handler) { calls.push({ evt: _evt, handler }); },
    registerCommand(name, opts) { calls.push({ cmd: name, opts }); },
    execCalls: [],
    async exec(cmd, args) {
      this.execCalls.push({ cmd, args });
      if (args[0] === "stash" && args[1] === "create") return { stdout: "treeA\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  };
  checkpointExtension(realPi);
  const turnStart = calls.find((c) => c.evt === "turn_start").handler;
  const sessionStart = calls.find((c) => c.evt === "session_start").handler;
  const undoCmd = calls.find((c) => c.cmd === "undo").opts;

  const sessA = ctx({ sessionId: "A" });
  await turnStart({}, sessA); // A checkpoint 0
  await turnStart({}, sessA); // A checkpoint 1
  // Verify A has a stack by running /checkpoint.
  const checkpointCmd = calls.find((c) => c.cmd === "checkpoint").opts;
  await checkpointCmd.handler("", sessA);
  assert.match(sessA.notifies[sessA.notifies.length - 1].m, /turn 1/);

  // New session fires session_start → stack cleared.
  const sessB = ctx({ sessionId: "B" });
  await sessionStart({}, sessB);
  await undoCmd.handler("1", sessB);
  assert.match(sessB.notifies[sessB.notifies.length - 1].m, /Nothing to undo/,
    "B cannot undo into A's stack");
});

test("command handlers do not throw when ctx.ui is missing (review: MED)", async () => {
  const calls = [];
  const realPi = {
    on(_evt, handler) { calls.push({ evt: _evt, handler }); },
    registerCommand(name, opts) { calls.push({ cmd: name, opts }); },
    async exec() { return { stdout: "", stderr: "" }; },
  };
  checkpointExtension(realPi);
  const undoCmd = calls.find((c) => c.cmd === "undo").opts;
  const bareCtx = { cwd: "/no/.git/here", sessionManager: { getSessionId: () => "x" } };
  // No ctx.ui at all — must not throw.
  await assert.doesNotReject(() => undoCmd.handler("1", bareCtx));
});
