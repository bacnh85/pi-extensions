/**
 * Inbound A2A task activity — the events the host TUI surfaces when a remote
 * peer calls this Pi session.
 *
 * The A2AServer emits InboundActivity events at task lifecycle boundaries
 * (arrived / progress / completed / failed); extensions/index.ts wires them
 * to transcript messages + toasts. Pure formatting helpers live here so they
 * are unit-testable without the SDK or a live agent session.
 */

// ---------------------------------------------------------------------------
// Activity events
// ---------------------------------------------------------------------------

export type InboundActivity =
  | {
      type: "arrived";
      taskId: string;
      identity: string;
      preview: string;
      contextId: string;
    }
  | { type: "progress"; taskId: string; line: string }
  | { type: "completed"; taskId: string; state: string; replyPreview: string; elapsedMs: number }
  | { type: "failed"; taskId: string; error: string; elapsedMs: number };

// ---------------------------------------------------------------------------
// Preview helpers
// ---------------------------------------------------------------------------

/** Single-line truncation for task/reply previews (keeps newlines collapsed). */
export function preview(text: string, max = 120): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Event → display line mapping (from the isolated agent session)
// ---------------------------------------------------------------------------

/**
 * Map an isolated agent-session event to a one-line activity string, or null
 * when the event has nothing worth showing.
 *
 * Supported events (same shapes pi-subagent's runner receives):
 *  - tool_execution_start:  "⚙ <tool> <args preview>"
 *  - tool_execution_end:    "✓ <tool>"
 *  - message_end (assistant): first assistant text line (reply being written)
 *  - agent_end:             "…done" (agent loop finished)
 */
export function activityLine(event: {
  type: string;
  toolName?: string;
  args?: unknown;
  message?: { role?: string; content?: unknown; parts?: unknown };
  willRetry?: boolean;
}): string | null {
  switch (event.type) {
    case "tool_execution_start": {
      const tool = String(event.toolName || "tool");
      const args = argsPreview(event.args);
      return args ? `⚙ ${tool} ${args}` : `⚙ ${tool}`;
    }
    case "tool_execution_end": {
      const tool = String(event.toolName || "tool");
      return `✓ ${tool}`;
    }
    case "message_end": {
      if (event.message?.role !== "assistant") return null;
      const content = event.message.content ?? event.message.parts ?? [];
      const text = (Array.isArray(content) ? content : [])
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .join("")
        .trim();
      if (!text) return null;
      const line = preview(text, 100);
      return line ? `✎ ${line}` : null;
    }
    case "agent_end": {
      if (event.willRetry) return null; // a retry isn't meaningful activity
      return "✓ agent finished";
    }
    default:
      return null;
  }
}

/** Compact, redacted-ish one-line preview of tool-call arguments. */
function argsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  // Prefer the most informative common keys; fall back to the first scalar.
  const keys = ["command", "path", "pattern", "query", "url", "message"];
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return preview(v, 60);
  }
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === "string" && v.trim()) return `${k}: ${preview(v, 40)}`;
    if (typeof v === "number" || typeof v === "boolean") return `${k}: ${v}`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Transcript message rendering (terse text the host LLM sees)
// ---------------------------------------------------------------------------

/** One-line transcript text for an activity event (LLM-context-safe, terse). */
export function activityToText(a: InboundActivity): string {
  switch (a.type) {
    case "arrived":
      return `[A2A inbound] task from ${a.identity}: ${a.preview || "(empty)"}`;
    case "progress":
      return `[A2A inbound] ${a.line}`;
    case "completed":
      return `[A2A inbound] task ${a.taskId.slice(0, 8)} completed (${(a.elapsedMs / 1000).toFixed(1)}s) — ${a.replyPreview || "(no reply)"}`;
    case "failed":
      return `[A2A inbound] task ${a.taskId.slice(0, 8)} failed (${(a.elapsedMs / 1000).toFixed(1)}s): ${a.error || "unknown error"}`;
  }
}

/** Short footer status while tasks are running (e.g. "2 inbound · 3 tools"). */
export function activityStatusLine(active: Array<{ taskId: string; identity: string }>): string | undefined {
  if (active.length === 0) return undefined;
  const n = active.length;
  const who = active.map((t) => t.identity).join(", ");
  return `A2A: ${n} inbound task${n > 1 ? "s" : ""} (${who})`;
}
