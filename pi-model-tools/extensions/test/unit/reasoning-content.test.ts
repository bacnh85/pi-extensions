import assert from "node:assert";
import { describe, it } from "node:test";
import { stripReasoningContent, cleanLeakedContent, cleanLeakedContentFromMessages, appendGuidanceToLastUserMessage } from "../../lib/reasoning-content.ts";

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
  it("strips reasoning from ALL assistant messages uniformly (cache-stable)", () => {
    const payload = { messages: [
      { role: "assistant", content: "old", reasoning_content: "old reasoning" },
      { role: "user", content: "q" },
      { role: "assistant", content: "new", reasoning_content: "current" },
    ]};
    const result = stripReasoningContent(payload) as any;
    assert.strictEqual(result.messages[0].reasoning_content, undefined);
    assert.strictEqual(result.messages[2].reasoning_content, undefined);
  });
  it("a given message's reasoning is stripped identically as the array grows (byte-stable across turns)", () => {
    // Turn N: A1 is the last assistant → stripped.
    const turnN = stripReasoningContent({ messages: [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1", reasoning_content: "think1" },
    ]}) as any;
    // Turn N+1: A1 is now a PRIOR assistant → must produce the same bytes.
    const turnN1 = stripReasoningContent({ messages: [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1", reasoning_content: "think1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2", reasoning_content: "think2" },
    ]}) as any;
    assert.strictEqual(turnN.messages[1].reasoning_content, undefined);
    assert.strictEqual(turnN1.messages[1].reasoning_content, undefined);
    // Byte-identical serialization of message A1 in both calls.
    assert.strictEqual(JSON.stringify(turnN.messages[1]), JSON.stringify(turnN1.messages[1]));
  });
  it("returns original when no assistant messages", () => {
    const payload = { messages: [{ role: "user", content: "hi" }] };
    assert.strictEqual(stripReasoningContent(payload), payload);
  });
  it("truncates long reasoning to N CHARS (not tokens) when PI_MODEL_TOOLS_REASONING_MAX_CHARS is set", () => {
    const prev = process.env.PI_MODEL_TOOLS_REASONING_MAX_CHARS;
    process.env.PI_MODEL_TOOLS_REASONING_MAX_CHARS = "50";
    try {
      const long = "x".repeat(100);
      const result = stripReasoningContent({ messages: [
        { role: "assistant", content: "a", reasoning_content: long },
      ] }) as any;
      assert.ok(result.messages[0].reasoning_content.length < 100, "should be truncated");
      assert.match(result.messages[0].reasoning_content, /\[reasoning truncated\]$/);
      assert.strictEqual(result.messages[0].reasoning_content.length, 50 + "\n\n[reasoning truncated]".length);
    } finally {
      if (prev === undefined) delete process.env.PI_MODEL_TOOLS_REASONING_MAX_CHARS;
      else process.env.PI_MODEL_TOOLS_REASONING_MAX_CHARS = prev;
    }
  });
});

describe("appendGuidanceToLastUserMessage", () => {
  it("appends guidance to the last user message (string content)", () => {
    const payload = { messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "current prompt" },
    ]};
    const result = appendGuidanceToLastUserMessage(payload, "GUIDE TEXT") as any;
    assert.match(result.messages[2].content, /^current prompt\n\nGUIDE TEXT$/);
    assert.strictEqual(result.messages[0].content, "first"); // untouched
  });

  it("appends to the last text part when content is an array", () => {
    const payload = { messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]};
    const result = appendGuidanceToLastUserMessage(payload, "GUIDE") as any;
    assert.strictEqual(result.messages[0].content[0].text, "hello\n\nGUIDE");
  });

  it("adds a text part when the array has no text part", () => {
    const payload = { messages: [
      { role: "user", content: [{ type: "image", image: "x" }] },
    ]};
    const result = appendGuidanceToLastUserMessage(payload, "GUIDE") as any;
    assert.strictEqual(result.messages[0].content[1].text, "GUIDE");
  });

  it("returns the original payload when no user message exists", () => {
    const payload = { messages: [{ role: "assistant", content: "hi" }] };
    assert.strictEqual(appendGuidanceToLastUserMessage(payload, "GUIDE"), payload);
  });

  it("returns the original payload when there is no messages array", () => {
    const payload = { system: "only" };
    assert.strictEqual(appendGuidanceToLastUserMessage(payload, "GUIDE"), payload);
  });
});
