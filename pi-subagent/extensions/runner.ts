/**
 * SDK-based sub-agent runner for pi-subagent.
 *
 * Creates an in-process AgentSession via the pi SDK instead of spawning a
 * separate `pi` process. This eliminates cold-start overhead and allows
 * fine-grained control over token budget:
 *
 *   - Only the agent's system prompt is used (no pi defaults).
 *   - No AGENTS.md, no extensions, no skills, no prompt templates loaded.
 *   - Thinking disabled, compaction disabled, one transient retry.
 *   - In-memory session (no disk I/O).
 *   - Shared auth/model infrastructure (no re-connection).
 *
 * Estimated token savings vs process-spawn: ~4-11K tokens per invocation.
 */

import type { Message, Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import * as path from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  DefaultResourceLoader,
  getAgentDir,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  classifyStopReason,
  createCombinedAbortSignal,
  type SubagentStatus,
} from "./security.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export const DEFAULT_INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000;
export const HARD_TIMEOUT_MS = 20 * 60 * 1000;

// ---------------------------------------------------------------------------
// Extension resource loader
// ---------------------------------------------------------------------------

/**
 * Build a FRESH lean DefaultResourceLoader for this child — no skills, prompt
 * templates, context files (AGENTS.md), or themes. Extensions are loaded per
 * child so their factories run against a runtime that THIS child's session will
 * bind.
 *
 * Do NOT cache/share this loader. Extensions capture the ExtensionAPI (`pi`)
 * at factory load time, and its actions delegate to the runtime passed to the
 * factory (see createExtensionAPI: pi.getAllTools() → runtime.getAllTools()).
 * If extensions were loaded once against a shared/cached runtime, that runtime
 * is never the one any single child binds: a session binds the runtime its own
 * getExtensions() returned (AgentSession constructor), while the factory-captured
 * pi still points at the shared runtime. A child then hits the runtime's throwing
 * "Extension runtime not initialized" stubs on the first provider request
 * (pi-model-tools' before_provider_request calls pi.getAllTools()), or stale-ctx
 * errors when the shared runtime is invalidated by the first child's dispose.
 * A per-child loader keeps every captured `pi` pointing at a runtime this child
 * both binds and owns.
 *
 * Project-extension trust is resolved from the parent (`projectTrusted`) so a
 * child never prompts for trust (it has no UI). reload() per child re-reads
 * extension files + re-runs factories; acceptable for short-lived children.
 */
async function getExtensionLoader(cwd: string, projectTrusted: boolean): Promise<ResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
  });
  await loader.reload({ resolveProjectTrust: async () => projectTrusted });
  // Log (don't throw on) extension load errors — a misbehaving extension must
  // not crash the child; the agent simply won't have that tool.
  const loadErrors = loader.getExtensions().errors;
  if (loadErrors.length > 0) {
    process.stderr.write(
      `[pi-subagent] extension load warnings in child loader: ${loadErrors.map((e) => `${e.path}: ${e.error}`).join("; ")}\n`,
    );
  }
  return loader;
}

export interface SubAgentProgress {
  label: string;
  at: number;
  elapsedMs: number;
  inactivityDeadline: number;
  hardDeadline: number;
  result: SubAgentResult;
}

export interface SubAgentResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  /** Unified diff of changes made in an isolated worktree (sandbox: "worktree"). */
  patch?: string;
  /** Canonical result status (added in 0.6.0). */
  status?: SubagentStatus;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startHeartbeat(onHeartbeat: () => void, intervalMs = 30_000): () => void {
  const timer = setInterval(onHeartbeat, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function runSubAgent(options: {
  cwd: string;
  systemPrompt: string;
  task: string;
  tools: string[];
  model: Model<any>;
  /** "worktree" runs the child in an isolated git worktree; the resulting diff is returned as result.patch. */
  sandbox?: "worktree";
  /** Pi 0.80.10's canonical credential/model runtime. */
  modelRuntime?: unknown;
  /** Legacy Pi SDK session options retained for 0.80.6 tests and hosts. */
  authStorage?: unknown;
  modelRegistry?: unknown;
  signal?: AbortSignal;
  agentName?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  onMessage?: (partialResult: SubAgentResult) => void;
  onProgress?: (progress: SubAgentProgress) => void;
  timeoutMs?: number;
  hardTimeoutMs?: number;
  /** Exec used for the git worktree lifecycle (add/remove/diff). Defaults to a child_process spawn when unset. */
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * When true, build a DefaultResourceLoader so the child inherits the parent's
   * extensions (and thus extension tools: web, serena, munin, …). When false or
   * unset, the lean empty-loader stub is used (no extensions).
   */
  loadExtensions?: boolean;
  /**
   * Whether the parent session trusts the project. Forwarded to the loader's
   * resolveProjectTrust so children inherit the parent's trust decision and
   * never prompt for project-extension trust (children have no UI). Defaults true.
   */
  projectTrusted?: boolean;
}): Promise<SubAgentResult> {
  const {
    cwd, systemPrompt, task, tools, model, modelRuntime, authStorage, modelRegistry, signal,
    agentName = "subagent", thinkingLevel = "off", onMessage, onProgress,
    timeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS, hardTimeoutMs = HARD_TIMEOUT_MS,
    loadExtensions = false, projectTrusted = true, sandbox, exec,
  } = options;
  const result: SubAgentResult = {
    agent: agentName, task, exitCode: 0, messages: [], stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: `${model.provider}/${model.id}`, status: undefined,
  };
  const resourceLoader: ResourceLoader = loadExtensions
    ? await getExtensionLoader(cwd, projectTrusted)
    : {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => systemPrompt, getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
        extendResources: () => {}, reload: async () => {},
      };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1 } });
  const startedAt = Date.now();
  let inactivityDeadline = startedAt + timeoutMs;
  const hardDeadline = startedAt + hardTimeoutMs;
  let timeoutKind: "idle" | "hard" | undefined;
  const timeoutController = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupCombined: (() => void) | undefined;
  const clearTimers = () => { if (idleTimer) clearTimeout(idleTimer); if (hardTimer) clearTimeout(hardTimer); };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    inactivityDeadline = Date.now() + timeoutMs;
    idleTimer = setTimeout(() => { timeoutKind = "idle"; timeoutController.abort(new Error(`Idle timeout after ${timeoutMs}ms`)); }, timeoutMs);
  };
  const snapshot = (label: string): SubAgentProgress => ({ label, at: Date.now(), elapsedMs: Date.now() - startedAt, inactivityDeadline, hardDeadline, result: { ...result, messages: [...result.messages] } });
  try {
    armIdle();
    hardTimer = setTimeout(() => { timeoutKind = "hard"; timeoutController.abort(new Error(`Hard timeout after ${hardTimeoutMs}ms`)); }, hardTimeoutMs);
    const { signal: combinedSignal, cleanup } = createCombinedAbortSignal([signal, timeoutController.signal]);
    cleanupCombined = cleanup;
    if (combinedSignal.aborted) {
      result.exitCode = 1;
      const timedOut = timeoutController.signal.aborted && !signal?.aborted;
      result.stopReason = timedOut ? "timeout" : "aborted";
      result.errorMessage = timedOut ? `${timeoutKind === "idle" ? "Idle" : "Hard"} timeout after ${timeoutKind === "idle" ? timeoutMs : hardTimeoutMs}ms` : "Sub-agent aborted before start";
      result.status = classifyStopReason(result.stopReason, !timedOut, timedOut);
      return result;
    }

    // Isolated git worktree: the child edits a sibling checkout; the resulting
    // diff is returned as result.patch and the worktree is removed on exit.
    // ponytail: falls back to the in-process cwd when git is unavailable — the
    // worktree is an isolation optimization, not a hard requirement.
    let worktreeDir: string | undefined;
    let childCwd = cwd;
    if (sandbox === "worktree") {
      const wt = await createWorktree(cwd, exec);
      if (wt.ok) {
        worktreeDir = wt.path;
        childCwd = wt.path!;
      } else if (wt.error) {
        result.stderr = `Worktree unavailable (${wt.error}); running in workspace.`;
      }
    }

    let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    try {
      const created = await createAgentSession({
        cwd: childCwd, model, thinkingLevel, resourceLoader, tools, sessionManager: SessionManager.inMemory(childCwd), settingsManager,
        ...(modelRuntime ? { modelRuntime } : {}),
        // Pi 0.80.10 owns credentials in ModelRuntime; older SDKs still accept these.
        ...(authStorage ? { authStorage, modelRegistry } : {}),
      } as any);
      session = created.session;
    } catch (error) {
      if (worktreeDir) await removeWorktree(cwd, worktreeDir, exec);
      throw error;
    }
    let unsubscribe: (() => void) | undefined;
    let removeAbort: (() => void) | undefined;
    try {
      const eventDone = new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (fn: () => void) => { if (!done) { done = true; unsubscribe?.(); fn(); } };
        unsubscribe = session.subscribe((event) => {
          try {
            // Any SDK session lifecycle event is actual child activity, unlike a parent heartbeat.
            armIdle(); onProgress?.(snapshot(event.type));
            if (event.type === "message_end") {
              const msg = event.message as AgentMessage;
              if (msg.role === "assistant") {
                result.usage.turns++;
                if (msg.usage) { result.usage.input += msg.usage.input || 0; result.usage.output += msg.usage.output || 0; result.usage.cacheRead += msg.usage.cacheRead || 0; result.usage.cacheWrite += msg.usage.cacheWrite || 0; result.usage.cost += msg.usage.cost?.total || 0; result.usage.contextTokens = msg.usage.totalTokens || 0; }
                if (!result.model && msg.model) result.model = `${msg.provider || "?"}/${msg.model}`;
                if (msg.stopReason) result.stopReason = msg.stopReason;
                result.errorMessage = msg.errorMessage;
              }
              result.messages.push(msg as unknown as Message);
              onMessage?.({ ...result, messages: [...result.messages] });
            } else if (event.type === "agent_end" && !event.willRetry) {
              if (!result.messages.length && event.messages) result.messages = event.messages as unknown as Message[];
              finish(resolve);
            }
          } catch (error) { finish(() => reject(error)); }
        });
        const abort = () => finish(resolve);
        combinedSignal.addEventListener("abort", abort, { once: true });
        removeAbort = () => combinedSignal.removeEventListener("abort", abort);
      });
      const abortSession = () => session.abort();
      combinedSignal.addEventListener("abort", abortSession, { once: true });
      const removeSessionAbort = () => combinedSignal.removeEventListener("abort", abortSession);
      await Promise.race([session.prompt(task), eventDone]);
      removeSessionAbort();
      const timedOut = timeoutController.signal.aborted && !signal?.aborted;
      if (timedOut) { result.stopReason = "timeout"; result.errorMessage = `${timeoutKind === "idle" ? "Idle" : "Hard"} timeout after ${timeoutKind === "idle" ? timeoutMs : hardTimeoutMs}ms`; }
      else if (combinedSignal.aborted) { result.stopReason = "aborted"; result.errorMessage ||= "Sub-agent aborted"; }
      result.status = classifyStopReason(result.stopReason, result.stopReason === "aborted", result.stopReason === "timeout");
      result.exitCode = result.status === "success" || result.status === "partial" ? 0 : 1;
      if (worktreeDir) {
        // Capture the child's changes as a unified diff before tearing down.
        const diff = await captureWorktreeDiff(cwd, worktreeDir, exec);
        if (diff.ok) result.patch = diff.diff;
        else if (diff.error) result.stderr = result.stderr ? `${result.stderr}; diff unavailable (${diff.error})` : `Diff unavailable (${diff.error})`;
      }
      return result;
    } finally {
      unsubscribe?.(); removeAbort?.();
      try { session.dispose(); } catch { /* best effort */ }
      if (worktreeDir) await removeWorktree(cwd, worktreeDir, exec);
    }
  } catch (error) {
    result.exitCode = 1;
    result.errorMessage = error instanceof Error ? error.message : String(error);
    result.stopReason ||= "error";
    result.status = classifyStopReason(result.stopReason, false, false);
    return result;
  } finally {
    clearTimers(); cleanupCombined?.();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal exec fallback (child_process spawn) used when no exec is injected. */
async function defaultExec(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    // Decode each chunk as a complete UTF-8 stream (Buffer.toString per chunk
    // would corrupt multi-byte sequences straddling chunk boundaries).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = ""; let stderr = "";
    const timer = options?.timeout ? setTimeout(() => child.kill("SIGKILL"), options.timeout) : undefined;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => { if (timer) clearTimeout(timer); resolve({ code: 1, stdout, stderr: String(err.message ?? err) }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

async function runGit(
  cwd: string,
  args: string[],
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const run = exec ?? defaultExec;
  const res = await run("git", args, { cwd, timeout: 30_000 });
  return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr };
}

/** Create a detached git worktree at .pi-worktrees/<rand> under the repo root. */
export async function createWorktree(
  cwd: string,
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const root = await runGit(cwd, ["rev-parse", "--show-toplevel"], exec);
    if (!root.ok) return { ok: false, error: root.stderr.trim() || "not a git repo" };
    const repoRoot = root.stdout.trim();
    if (!repoRoot) return { ok: false, error: "empty git root" };
    const id = `pi-subagent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const wtPath = path.join(repoRoot, ".pi-worktrees", id);
    const add = await runGit(repoRoot, ["worktree", "add", "--detach", wtPath, "HEAD"], exec);
    if (!add.ok) return { ok: false, error: add.stderr.trim() || "git worktree add failed" };
    return { ok: true, path: wtPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Unified diff of ALL changes in the worktree vs HEAD (tracked edits, staged
 *  changes, AND new untracked files). Stages first so untracked files are
 *  captured — the worktree is removed right after, so mutating its index is
 *  safe. A single `diff --cached HEAD` avoids duplicate hunks from combining
 *  `diff HEAD` + `diff --cached`. */
export async function captureWorktreeDiff(
  repoRoot: string,
  worktreeDir: string,
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; diff?: string; error?: string }> {
  const add = await runGit(worktreeDir, ["add", "-A"], exec);
  if (!add.ok) return { ok: false, error: add.stderr.trim() || "git add -A failed" };
  const diff = await runGit(worktreeDir, ["diff", "--cached", "HEAD"], exec);
  if (!diff.ok) return { ok: false, error: diff.stderr.trim() || "git diff --cached HEAD failed" };
  const text = diff.stdout.trim();
  return { ok: true, diff: text || "(no changes)" };
}

/** Remove a worktree and its metadata, best-effort. */
export async function removeWorktree(
  repoRoot: string,
  worktreeDir: string,
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<void> {
  try {
    await runGit(repoRoot, ["worktree", "remove", "--force", worktreeDir], exec);
  } catch { /* best effort */ }
}


export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const texts: string[] = [];
    for (const part of msg.content) {
      if (part.type === "text" && part.text.trim()) texts.push(part.text);
    }
    if (texts.length === 0) continue;
    return texts.join("");
  }
  return "";
}

export function isFailedResult(result: SubAgentResult): boolean {
  // Use canonical status if available.
  if (result.status) {
    return result.status === "error" || result.status === "aborted" || result.status === "timeout";
  }
  // Fall back to legacy heuristics.
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    result.stopReason === "timeout"
  );
}

export function getResultOutput(result: SubAgentResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

/** Concurrency-limited map. Runs up to `concurrency` async operations at a time. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}
