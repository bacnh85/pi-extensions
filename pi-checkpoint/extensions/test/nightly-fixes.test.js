import assert from "node:assert/strict";
import test from "node:test";
import { rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import checkpointExtension from "../index.js";

// Regression tests for the 2026-09-12 nightly review fixes:
// P0 redo order, P1 git-failure handling.

function setup(execImpl) {
  const repo = mkdtempSync(join(tmpdir(), "ck-nightly-"));
  mkdirSync(join(repo, ".git"));
  const calls = [];
  const realPi = {
    on(_evt, handler) { calls.push({ evt: _evt, handler }); },
    registerCommand(name, opts) { calls.push({ cmd: name, opts }); },
    execCalls: [],
    async exec(cmd, args) {
      this.execCalls.push({ cmd, args });
      return execImpl.call(this, args);
    },
  };
  checkpointExtension(realPi);
  const c = {
    cwd: repo,
    notifies: [],
    sessionManager: { getSessionId: () => "s1" },
    ui: { notify(m, t) { c.notifies.push({ m, t }); } },
  };
  // isGitRepo only checks for a .git dir; fake it via a cwd we control.
  return {
    pi: realPi,
    ctx: c,
    turnStart: calls.find((x) => x.evt === "turn_start").handler,
    undo: calls.find((x) => x.cmd === "undo").opts,
    redo: calls.find((x) => x.cmd === "redo").opts,
    checkpointCmd: calls.find((x) => x.cmd === "checkpoint").opts,
  };
  TEMP_REPOS.push(repo);
}

const TEMP_REPOS = [];
process.on("exit", () => {
  for (const d of TEMP_REPOS) rmSync(d, { recursive: true, force: true });
});

test("/redo 2 replays oldest-first and ends at the pre-undo state (round-trip)", async () => {
  const t = setup(function (args) {
    if (args[0] === "stash" && args[1] === "create") return { stdout: `tree${this.turn = (this.turn ?? 0) + 1}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const { pi, ctx, turnStart, undo, redo, checkpointCmd } = t;

  await turnStart({}, ctx); // checkpoint 0 → tree1
  await turnStart({}, ctx); // checkpoint 1 → tree2
  await turnStart({}, ctx); // checkpoint 2 → tree3

  await undo.handler("2", ctx);
  let checkouts = pi.execCalls.filter((x) => x.args[0] === "checkout");
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].args[1], "refs/pi-checkpoints/s1/0", "undo 2 lands on checkpoint 0");

  await redo.handler("2", ctx);
  checkouts = pi.execCalls.filter((x) => x.args[0] === "checkout");
  assert.equal(checkouts.length, 3, "undo 1 + redo 2 checkouts");
  assert.equal(checkouts[1].args[1], "refs/pi-checkpoints/s1/1", "redo re-applies older checkpoint first");
  assert.equal(checkouts[2].args[1], "refs/pi-checkpoints/s1/2", "redo ends at the pre-undo state");
  assert.deepEqual(checkouts[2].args, ["checkout", "refs/pi-checkpoints/s1/2", "--", "."]);

  // Stack is intact, not scrambled: [0, 1, 2] with 2 at head, redo drained.
  await checkpointCmd.handler("", ctx);
  const report = ctx.notifies[ctx.notifies.length - 1].m;
  assert.match(report, /turn 2.*head/s);
  assert.match(report, /Redo buffer: 0/);
});

test("snapshot is skipped (and notified) when git stash create fails", async () => {
  const t = setup((args) => {
    if (args[0] === "stash" && args[1] === "create") throw new Error("fatal: not a git repository");
    return { stdout: "", stderr: "" };
  });
  const { pi, ctx, turnStart, undo } = t;

  await turnStart({}, ctx);
  assert.equal(pi.execCalls.filter((x) => x.args[0] === "update-ref").length, 0,
    "no ref written after stash create failure");
  const last = ctx.notifies[ctx.notifies.length - 1];
  assert.equal(last.t, "warning");
  assert.match(last.m, /snapshot skipped/);
  assert.match(last.m, /stash create failed/);

  // No checkpoint was recorded, so there is nothing to undo.
  await undo.handler("1", ctx);
  assert.match(ctx.notifies[ctx.notifies.length - 1].m, /Nothing to undo/);
});

test("snapshot is skipped when git update-ref fails", async () => {
  const t = setup((args) => {
    if (args[0] === "stash" && args[1] === "create") return { stdout: "treeX\n", stderr: "" };
    if (args[0] === "update-ref") return { stdout: "", stderr: "error: unable to write ref", failed: true };
    return { stdout: "", stderr: "" };
  });
  const { ctx, turnStart, undo } = t;

  await turnStart({}, ctx);
  const last = ctx.notifies[ctx.notifies.length - 1];
  assert.equal(last.t, "warning");
  assert.match(last.m, /update-ref failed/);
  await undo.handler("1", ctx);
  assert.match(ctx.notifies[ctx.notifies.length - 1].m, /Nothing to undo/,
    "failed ref write must not push a checkpoint onto the stack");
});

test("a new turn clears the redo buffer (no stale re-apply)", async () => {
  let n = 0;
  const t = setup((args) => {
    if (args[0] === "stash" && args[1] === "create") return { stdout: `tree${++n}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const { ctx, turnStart, undo, redo } = t;

  await turnStart({}, ctx); // checkpoint 0
  await turnStart({}, ctx); // checkpoint 1
  await undo.handler("1", ctx);
  await turnStart({}, ctx); // new work → redo history invalidated
  await redo.handler("1", ctx);
  assert.match(ctx.notifies[ctx.notifies.length - 1].m, /Nothing to redo/);
});