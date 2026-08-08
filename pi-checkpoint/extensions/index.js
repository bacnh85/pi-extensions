/**
 * pi-checkpoint — git-backed undo/redo for Pi.
 *
 * Snapshots file state into a dedicated ref namespace at the start of each turn,
 * so /undo rolls back the last user message AND its file changes together.
 * PI has conversation-level /tree /fork /clone but no file-state snapshots tied
 * to turns; this fills that gap (vs OpenCode's git-backed /undo /redo).
 *
 * Storage: refs/pi-checkpoints/<sessionId>/<n> — a dedicated namespace so we
 * never touch the user's working refs, branches, or stash. Restores use
 * `git checkout` of tracked files from the snapshot (index + worktree), leaving
 * untracked files alone.
 *
 * Commands:
 *   /undo [n]   — restore file state to N turns ago (default 1)
 *   /redo [n]   — re-apply after /undo (mirrors /undo depth)
 *   /checkpoint — show the checkpoint stack for this session
 *
 * Gracefully no-ops (with a notify) outside a git repo. Zero deps, plain JS.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const REF_NS = "refs/pi-checkpoints";

/**
 * Is `cwd` the root of a git repo (has a .git dir)? Exported for testing.
 */
export function isGitRepo(cwd) {
  return !!cwd && existsSync(join(cwd, ".git"));
}

export default function checkpointExtension(pi) {
  // Stack of snapshot refs for the current session branch. index 0 = oldest.
  // /undo pops from the top; /redo re-pushes from a redo buffer.
  const stack = [];
  const redoBuffer = [];
  let sessionCounter = 0;
  let lastSessionId = null;

  function refName(sessionId, n) {
    // Sanitize sessionId to a ref-safe component.
    const safe = String(sessionId || "default").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) || "default";
    return `${REF_NS}/${safe}/${n}`;
  }

  async function git(args, ctx, opts = {}) {
    try {
      return await pi.exec("git", args, { cwd: ctx?.cwd, ...opts });
    } catch (e) {
      return { stdout: "", stderr: String(e?.message || e), failed: true };
    }
  }

  async function snapshot(ctx) {
    const sid = ctx.sessionManager?.getSessionId?.() || "default";
    if (sid !== lastSessionId) {
      // New/resumed session: reset state so old refs aren't mixed in.
      lastSessionId = sid;
      sessionCounter = 0;
      stack.length = 0;
      redoBuffer.length = 0;
    }
    const n = sessionCounter++;
    const ref = refName(sid, n);

    // `git stash create` returns a commit ref of the current working/index
    // state WITHOUT touching the stash list. Empty stdout = clean tree (nothing
    // to snapshot). We still record an empty checkpoint so /undo depth matches
    // turns, even when a turn made no changes.
    const created = await git(["stash", "create"], ctx);
    if (!created?.stdout?.trim()) {
      stack.push({ ref: null, n });
      return;
    }
    const tree = created.stdout.trim();
    await git(["update-ref", ref, tree], ctx);
    stack.push({ ref, n });
  }

  async function restoreRef(ref, ctx) {
    if (!ref) return; // empty checkpoint — nothing to restore
    // Restore tracked-file state from the snapshot's tree into worktree+index.
    // `git checkout <tree> -- .` touches only tracked paths at that tree;
    // untracked files remain.
    await git(["checkout", ref, "--", "."], ctx);
  }

  pi.on("turn_start", async (_event, ctx) => {
    if (!isGitRepo(ctx?.cwd)) return; // no-op outside git
    await snapshot(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    // Eager reset so a stale stack from a prior session can't be /undone into.
    // sessionId may not be stable yet here, but clearing all state is always safe
    // because checkpoints are captured fresh on the first turn_start that follows.
    stack.length = 0;
    redoBuffer.length = 0;
    sessionCounter = 0;
    lastSessionId = ctx?.sessionManager?.getSessionId?.() || null;
  });

  // Best-effort notify: never let a missing ctx.ui throw out of a command.
  function notify(ctx, msg, type = "info") {
    try { ctx?.ui?.notify?.(msg, type); } catch { /* best-effort */ }
  }

  pi.registerCommand("undo", {
    description: "Undo last turn's file changes (git-backed)",
    getArgumentCompletions(prefix) {
      const depths = ["1", "2", "3"];
      const filtered = depths.filter((d) => d.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((d) => ({ value: d, label: d })) : null;
    },
    handler: async (args, ctx) => {
      if (!isGitRepo(ctx?.cwd)) {
        notify(ctx, "Not a git repo — /undo disabled.", "warning");
        return;
      }
      const depth = Math.max(1, parseInt(String(args || "1"), 10) || 1);
      if (stack.length < depth) {
        notify(ctx, `Nothing to undo (only ${stack.length} checkpoint${stack.length === 1 ? "" : "s"}).`, "info");
        return;
      }

      // Move the last `depth` snapshots into the redo buffer, then restore the
      // one now at the top of the stack (the state before those turns).
      const undone = [];
      for (let i = 0; i < depth; i++) {
        const top = stack.pop();
        if (!top) break;
        undone.push(top);
      }
      redoBuffer.push(...undone.reverse());

      const target = stack[stack.length - 1];
      await restoreRef(target?.ref, ctx);
      const label = target?.ref ? target.n : "(clean)";
      notify(ctx, `Undid ${undone.length} turn(s); file state restored to checkpoint ${label}.`, "info");
    },
  });

  pi.registerCommand("redo", {
    description: "Redo file changes after /undo (git-backed)",
    handler: async (args, ctx) => {
      if (!isGitRepo(ctx?.cwd)) {
        notify(ctx, "Not a git repo — /redo disabled.", "warning");
        return;
      }
      const depth = Math.max(1, parseInt(String(args || "1"), 10) || 1);
      if (redoBuffer.length === 0) {
        notify(ctx, "Nothing to redo.", "info");
        return;
      }
      let done = 0;
      for (let i = 0; i < depth && redoBuffer.length > 0; i++) {
        const top = redoBuffer.pop();
        stack.push(top);
        await restoreRef(top.ref, ctx);
        done++;
      }
      notify(ctx, `Redid ${done} turn(s).`, "info");
    },
  });

  pi.registerCommand("checkpoint", {
    description: "Show the checkpoint stack for this session",
    handler: async (_args, ctx) => {
      if (!isGitRepo(ctx?.cwd)) {
        notify(ctx, "Not a git repo — checkpoints disabled.", "info");
        return;
      }
      if (stack.length === 0) {
        notify(ctx, "No checkpoints yet (captured at each turn).", "info");
        return;
      }
      const lines = stack.map((c, i) => {
        const marker = i === stack.length - 1 ? " ← head" : "";
        return `  [${i}] turn ${c.n}: ${c.ref || "(clean)"}` + marker;
      });
      notify(ctx, `Checkpoints:\n${lines.join("\n")}\nRedo buffer: ${redoBuffer.length}`, "info");
    },
  });
}
