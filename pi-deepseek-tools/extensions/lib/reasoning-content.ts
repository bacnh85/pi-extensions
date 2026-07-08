/**
 * reasoning-content.ts — strip `reasoning_content` from provider request payloads
 *
 * DeepSeek V4 native responses include `reasoning_content` in assistant messages.
 * On multi-turn conversations the accumulated `reasoning_content` fields can cause
 * 400 errors with OpenCode-Go and other proxy providers. This module strips them
 * from all assistant messages *except* the most recent one (current turn's response),
 * preserving thinking continuity across turns.
 */

import { isRecord } from "./deepseek-tools.ts";

/**
 * Walk a provider request payload and remove `reasoning_content` from
 * assistant messages in the `messages[]` array.  Handles both chat-completion
 * style (payload.messages) and older message-list top-level payloads.
 *
 * @returns a new payload object if anything was removed, or the original
 *          reference if no change was needed.
 */
export function stripReasoningContent(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;

	const messages = findMessagesArray(payload);
	if (!messages || messages.length === 0) return payload;

	// Strip from all but the last message.  The last assistant message is the
	// current turn's fresh response — stripping it would remove the model's
	// just-produced reasoning before the provider even sees it.
	const lastAssistantIdx = findLastAssistantIndex(messages);
	let changed = false;

	for (let i = 0; i < messages.length; i++) {
		if (i === lastAssistantIdx) continue; // keep current turn
		if (messages[i].role !== "assistant") continue;
		if ("reasoning_content" in messages[i]) {
			delete messages[i].reasoning_content;
			changed = true;
		}
		// Also handle variations that some wrappers emit
		if ("reasoning" in messages[i]) {
			delete messages[i].reasoning;
			changed = true;
		}
	}

	return changed ? payload : payload; // mutated in-place via clone
}

/**
 * Deep-clone a payload before mutation so we never touch the original.
 * If the payload is not an object, returns the original unchanged.
 */
export function clonePayload<T>(payload: T): T {
	if (typeof payload !== "object" || payload === null) return payload;
	if (Array.isArray(payload)) return payload.map(clonePayload) as unknown as T;
	const cloned: Record<string, unknown> = {};
	for (const key of Object.keys(payload as Record<string, unknown>)) {
		cloned[key] = clonePayload((payload as Record<string, unknown>)[key]);
	}
	return cloned as T;
}

// --- internal helpers ---

function findMessagesArray(payload: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
	// Standard chat completion payload
	if (Array.isArray(payload.messages)) {
		return payload.messages as Array<Record<string, unknown>>;
	}
	// Some providers nest under `body`
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
