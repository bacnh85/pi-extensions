import { assert } from "chai";

import {
  activityLine,
  activityStatusLine,
  activityToText,
  classifyLine,
  preview,
  type InboundActivity,
} from "../lib/activity";

describe("activity", () => {
  describe("preview", () => {
    it("collapses whitespace and trims", () => {
      assert.equal(preview("  hello\n  world  "), "hello world");
    });
    it("truncates long text with an ellipsis", () => {
      const long = "x".repeat(200);
      assert.equal(preview(long, 120).length, 120);
      assert.match(preview(long, 120), /…$/);
    });
    it("keeps short text unchanged", () => {
      assert.equal(preview("hi", 120), "hi");
    });
  });

  describe("activityLine", () => {
    it("maps tool_execution_start with a command arg", () => {
      const line = activityLine({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
      assert.equal(line, "⚙ bash npm test");
    });
    it("maps tool_execution_start without args", () => {
      const line = activityLine({ type: "tool_execution_start", toolName: "read", args: {} });
      assert.equal(line, "⚙ read");
    });
    it("maps tool_execution_end", () => {
      assert.equal(activityLine({ type: "tool_execution_end", toolName: "bash" }), "✓ bash");
    });
    it("maps assistant message_end to text delta", () => {
      const line = activityLine({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Checking files…" }] },
      });
      assert.equal(line, "✎ Checking files…");
    });
    it("ignores user message_end", () => {
      assert.equal(
        activityLine({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
        null,
      );
    });
    it("ignores agent_end with willRetry", () => {
      assert.equal(activityLine({ type: "agent_end", willRetry: true }), null);
    });
    it("maps agent_end to finished", () => {
      assert.equal(activityLine({ type: "agent_end", willRetry: false }), "✓ agent finished");
    });
    it("returns null for unknown events", () => {
      assert.equal(activityLine({ type: "something_else" }), null);
    });
  });

  describe("activityToText", () => {
    it("formats arrived", () => {
      const a: InboundActivity = { type: "arrived", taskId: "t1", identity: "hermes", text: "find TODOs", contextId: "c1" };
      assert.equal(activityToText(a), "[A2A inbound] task from hermes:\nfind TODOs");
    });
    it("formats completed with elapsed", () => {
      const a: InboundActivity = { type: "completed", taskId: "t1", state: "completed", replyPreview: "done", elapsedMs: 2500 };
      assert.match(activityToText(a), /completed \(2\.5s\) — done/);
    });
    it("formats failed", () => {
      const a: InboundActivity = { type: "failed", taskId: "t1", error: "boom", elapsedMs: 1000 };
      assert.match(activityToText(a), /failed \(1\.0s\): boom/);
    });
  });

  describe("activityStatusLine", () => {
    it("returns undefined when no active tasks", () => {
      assert.equal(activityStatusLine([]), undefined);
    });
    it("summarizes active tasks with identities", () => {
      const line = activityStatusLine([
        { taskId: "t1", identity: "hermes" },
        { taskId: "t2", identity: "session-b" },
      ]);
      assert.equal(line, "A2A: 2 inbound tasks (hermes, session-b)");
    });
  });

  describe("classifyLine (0.6.2 UX colors)", () => {
    it("classifies received / executing / replying / completed / failed", () => {
      assert.equal(classifyLine("[A2A inbound] task from hermes:\nfind TODOs"), "received");
      assert.equal(classifyLine("[A2A inbound] ⚙ bash grep TODO"), "executing");
      assert.equal(classifyLine("[A2A inbound] ✓ agent finished"), "executing");
      assert.equal(classifyLine("[A2A inbound] ✎ here is the list"), "replying");
      assert.equal(classifyLine("[A2A inbound] task t1 comp completed (2.5s) — done"), "completed");
      assert.equal(classifyLine("[A2A inbound] task t1 comp failed (1.0s): boom"), "failed");
    });
    it("multi-line prefixes classify by prefix, not by newline", () => {
      // Real replies and error stacks are multi-line — the prefix wins.
      assert.equal(classifyLine("[A2A inbound] ✎ line1\nline2\nline3"), "replying");
      assert.equal(classifyLine("[A2A inbound] task t1 comp failed (1.0s): boom\nstack"), "failed");
      assert.equal(classifyLine("[A2A inbound] task t1 comp completed (1.0s) — a\nb"), "completed");
    });
    it("multi-line with no recognized prefix is always received", () => {
      assert.equal(classifyLine("[A2A inbound] ⚙ bash\nsecond line"), "received");
    });
  });
});
