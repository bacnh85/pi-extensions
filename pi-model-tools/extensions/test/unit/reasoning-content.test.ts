import assert from "node:assert";
import { describe, it } from "node:test";
import { stripReasoningContent, cleanLeakedContent, cleanLeakedContentFromMessages } from "../../lib/reasoning-content.ts";

describe("cleanLeakedContent", () => {
  it("strips Reasoning: header", () => {
    assert.strictEqual(cleanLeakedContent("Reasoning: thinking...\nAnswer", new Set(["read"])), "Answer");
  });
  it("strips backtick tool calls matching active tools", () => {
    assert.strictEqual(cleanLeakedContent("Use `grep(\"x\")` now", new Set(["grep"])), "Use now");
  });
  it("does NOT strip non-matching calls", () => {
    const c = "Using `random()` here";
    assert.strictEqual(cleanLeakedContent(c, new Set(["grep"])), c);
  });
});

describe("cleanLeakedContentFromMessages", () => {
  it("cleans leaked content from assistant messages", () => {
    const payload = { messages: [
      { role: "user", content: "find it" },
      { role: "assistant", content: "Reasoning: ...\nI'll `grep(\"x\")` now" },
    ]};
    const result = cleanLeakedContentFromMessages(payload, ["grep"]) as any;
    assert.ok(!result.messages[1].content.includes("Reasoning"));
    assert.ok(!result.messages[1].content.includes("`grep"));
  });
  it("returns original when no changes needed", () => {
    const payload = { messages: [{ role: "user", content: "hello" }] };
    assert.strictEqual(cleanLeakedContentFromMessages(payload, []), payload);
  });
});

describe("stripReasoningContent", () => {
  it("strips reasoning from prior assistant messages, keeps latest", () => {
    const payload = { messages: [
      { role: "assistant", content: "old", reasoning_content: "old reasoning" },
      { role: "user", content: "q" },
      { role: "assistant", content: "new", reasoning_content: "current" },
    ]};
    const result = stripReasoningContent(payload) as any;
    assert.strictEqual(result.messages[0].reasoning_content, undefined);
    assert.strictEqual(result.messages[2].reasoning_content, "current");
  });
  it("returns original when no assistant messages", () => {
    const payload = { messages: [{ role: "user", content: "hi" }] };
    assert.strictEqual(stripReasoningContent(payload), payload);
  });
});
