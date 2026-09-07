/**
 * Auto-review: after a user-initiated turn that mutated files, dispatch the
 * read-only `reviewer` agent on the turn's diff as a background task. Its
 * findings wake the parent via the normal background follow-up turn.
 *
 * Enabled via `subagent.autoReview: true` in settings.json (default off).
 * Guards keep it quiet: user-initiated turns only (auto-injected wake-ups are
 * excluded — see ADVISOR_PREFIXES), a per-session dispatch cap, and never two
 * background tasks at once.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSubagentSection, readSubagentSectionFrom } from "./roles.ts";
import { discoverAgents } from "./agents.ts";
import { runNamedAgent } from "./service.ts";
import { startBackgroundTask, type BackgroundDeps } from "./background.ts";
import type { threadStore as ThreadStoreType } from "./threads.ts";
import type { SubAgentResult } from "./runner.ts";

/** File-mutating tool names counted toward the dispatch threshold. */
const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "str_replace_editor"]);
/** Minimum mutation tool calls in one turn before a review is worth dispatching. */
export const MIN_MUTATIONS = 3;
/** Per-session dispatch cap — bounds model cost and any review→fix→review loop. */
export const MAX_PER_SESSION = 3;
/** Reviewer inactivity timeout for the bounded diff review (ms). */
export const REVIEW_TIMEOUT_MS = 10 * 60 * 1_000;
/** Max diff text embedded in the task (reviewer can `read` files for more). */
const MAX_EMBED_BYTES = 24 * 1024;

// pi-advisor steers blockers/concerns via pi.sendUserMessage — plain user-role
// messages with NO customType (fixed templates in pi-advisor's lib/watcher.ts).
// A turn woken by them is not user-initiated and must not re-trigger review.
const ADVISOR_PREFIXES = [
  "Advisor review (nit",
  "Advisor review (concern",
  "Advisor review (blocker",
];

/** Effective `subagent.autoReview`: layered ctx settings (when the SDK exposes
 *  them) → trusted repo `.pi/settings.json` → global settings.json. Mirrors
 *  readSubagentRoles precedence. */
export function readAutoReviewEnabled(ctx?: ExtensionContext, globalSection: Record<string, unknown> = readSubagentSection()): boolean {
  let enabled = globalSection.autoReview === true;
  try {
    if (ctx?.isProjectTrusted?.()) {
      const project = readSubagentSectionFrom(join(ctx.cwd, ".pi", "settings.json"));
      if (typeof project.autoReview === "boolean") enabled = project.autoReview;
    }
  } catch { /* untrusted ctx or unreadable file — global only */ }
  const layered = (ctx as unknown as { settings?: { subagent?: { autoReview?: unknown } } } | undefined)?.settings?.subagent?.autoReview;
  if (typeof layered === "boolean") return layered;
  return enabled;
}

export interface AutoReviewState {
  /** Last transcript entry id classified; undefined until the first settle reseeds it. */
  cursor: string | undefined;
  /** Auto-reviews dispatched this session. */
  dispatched: number;
}

export function createAutoReviewState(): AutoReviewState {
  return { cursor: undefined, dispatched: 0 };
}

export interface TurnAnalysis {
  mutationCount: number;
  files: string[];
  /** True only when a real user prompt (not an advisor steer / custom wake-up) drove the turn. */
  userInitiated: boolean;
  cursor: string | undefined;
}

function userEntryText(entry: any): string {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part?.text ?? ""))
    .join("\n");
}

function extractMutatedPaths(part: any): string[] {
  const args = part?.arguments;
  if (typeof args?.path === "string" && args.path) return [args.path];
  if (typeof args?.file_path === "string" && args.file_path) return [args.file_path];
  if (typeof args?.patch === "string") {
    return [...args.patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim());
  }
  return [];
}

/**
 * Classify one settled turn's entries (those after `sinceId`): mutation tool
 * calls, changed files, and whether a genuine user prompt drove the turn.
 * Cursor entry itself is excluded (pi-advisor toolCallCount pattern).
 */
export function analyzeTurn(entries: any[], sinceId: string | undefined): TurnAnalysis {
  // Flip counting at the cursor entry but classify from the NEXT entry on —
  // strictly-after semantics, matching pi-advisor's toolCallCount.
  let counting = sinceId === undefined;
  let mutationCount = 0;
  const files = new Set<string>();
  let userInitiated = false;
  let cursor = sinceId;
  for (const entry of entries) {
    if (counting) {
      if (typeof entry?.id === "string") cursor = entry.id;
      if (entry?.type === "message") {
        const role = entry.message?.role;
        if (role === "user") {
          const text = userEntryText(entry);
          if (text && !ADVISOR_PREFIXES.some((p) => text.startsWith(p))) userInitiated = true;
        } else if (role === "assistant" && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content) {
            if (part?.type !== "toolCall" || !MUTATION_TOOLS.has(part?.name)) continue;
            mutationCount++;
            for (const file of extractMutatedPaths(part)) files.add(file);
          }
        }
      }
    } else if (entry?.id === sinceId) {
      counting = true;
    }
  }
  return { mutationCount, files: [...files], userInitiated, cursor };
}

/** First-call reseed: point the cursor at the transcript tail so a mid-session
 *  enable never replays history (pi-advisor reseedCursor pattern). */
export function latestEntryId(entries: any[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (typeof entries[i]?.id === "string") return entries[i].id;
  }
  return undefined;
}

function git(cwd: string, args: string[], maxBytes: number): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) return resolve("");
      const out = String(stdout);
      resolve(out.length > maxBytes ? out.slice(0, maxBytes) + "\n… (truncated)" : out);
    });
  });
}

/** Scoped diff + porcelain status for the turn's changed files. Never rejects. */
export async function captureDiff(cwd: string, files: string[]): Promise<{ diff: string; status: string }> {
  return {
    diff: files.length > 0 ? await git(cwd, ["diff", "HEAD", "--", ...files], MAX_EMBED_BYTES) : "",
    status: await git(cwd, ["status", "--porcelain"], 4_096),
  };
}

export function buildReviewTask(files: string[], diff: string, status: string): string {
  return [
    "Review this change for correctness, security, regressions, and missing tests. Only the files below are in scope — do not attempt a broader review.",
    "",
    "Changed files:",
    ...files.map((file) => `- ${file}`),
    "",
    status ? `Git status:\n${status}\n` : "",
    diff ? `Diff (may be truncated):\n${diff}` : "No tracked diff captured — read the changed files directly.",
    "",
    "Output contract (hard limits):",
    "- Max 5 findings, one line each: `path:line — issue — evidence`.",
    "- No praise, no style noise, no restating the diff.",
    "- If nothing warrants a finding, reply with exactly: REVIEW: CLEAN",
    "- Max 30 lines total.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * runOne adapter so the auto-review dispatch can reuse startBackgroundTask
 * (threads, history, status/cancel, completion delivery) without the tool
 * path's execute-scoped runOne. Always read-only; reviewer needs no bash.
 */
export function makeHookRunOne(bundledAgentsDir: string, ctx: ExtensionContext): BackgroundDeps["runOne"] {
  return async (agentName, task, _cwd, signal, timeoutMs, onProgress, onActivity) => {
    const agent = discoverAgents(ctx.cwd, "user", bundledAgentsDir).agents.find((a) => a.name === agentName);
    if (!agent) {
      const errorResult: SubAgentResult = {
        agent: agentName,
        task,
        exitCode: 1,
        status: "error",
        stopReason: "error",
        messages: [],
        stderr: `Unknown agent: "${agentName}".`,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        errorMessage: `Unknown agent: "${agentName}"`,
      };
      return errorResult;
    }
    // ponytail: hook dispatches are always read-only regardless of the agent file
    return await runNamedAgent({
      agent: { ...agent, sandbox: "read-only" },
      task,
      cwd: ctx.cwd,
      ctx,
      timeout: timeoutMs,
      signal,
      readOnly: true,
      onMessage: onProgress,
      onProgress: onActivity,
    });
  };
}

// ---------------------------------------------------------------------------
// agent_settled glue (extracted for testability — dispatch/isRunning injectable)
// ---------------------------------------------------------------------------

export interface AutoReviewSettleDeps {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  state: AutoReviewState;
  bundledAgentsDir: string;
  threadStore: typeof ThreadStoreType;
  /** Theme color for the reviewer thread (index.ts owns the name→color map). */
  agentColor: string | undefined;
  /** startBackgroundTask; injectable so tests can capture dispatches. */
  dispatch: typeof startBackgroundTask;
  /** True when any background task is running; injectable for tests. */
  isRunning: () => boolean;
}

/** One agent_settled tick: analyze the settled turn and maybe dispatch the reviewer. Returns true when a review was dispatched. */
export async function handleAutoReviewSettle(deps: AutoReviewSettleDeps): Promise<boolean> {
  const { ctx, state } = deps;
  const debug = process.env.PI_SUBAGENT_AUTOREVIEW_DEBUG === "1";
  try {
    const entries = ctx.sessionManager.getEntries() as any[];
    if (!readAutoReviewEnabled(ctx)) {
      // Keep the cursor fresh while disabled so enabling mid-session never
      // replays accumulated history as one pseudo-turn.
      state.cursor = latestEntryId(entries);
      return false;
    }
    // Headless one-shot modes can't surface the follow-up turn and shouldn't
    // linger on a detached reviewer — track the cursor, dispatch nothing.
    if (ctx.mode !== "tui") {
      state.cursor = latestEntryId(entries);
      return false;
    }
    const analysis = analyzeTurn(entries, state.cursor);
    // Write back the transcript tail unconditionally: if the cursor entry was
    // dropped (compaction/pruning), counting never flips and analyzeTurn would
    // return the stale id forever — a silent permanent disable (pi-advisor
    // reseeds to latestEntryId for the same reason).
    state.cursor = latestEntryId(entries);
    if (debug) console.error(`[auto-review] mutations=${analysis.mutationCount} userInitiated=${analysis.userInitiated} dispatched=${state.dispatched}`);
    if (!analysis.userInitiated) return false; // advisor steers / custom wake-ups must not loop
    if (analysis.mutationCount < MIN_MUTATIONS) return false; // trivial edits stay un-reviewed
    if (analysis.files.length === 0) return false; // delete-only/mutation-without-path turns have nothing to scope
    if (state.dispatched >= MAX_PER_SESSION) return false;
    if (deps.isRunning()) return false;
    const { diff, status } = await captureDiff(ctx.cwd, analysis.files);
    deps.dispatch({
      agent: "reviewer",
      task: buildReviewTask(analysis.files, diff, status),
      timeout: REVIEW_TIMEOUT_MS,
      agentColor: deps.agentColor,
      deps: { pi: deps.pi, ctx, runOne: makeHookRunOne(deps.bundledAgentsDir, ctx), threadStore: deps.threadStore },
    });
    state.dispatched++;
    if (debug) console.error("[auto-review] reviewer dispatched (background)");
    return true;
  } catch {
    // Auto-review must never break the main loop (same contract as pi-advisor's watcher).
    return false;
  }
}
