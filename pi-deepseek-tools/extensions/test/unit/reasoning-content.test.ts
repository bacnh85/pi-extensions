import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripReasoningContent, cleanLeakedContent, cleanLeakedContentFromMessages } from "../../lib/reasoning-content";

const activeTools = ["read", "find", "grep"];
const clean = (content: unknown) => cleanLeakedContent(content, new Set(activeTools));
const cleanMessages = (payload: unknown) => cleanLeakedContentFromMessages(payload, activeTools);

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

	it("strips thinking_content field (wider field coverage)", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: "old", thinking_content: "prior thought" },
				{ role: "user", content: "go on" },
				{ role: "assistant", content: "new", thinking_content: "fresh thought" },
			],
		};
		const result = stripReasoningContent(payload) as typeof payload;
		assert.equal((result.messages[0] as any).thinking_content, undefined, "prior thinking_content stripped");
		assert.equal((result.messages[2] as any).thinking_content, "fresh thought", "current thinking_content preserved");
	});

	it("strips chain_of_thought field (wider field coverage)", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: "old", chain_of_thought: "prior cot" },
				{ role: "user", content: "continue" },
				{ role: "assistant", content: "new", chain_of_thought: "fresh cot" },
			],
		};
		const result = stripReasoningContent(payload) as typeof payload;
		assert.equal((result.messages[0] as any).chain_of_thought, undefined, "prior chain_of_thought stripped");
		assert.equal((result.messages[2] as any).chain_of_thought, "fresh cot", "current chain_of_thought preserved");
	});

	it("strips cot field (wider field coverage)", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: "old", cot: "prior" },
				{ role: "user", content: "more" },
				{ role: "assistant", content: "new", cot: "fresh" },
			],
		};
		const result = stripReasoningContent(payload) as typeof payload;
		assert.equal((result.messages[0] as any).cot, undefined, "prior cot stripped");
		assert.equal((result.messages[2] as any).cot, "fresh", "current cot preserved");
	});

	it("truncates long prior reasoning when PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS is set", () => {
		const previous = process.env.PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS;
		process.env.PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS = "20";
		try {
			const longReasoning = "A".repeat(100);
			const payload = {
				messages: [
					{ role: "assistant", content: "old", reasoning_content: longReasoning },
					{ role: "user", content: "continue" },
					{ role: "assistant", content: "new", reasoning_content: "short" },
				],
			};
			const result = stripReasoningContent(payload) as typeof payload;
			// Prior reasoning truncated, not deleted
			assert.ok((result.messages[0] as any).reasoning_content.startsWith("A".repeat(20)), "truncated to 20 chars");
			assert.ok((result.messages[0] as any).reasoning_content.includes("[reasoning truncated]"), "truncation marker present");
			// Current reasoning preserved
			assert.equal((result.messages[2] as any).reasoning_content, "short");
		} finally {
			if (previous === undefined) delete process.env.PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS;
			else process.env.PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS = previous;
		}
	});

	it("returns original payload when no prior reasoning exists (lazy fast path)", () => {
		const payload = {
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
		};
		// No prior reasoning — should return the exact same reference
		assert.equal(stripReasoningContent(payload), payload);
	});

	it("returns original payload when only current turn has reasoning (lazy fast path)", () => {
		const payload = {
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello", reasoning_content: "current thinking" },
			],
		};
		// Only current turn has reasoning — nothing to strip on prior messages
		assert.equal(stripReasoningContent(payload), payload);
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

describe("cleanLeakedContent", () => {
	it("leaves normal content unchanged", () => {
		assert.equal(clean("Hello world"), "Hello world");
		assert.equal(clean("Use the read tool"), "Use the read tool");
	});

	it("strips leading Reasoning: header and its entire line", () => {
		assert.equal(clean("Reasoning: I need to find the file first.\nLet me search."), "Let me search.");
	});

	it("strips leading Thinking: header and its entire line", () => {
		assert.equal(clean("Thinking: plan the edit.\nNow applying changes."), "Now applying changes.");
	});

	it("strips leading Chain of Thought: header and its entire line", () => {
		assert.equal(clean("Chain of Thought: step 1.\nstep 2."), "step 2.");
	});

	it("strips case-insensitive thinking headers", () => {
		assert.equal(clean("REASONING: analyze source.\nresult."), "result.");
		assert.equal(clean("thinking: deeply.\noutput."), "output.");
	});

	it("strips leaked backtick tool calls with known Pi tool names", () => {
		const result = clean('I need to find the file. `read("README.md")` Let me read it.');
		assert.equal(result, "I need to find the file. Let me read it.");
	});

	it("does not strip non-backtick patterns (would cause false positives in bash output)", () => {
		const result = clean('Use find("*.ts", "src/") to locate.');
		assert.equal(result, 'Use find("*.ts", "src/") to locate.');
	});

	it("does not strip non-Pi-tool function calls", () => {
		const content = 'Call helperFunction("arg") to proceed.';
		assert.equal(clean(content), content);
	});

	it("handles non-string input gracefully", () => {
		assert.strictEqual(clean(null), null);
		assert.strictEqual(clean(42), 42);
		assert.deepStrictEqual(clean(["a"]), ["a"]);
	});

	it("combines header strip and tool-call strip", () => {
		const result = clean("Reasoning: search the codebase.\n`grep('foo', 'src/')` found.");
		assert.equal(result, "found.");
	});

	it("does not modify content with no leaked patterns", () => {
		const content = "Read the file and check the content.";
		// Should return the same reference
		assert.equal(clean(content), content);
	});
});

describe("cleanLeakedContentFromMessages", () => {
	it("leaves payload without leaked content unchanged", () => {
		const payload = {
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
		};
		assert.equal(cleanMessages(payload), payload);
	});

	it("cleans leaked content only in assistant messages", () => {
		const payload = {
			messages: [
				{ role: "user", content: "Explain `read('file.ts')` and Reasoning: headers" },
				{ role: "assistant", content: "Reasoning: search for the file.\n`find('*.ts')` found it." },
			],
		};
		const result = cleanMessages(payload) as typeof payload;
		assert.notEqual(result, payload);
		assert.equal(result.messages[0].content, payload.messages[0].content);
		assert.equal(result.messages[1].content, "found it.");
	});

	it("cleans leaked content across multiple messages", () => {
		const payload = {
			messages: [
				{ role: "assistant", content: "Thinking: about the approach.\nResult A." },
				{ role: "user", content: "continue" },
				{ role: "assistant", content: "Reasoning: about the implementation.\nResult B." },
			],
		};
		const result = cleanMessages(payload) as typeof payload;
		assert.equal((result.messages[0] as any).content, "Result A.");
		assert.equal((result.messages[2] as any).content, "Result B.");
	});

	it("handles empty messages array", () => {
		assert.deepStrictEqual(cleanMessages({ messages: [] }), { messages: [] });
	});

	it("handles non-object payload", () => {
		assert.equal(cleanMessages(null), null);
		assert.equal(cleanMessages("str"), "str");
	});

	it("handles array content parts (multimodal)", () => {
		const payload = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [{ type: "text", text: "Reasoning: think about approach.\n`read('x')` done." }] },
			],
		};
		const result = cleanMessages(payload) as typeof payload;
		assert.notEqual(result, payload);
		const cleanedParts = (result.messages[1] as any).content as Array<{ type: string; text: string }>;
		assert.equal(cleanedParts[0].text, "done.");
	});

	it("returns original reference when no message has leaked content (fast path)", () => {
		const payload = {
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
		};
		assert.equal(cleanMessages(payload), payload);
	});
});
