/**
 * reasoning-content.ts — strip reasoning/thinking fields from provider request payloads
 * and clean leaked thinking/plain-text tool calls from message content.
 *
 * DeepSeek V4 native responses include reasoning fields in assistant messages
 * (`reasoning_content`, `reasoning`, `thinking_content`, `chain_of_thought`, etc.).
 * On multi-turn conversations, accumulated reasoning fields can cause 400 errors
 * with OpenCode-Go and other proxy providers. This module strips them from all
 * assistant messages *except* the most recent one (current turn's response),
 * preserving thinking continuity across turns.
 *
 * Optional truncation via PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS: when set to a
 * number, reasoning content longer than that value is truncated (with a marker)
 * rather than deleted entirely. This is useful when the provider rejects only
 * very long reasoning fields but short ones are fine.
 *
 * Leaked content cleaning (always applied): strips leaked thinking headers and
 * registered plain-text tool calls from assistant message content only.
 */

import { isRecord } from "./deepseek-tools.ts";

/**
 * Known field names that carry reasoning/thinking content across DeepSeek
 * proxy variants. Add more here if new wrappers emit different field names.
 */
const REASONING_FIELDS = new Set([
	"reasoning_content",
	"reasoning",
	"thinking_content",
	"chain_of_thought",
	"cot",
]);

/**
 * Read the optional max-tokens threshold from the environment.
 * Returns Infinity when unset or invalid.
 */
function maxReasoningTokens(env = process.env): number {
	const raw = env.PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS;
	if (raw === undefined || raw === "") return Infinity;
	const val = parseInt(raw, 10);
	return Number.isFinite(val) && val > 0 ? val : Infinity;
}

/**
 * Walk a provider request payload and remove reasoning fields from all
 * assistant messages except the most recent one.  Handles both chat-completion
 * style (payload.messages) and older message-list top-level payloads
 * (payload.body.messages).
 *
 * Reasoning fields stripped (when present on prior assistant messages):
 *   reasoning_content, reasoning, thinking_content, chain_of_thought, cot
 *
 * When PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS=<N> is set, reasoning values
 * longer than N characters are truncated with a marker instead of deleted.
 *
 * @returns the cloned (and stripped) payload, or the original reference
 *          if no prior reasoning exists (single pass, clones on first
 *          field found — the common path pays nothing).
 */
export function stripReasoningContent(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;

	const messages = findMessagesArray(payload);
	if (!messages || messages.length === 0) return payload;

	const lastAssistantIdx = findLastAssistantIndex(messages);
	if (lastAssistantIdx < 0) return payload;

	let cloned: Record<string, unknown> | undefined;
	let clonedMessages: Array<Record<string, unknown>> | undefined;
	const threshold = maxReasoningTokens();

	for (let i = 0; i < messages.length; i++) {
		if (i === lastAssistantIdx || messages[i].role !== "assistant") continue;

		for (const field of REASONING_FIELDS) {
			if (!(field in messages[i])) continue;

			// Clone on first reasoning field found — single pass, no pre-scan
			if (!cloned) {
				cloned = structuredClone(payload);
				clonedMessages = findMessagesArray(cloned);
				if (!clonedMessages) return payload;
			}

			const targetMessages = clonedMessages;
			if (!targetMessages) return payload;
			const value = targetMessages[i][field];
			if (Number.isFinite(threshold) && typeof value === "string" && value.length > threshold) {
				targetMessages[i][field] = value.slice(0, threshold) + "\n\n[reasoning truncated]";
			} else {
				delete targetMessages[i][field];
			}
		}
	}

	return cloned ?? payload;
}

// ────────────────────────────────────────────────────────
// Leaked content cleaning
// ────────────────────────────────────────────────────────

/**
 * Patterns for leaked thinking headers that V4 sometimes emits as plaintext
 * at the start of assistant message content.
 * Strips the entire first line (header + thinking content) because the
 * actual response starts on a new line or after the thinking block.
 */
const LEAKED_THINKING_HEADER = /^(Reasoning|Thinking|Chain of Thought)\s*:[^\n]*\n?/i;

/** Backtick-wrapped call syntax emitted as plain text instead of a real tool call. */
const LEAKED_TOOL_CALL_RE = /`([a-z_]+)\(([^)]*)\)`\s*/g;

/**
 * Clean leaked thinking content from a single message content string.
 *
 * 1. Strips leading "Reasoning:" / "Thinking:" / "Chain of Thought:" headers
 * 2. Strips leaked plain-text tool calls like `read("file.ts")`
 *
 * Returns the cleaned content, or the original if nothing changed.
 */
export function cleanLeakedContent(content: unknown, activeTools: ReadonlySet<string>): unknown {
	if (typeof content !== "string") return content;

	let cleaned = content;
	if (LEAKED_THINKING_HEADER.test(cleaned)) {
		cleaned = cleaned.replace(LEAKED_THINKING_HEADER, "").trimStart();
	}

	cleaned = cleaned.replace(LEAKED_TOOL_CALL_RE, (match, toolName: string) => activeTools.has(toolName) ? "" : match);
	return cleaned !== content ? cleaned : content;
}

/**
 * Walk assistant messages and clean leaked content from string content fields.
 * Also handles text parts in multi-modal content arrays.
 * Returns cloned payload only when at least one message was changed.
 */
export function cleanLeakedContentFromMessages(payload: unknown, activeTools: readonly string[]): unknown {
	if (!isRecord(payload)) return payload;

	const messages = findMessagesArray(payload);
	if (!messages || messages.length === 0) return payload;

	const toolNames = new Set(activeTools);
	let cloned: Record<string, unknown> | undefined;
	let clonedMessages: Array<Record<string, unknown>> | undefined;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const cleanedContent = cleanMessageContent(msg.content, toolNames);
		if (cleanedContent === msg.content) continue;

		if (!cloned) {
			cloned = structuredClone(payload);
			clonedMessages = findMessagesArray(cloned)!;
		}
		clonedMessages![i].content = cleanedContent;
	}

	return cloned ?? payload;
}

function cleanMessageContent(content: unknown, activeTools: ReadonlySet<string>): unknown {
	if (typeof content === "string") return cleanLeakedContent(content, activeTools);
	if (!Array.isArray(content)) return content;

	let changed = false;
	const cleaned = content.map((part: unknown) => {
		if (!isRecord(part) || typeof part.text !== "string") return part;
		const cleanedText = cleanLeakedContent(part.text, activeTools);
		if (cleanedText === part.text) return part;
		changed = true;
		return { ...part, text: cleanedText };
	});
	return changed ? cleaned : content;
}

// --- internal helpers ---

function findMessagesArray(payload: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
	if (Array.isArray(payload.messages)) {
		return payload.messages as Array<Record<string, unknown>>;
	}
	if (isRecord(payload.body) && Array.isArray(payload.body.messages)) {
		return payload.body.messages as Array<Record<string, unknown>>;
	}
	return undefined;
}

function findLastAssistantIndex(messages: Array<Record<string, unknown>>): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return i;
	}
	return -1;
}
