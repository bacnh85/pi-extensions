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
 * plain-text tool-call syntax that some V4 variants emit in message content.
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
const LEAKED_THINKING_HEADER = /^(Reasoning|Thinking|Chain of Thought)\s*:[^\n]*\n?/im;

/**
 * Known Pi tool-name patterns for detecting leaked plain-text tool calls.
 * These look like `read("file.ts")` or `` `read(path="file.ts")` `` in content.
 * The trailing \\s* consumes whitespace after the call so the gap left by removal
 * doesn't leave a stray space (e.g., `` `grep('foo')` found`` → "found", not " found").
 */
const LEAKED_TOOL_CALL_RE = /`?([a-z_]+)\(([^)]*)\)`?\s*/g;

const PI_TOOL_NAMES = new Set([
	"read", "write", "edit", "bash", "grep", "find", "ls",
	"serena_find_symbol", "serena_get_symbols_overview",
	"serena_find_referencing_symbols", "serena_find_declaration",
	"serena_find_implementations", "serena_replace_symbol_body",
	"serena_insert_before_symbol", "serena_insert_after_symbol",
	"serena_rename_symbol", "serena_safe_delete_symbol",
	"serena_search_for_pattern", "serena_replace_content",
	"serena_restart_language_server", "serena_get_diagnostics_for_file",
	"munin_search", "munin_get", "munin_store", "munin_list",
	"munin_recent", "munin_delete", "munin_capabilities",
	"web_search", "web_extract", "web_map", "web_crawl",
	"web_screenshot", "web_pdf", "web_status",
]);

/**
 * Check if a string looks like a known Pi tool name.
 */
function isPiToolName(name: string): boolean {
	return PI_TOOL_NAMES.has(name);
}

/**
 * Clean leaked thinking content from a single message content string.
 *
 * 1. Strips leading "Reasoning:" / "Thinking:" / "Chain of Thought:" headers
 * 2. Strips leaked plain-text tool calls like `read("file.ts")`
 *
 * Returns the cleaned content, or the original if nothing changed.
 */
export function cleanLeakedContent(content: unknown): unknown {
	if (typeof content !== "string") return content;

	let cleaned = content;

	// Step 1: Strip leaked thinking header at start of content
	if (LEAKED_THINKING_HEADER.test(cleaned)) {
		cleaned = cleaned.replace(LEAKED_THINKING_HEADER, "").trimStart();
	}

	// Step 2: Strip leaked backtick-wrapped tool calls (inline only, not code blocks)
	cleaned = cleaned.replace(LEAKED_TOOL_CALL_RE, (match, toolName: string) => {
		if (isPiToolName(toolName)) {
			return ""; // remove the leaked call, keep surrounding text
		}
		return match; // leave non-tool calls alone
	});

	return cleaned !== content ? cleaned : content;
}

/**
 * Walk all messages and clean leaked content from string content fields.
 * Also handles array-of-string content (multi-modal messages).
 * Returns cloned payload only when at least one message was changed.
 */
export function cleanLeakedContentFromMessages(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;

	const messages = findMessagesArray(payload);
	if (!messages || messages.length === 0) return payload;

	let cloned: Record<string, unknown> | undefined;
	let clonedMessages: Array<Record<string, unknown>> | undefined;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const cleanedContent = cleanMessageContent(msg.content);
		if (cleanedContent === msg.content) continue;

		if (!cloned) {
			cloned = structuredClone(payload);
			clonedMessages = findMessagesArray(cloned)!;
		}
		(clonedMessages![i] as Record<string, unknown>).content = cleanedContent;
	}

	return cloned ?? payload;
}

function cleanMessageContent(content: unknown): unknown {
	if (typeof content === "string") {
		return cleanLeakedContent(content);
	}
	if (Array.isArray(content)) {
		let changed = false;
		const cleaned = content.map((part: unknown) => {
			if (isRecord(part) && typeof part.text === "string") {
				const cleanedText = cleanLeakedContent(part.text);
				if (cleanedText !== part.text) changed = true;
				return cleanedText !== part.text ? { ...part, text: cleanedText } : part;
			}
			return part;
		});
		return changed ? cleaned : content;
	}
	return content;
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
