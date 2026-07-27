/**
 * reasoning-content.ts — shared reasoning strip + leaked-content cleaning.
 *
 * Used by pi-model-tools for all detected model families. Generic — works
 * for DeepSeek V4, GLM, and any reasoning model that accumulates
 * reasoning_content across turns or leaks tool calls as prose.
 */

import { isRecord } from "./model-detection.ts";

const REASONING_FIELDS = new Set(["reasoning_content", "reasoning", "thinking_content", "chain_of_thought", "cot"]);

function maxReasoningTokens(env = process.env): number {
  const raw = env.PI_MODEL_TOOLS_REASONING_MAX_TOKENS;
  if (raw === undefined || raw === "") return Infinity;
  const val = parseInt(raw, 10);
  return Number.isFinite(val) && val > 0 ? val : Infinity;
}

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
      if (!cloned) {
        cloned = structuredClone(payload);
        clonedMessages = findMessagesArray(cloned);
        if (!clonedMessages) return payload;
      }
      const value = clonedMessages![i][field];
      if (Number.isFinite(threshold) && typeof value === "string" && value.length > threshold) {
        clonedMessages![i][field] = value.slice(0, threshold) + "\n\n[reasoning truncated]";
      } else {
        delete clonedMessages![i][field];
      }
    }
  }
  return cloned ?? payload;
}

// ── Leaked content cleaning ──

const LEAKED_THINKING_HEADER = /^(Reasoning|Thinking|Chain of Thought)\s*:[^\n]*\n?/i;
const LEAKED_TOOL_CALL_RE = /`([a-z_]+)\(([^)]*)\)`\s*/g;

export function cleanLeakedContent(content: unknown, activeTools: ReadonlySet<string>): unknown {
  if (typeof content !== "string") return content;
  let cleaned = content;
  if (LEAKED_THINKING_HEADER.test(cleaned)) cleaned = cleaned.replace(LEAKED_THINKING_HEADER, "").trimStart();
  cleaned = cleaned.replace(LEAKED_TOOL_CALL_RE, (match, toolName: string) => activeTools.has(toolName) ? "" : match);
  return cleaned !== content ? cleaned : content;
}

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
    if (!cloned) { cloned = structuredClone(payload); clonedMessages = findMessagesArray(cloned)!; }
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

function findMessagesArray(payload: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  if (Array.isArray(payload.messages)) return payload.messages as Array<Record<string, unknown>>;
  if (isRecord(payload.body) && Array.isArray(payload.body.messages)) return payload.body.messages as Array<Record<string, unknown>>;
  return undefined;
}

function findLastAssistantIndex(messages: Array<Record<string, unknown>>): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i;
  return -1;
}
