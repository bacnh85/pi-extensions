/**
 * Tests for the live progress widget.
 * Covers renderTaskWidget (pure) and deriveRecentToolCalls (status derivation).
 */

import assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { Message } from "@earendil-works/pi-ai";
import {
  renderTaskWidget,
  renderLiveThreadLine,
  deriveRecentToolCalls,
  formatMs,
  type RecentToolCall,
} from "../widget.ts";
import type { SubagentThread } from "../threads.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeThread(overrides: Partial<SubagentThread> = {}): SubagentThread {
  const now = Date.now();
  return {
    id: "t1",
    agentName: "scout",
    task: "find auth code",
    mode: "single",
    status: "running",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function assistantMsg(toolCalls: Array<{ id: string; name: string; args?: Record<string, unknown> }>): Message {
  return {
    role: "assistant",
    content: toolCalls.map((tc) => ({
      type: "toolCall" as const,
      id: tc.id,
      name: tc.name,
      arguments: tc.args ?? {},
    })),
    api: "anthropic" as never,
    provider: "anthropic" as never,
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function toolResultMsg(toolCallId: string, isError = false): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: "ok" }],
    isError,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// formatMs
// ---------------------------------------------------------------------------

describe("widget formatMs", () => {
  it("formats sub-second as ms", () => {
    assert.equal(formatMs(500), "500ms");
  });
  it("formats seconds with one decimal", () => {
    assert.equal(formatMs(1500), "1.5s");
    assert.equal(formatMs(45_000), "45.0s");
  });
  it("formats minutes", () => {
    assert.equal(formatMs(125_000), "2m 5s");
  });
});

// ---------------------------------------------------------------------------
// deriveRecentToolCalls
// ---------------------------------------------------------------------------

describe("deriveRecentToolCalls", () => {
  it("returns empty for no messages", () => {
    assert.deepEqual(deriveRecentToolCalls([]), []);
  });

  it("marks a tool call in_progress when no matching result", () => {
    const msgs = [assistantMsg([{ id: "c1", name: "read", args: { path: "/a" } }])];
    const calls = deriveRecentToolCalls(msgs);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "read");
    assert.equal(calls[0]!.status, "in_progress");
  });

  it("marks done when a non-error result matches", () => {
    const msgs: Message[] = [
      assistantMsg([{ id: "c1", name: "grep", args: { pattern: "foo" } }]),
      toolResultMsg("c1", false),
    ];
    const calls = deriveRecentToolCalls(msgs);
    assert.equal(calls[0]!.status, "done");
  });

  it("marks error when an error result matches", () => {
    const msgs: Message[] = [
      assistantMsg([{ id: "c1", name: "bash", args: { command: "false" } }]),
      toolResultMsg("c1", true),
    ];
    const calls = deriveRecentToolCalls(msgs);
    assert.equal(calls[0]!.status, "error");
  });

  it("mixes in_progress, done, error across multiple calls", () => {
    const msgs: Message[] = [
      assistantMsg([{ id: "c1", name: "read" }, { id: "c2", name: "grep" }]),
      toolResultMsg("c1", false),
      toolResultMsg("c2", true),
      assistantMsg([{ id: "c3", name: "bash" }]), // no result yet
    ];
    const calls = deriveRecentToolCalls(msgs);
    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.status, "done");
    assert.equal(calls[1]!.status, "error");
    assert.equal(calls[2]!.status, "in_progress");
  });

  it("caps to the limit, keeping most recent", () => {
    const calls: Array<{ id: string; name: string }> = [];
    for (let i = 0; i < 10; i++) calls.push({ id: `c${i}`, name: "read" });
    const msgs = [assistantMsg(calls)];
    const result = deriveRecentToolCalls(msgs, 3);
    assert.equal(result.length, 3);
    assert.equal(result[2]!.name, "read");
  });
});

// ---------------------------------------------------------------------------
// renderLiveThreadLine
// ---------------------------------------------------------------------------

describe("renderLiveThreadLine", () => {
  it("returns a header with agent and elapsed for a running thread", () => {
    const thread = makeThread({ createdAt: Date.now() - 2000 });
    const line = renderLiveThreadLine(thread, null, Date.now(), "accent");
    assert.match(line, /Scout/);
    assert.match(line, /2\.0s|2s/);
  });

  it("includes the latest tool call with a status mark", () => {
    const thread = makeThread({
      result: {
        agent: "scout",
        task: "find",
        exitCode: -1,
        messages: [
          assistantMsg([{ id: "c1", name: "grep", args: { pattern: "x" } }]),
          toolResultMsg("c1", false),
        ],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      },
    });
    const line = renderLiveThreadLine(thread, null, Date.now(), "accent");
    assert.match(line, /grep/);
    assert.match(line, /✓/);
  });

  it("shows tool count for completed calls", () => {
    const thread = makeThread({
      result: {
        agent: "scout",
        task: "find",
        exitCode: -1,
        messages: [
          assistantMsg([{ id: "c1", name: "read" }]),
          toolResultMsg("c1", false),
        ],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      },
    });
    const line = renderLiveThreadLine(thread, null, Date.now(), "accent");
    assert.match(line, /1 tool/);
  });

  it("shows up to 5 recent tool calls as a list", () => {
    const thread = makeThread({
      result: {
        agent: "scout", task: "find", exitCode: -1,
        messages: [
          assistantMsg([{ id: "c1", name: "read" }]), toolResultMsg("c1", false),
          assistantMsg([{ id: "c2", name: "grep" }]), toolResultMsg("c2", false),
          assistantMsg([{ id: "c3", name: "find" }]), toolResultMsg("c3", false),
        ],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      },
    });
    const line = renderLiveThreadLine(thread, null, Date.now(), "accent", 5);
    assert.match(line, /read/);
    assert.match(line, /grep/);
    assert.match(line, /find/);
  });
});

// ---------------------------------------------------------------------------
// renderTaskWidget
// ---------------------------------------------------------------------------

describe("renderTaskWidget", () => {
  it("returns [] when no threads are running", () => {
    assert.deepEqual(
      renderTaskWidget({ threads: [makeThread({ status: "completed" })], width: 80 }),
      [],
    );
  });

  it("returns [] for empty thread list", () => {
    assert.deepEqual(renderTaskWidget({ threads: [], width: 80 }), []);
  });

  it("renders a header + trailing blank for one running thread", () => {
    const thread = makeThread({ createdAt: Date.now() - 2000 });
    const lines = renderTaskWidget({ threads: [thread], width: 100, now: Date.now() });
    assert.ok(lines.length >= 1, "expected at least a header line");
    // The last line is a blank separator.
    assert.equal(lines[lines.length - 1], "");
  });

  it("renders latest tool-call line when messages exist", () => {
    const thread = makeThread({
      result: {
        agent: "scout",
        task: "find",
        exitCode: -1,
        messages: [assistantMsg([{ id: "c1", name: "grep", args: { pattern: "x" } }])],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      },
    });
    const lines = renderTaskWidget({ threads: [thread], width: 100, now: Date.now() });
    // Header + tool line + blank.
    assert.ok(lines.length >= 2);
    assert.equal(lines[lines.length - 1], "");
  });

  it("renders 4 blocks for 4 parallel running threads", () => {
    const threads: SubagentThread[] = [];
    for (let i = 0; i < 4; i++) {
      threads.push(makeThread({ id: `t${i}`, task: `task ${i}` }));
    }
    const lines = renderTaskWidget({ threads, width: 100, now: Date.now() });
    // Each thread produces >=1 line + 1 blank separator. At least 4 content lines.
    const nonBlank = lines.filter((l) => l.length > 0);
    assert.ok(nonBlank.length >= 4, `expected >=4 content lines, got ${nonBlank.length}`);
  });

  it("caps at 8 running threads and shows +N more", () => {
    const threads: SubagentThread[] = [];
    for (let i = 0; i < 11; i++) {
      threads.push(makeThread({ id: `t${i}`, task: `task ${i}` }));
    }
    const lines = renderTaskWidget({ threads, width: 100, now: Date.now() });
    assert.ok(lines.some((l) => l.includes("3 more running")), "expected +3 more running line");
  });

  it("ignores completed/failed threads (only running shown)", () => {
    const threads = [
      makeThread({ id: "t1", status: "completed" }),
      makeThread({ id: "t2", status: "failed" }),
      makeThread({ id: "t3", status: "running" }),
    ];
    const lines = renderTaskWidget({ threads, width: 100, now: Date.now() });
    // Only t3 appears.
    assert.ok(lines.length >= 1);
    assert.ok(!lines.some((l) => l.includes("t1")), "completed thread should not appear");
  });
});
