/**
 * Auto-review guard tests: turn analysis (mutation counting, file extraction,
 * user-initiated vs auto-injected wake-ups, cursor semantics), config read,
 * review-task construction, and the agent_settled dispatch glue (guards,
 * cursor accounting, cap, suppression) with an injected dispatcher.
 */

import * as assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import {
  analyzeTurn,
  buildReviewTask,
  createAutoReviewState,
  handleAutoReviewSettle,
  latestEntryId,
  MIN_MUTATIONS,
  readAutoReviewEnabled,
} from "../auto-review.ts";
// --- entry factories (shapes mirror real session entries) ---

let nextId = 0;
function userEntry(text: string, id = `e${++nextId}`): any {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

function customEntry(customType: string, id = `e${++nextId}`): any {
  return { type: "custom", id, customType, content: `Background task ${id} (reviewer) completed.` };
}

function assistantEntry(toolCalls: Array<{ name: string; args?: any }>, id = `e${++nextId}`): any {
  return {
    type: "message",
    id,
    message: {
      role: "assistant",
      content: toolCalls.map((t) => ({ type: "toolCall", id: `c${id}`, name: t.name, arguments: t.args ?? {} })),
    },
  };
}

describe("analyzeTurn", () => {
  it("counts mutation tool calls and extracts file paths from edit/write", () => {
    const prior = { type: "custom", id: "prior" }; // previous turn's tail (cursor)
    const entries = [
      prior,
      userEntry("please fix the bug"),
      assistantEntry([
        { name: "read", args: { path: "/tmp/a.ts" } },
        { name: "edit", args: { path: "src/a.ts" } },
        { name: "write", args: { path: "src/b.ts" } },
        { name: "bash", args: { command: "ls" } },
      ]),
    ];
    const result = analyzeTurn(entries, prior.id);
    assert.equal(result.mutationCount, 2);
    assert.deepEqual(result.files.sort(), ["src/a.ts", "src/b.ts"]);
    assert.equal(result.userInitiated, true);
    assert.equal(result.cursor, entries[2].id);
  });

  it("extracts files from apply_patch bodies (Update/Add/Delete)", () => {
    const patch = "*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** Add File: src/new.ts\n+hi\n*** Delete File: src/gone.ts\n*** End Patch";
    const entries = [
      userEntry("do it"),
      assistantEntry([{ name: "apply_patch", args: { patch } }]),
    ];
    const result = analyzeTurn(entries, entries[0].id);
    assert.equal(result.mutationCount, 1);
    assert.deepEqual(result.files.sort(), ["src/gone.ts", "src/new.ts", "src/x.ts"]);
  });

  it("skips entries up to and including the cursor (exclusive)", () => {
    const entries = [
      userEntry("turn one"),
      assistantEntry([{ name: "edit", args: { path: "one.ts" } }]),
      userEntry("turn two"),
      assistantEntry([
        { name: "edit", args: { path: "two-a.ts" } },
        { name: "edit", args: { path: "two-b.ts" } },
        { name: "edit", args: { path: "two-c.ts" } },
      ]),
    ];
    const result = analyzeTurn(entries, entries[1].id);
    assert.equal(result.mutationCount, 3);
    assert.ok(!result.files.includes("one.ts"));
    assert.equal(result.userInitiated, true);
  });

  it("advisor steering (plain user message, no customType) is NOT user-initiated", () => {
    const entries = [
      userEntry("Advisor review (concern — address this or state why it does not apply): the loop guard misses advisor steers"),
      assistantEntry([
        { name: "edit", args: { path: "fix-a.ts" } },
        { name: "edit", args: { path: "fix-b.ts" } },
        { name: "edit", args: { path: "fix-c.ts" } },
      ]),
    ];
    const result = analyzeTurn(entries, entries[0].id);
    assert.equal(result.mutationCount, 3);
    assert.equal(result.userInitiated, false);
  });

  it("custom wake-up entries (pi-subagent-complete) are not user messages", () => {
    const entries = [
      customEntry("pi-subagent-complete"),
      assistantEntry([
        { name: "edit", args: { path: "a.ts" } },
        { name: "edit", args: { path: "b.ts" } },
        { name: "edit", args: { path: "c.ts" } },
      ]),
    ];
    const result = analyzeTurn(entries, entries[0].id);
    assert.equal(result.mutationCount, 3);
    assert.equal(result.userInitiated, false);
  });

  it("a real user prompt later in the turn makes it user-initiated", () => {
    const entries = [
      customEntry("pi-subagent-complete"),
      userEntry("ok apply the findings"),
      assistantEntry([
        { name: "edit", args: { path: "a.ts" } },
        { name: "edit", args: { path: "b.ts" } },
        { name: "edit", args: { path: "c.ts" } },
      ]),
    ];
    const result = analyzeTurn(entries, entries[0].id);
    assert.equal(result.userInitiated, true);
  });

  it("with no cursor it classifies from the start", () => {
    const entries = [
      userEntry("go"),
      assistantEntry([{ name: "str_replace_editor", args: { path: "a.ts", command: "str_replace" } }]),
    ];
    const result = analyzeTurn(entries, undefined);
    assert.equal(result.mutationCount, 1);
    assert.deepEqual(result.files, ["a.ts"]);
  });

  it("threshold constant stays at 3 mutations", () => {
    assert.equal(MIN_MUTATIONS, 3);
  });
});

describe("latestEntryId", () => {
  it("returns the last entry with a string id", () => {
    assert.equal(latestEntryId([{ type: "custom" }, { id: "a" }, { id: "b" }]), "b");
    assert.equal(latestEntryId([]), undefined);
  });
});

describe("readAutoReviewEnabled", () => {
  it("layered ctx settings win (true)", () => {
    assert.equal(readAutoReviewEnabled({ settings: { subagent: { autoReview: true } } } as any, {}), true);
  });

  it("layered ctx settings win (false beats global true)", () => {
    assert.equal(readAutoReviewEnabled({ settings: { subagent: { autoReview: false } } } as any, { autoReview: true }), false);
  });

  it("falls back to the global section", () => {
    assert.equal(readAutoReviewEnabled(undefined, { autoReview: true }), true);
    assert.equal(readAutoReviewEnabled(undefined, {}), false);
    assert.equal(readAutoReviewEnabled({} as any, {}), false);
  });

  it("trusted repo .pi/settings.json overlay applies to a real-shape ctx (no settings prop)", () => {
    const project = mkdtempSync(join(os.tmpdir(), "ar-overlay-"));
    try {
      mkdirSync(join(project, ".pi"), { recursive: true });
      writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ subagent: { autoReview: true } }));
      const ctx = { cwd: project, isProjectTrusted: () => true } as any;
      assert.equal(readAutoReviewEnabled(ctx, {}), true);
      // untrusted repo → overlay ignored
      const untrusted = { cwd: project, isProjectTrusted: () => false } as any;
      assert.equal(readAutoReviewEnabled(untrusted, {}), false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("buildReviewTask", () => {
  it("lists files, embeds diff, and demands the CLEAN/no-findings contract", () => {
    const task = buildReviewTask(["src/a.ts"], "--- a/src/a.ts\n+++ b/src/a.ts", " M src/a.ts");
    assert.ok(task.includes("- src/a.ts"));
    assert.ok(task.includes("M src/a.ts"));
    assert.ok(task.includes("REVIEW: CLEAN"));
    assert.ok(task.includes("Max 5 findings"));
    // no-diff variant directs the reviewer at the files instead
    const noDiff = buildReviewTask(["src/b.ts"], "", "");
    assert.ok(noDiff.includes("read the changed files directly"));
  });
});

// ---------------------------------------------------------------------------
// handleAutoReviewSettle — the agent_settled dispatch glue
// ---------------------------------------------------------------------------

function makeGlue(entries: any[], state = createAutoReviewState(), opts: { enabled?: boolean; running?: boolean; mode?: string } = {}) {
  const dispatches: any[] = [];
  const enabled = opts.enabled ?? true;
  const deps = {
    pi: {} as any,
    ctx: {
      settings: { subagent: { autoReview: enabled } },
      sessionManager: { getEntries: () => entries },
      cwd: os.tmpdir(), // not a git repo — captureDiff degrades to empty diff
      mode: opts.mode ?? "tui",
    } as any,
    state,
    bundledAgentsDir: "/unused",
    threadStore: {} as any,
    agentColor: undefined,
    dispatch: (input: any) => {
      dispatches.push(input);
      return { taskId: "bg-test", receipt: "ok" };
    },
    isRunning: () => opts.running ?? false,
  };
  return { deps, dispatches, state };
}

function editTurn(userText: string, files: string[]): any[] {
  return [userEntry(userText), assistantEntry(files.map((path) => ({ name: "edit", args: { path } })))];
}

describe("handleAutoReviewSettle", () => {
  it("fresh session (cursor undefined) dispatches on the first qualifying turn", async () => {
    const entries = editTurn("please fix", ["a.ts", "b.ts", "c.ts"]);
    const { deps, dispatches, state } = makeGlue(entries);
    const dispatched = await handleAutoReviewSettle(deps);
    assert.equal(dispatched, true);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].agent, "reviewer");
    assert.deepEqual(dispatches[0].task.match(/^- [^\n]*\.ts$/gm)?.sort(), ["- a.ts", "- b.ts", "- c.ts"]);
    assert.equal(state.dispatched, 1);
    assert.equal(state.cursor, entries[1].id);
  });

  it("turn woken by a background completion (custom entry) does not dispatch", async () => {
    const entries = [customEntry("pi-subagent-complete"), ...editTurn("", ["a.ts", "b.ts", "c.ts"]).slice(1)];
    const { deps, dispatches } = makeGlue(entries);
    assert.equal(await handleAutoReviewSettle(deps), false);
    assert.equal(dispatches.length, 0);
  });

  it("turn woken by an advisor steer (plain user message prefix) does not dispatch", async () => {
    const entries = editTurn("Advisor review (concern — address this or state why it does not apply): fix the guard", ["a.ts", "b.ts", "c.ts"]);
    const { deps, dispatches } = makeGlue(entries);
    assert.equal(await handleAutoReviewSettle(deps), false);
    assert.equal(dispatches.length, 0);
  });

  it("below the mutation threshold does not dispatch", async () => {
    const { deps, dispatches } = makeGlue(editTurn("small tweak", ["a.ts", "b.ts"]));
    assert.equal(await handleAutoReviewSettle(deps), false);
    assert.equal(dispatches.length, 0);
  });

  it("session cap blocks further dispatches", async () => {
    const { deps, dispatches, state } = makeGlue(editTurn("fix", ["a.ts", "b.ts", "c.ts"]));
    state.dispatched = 3;
    assert.equal(await handleAutoReviewSettle(deps), false);
    assert.equal(dispatches.length, 0);
  });

  it("a running background task suppresses dispatch", async () => {
    const { deps, dispatches } = makeGlue(editTurn("fix", ["a.ts", "b.ts", "c.ts"]), undefined, { running: true });
    assert.equal(await handleAutoReviewSettle(deps), false);
    assert.equal(dispatches.length, 0);
  });

  it("cursor id absent from entries (compaction) re-seeds to the tail — no stuck session, no blind dispatch", async () => {
    const entries = editTurn("fix", ["a.ts", "b.ts", "c.ts"]);
    const state = createAutoReviewState();
    state.cursor = "compacted-away"; // id no longer in the transcript
    const { deps, dispatches } = makeGlue(entries, state);
    // The stale-cursor turn itself can't be analyzed (mutations invisible behind
    // the lost cursor) — but the cursor unsticks instead of disabling forever.
    assert.equal(await handleAutoReviewSettle(deps), false);
    assert.equal(dispatches.length, 0);
    assert.equal(state.cursor, entries[1].id);
    // The next qualifying turn dispatches normally.
    const next = editTurn("fix again", ["d.ts", "e.ts", "f.ts"]);
    entries.push(...next);
    assert.equal(await handleAutoReviewSettle(deps), true);
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].task.includes("d.ts"));
  });

  it("delete-only apply_patch turns list the deleted files", () => {
    const patch = "*** Begin Patch\n*** Delete File: gone-a.ts\n*** Delete File: gone-b.ts\n*** Delete File: gone-c.ts\n*** End Patch";
    const entries = [userEntry("clean up"), assistantEntry([{ name: "apply_patch", args: { patch } }])];
    const probe = analyzeTurn(entries, entries[0].id);
    assert.equal(probe.mutationCount, 1); // one tool call…
    assert.deepEqual(probe.files.sort(), ["gone-a.ts", "gone-b.ts", "gone-c.ts"]); // …three deleted files
  });

  it("qualifying mutations with no extractable file paths do not dispatch blind", async () => {
    const entries = [userEntry("clean up"), assistantEntry([{ name: "edit", args: {} }, { name: "write", args: {} }, { name: "apply_patch", args: {} }])];
    const { deps, dispatches, state } = makeGlue(entries);
    assert.equal(await handleAutoReviewSettle(deps), false);
    assert.equal(dispatches.length, 0);
    assert.equal(state.dispatched, 0); // cap not consumed by a blind review
  });

  it("headless one-shot mode advances the cursor but never dispatches", async () => {
    const entries = editTurn("fix", ["a.ts", "b.ts", "c.ts"]);
    const { deps, dispatches, state } = makeGlue(entries, undefined, { mode: "print" });
    assert.equal(await handleAutoReviewSettle(deps), false);
    assert.equal(dispatches.length, 0);
    assert.equal(state.cursor, entries[1].id); // cursor still tracked while headless
  });

  it("disabled periods advance the cursor — enabling mid-session reviews only new turns", async () => {
    const turn1 = editTurn("turn one", ["one-a.ts", "one-b.ts", "one-c.ts"]);
    const turn2 = editTurn("turn two", ["two-a.ts", "two-b.ts", "two-c.ts"]);
    const entries = [...turn1, ...turn2];
    const { deps, dispatches, state } = makeGlue(entries, createAutoReviewState(), { enabled: false });
    // While disabled the cursor tracks the tail and nothing dispatches.
    await handleAutoReviewSettle(deps);
    assert.equal(dispatches.length, 0);
    assert.equal(state.cursor, entries[3].id);
    // Enable mid-session: a new qualifying turn reviews only its own files.
    const turn3 = editTurn("turn three", ["three-a.ts", "three-b.ts", "three-c.ts"]);
    entries.push(...turn3);
    (deps.ctx.settings.subagent as any).autoReview = true;
    assert.equal(await handleAutoReviewSettle(deps), true);
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].task.includes("three-a.ts"));
    assert.ok(!dispatches[0].task.includes("one-a.ts"));
  });
});
