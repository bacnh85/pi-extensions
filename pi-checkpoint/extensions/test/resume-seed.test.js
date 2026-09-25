import assert from "node:assert/strict";
import test from "node:test";
import { rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import checkpointExtension from "../index.js";

// Regression tests for the 0.1.5 P1 fix: session_start used to reset
// sessionCounter to 0, so a RESUMED session (same sessionId) overwrote the
// prior session's refs refs/pi-checkpoints/<sid>/0… — silently destroying
// restore points. session_start must seed the counter from existing refs.

function setup(execImpl) {
  const repo = mkdtempSync(join(tmpdir(), "ck-resume-"));
  TEMP_REPOS.push(repo);
  mkdirSync(join(repo, ".git"));
  const calls = [];
  const realPi = {
    on(_evt, handler) { calls.push({ evt: _evt, handler }); },
    registerCommand(name, opts) { calls.push({ cmd: name, opts }); },
    execCalls: [],
    // Simulated ref store: update-ref writes, for-each-ref lists (matches git).
    refs: new Set(),
    async exec(cmd, args) {
      this.execCalls.push({ cmd, args });
      if (args[0] === "update-ref" && args[1] !== "-d") this.refs.add(args[1]);
      if (args[0] === "for-each-ref") {
        const prefix = args[1];
        return { stdout: [...this.refs].filter((r) => r.startsWith(prefix)).join("\n"), stderr: "" };
      }
      return execImpl.call(this, args);
    },
  };
  checkpointExtension(realPi);
  const ctx = {
    cwd: repo,
    notifies: [],
    sessionManager: { getSessionId: () => "s1" },
    ui: { notify(m, t) { ctx.notifies.push({ m, t }); } },
  };
  const agentStart = calls.find((x) => x.evt === "agent_start").handler;
  const turnStart = calls.find((x) => x.evt === "turn_start").handler;
  const turn = async () => { await agentStart({}, ctx); await turnStart({}, ctx); };
  return {
    pi: realPi,
    ctx,
    turnStart,
    turn,
    sessionStart: calls.find((x) => x.evt === "session_start").handler,
  };
}

const TEMP_REPOS = [];
process.on("exit", () => {
  for (const d of TEMP_REPOS) rmSync(d, { recursive: true, force: true });
});

function updateRefs(pi) {
  return pi.execCalls.filter((x) => x.args[0] === "update-ref" && x.args[1] !== "-d").map((x) => x.args[1]);
}

test("resumed session with same sessionId appends refs instead of overwriting", async () => {
  const t = setup((args) => {
    if (args[0] === "stash" && args[1] === "create") return { stdout: "tree\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const { pi, ctx, turnStart, turn, sessionStart } = t;

  // ── Session 1 ──
  await sessionStart({}, ctx);
  await turn(); // ref s1/0
  await turn(); // ref s1/1
  assert.deepEqual(updateRefs(pi), ["refs/pi-checkpoints/s1/0", "refs/pi-checkpoints/s1/1"]);

  // ── Resume: same sessionId, session_start fires again (simulates restart) ──
  await sessionStart({}, ctx);
  await turn();
  const written = updateRefs(pi);
  assert.equal(written.length, 3);
  assert.equal(written[2], "refs/pi-checkpoints/s1/2",
    "second session must write a DIFFERENT ref name, not overwrite s1/0");
  assert.deepEqual(written.slice(0, 2), ["refs/pi-checkpoints/s1/0", "refs/pi-checkpoints/s1/1"],
    "first session's refs were never rewritten");

  // Snapshot logic self-heals even if session_start was missed (different sid path).
  await turn();
  assert.equal(updateRefs(pi).length, 4);
  assert.equal(updateRefs(pi)[3], "refs/pi-checkpoints/s1/3");
});

test("fresh session with no existing refs starts the counter at 0", async () => {
  const t = setup((args) => {
    if (args[0] === "stash" && args[1] === "create") return { stdout: "tree\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const { pi, ctx, turnStart, turn, sessionStart } = t;

  await sessionStart({}, ctx);
  await turn();
  assert.deepEqual(updateRefs(pi), ["refs/pi-checkpoints/s1/0"], "no refs → counter seeded to 0");
});

test("counter seeds past a gap in ref numbering (max + 1)", async () => {
  const t = setup((args) => {
    if (args[0] === "stash" && args[1] === "create") return { stdout: "tree\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const { pi, ctx, turnStart, turn, sessionStart } = t;

  // Pre-existing refs with a numbering gap (e.g. after pruning) — seed = max + 1.
  pi.refs = new Set(["refs/pi-checkpoints/s1/0", "refs/pi-checkpoints/s1/5", "refs/pi-checkpoints/s1/2"]);

  await sessionStart({}, ctx);
  await turn();
  assert.deepEqual(updateRefs(pi), ["refs/pi-checkpoints/s1/6"], "seed = max existing index + 1");
});

test("for-each-ref failure during seeding falls back to 0 and session still works", async () => {
  const t = setup((args) => {
    if (args[0] === "for-each-ref") return { stdout: "", stderr: "boom", failed: true };
    if (args[0] === "stash" && args[1] === "create") return { stdout: "tree\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const { pi, ctx, turnStart, turn, sessionStart } = t;

  await assert.doesNotReject(() => sessionStart({}, ctx));
  await turn();
  assert.deepEqual(updateRefs(pi), ["refs/pi-checkpoints/s1/0"]);
});
