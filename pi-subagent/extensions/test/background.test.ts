/**
 * Tests for background task execution and task control (status/cancel).
 *
 * Uses a fake runOne that resolves after a tick, and a fake pi/ctx capturing
 * sendMessage calls so we can assert the follow-up turn fires.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "mocha";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubAgentResult, SubAgentProgress } from "../runner.ts";
import { ThreadStore, type SubagentThread } from "../threads.ts";
import {
  startBackgroundTask,
  cancelBackgroundTask,
  getBackgroundTask,
  snapshotTask,
  clearBackgroundTasks,
  type BackgroundDeps,
} from "../background.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeRunOne(opts: { delayMs?: number; result?: Partial<SubAgentResult> } = {}): {
  runOne: BackgroundDeps["runOne"];
  calls: { agent: string; task: string; aborted: boolean }[];
} {
  const calls: { agent: string; task: string; aborted: boolean }[] = [];
  const runOne: BackgroundDeps["runOne"] = async (agent, task, _cwd, signal, _timeout, onProgress) => {
    calls.push({ agent, task, aborted: false });
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 10));
    // Re-check abort status after the delay (cancel may have fired meanwhile).
    calls[calls.length - 1]!.aborted = signal.aborted;
    if (signal.aborted) {
      return {
        agent, task, exitCode: 1, status: "aborted", stopReason: "aborted",
        messages: [], stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        errorMessage: "aborted",
        ...opts.result,
      };
    }
    // Emit one progress tick.
    onProgress({
      agent, task, exitCode: 0, status: undefined, messages: [], stderr: "",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 },
      ...opts.result,
    } as SubAgentResult);
    return {
      agent, task, exitCode: 0, status: "success", stopReason: "stop",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], api: "anthropic" as never, provider: "anthropic" as never, model: "test", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } }, stopReason: "stop", timestamp: Date.now() }],
      stderr: "",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 3, turns: 1 },
      ...opts.result,
    };
  };
  return { runOne, calls };
}

function makeFakeDeps(runOne: BackgroundDeps["runOne"]): {
  deps: BackgroundDeps;
  sentMessages: { content: unknown; options: unknown }[];
} {
  const sentMessages: { content: unknown; options: unknown }[] = [];
  const store = new ThreadStore();
  const pi = {
    sendMessage: (msg: { content: unknown }, options?: unknown) => {
      sentMessages.push({ content: msg.content, options });
    },
  } as unknown as ExtensionAPI;
  const ctx = { mode: "non-tui" } as unknown as ExtensionContext;
  return {
    deps: { pi, ctx, runOne, threadStore: store as unknown as typeof import("../threads.ts").threadStore },
    sentMessages,
  };
}

/** Fake deps whose sendMessage throws — simulates a session that shut down mid-delivery. */
function makeThrowingDeps(runOne: BackgroundDeps["runOne"]): {
  deps: BackgroundDeps;
} {
  const store = new ThreadStore();
  const pi = {
    sendMessage: () => {
      throw new Error("session closed");
    },
  } as unknown as ExtensionAPI;
  const ctx = { mode: "non-tui" } as unknown as ExtensionContext;
  return {
    deps: { pi, ctx, runOne, threadStore: store as unknown as typeof import("../threads.ts").threadStore },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("background task", () => {
  beforeEach(() => clearBackgroundTasks());

  it("returns immediately with a receipt containing the task id", async () => {
    const { runOne } = makeFakeRunOne();
    const { deps } = makeFakeDeps(runOne);
    const result = startBackgroundTask({ agent: "scout", task: "find auth", deps });
    assert.match(result.taskId, /^bg-/);
    assert.match(result.receipt, /Started background task/);
    assert.match(result.receipt, /DO NOT poll/);
    clearBackgroundTasks();
  });

  it("delivers a follow-up turn on completion with triggerTurn + deliverAs followUp", async () => {
    const { runOne } = makeFakeRunOne();
    const { deps, sentMessages } = makeFakeDeps(runOne);
    startBackgroundTask({ agent: "scout", task: "find auth", deps });
    // Wait for the detached promise to settle.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sentMessages.length, 1, "expected one completion message");
    assert.deepEqual(sentMessages[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
    clearBackgroundTasks();
  });

  it("registers the task so status can find it while running", async () => {
    const { runOne } = makeFakeRunOne({ delayMs: 100 });
    const { deps } = makeFakeDeps(runOne);
    const { taskId } = startBackgroundTask({ agent: "planner", task: "plan X", deps });
    const task = getBackgroundTask(taskId);
    assert.ok(task, "task should be findable while running");
    assert.equal(task!.status, "running");
    const snap = snapshotTask(task!);
    assert.equal(snap.agent, "planner");
    assert.equal(snap.status, "running");
    clearBackgroundTasks();
  });

  it("cancels a running task", async () => {
    const { runOne, calls } = makeFakeRunOne({ delayMs: 200 });
    const { deps } = makeFakeDeps(runOne);
    const { taskId } = startBackgroundTask({ agent: "worker", task: "build", deps });
    const result = cancelBackgroundTask(taskId);
    assert.equal(result.outcome, "cancelled");
    // The signal is now aborted; runOne sees it.
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(calls[0]!.aborted, "runOne should have seen an aborted signal");
    clearBackgroundTasks();
  });
});

describe("task control", () => {
  beforeEach(() => clearBackgroundTasks());

  it("cancel returns not_found for unknown id", () => {
    const result = cancelBackgroundTask("bg-nonexistent");
    assert.equal(result.outcome, "not_found");
  });

  it("cancel returns already_done for a completed task", async () => {
    const { runOne } = makeFakeRunOne({ delayMs: 10 });
    const { deps } = makeFakeDeps(runOne);
    const { taskId } = startBackgroundTask({ agent: "scout", task: "x", deps });
    await new Promise((r) => setTimeout(r, 50));
    const result = cancelBackgroundTask(taskId);
    assert.equal(result.outcome, "already_done");
    clearBackgroundTasks();
  });

  it("snapshot includes output after completion", async () => {
    const { runOne } = makeFakeRunOne({ delayMs: 10 });
    const { deps } = makeFakeDeps(runOne);
    const { taskId } = startBackgroundTask({ agent: "scout", task: "x", deps });
    await new Promise((r) => setTimeout(r, 50));
    const task = getBackgroundTask(taskId);
    assert.ok(task);
    const snap = snapshotTask(task!);
    assert.equal(snap.status, "completed");
    assert.ok(snap.result, "snapshot should include result after completion");
    clearBackgroundTasks();
  });

  it("keeps task status completed when sendMessage throws (no .then->.catch cascade)", async () => {
    // Regression for the HIGH finding: if deliverCompletion throws, the old
    // .catch would overwrite a completed task to "failed". Delivery must be
    // isolated so the task's real status and history survive.
    const { runOne } = makeFakeRunOne({ delayMs: 10 });
    const { deps } = makeThrowingDeps(runOne);
    const { taskId } = startBackgroundTask({ agent: "scout", task: "x", deps });
    await new Promise((r) => setTimeout(r, 50));
    const task = getBackgroundTask(taskId);
    assert.ok(task, "task should still exist");
    assert.equal(task!.status, "completed", "delivery failure must not flip status to failed");
    clearBackgroundTasks();
  });
});
