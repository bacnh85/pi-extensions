import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { stripReasoningContent, clonePayload } from "../../lib/reasoning-content";

describe("stripReasoningContent", () => {
	it("leaves payloads without messages unchanged", () => {
		const payload = { model: "deepseek-v4-flash", max_tokens: 1024 };
		assert.equal(stripReasoningContent(payload), payload);
	});

	it("leaves payloads without reasoning_content unchanged", () => {
		const payload = {
			model: "deepseek-v4-flash",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
		};
		assert.equal(stripReasoningContent(payload), payload);
	});

	it("strips reasoning_content from all but the last assistant message", () => {
		const payload = {
			model: "deepseek-v4-flash",
			messages: [
				{ role: "user", content: "list files" },
				{ role: "assistant", content: "sure", reasoning_content: "thinking about ls" },
				{ role: "user", content: "now edit" },
				{ role: "assistant", content: "ok editing", reasoning_content: "planning edit" },
			],
		};
		const result = stripReasoningContent(payload) as typeof payload;
		// First assistant message: stripped
		assert.equal((result.messages[1] as any).reasoning_content, undefined);
		// Last assistant message: preserved (current turn)
		assert.equal((result.messages[3] as any).reasoning_content, "planning edit");
	});

	it("strips reasoning_content when there is only one assistant message (current turn)", () => {
		const payload = {
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello", reasoning_content: "thinking" },
			],
		};
		const result = stripReasoningContent(payload) as typeof payload;
		// Single assistant message is the current turn — preserved
		assert.equal((result.messages[1] as any).reasoning_content, "thinking");
	});

	it("strips reasoning from all prior assistant messages (variation field)", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: "first", reasoning: "deep thought" },
				{ role: "user", content: "continue" },
				{ role: "assistant", content: "second", reasoning: "more thought" },
			],
		};
		const result = stripReasoningContent(payload) as typeof payload;
		// Prior assistant: reasoning stripped
		assert.equal((result.messages[0] as any).reasoning, undefined);
		// Current assistant: reasoning preserved
		assert.equal((result.messages[2] as any).reasoning, "more thought");
	});

	it("handles empty messages array", () => {
		const payload = { messages: [] };
		assert.equal(stripReasoningContent(payload), payload);
	});

	it("handles non-object payload gracefully", () => {
		assert.equal(stripReasoningContent(null), null);
		assert.equal(stripReasoningContent("string"), "string");
		assert.equal(stripReasoningContent(42), 42);
	});

	it("handles nested body.messages structure", () => {
		const payload = {
			body: {
				messages: [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: "hello", reasoning_content: "thinking" },
				],
			},
		};
		const result = stripReasoningContent(payload) as typeof payload;
		// Single assistant message is the current turn — preserved
		assert.equal((result.body.messages[1] as any).reasoning_content, "thinking");
	});

	it("handles nested body.messages with current turn preserved", () => {
		const payload = {
			body: {
				messages: [
					{ role: "assistant", content: "prev", reasoning_content: "old think" },
					{ role: "user", content: "next" },
					{ role: "assistant", content: "curr", reasoning_content: "fresh think" },
				],
			},
		};
		const result = stripReasoningContent(payload) as typeof payload;
		// Prior assistant: stripped
		assert.equal((result.body.messages[0] as any).reasoning_content, undefined);
		// Current assistant: preserved
		assert.equal((result.body.messages[2] as any).reasoning_content, "fresh think");
	});

	it("strips prior reasoning_content in nested body.messages", () => {
		const payload = {
			body: {
				messages: [
					{ role: "assistant", content: "old", reasoning_content: "ancient" },
					{ role: "assistant", content: "mid", reasoning_content: "mid" },
					{ role: "user", content: "continue" },
					{ role: "assistant", content: "fresh", reasoning_content: "new" },
				],
			},
		};
		const result = stripReasoningContent(payload) as typeof payload;
		assert.equal((result.body.messages[0] as any).reasoning_content, undefined, "prior msg 0 stripped");
		assert.equal((result.body.messages[1] as any).reasoning_content, undefined, "prior msg 1 stripped");
		assert.equal((result.body.messages[3] as any).reasoning_content, "new", "current turn preserved");
	});

	it("handles only user messages (no assistant)", () => {
		const payload = {
			messages: [
				{ role: "user", content: "a" },
				{ role: "user", content: "b" },
			],
		};
		assert.equal(stripReasoningContent(payload), payload);
	});
});

describe("clonePayload", () => {
	it("deep-clones a plain object", () => {
		const original = { a: 1, b: { c: [2, 3] } };
		const cloned = clonePayload(original);
		assert.deepEqual(cloned, original);
		assert.notEqual(cloned, original);
		assert.notEqual(cloned.b, original.b);
	});

	it("returns primitives unchanged", () => {
		assert.equal(clonePayload(null), null);
		assert.equal(clonePayload(42), 42);
		assert.equal(clonePayload("str"), "str");
	});

	it("deep-clones arrays", () => {
		const original = [{ a: 1 }, { b: 2 }];
		const cloned = clonePayload(original);
		assert.deepEqual(cloned, original);
		assert.notEqual(cloned, original);
		assert.notEqual(cloned[0], original[0]);
	});
});
