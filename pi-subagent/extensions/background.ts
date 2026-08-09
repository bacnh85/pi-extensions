/**
 * Background task execution for pi-subagent.
 *
 * A background task runs detached from the parent tool call: `execute` returns
 * immediately with a receipt, and when the child finishes, a follow-up turn is
 * delivered via sendMessage({ triggerTurn: true, deliverAs: "followUp" }).
 *
 * The in-memory registry supports task control (status/cancel) by taskId.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { SubAgentResult, SubAgentProgress } from "./runner.ts";
import { isFailedResult, getResultOutput, getFinalOutput } from "./runner.ts";
import type { threadStore as ThreadStoreType } from "./threads.ts";
import type { AgentScope } from "./agents.ts";
import { parseStructuredResult } from "./result.ts";
import { appendHistory } from "./history.ts";

/** Mirrors SubagentDetails from index.ts without a circular import. */
interface BackgroundDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SubAgentResult[];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackgroundStatus = "running" | "completed" | "failed" | "aborted" | "timeout";

export interface BackgroundTask {
  id: string;
  threadId: string;
  agent: string;
  task: string;
  startedAt: number;
  status: BackgroundStatus;
  controller: AbortController;
  result?: SubAgentResult;
  completedAt?: number;
}

export interface BackgroundDeps {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  /** Run a single agent (the existing runOne closure). */
  runOne: (
    agent: string,
    task: string,
    cwd: string | undefined,
    signal: AbortSignal,
    timeoutMs: number | undefined,
    onProgress: (partial: SubAgentResult) => void,
    onActivity: (progress: SubAgentProgress) => void,
    onHeartbeatDetails: () => BackgroundDetails,
    onHeartbeat: () => void,
    isReadOnly?: boolean,
  ) => Promise<SubAgentResult>;
  threadStore: typeof ThreadStoreType;
}

// ---------------------------------------------------------------------------
// Registry (in-memory, per-session)
// ---------------------------------------------------------------------------

const backgroundTasks = new Map<string, BackgroundTask>();

export function getBackgroundTask(id: string): BackgroundTask | undefined {
  return backgroundTasks.get(id);
}

export function getAllBackgroundTasks(): BackgroundTask[] {
  return Array.from(backgroundTasks.values());
}

export function clearBackgroundTasks(): void {
  for (const task of backgroundTasks.values()) {
    task.controller.abort();
  }
  backgroundTasks.clear();
}

// ---------------------------------------------------------------------------
// Status snapshot (for operation: "status")
// ---------------------------------------------------------------------------

export interface TaskSnapshot {
  id: string;
  agent: string;
  task: string;
  status: BackgroundStatus;
  startedAt: number;
  completedAt?: number;
  elapsedMs: number;
  threadId: string;
  result?: { output: string; model?: string; usage?: unknown };
}

export function snapshotTask(task: BackgroundTask, now = Date.now()): TaskSnapshot {
  const result = task.result;
  return {
    id: task.id,
    agent: task.agent,
    task: task.task,
    status: task.status,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    elapsedMs: now - task.startedAt,
    threadId: task.threadId,
    result: result
      ? { output: getResultOutput(result), model: result.model, usage: result.usage }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Start a background task
// ---------------------------------------------------------------------------

export interface StartBackgroundInput {
  agent: string;
  task: string;
  cwd?: string;
  timeout?: number;
  agentColor?: string;
  toolCallId?: string;
  deps: BackgroundDeps;
}

export interface StartBackgroundResult {
  taskId: string;
  receipt: string;
}

/**
 * Start a detached background task. Returns immediately with a receipt.
 * On completion, delivers a follow-up turn to the parent session.
 */
export function startBackgroundTask(input: StartBackgroundInput): StartBackgroundResult {
  const { agent, task, cwd, timeout, agentColor, toolCallId, deps } = input;
  const taskId = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const controller = new AbortController();
  const startedAt = Date.now();

  // Create a thread so the task shows in the widget + /agent viewer.
  const thread = deps.threadStore.createThread({
    agentName: agent,
    task,
    mode: "single",
    toolCallId,
    color: agentColor,
  });

  const bgTask: BackgroundTask = {
    id: taskId,
    threadId: thread.id,
    agent,
    task,
    startedAt,
    status: "running",
    controller,
  };
  backgroundTasks.set(taskId, bgTask);

  // Run detached — the parent does NOT await this.
  void deps
    .runOne(
      agent,
      task,
      cwd,
      controller.signal,
      timeout,
      (partial) => deps.threadStore.updateThread(thread.id, { result: partial }),
      (progress) => deps.threadStore.updateProgress(thread.id, progress),
      () => ({ mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null, results: [] }),
      () => deps.threadStore.refreshHeartbeat(thread.id),
    )
    .then((result) => {
      bgTask.result = result;
      bgTask.completedAt = Date.now();
      const failed = isFailedResult(result);
      bgTask.status = failed
        ? result.stopReason === "timeout"
          ? "timeout"
          : result.stopReason === "aborted"
            ? "aborted"
            : "failed"
        : "completed";
      try {
        deps.threadStore.updateThread(thread.id, {
          status: failed ? (result.stopReason === "aborted" ? "aborted" : "failed") : "completed",
          result,
        });
      } catch {
        /* thread store unavailable — non-fatal; status/history already set */
      }
      recordHistory(bgTask, result, deps);
      // Delivery failure must NOT cascade into .catch: the task genuinely
      // completed, so its status/history must reflect that. Swallow sendMessage
      // errors (e.g. session already shut down) as non-fatal.
      try {
        deliverCompletion(bgTask, result, deps);
      } catch {
        /* delivery failed — non-fatal; status/history already recorded */
      }
      scheduleEviction(taskId);
    })
    .catch((err: unknown) => {
      // Reached when runOne itself rejects (delivery is isolated above; any
      // other side-effect throw in .then is also caught here defensively).
      bgTask.completedAt = Date.now();
      bgTask.status = "failed";
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        deps.threadStore.updateThread(thread.id, { status: "failed" });
      } catch {
        /* thread store unavailable — non-fatal */
      }
      recordHistory(bgTask, undefined, deps, errMsg);
      try {
        deliverError(bgTask, errMsg, deps);
      } catch {
        /* delivery failed — non-fatal */
      }
      scheduleEviction(taskId);
    });

  const receipt = [
    `Started background task ${taskId} (${agent}).`,
    `Use subagent operation:"status" taskId:"${taskId}" to inspect progress.`,
    "You will be notified automatically when it completes — DO NOT poll or sleep.",
  ].join("\n");

  return { taskId, receipt };
}

// ---------------------------------------------------------------------------
// Completion delivery (follow-up turn)
// ---------------------------------------------------------------------------

function deliverCompletion(task: BackgroundTask, result: SubAgentResult, deps: BackgroundDeps): void {
  const output = getFinalOutput(result.messages) || getResultOutput(result) || "(no output)";
  const failed = isFailedResult(result);
  const phase = task.status;
  const summary = output.split("\n").slice(0, 1)[0]!.slice(0, 200);
  const elapsedMs = (task.completedAt ?? Date.now()) - task.startedAt;

  deps.pi.sendMessage(
    {
      customType: "pi-subagent-complete",
      content: failed
        ? `Background task ${task.id} (${task.agent}) ${phase}.\n\n${getResultOutput(result)}`
        : `Background task ${task.id} (${task.agent}) completed.\n\n${output}`,
      display: true,
      details: {
        task_id: task.id,
        agent: task.agent,
        status: task.status,
        summary,
        full_output: output,
        elapsed_ms: elapsedMs,
        model: result.model,
        usage: result.usage,
        background: true,
      },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function deliverError(task: BackgroundTask, errMsg: string, deps: BackgroundDeps): void {
  deps.pi.sendMessage(
    {
      customType: "pi-subagent-complete",
      content: `Background task ${task.id} (${task.agent}) failed: ${errMsg}`,
      display: true,
      details: {
        task_id: task.id,
        agent: task.agent,
        status: "failed" as const,
        summary: errMsg,
        full_output: errMsg,
        background: true,
      },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

// ---------------------------------------------------------------------------
// History recording (durable metadata for /subagent history)
// ---------------------------------------------------------------------------

function recordHistory(
  task: BackgroundTask,
  result: SubAgentResult | undefined,
  deps: BackgroundDeps,
  errMsg?: string,
): void {
  try {
    const output = errMsg ?? (result ? getFinalOutput(result.messages) || getResultOutput(result) : "");
    const structured = parseStructuredResult(output);
    const piDir = join(deps.ctx.cwd, CONFIG_DIR_NAME);
    appendHistory(piDir, {
      id: task.id,
      agent: task.agent,
      task: task.task,
      status: task.status === "running" ? "interrupted" : (task.status as "completed" | "failed" | "aborted" | "timeout"),
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      summary: structured.summary,
      background: true,
      model: result?.model,
    });
  } catch {
    // History file not writable — non-fatal.
  }
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export type CancelOutcome = "cancelled" | "not_found" | "already_done";

export function cancelBackgroundTask(id: string): { outcome: CancelOutcome; task?: BackgroundTask } {
  const task = backgroundTasks.get(id);
  if (!task) return { outcome: "not_found" };
  if (task.status !== "running") return { outcome: "already_done", task };
  task.controller.abort();
  // Status will be finalized by the runOne promise resolving with aborted.
  return { outcome: "cancelled", task };
}

// ---------------------------------------------------------------------------
// Eviction — completed tasks are retained briefly for status queries, then
// dropped so the in-memory registry doesn't grow unbounded across a session.
// ---------------------------------------------------------------------------

const TASK_RETENTION_MS = 60_000;

function scheduleEviction(taskId: string): void {
  const timer = setTimeout(() => {
    backgroundTasks.delete(taskId);
  }, TASK_RETENTION_MS);
  timer.unref?.();
}
