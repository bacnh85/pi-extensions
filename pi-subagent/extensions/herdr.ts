/**
 * Herdr delegation backend for pi-subagent.
 *
 * When pi runs inside herdr (https://herdr.dev, HERDR_ENV=1), subagent tasks
 * can be delegated to visible interactive pi sessions in herdr tabs/panes
 * instead of in-process SDK sessions:
 *
 *   - One tab per agent type, tab label = agent name (e.g. "scout").
 *   - One pane per agent instance inside that tab.
 *   - Child = full `pi` session started via `herdr agent start <name> --kind pi`
 *     with the agent persona passed as a file (--append-system-prompt; herdr's arg
 *     encoder rejects multi-line strings) plus --model,
 *     --thinking, --tools).
 *   - Results come back via a file contract: the task prompt instructs the
 *     child to write its final report to a known path (pane reads are
 *     best-effort only — TUI agents render on the alternate screen, which
 *     never reaches herdr's scrollback).
 *
 * All herdr CLI calls go through an injectable `exec` (defaultExec from
 * runner.ts) so tests can script the CLI responses.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { defaultExec, type SubAgentResult } from "./runner.ts";
import { READ_ONLY_TOOLS } from "./security.ts";

export type HerdrExec = typeof defaultExec;

/**
 * The exec used by the control tool and runner resolution in index.ts.
 * Tests swap this to script the herdr CLI without touching defaultExec.
 */
export const herdrCli: { exec: HerdrExec } = { exec: defaultExec };

/** Set to "off" on child tabs so delegated children never recurse into herdr dispatch. */
export const HERDR_OFF_ENV = "PI_SUBAGENT_HERDR";

const HERDR_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** Reject herdr tasks above this size — the prompt travels as a CLI argv element. */
export const MAX_HERDR_TASK_BYTES = 64 * 1024;
/**
 * Usable task budget: wrapTaskPrompt appends the ~150-byte report-file
 * delivery contract to the task text, so validation must reserve headroom or
 * a ceiling-sized task passes validation and then exceeds the ceiling.
 */
export const HERDR_TASK_BUDGET = MAX_HERDR_TASK_BYTES - 1024;

/**
 * Byte-safe truncation for herdr task text (chain `{previous}` substitution
 * can exceed the task budget when a step's report is large). Cuts at
 * HERDR_TASK_BUDGET minus the marker, backs off any split multibyte
 * sequence, and appends a visible marker — the result passes the
 * prepareHerdrTask size check.
 */
export function truncateHerdrTask(task: string): string {
  if (Buffer.byteLength(task, "utf8") <= HERDR_TASK_BUDGET) return task;
  const marker = "\n\n…({previous} truncated: herdr task ceiling 64KB)";
  const budget = HERDR_TASK_BUDGET - Buffer.byteLength(marker, "utf8");
  let cut = Buffer.from(task, "utf8").subarray(0, budget).toString("utf8");
  // A split multibyte tail becomes U+FFFD — back off up to 3 continuation
  // bytes, then a dangling lead byte, so the cut lands between characters.
  while (cut.endsWith("\uFFFD") && cut.length > 0) cut = cut.slice(0, -1);
  return cut + marker;
}
const AGENT_START_TIMEOUT_MS = 45_000;

export interface HerdrHandle {
  /** Unique herdr agent name (e.g. "scout-1"). */
  name: string;
  agentType: string;
  tabId: string;
  paneId: string;
  resultFile: string;
  task: string;
  /** Resolved "provider/id" passed to the child. */
  model: string;
  timeoutMs: number;
  /** False when the tab pre-existed (label match) and was only adopted —
   *  adopted tabs are never eligible for close-tab. */
  tabCreatedHere: boolean;
}

// ---------------------------------------------------------------------------
// Session-scoped registry of agents this session delegated to herdr panes.
// Reconciled lazily against `herdr agent list` / `pane list` (the user may
// close tabs manually). Drives the `herdr` control tool.
// ---------------------------------------------------------------------------

const registry = new Map<string, HerdrHandle>();

export function getHerdrRegistry(): HerdrHandle[] {
  return [...registry.values()];
}

export function isManagedHerdrTab(tabId: string): boolean {
  for (const entry of registry.values()) {
    if (entry.tabId === tabId) return true;
  }
  return false;
}

/** close-tab eligibility: the agent must be session-delegated AND live in a
 *  tab this session actually created (label-matched pre-existing tabs are
 *  adopted for dispatch but never ours to close). */
export function canCloseHerdrTab(name: string): boolean {
  const entry = registry.get(name);
  return Boolean(entry?.tabCreatedHere);
}

/** True when this session dispatched the named agent (mutating control-tool
 *  actions are scoped to these). */
export function isDelegatedHerdrAgent(name: string): boolean {
  return registry.has(name);
}

/**
 * Sibling agents sharing the named agent's tab whose pane state suggests live
 * work (working/blocked, or unknown — e.g. the agent list was unavailable).
 * Closing the tab kills every pane in it, so close-tab must refuse while any
 * of these exist. Pure over the registry + a caller-supplied state map.
 */
export function busyHerdrSiblings(name: string, stateByPane: Map<string, string | undefined>): string[] {
  const entry = registry.get(name);
  if (!entry) return [];
  return [...registry.values()]
    .filter((e) => e.tabId === entry.tabId && e.name !== name)
    .filter((e) => {
      const state = stateByPane.get(e.paneId);
      // Fail closed: only an observed idle/done state proves the sibling is
      // not mid-task — anything else (working, blocked, unrecognized future
      // states) must block close-tab.
      return !(state === "idle" || state === "done");
    })
    .map((e) => e.name);
}

/**
 * Full close-tab refusal check: busy siblings (see busyHerdrSiblings —
 * unverifiable state counts as busy) plus the named agent itself while it is
 * still working/blocked. Asymmetry is deliberate: a sibling with no readable
 * state definitely exists but can't be cleared → refuse; the named agent's
 * own pane with no readable state was most likely already closed → allow.
 */
export function herdrTabCloseBlockers(
  name: string,
  stateByPane: Map<string, string | undefined>,
): { siblings: string[]; self: string | undefined } {
  const entry = registry.get(name);
  if (!entry) return { siblings: [], self: undefined };
  const selfState = stateByPane.get(entry.paneId);
  return {
    siblings: busyHerdrSiblings(name, stateByPane),
    self: selfState !== undefined && !(selfState === "idle" || selfState === "done") ? selfState : undefined,
  };
}

export function forgetHerdrTab(tabId: string): void {
  for (const [name, entry] of registry) {
    if (entry.tabId === tabId) registry.delete(name);
  }
}

/** Drop a single registry entry (control-tool `forget` for stale entries). */
export function forgetHerdrAgent(name: string): void {
  registry.delete(name);
}

/** Test hook: reset the session registry. */
export function clearHerdrRegistry(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Detection & runner resolution
// ---------------------------------------------------------------------------

/** herdr injects HERDR_ENV=1 + workspace/pane IDs into every managed pane. */
export function herdrEnvDetected(): boolean {
  return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_WORKSPACE_ID);
}

/** settings.subagent.herdr === "off" (or the child recursion guard) disables herdr dispatch. */
export function herdrDisabled(subagentSettings: { herdr?: unknown } | undefined): boolean {
  if (subagentSettings?.herdr === "off") return true;
  return process.env[HERDR_OFF_ENV] === "off";
}

let defaultExecProbe: Promise<boolean> | undefined;

export async function probeHerdrBinary(exec: HerdrExec = defaultExec): Promise<boolean> {
  // Memoize the default-exec probe per process — every subagent call inside
  // herdr would otherwise pay a CLI spawn. Custom execs (tests) never cache.
  if (exec === defaultExec && defaultExecProbe) return defaultExecProbe;
  const probe = (async () => {
    const res = await exec("herdr", ["--version"], { timeout: 5_000 });
    const ok = res.code === 0;
    // Cache successes only: a transient failure (CLI hang, load spike) must
    // not permanently disable herdr delegation for the process lifetime.
    if (exec === defaultExec && ok) defaultExecProbe = Promise.resolve(true);
    return ok;
  })();
  return probe;
}

/**
 * Effective runner for a subagent tool call: explicit param wins; otherwise
 * herdr when the env is detected, the binary answers, and neither settings
 * nor the recursion-guard env disabled it.
 */
export async function resolveEffectiveRunner(
  requested: "sdk" | "herdr" | undefined,
  subagentSettings: { herdr?: unknown } | undefined,
  exec: HerdrExec = defaultExec,
): Promise<{ runner: "sdk" | "herdr"; error?: string }> {
  if (requested === "herdr") {
    if (!herdrEnvDetected()) return { runner: "sdk", error: "runner:\"herdr\" requested but pi is not running inside herdr (HERDR_ENV!=1)." };
    if (herdrDisabled(subagentSettings)) return { runner: "sdk", error: "runner:\"herdr\" requested but herdr delegation is disabled (subagent.herdr:\"off\" or PI_SUBAGENT_HERDR=off)." };
    if (!await probeHerdrBinary(exec)) return { runner: "sdk", error: "runner:\"herdr\" requested but the herdr binary is not available on PATH." };
    return { runner: "herdr" };
  }
  if (requested === "sdk") return { runner: "sdk" };
  if (!herdrEnvDetected() || herdrDisabled(subagentSettings)) return { runner: "sdk" };
  if (!await probeHerdrBinary(exec)) return { runner: "sdk" };
  return { runner: "herdr" };
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function extractCliError(res: { stderr: string; stdout: string }): string {
  for (const raw of [res.stderr, res.stdout]) {
    const text = raw.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      if (typeof parsed.error === "string") return parsed.error;
      if (parsed.error?.message) return parsed.error.message;
    } catch { /* not JSON */ }
    return text.split("\n")[0]!.slice(0, 300);
  }
  return `exit code ${"?"}`;
}

async function herdrJson(
  exec: HerdrExec,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const res = await exec("herdr", args, { timeout: timeoutMs });
  if (res.code !== 0) return { ok: false, error: extractCliError(res) };
  try {
    return { ok: true, data: JSON.parse(res.stdout) };
  } catch {
    return { ok: false, error: `herdr ${args.join(" ")}: unparseable JSON output` };
  }
}

// ---------------------------------------------------------------------------
// Name allocation & child argv
// ---------------------------------------------------------------------------

/** "scout-1", "scout-2", … — herdr names are [a-z][a-z0-9_-]{0,31}, unique among live agents. */
export function allocateName(agentType: string, liveNames: Iterable<string>): string {
  const taken = new Set(liveNames);
  let base = agentType.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!base) base = "agent";
  if (!/^[a-z]/.test(base)) base = `a${base}`;
  base = base.slice(0, 26);
  for (let n = 1; n < 1_000; n++) {
    const name = `${base}-${n}`;
    if (!taken.has(name)) return name;
    taken.add(name);
  }
  throw new Error(`Could not allocate a unique herdr agent name for "${agentType}"`);
}

export interface BuildPiArgsOptions {
  name: string;
  /** Path to a file holding the persona — herdr's `agent start --` arg
   * encoder rejects multi-line/shell-unsafe strings, so the system prompt
   * travels as a file (`--append-system-prompt` reads files). */
  systemPromptFile: string;
  /** Resolved "provider/id" — omitted to let the child use its own default. */
  model?: string;
  thinking?: string;
  tools?: string[];
  readOnly?: boolean;
  /** Stamp making the session id unique per dispatch. Follow-up prompts (herdr
   *  tool) continue the LIVE process's in-memory context regardless of the id;
   *  a stable id would instead silently resume a stale (potentially huge)
   *  session after a tab close or parent restart. */
  sessionStamp: string;
}

/** CLI flags that reproduce the agent persona in a full interactive pi child. */
export function buildPiArgs(opts: BuildPiArgsOptions): string[] {
  const args = ["--append-system-prompt", opts.systemPromptFile];
  if (opts.model) args.push("--model", opts.model);
  const thinking = opts.thinking && opts.thinking !== "off" ? opts.thinking : undefined;
  if (thinking) args.push("--thinking", thinking);
  let tools = opts.tools;
  if (opts.readOnly) {
    // Same filter the SDK path applies: explicit tools ∩ read-only allowlist.
    tools = (opts.tools ?? [...READ_ONLY_TOOLS]).filter((t) => READ_ONLY_TOOLS.includes(t));
    if (tools.length === 0) {
      // Omitting --tools would hand the child pi's FULL default toolset —
      // worse than failing. Mirror the SDK path and reject.
      throw new Error("read-only sandbox leaves no allowed tools for this agent — add read-only tools (read, grep, find, ls, …) to the agent definition or drop sandbox:\"read-only\"");
    }
  }
  if (tools && tools.length > 0) args.push("--tools", tools.join(","));
  // Fresh session per dispatch: the id is unique per task, so a recycled
  // agent name never resumes a stale session. Control-tool follow-ups keep
  // context in the live process's memory, not via the id.
  args.push("--session-id", `herdr-${opts.name}-${opts.sessionStamp}`, "--name", opts.name);
  return args;
}

/** Task + file-report contract. The file is the reliable channel: pi renders
 *  on the alternate screen, so finished output never reaches herdr scrollback. */
export function wrapTaskPrompt(task: string, resultFile: string): string {
  return (
    `${task}\n\n---\n` +
    `Delivery: when your task is complete, write your full final report as Markdown to \`${resultFile}\` ` +
    `(create parent directories if needed), then reply with a one-line summary only.`
  );
}

// ---------------------------------------------------------------------------
// Layout: tab per agent type, pane per instance
// ---------------------------------------------------------------------------

/** Find a tab labelled `agentType` in the current workspace, else create one. */
export async function ensureTab(opts: {
  agentType: string;
  cwd: string;
  exec: HerdrExec;
}): Promise<{ tabId: string; rootPaneId?: string; created: boolean }> {
  const workspace = process.env.HERDR_WORKSPACE_ID!;
  const listed = await herdrJson(opts.exec, ["tab", "list", "--workspace", workspace]);
  if (listed.ok) {
    const tabs: any[] = listed.data?.result?.tabs ?? [];
    const match = tabs.find((t) => t?.label === opts.agentType && t?.tab_id);
    if (match) return { tabId: match.tab_id, created: false };
  }
  const created = await herdrJson(opts.exec, [
    "tab", "create",
    "--workspace", workspace,
    "--cwd", opts.cwd,
    "--label", opts.agentType,
    // Children must not recurse into herdr dispatch.
    "--env", `${HERDR_OFF_ENV}=off`,
    "--no-focus",
  ]);
  if (!created.ok) throw new Error(`herdr tab create failed: ${created.error}`);
  const tabId = created.data?.result?.tab?.tab_id;
  const rootPaneId = created.data?.result?.root_pane?.pane_id;
  if (!tabId || !rootPaneId) throw new Error("herdr tab create: unexpected response shape (missing tab_id/root_pane)");
  return { tabId, rootPaneId, created: true };
}

/** Panes of a tab split into free (no agent) and all. */
async function tabPaneState(
  tabId: string,
  exec: HerdrExec,
): Promise<{ free: string[]; all: string[] }> {
  const workspace = process.env.HERDR_WORKSPACE_ID!;
  const [panes, agents] = await Promise.all([
    herdrJson(exec, ["pane", "list", "--workspace", workspace]),
    herdrJson(exec, ["agent", "list"]),
  ]);
  const all: string[] = panes.ok
    ? (panes.data?.result?.panes ?? []).filter((p: any) => p?.tab_id === tabId && p?.pane_id).map((p: any) => p.pane_id)
    : [];
  const occupied = new Set<string>(
    agents.ok ? (agents.data?.result?.agents ?? []).map((a: any) => a?.pane_id).filter(Boolean) : [],
  );
  return { free: all.filter((id) => !occupied.has(id)), all };
}

/**
 * Return a pane in `tabId` that can host a new agent: the tab's root pane when
 * it is still a free shell, else a fresh split (direction alternates so
 * repeated dispatches don't create unusably narrow strips).
 */
export async function ensurePane(opts: {
  tabId: string;
  cwd: string;
  exec: HerdrExec;
  /** Reuse a free (agent-less) pane. Only safe for tabs this session created
   *  with the validated cwd — a free pane in an adopted tab belongs to
   *  whatever cwd its shell sits in, or to the user. */
  reuseFreePane: boolean;
}): Promise<string> {
  const { free, all } = await tabPaneState(opts.tabId, opts.exec);
  if (opts.reuseFreePane && free.length > 0) return free[0]!;
  const target = all[all.length - 1];
  if (!target) throw new Error(`herdr: no panes found in tab ${opts.tabId}`);
  const direction = all.length % 2 === 1 ? "right" : "down";
  const split = await herdrJson(opts.exec, [
    "pane", "split", target,
    "--direction", direction,
    "--cwd", opts.cwd,
    "--env", `${HERDR_OFF_ENV}=off`,
    "--no-focus",
  ]);
  if (!split.ok) throw new Error(`herdr pane split failed: ${split.error}`);
  const paneId = split.data?.result?.pane?.pane_id;
  if (!paneId) throw new Error("herdr pane split: unexpected response shape (missing pane.pane_id)");
  return paneId;
}

/** Names of all live herdr agents (defensive: field name varies across versions). */
export async function liveAgentNames(exec: HerdrExec): Promise<string[]> {
  const listed = await herdrJson(exec, ["agent", "list"]);
  if (!listed.ok) return [];
  return (listed.data?.result?.agents ?? [])
    .map((a: any) => a?.name ?? a?.agent_name)
    .filter((n: unknown): n is string => typeof n === "string" && n.length > 0);
}

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

/** Start an interactive pi child in a pane; tolerates slow startups (agent_not_ready). */
export async function startAgent(opts: {
  name: string;
  paneId: string;
  piArgs: string[];
  exec: HerdrExec;
  /** Backoff between pane-availability retries (tests shrink this). */
  retryDelayMs?: number;
}): Promise<void> {
  // A brand-new pane's shell may not be at its prompt yet when several tabs
  // are created concurrently — retry the pane-availability rejection briefly.
  for (let attempt = 1; ; attempt++) {
    const res = await opts.exec(
      "herdr",
      ["agent", "start", opts.name, "--kind", "pi", "--pane", opts.paneId, "--", ...opts.piArgs],
      { timeout: AGENT_START_TIMEOUT_MS },
    );
    if (res.code === 0) return;
    const errText = `${res.stderr}\n${res.stdout}`;
    if (/not an available shell/i.test(errText) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, (opts.retryDelayMs ?? 2_000) * attempt));
      continue;
    }
    if (/agent_not_ready|timed?\s?out/i.test(errText)) {
      // The name stays bound; wait for the child to become ready for input.
      const wait = await opts.exec(
        "herdr",
        ["agent", "wait", opts.name, "--until", "idle", "--timeout", "30000"],
        { timeout: AGENT_START_TIMEOUT_MS },
      );
      if (wait.code === 0) return;
      throw new Error(`herdr agent ${opts.name} did not become ready: ${extractCliError(wait)}`);
    }
    throw new Error(`herdr agent start failed: ${extractCliError(res)}`);
  }
}

export type HerdrAgentState = "idle" | "done" | "blocked" | "working" | "unknown";

export async function getAgentState(name: string, exec: HerdrExec): Promise<HerdrAgentState> {
  const status = (await getAgentInfo(name, exec))?.status;
  return status === "idle" || status === "done" || status === "blocked" || status === "working"
    ? status
    : "unknown";
}

export interface HerdrAgentInfo {
  name?: string;
  paneId?: string;
  tabId?: string;
  status?: string;
  cwd?: string;
}

/** Live info for one herdr agent (`herdr agent get`). */
export async function getAgentInfo(name: string, exec: HerdrExec): Promise<HerdrAgentInfo | undefined> {
  const got = await herdrJson(exec, ["agent", "get", name]);
  if (!got.ok) return undefined;
  const a = got.data?.result?.agent ?? got.data?.result ?? {};
  return {
    name: a.name ?? a.agent_name,
    paneId: a.pane_id,
    tabId: a.tab_id,
    status: a.agent_status,
    cwd: a.cwd,
  };
}

/** Live info for all herdr agents (`herdr agent list`). */
export async function listHerdrAgents(exec: HerdrExec): Promise<HerdrAgentInfo[]> {
  const listed = await herdrJson(exec, ["agent", "list"]);
  if (!listed.ok) return [];
  return (listed.data?.result?.agents ?? []).map((a: any) => ({
    name: a?.name ?? a?.agent_name,
    paneId: a?.pane_id,
    tabId: a?.tab_id,
    status: a?.agent_status,
    cwd: a?.cwd,
  }));
}

export interface PromptOutcome {
  /** Settled lifecycle state after the prompt (or best-known state on failure). */
  state: HerdrAgentState;
  /** False when herdr rejected the prompt before writing any input. */
  delivered: boolean;
  error?: string;
}

/** Submit the task and wait for the first settled idle/done/blocked state. */
export async function promptAndWait(opts: {
  name: string;
  text: string;
  timeoutMs: number;
  exec: HerdrExec;
}): Promise<PromptOutcome> {
  const res = await opts.exec(
    "herdr",
    ["agent", "prompt", opts.name, opts.text, "--wait", "--timeout", String(opts.timeoutMs)],
    { timeout: opts.timeoutMs + 20_000 },
  );
  if (res.code !== 0) {
    const errText = `${res.stderr}\n${res.stdout}`;
    if (/agent_blocked/i.test(errText)) {
      return { state: "blocked", delivered: false, error: "Agent is blocked on a dialog — answer it in its pane, then prompt again." };
    }
    if (/timed?\s?out/i.test(errText)) {
      return { state: "unknown", delivered: true, error: `timeout after ${opts.timeoutMs}ms` };
    }
    if (/stalled/i.test(errText)) {
      return { state: "unknown", delivered: false, error: "agent_prompt_stalled: no agent activity observed after submission" };
    }
    // Unexpected error — still report the last known state.
    const state = await getAgentState(opts.name, opts.exec);
    return { state, delivered: true, error: extractCliError(res) };
  }
  const state = await getAgentState(opts.name, opts.exec);
  return { state, delivered: true };
}

/** Best-effort output collection: report file first, pane scrollback fallback. */
/** Cap for report-file content fed back into the parent context. */
export const MAX_REPORT_BYTES = 256 * 1024;

export async function collectResult(opts: {
  handle: HerdrHandle;
  exec: HerdrExec;
}): Promise<{ output: string; source: "file" | "pane" | "none" }> {
  try {
    const raw = await fs.readFile(opts.handle.resultFile);
    const text = raw.length > MAX_REPORT_BYTES
      ? raw.subarray(0, MAX_REPORT_BYTES).toString("utf8") + "\n\n…(truncated)"
      : raw.toString("utf8");
    if (text.trim()) return { output: text.trim(), source: "file" };
  } catch { /* no report file — fall back to pane read */ }
  const read = await opts.exec(
    "herdr",
    ["agent", "read", opts.handle.name, "--source", "recent-unwrapped", "--lines", "200"],
    { timeout: 10_000 },
  );
  const paneText = read.code === 0 ? read.stdout.trim() : "";
  // Pane scrollback can contain pre-prompt noise (resumed sessions, earlier
  // turns). The final reply sits at the END, so cap to the tail — this also
  // bounds {previous} substitution in chains.
  const MAX_PANE_CAPTURE_BYTES = 8 * 1024;
  const capped = paneText.length > MAX_PANE_CAPTURE_BYTES
    ? "…(earlier pane output truncated)\n" + paneText.slice(-MAX_PANE_CAPTURE_BYTES)
    : paneText;
  return { output: capped, source: paneText ? "pane" : "none" };
}

/** Interrupt a delegated agent: esc first (pi interrupt), ctrl+c if still working. */
export async function cancelAgent(name: string, exec: HerdrExec = defaultExec): Promise<void> {
  await exec("herdr", ["agent", "send-keys", name, "esc"], { timeout: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  try {
    const state = await getAgentState(name, exec);
    // Escalate whenever the post-esc state is not verifiably settled:
    // herdr 0.9.0 does not classify ask_user_question dialogs as "blocked"
    // (they report "unknown"), so classification-based escalation would
    // strand them. Interrupting a finished child is harmless.
    if (state !== "idle" && state !== "done") {
      await exec("herdr", ["agent", "send-keys", name, "ctrl+c"], { timeout: 5_000 });
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Result building
// ---------------------------------------------------------------------------

export function buildHerdrResult(
  handle: HerdrHandle,
  outcome: {
    state: PromptOutcome["state"];
    delivered: boolean;
    error?: string;
    output: string;
    outputSource: "file" | "pane" | "none";
    durationMs: number;
  },
): SubAgentResult {
  // The usage line renders `model` verbatim — piggyback the pane identity so
  // results are traceable to their herdr pane without render changes.
  const model = `${handle.model} · herdr pane:${handle.name}`;
  let stopReason: string;
  let status: SubAgentResult["status"];
  let errorMessage: string | undefined;
  if (outcome.state === "blocked" || (outcome.delivered && !outcome.error && outcome.state === "working")) {
    stopReason = "blocked";
    status = "partial";
    errorMessage = outcome.error ?? "Blocked awaiting user input — answer in the pane (or use the herdr tool), then prompt again.";
  } else if (outcome.error && /timeout/.test(outcome.error)) {
    stopReason = "timeout";
    status = "timeout";
    errorMessage = outcome.error;
    // Any other error is a failure — an error with a settled state (idle/done)
    // must never fall through to success.
  } else if (outcome.error || !outcome.delivered) {
    stopReason = "error";
    status = "error";
    errorMessage = outcome.error ?? "herdr agent did not settle";
  } else if (outcome.state === "unknown" && !outcome.output) {
    // Settled per the CLI, but the post-prompt state read failed (crashed
    // child, unrecognized status) and nothing was collected — never fabricate
    // an empty success.
    stopReason = "error";
    status = "error";
    errorMessage = "agent settled but its state could not be verified and no report was collected";
  } else {
    stopReason = "stop";
    status = "success";
  }
  // Synthetic assistant message carrying the report — keeps getResultOutput /
  // renderSingleResult working unchanged (they read result.messages).
  // Pane-source output is a best-effort capture (echoed task, TUI noise) —
  // label it so the parent treats it with appropriate distrust.
  const output = outcome.outputSource === "pane" && outcome.output
    ? `[best-effort pane capture]\n\n${outcome.output}`
    : outcome.output;
  const messages = (output
    ? [{ role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop" }]
    : []) as unknown as Message[];
  const failed = status === "error" || status === "timeout";
  return {
    agent: handle.agentType,
    task: handle.task,
    exitCode: failed ? 1 : 0,
    messages,
    stderr: errorMessage ?? "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model,
    stopReason,
    errorMessage,
    status,
    durationMs: outcome.durationMs,
  };
}

// ---------------------------------------------------------------------------
// High-level task flow used by the subagent tool path
// ---------------------------------------------------------------------------

export interface PrepareHerdrTaskOptions {
  agentType: string;
  systemPrompt: string;
  task: string;
  cwd: string;
  /** Resolved "provider/id" — omitted to let the child use its own default. */
  model?: string;
  thinking?: string;
  tools?: string[];
  readOnly?: boolean;
  timeoutMs: number;
  exec?: HerdrExec;
}

function resultFilePath(cwd: string, name: string, stamp: string): string {
  return path.join(cwd, ".pi", "herdr", `${name}-${stamp}.md`);
}

/** Session + report files share one stamp so they correlate per dispatch. */
function dispatchStamp(): string {
  return Date.now().toString(36);
}

/**
 * Validate + create topology + start the child (no prompt yet). Split from
 * execution so parallel dispatch can materialise every pane up front — all
 * agents visible in herdr — before any prompt is submitted.
 */
async function prepareHerdrTaskUncached(opts: PrepareHerdrTaskOptions): Promise<HerdrHandle> {
  // herdrCli.exec (defaultExec unless a test swapped it) — one seam keeps
  // every dispatch path controllable from tests.
  const exec = opts.exec ?? herdrCli.exec;
  if (Buffer.byteLength(opts.task, "utf8") > HERDR_TASK_BUDGET) {
    throw new Error(`herdr task exceeds the ${HERDR_TASK_BUDGET}-byte budget (argv ceiling incl. delivery wrapper) — shorten the task or use runner:"sdk".`);
  }
  const liveNames = await liveAgentNames(exec);
  const name = allocateName(opts.agentType, [...liveNames, ...registry.keys()]);
  const stamp = dispatchStamp();
  const handle: HerdrHandle = {
    name,
    agentType: opts.agentType,
    tabId: "",
    paneId: "",
    resultFile: resultFilePath(opts.cwd, name, stamp),
    task: opts.task,
    model: opts.model ?? "",
    timeoutMs: opts.timeoutMs,
    tabCreatedHere: true,
  };
  // Reserve immediately so concurrent allocators (and the control tool) see it.
  registry.set(name, handle);
  try {
    await fs.mkdir(path.dirname(handle.resultFile), { recursive: true });
    // Persona as a file: raw multi-line args cannot cross herdr's shell encoder.
    const systemPromptFile = path.join(path.dirname(handle.resultFile), `${name}.system.md`);
    await fs.writeFile(systemPromptFile, opts.systemPrompt, "utf8");
    // Build argv before touching topology — arg validation failures (e.g. a
    // read-only sandbox with no allowed tools) must leave no orphan tab/pane.
    const piArgs = buildPiArgs({
      name,
      systemPromptFile,
      model: opts.model,
      thinking: opts.thinking,
      tools: opts.tools,
      readOnly: opts.readOnly,
      sessionStamp: stamp,
    });
    const { tabId, created } = await ensureTab({ agentType: opts.agentType, cwd: opts.cwd, exec });
    handle.tabId = tabId;
    handle.tabCreatedHere = created;
    const paneId = await ensurePane({ tabId, cwd: opts.cwd, exec, reuseFreePane: created });
    handle.paneId = paneId;
    try {
      await startAgent({ name, paneId, piArgs, exec });
    } catch (err) {
      // Another session's parent grabbed the name between our list and our
      // start — re-allocate past the collision and retry once.
      if (!/already used/i.test(err instanceof Error ? err.message : String(err))) throw err;
      // Avoid live herdr names too — the collision we're recovering from
      // came from a live agent this registry doesn't know about.
      const retryName = allocateName(opts.agentType, [...(await liveAgentNames(exec)), ...registry.keys()]);
      handle.name = retryName;
      registry.delete(name);
      registry.set(retryName, handle);
      const retryArgs = buildPiArgs({
        name: retryName,
        systemPromptFile,
        model: opts.model,
        thinking: opts.thinking,
        tools: opts.tools,
        readOnly: opts.readOnly,
        sessionStamp: stamp,
      });
      handle.resultFile = resultFilePath(opts.cwd, retryName, stamp);
      await startAgent({ name: retryName, paneId, piArgs: retryArgs, exec });
    }
    await fs.mkdir(path.dirname(handle.resultFile), { recursive: true });
    return handle;
  } catch (err) {
    registry.delete(handle.name);
    throw err;
  }
}

// ponytail: prepares serialize per agent type — concurrent same-type dispatch
// would race tab create / pane pick / name allocation; the expensive part
// (prompt + run) stays fully parallel. Drop the chain if cross-type prepare
// throughput ever matters.
const prepareChains = new Map<string, Promise<HerdrHandle>>();

export function prepareHerdrTask(opts: PrepareHerdrTaskOptions): Promise<HerdrHandle> {
  const prev = prepareChains.get(opts.agentType) ?? Promise.resolve(null as unknown as HerdrHandle);
  const job = prev.then(
    () => prepareHerdrTaskUncached(opts),
    () => prepareHerdrTaskUncached(opts),
  );
  prepareChains.set(opts.agentType, job);
  job.catch(() => { /* stored chain must not reject unhandled */ });
  return job;
}

export interface ExecuteHerdrTaskOptions {
  exec?: HerdrExec;
  /** Poll feedback: herdr lifecycle state changes (~2s cadence). */
  onState?: (state: string) => void;
  /** Abort source (parent abort / abortOnFailure). When aborted, the result is
   *  mapped to status "aborted" instead of whatever state the child settled
   *  into — a cancelled agent must never read as success. */
  signal?: AbortSignal;
}

/** Prompt the prepared agent, wait for settle, collect the report. */
export async function executeHerdrTask(
  handle: HerdrHandle,
  opts: ExecuteHerdrTaskOptions = {},
): Promise<SubAgentResult> {
  const exec = opts.exec ?? herdrCli.exec;
  const startedAt = Date.now();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let pollInFlight = false;
  let lastState = "";
  const poll = async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const state = await getAgentState(handle.name, exec);
      if (state !== lastState) {
        lastState = state;
        opts.onState?.(state);
      }
    } catch { /* state poll is best-effort */ }
    pollInFlight = false;
  };
  try {
    pollTimer = setInterval(() => { void poll(); }, 2_000);
    pollTimer.unref?.();
    // A pre-aborted dispatch must not submit the task to the live child at
    // all (mirrors the SDK path's early return on an aborted signal).
    const prompt = opts.signal?.aborted
      ? { state: "unknown" as const, delivered: false, error: "aborted: parent operation aborted" }
      : await promptAndWait({
        name: handle.name,
        text: wrapTaskPrompt(handle.task, handle.resultFile),
        timeoutMs: handle.timeoutMs,
        exec,
      });
    let output = "";
    let outputSource: "file" | "pane" | "none" = "none";
    const aborted = Boolean(opts.signal?.aborted);
    const timedOut = !aborted && Boolean(prompt.error && /timeout/.test(prompt.error));
    if (timedOut) {
      // Wall-clock cap: interrupt the child so it stops burning tokens.
      await cancelAgent(handle.name, exec);
    } else if (!aborted) {
      const collected = await collectResult({ handle, exec });
      output = collected.output;
      outputSource = collected.source;
    }
    const result = buildHerdrResult(handle, {
      state: prompt.state,
      delivered: prompt.delivered,
      error: prompt.error,
      output,
      outputSource,
      durationMs: Date.now() - startedAt,
    });
    if (aborted) {
      // Match the SDK runner's abort semantics (esc/ctrl+c already sent by the
      // abort wiring — the child settling to idle must not read as success).
      result.stopReason = "aborted";
      result.status = "aborted";
      result.exitCode = 1;
      result.errorMessage = "Cancelled: parent operation aborted";
    }
    return result;
  } finally {
    if (pollTimer) clearInterval(pollTimer);
  }
}
