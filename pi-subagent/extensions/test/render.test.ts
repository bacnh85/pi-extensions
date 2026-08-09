/**
 * Tests for render.ts — compact collapsed result display.
 * Collapsed single-agent results show the answer preview, NOT the tool-call trace.
 */

import assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { Message } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { renderSingleResult } from "../render.ts";
import type { SubAgentResult } from "../runner.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    agent: "scout",
    task: "find auth",
    exitCode: 0,
    status: "success",
    stopReason: "stop",
    messages: [],
    stderr: "",
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 30, turns: 2 },
    model: "test/model",
    ...overrides,
  };
}

/** Minimal theme shim — returns text uncolored (so assertions see plain text). */
const plainTheme = {
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
} as const;

function renderLines(component: Text | import("@earendil-works/pi-tui").Container, width = 100): string[] {
  if (component instanceof Text) return component.render(width);
  return component.render(width);
}

// ---------------------------------------------------------------------------
// Collapsed result
// ---------------------------------------------------------------------------

describe("renderSingleResult collapsed", () => {
  it("shows toolcount and duration in the usage line", () => {
    const result = makeResult({
      durationMs: 12_300,
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Found it." }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      ] as Message[],
    });
    const component = renderSingleResult(result, false, plainTheme as never);
    const all = renderLines(component as Text).join("\n");
    assert.match(all, /1 toolcall/);
    assert.match(all, /12\.3s/);
  });

  it("shows the answer preview with ⎿ prefix", () => {
    const result = makeResult({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "/a.ts" } },
          ],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "The auth flow uses JWT tokens." }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      ] as Message[],
    });
    const component = renderSingleResult(result, false, plainTheme as never);
    const lines = renderLines(component as Text);
    const all = lines.join("\n");
    assert.match(all, /⎿ The auth flow uses JWT tokens\./, "collapsed should show the answer preview");
    assert.ok(!all.includes("→ read"), "collapsed should NOT show the tool-call trace");
  });

  it("does not list tool calls even when many exist", () => {
    const calls: Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }> = [];
    for (let i = 0; i < 10; i++) {
      calls.push({ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `/f${i}.ts` } });
    }
    const result = makeResult({
      messages: [
        {
          role: "assistant",
          content: calls,
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      ] as Message[],
    });
    const component = renderSingleResult(result, false, plainTheme as never);
    const lines = renderLines(component as Text);
    const all = lines.join("\n");
    assert.match(all, /⎿ Done\./);
    assert.ok(!all.includes("→ read"), "10 tool calls must NOT appear in collapsed view");
    assert.ok(!all.includes("10 earlier"), "no tool-call count hint");
  });

  it("shows the expand hint when there is output", () => {
    const result = makeResult({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Answer here." }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      ] as Message[],
    });
    const component = renderSingleResult(result, false, plainTheme as never);
    const lines = renderLines(component as Text);
    const all = lines.join("\n");
    assert.match(all, /Ctrl\+O to expand/);
    assert.match(all, /\/agent for full thread/);
  });

  it("shows (no output) when nothing was produced", () => {
    const result = makeResult({ messages: [], status: "success" });
    const component = renderSingleResult(result, false, plainTheme as never);
    const lines = renderLines(component as Text);
    const all = lines.join("\n");
    assert.match(all, /\(no output\)/);
  });

  it("shows error message exactly once (not echoed under ⎿)", () => {
    const result = makeResult({
      status: "error",
      exitCode: 1,
      stopReason: "error",
      errorMessage: "provider boom",
      messages: [],
    });
    const component = renderSingleResult(result, false, plainTheme as never);
    const lines = renderLines(component as Text);
    const all = lines.join("\n");
    assert.match(all, /✗/);
    // Error message must appear exactly once (Error: line) and never under ⎿.
    assert.equal((all.match(/provider boom/g) || []).length, 1);
    assert.ok(!/⎿ provider boom/.test(all), "error must not be echoed as ⎿ preview");
    // An error WITH a message must NOT also show a contradictory (no output).
    assert.ok(!/\(no output\)/.test(all), "error with errorMessage must not also show (no output)");
  });

  it("timeout-style error shows the message without (no output)", () => {
    const result = makeResult({
      status: "timeout",
      exitCode: 1,
      stopReason: "timeout",
      errorMessage: "Idle timeout after 180000ms",
      messages: [],
    });
    const component = renderSingleResult(result, false, plainTheme as never);
    const lines = renderLines(component as Text);
    const all = lines.join("\n");
    assert.match(all, /\[timeout\]/);
    assert.match(all, /Error: Idle timeout after 180000ms/);
    assert.ok(!/\(no output\)/.test(all), "timeout error must not also show (no output)");
  });

  it("skips entire fenced code blocks when previewing the answer", () => {
    const result = makeResult({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "```ts\nconst x = 1;\n```\nThat's the code." }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      ] as Message[],
    });
    const component = renderSingleResult(result, false, plainTheme as never);
    const lines = renderLines(component as Text);
    const all = lines.join("\n");
    assert.ok(!/⎿ ```/.test(all), "preview should not start with a code fence");
    assert.ok(!/⎿ const x = 1;/.test(all), "preview should skip fence interior code");
    assert.match(all, /⎿ That's the code\./);
  });

  it("shows neutral (no output) without ⎿ prefix for empty results", () => {
    const result = makeResult({ messages: [], status: "success" });
    const component = renderSingleResult(result, false, plainTheme as never);
    const lines = renderLines(component as Text);
    const all = lines.join("\n");
    assert.match(all, /\(no output\)/);
    assert.ok(!/⎿ \(no output\)/.test(all), "empty result must not show ⎿ (no output)");
  });

  it("shows (no output) for error without errorMessage", () => {
    const result = makeResult({
      status: "error",
      exitCode: 1,
      stopReason: "tool_error",
      messages: [],
      // errorMessage intentionally undefined — the reachable dead-branch case.
    });
    const component = renderSingleResult(result, false, plainTheme as never);
    const lines = renderLines(component as Text);
    const all = lines.join("\n");
    assert.match(all, /\(no output\)/);
  });

  it("shows a fallback for all-structural markdown output", () => {
    const result = makeResult({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "# Summary\n- Point A\n- Point B" }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      ] as Message[],
    });
    const component = renderSingleResult(result, false, plainTheme as never);
    const lines = renderLines(component as Text);
    const all = lines.join("\n");
    assert.match(all, /markdown answer/);
  });
});
