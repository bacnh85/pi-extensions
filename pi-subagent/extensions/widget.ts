/**
 * Live progress widget for pi-subagent.
 *
 * A persistent above-editor widget that shows what each running subagent is
 * doing right now — spinner, agent, elapsed time, tool-call count, and the
 * latest tool call with done/error/in-progress status. Fed by the live
 * threadStore subscription (per SDK session event), NOT by JSONL polling.
 *
 * Mirrors pi-task's widget UX but cheaper: we have in-process live events.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Message } from "@earendil-works/pi-ai";
import type { SubagentThread } from "./threads.ts";
import { formatToolCall } from "./render.ts";

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 80;
const TREE_LAST = "└─"; // pi-task uses └─; keep consistent
const MAX_WIDTH = 120;
const MAX_THREADS = 8;

// ---------------------------------------------------------------------------
// Theme shim
// ---------------------------------------------------------------------------

export interface WidgetTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

function color(theme: WidgetTheme | null | undefined, token: string, text: string): string {
  return theme?.fg ? theme.fg(token, text) : text;
}

function bold(theme: WidgetTheme | null | undefined, text: string): string {
  return theme?.bold ? theme.bold(text) : text;
}

// ---------------------------------------------------------------------------
// Elapsed formatting
// ---------------------------------------------------------------------------

export function formatMs(ms: number): string {
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

// ---------------------------------------------------------------------------
// Tool-call status derivation from the message stream
// ---------------------------------------------------------------------------

export type ToolStatus = "in_progress" | "done" | "error";

export interface RecentToolCall {
  name: string;
  detail: string;
  status: ToolStatus;
}

/**
 * Derive recent tool calls with status by pairing assistant toolCall parts
 * (carrying .id) against later toolResult messages (carrying toolCallId + isError).
 * Returns most-recent-last. Capped at `cap` entries.
 */
export function deriveRecentToolCalls(messages: Message[], cap = 5): RecentToolCall[] {
  // Map toolCallId -> isError for completed results.
  const resultsById = new Map<string, boolean>();
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      resultsById.set(msg.toolCallId, msg.isError);
    }
  }
  // Walk assistant messages, collect toolCall parts in order.
  const calls: RecentToolCall[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type !== "toolCall") continue;
      const isError = resultsById.get(part.id);
      const status: ToolStatus = isError === undefined ? "in_progress" : isError ? "error" : "done";
      calls.push({
        name: part.name,
        detail: formatToolCall(part.name, part.arguments ?? {}, (token, text) => text),
        status,
      });
    }
  }
  return calls.slice(-cap);
}

function countToolProgress(messages: Message[]): { toolCount: number; inFlight: number } {
  const resultIds = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  let toolCount = 0;
  let inFlight = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.content) {
      if (p.type !== "toolCall") continue;
      if (resultIds.has(p.id)) toolCount++;
      else inFlight++;
    }
  }
  return { toolCount, inFlight };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusMark(theme: WidgetTheme | null | undefined, status: ToolStatus, spinner: string): string {
  switch (status) {
    case "done": return color(theme, "success", "✓");
    case "error": return color(theme, "error", "✗");
    case "in_progress":
    default: return color(theme, "accent", spinner);
  }
}

/**
 * One-line live status for a running thread: spinner · Agent · elapsed ·
 * tools · latest tool call. Used by both the widget and the tool-call row.
 */
export function renderLiveThreadLine(
  thread: SubagentThread,
  theme: WidgetTheme | null | undefined,
  now: number,
  agentColor: string,
  maxCalls = 5,
): string {
  const agentName = thread.agentName.charAt(0).toUpperCase() + thread.agentName.slice(1);
  const elapsed = formatMs(now - thread.createdAt);
  const messages = thread.result?.messages ?? [];
  const { toolCount, inFlight } = countToolProgress(messages);
  const spinner = SPINNER_FRAMES[Math.floor(now / SPINNER_MS) % SPINNER_FRAMES.length]!;

  let line =
    color(theme, "accent", spinner) + " " +
    color(theme, agentColor, bold(theme, agentName)) +
    color(theme, "dim", " · ") +
    color(theme, "warning", elapsed);
  if (toolCount > 0 || inFlight > 0) {
    const parts: string[] = [];
    if (toolCount > 0) parts.push(`${toolCount} tool${toolCount > 1 ? "s" : ""}`);
    if (inFlight > 0) parts.push(`${inFlight} running`);
    line += color(theme, "dim", " · ") + color(theme, "muted", parts.join(", "));
  }

  // Recent tool calls (up to maxCalls) — list, most-recent-last.
  const recent = deriveRecentToolCalls(messages, maxCalls);
  const hidden = Math.max(0, toolCount + inFlight - recent.length);
  if (hidden > 0 && recent.length >= maxCalls) {
    line += "\n  " + color(theme, "dim", `+${hidden} earlier`);
  }
  for (const call of recent) {
    line += "\n  " +
      color(theme, "dim", TREE_LAST) + " " +
      statusMark(theme, call.status, spinner) + " " +
      call.detail;
  }
  return line;
}

function renderThread(
  thread: SubagentThread,
  now: number,
  maxWidth: number,
  theme: WidgetTheme | null | undefined,
): string[] {
  const lines: string[] = [];
  const agentColor = thread.color ?? "accent";

  // Header: spinner · Agent · elapsed · tools — then task preview.
  const base = renderLiveThreadLine(thread, theme, now, agentColor).split("\n")[0] ?? "";
  const taskPreview = thread.task.length > 40 ? `${thread.task.slice(0, 37)}...` : thread.task;
  const header = base + (thread.task ? color(theme, "dim", ` — ${taskPreview}`) : "");
  lines.push(truncateToWidth(header, maxWidth));

  // Latest tool call line (from the shared live-line renderer).
  const full = renderLiveThreadLine(thread, theme, now, agentColor).split("\n");
  if (full.length > 1) {
    lines.push(truncateToWidth(full[1]!, maxWidth));
  }
  return lines;
}

/**
 * Render the full widget for a set of threads.
 * Pure function — takes state, returns lines. No side effects.
 */
export function renderTaskWidget(params: {
  threads: SubagentThread[];
  width: number;
  theme?: WidgetTheme | null;
  now?: number;
}): string[] {
  const { threads, width, theme } = params;
  // Only running threads appear in the live widget.
  const running = threads.filter((t) => t.status === "running");
  if (running.length === 0) return [];

  const now = params.now ?? Date.now();
  const maxWidth = Math.min(width, MAX_WIDTH);
  const spinner = SPINNER_FRAMES[Math.floor(now / SPINNER_MS) % SPINNER_FRAMES.length]!;

  const lines: string[] = [];
  const shown = running.slice(0, MAX_THREADS);
  for (const thread of shown) {
    lines.push(...renderThread(thread, now, maxWidth, theme));
    lines.push(""); // breathing room between threads
  }
  const hidden = running.length - shown.length;
  if (hidden > 0) {
    lines.push(truncateToWidth(color(theme, "dim", `+ ${hidden} more running`), maxWidth));
    lines.push("");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Controller — owns the setWidget handle + threadStore subscription
// ---------------------------------------------------------------------------

export interface TaskWidgetController {
  ensureWidget(ctx: ExtensionContext): void;
  requestRender(): void;
  clearWidgetIfIdle(): void;
  dispose(): void;
}

export function createTaskWidgetController(
  getThreads: () => SubagentThread[],
  subscribe?: (listener: () => void) => () => void,
): TaskWidgetController {
  let widgetCtx: ExtensionContext | null = null;
  let requestWidgetRender: (() => void) | null = null;
  let widgetTheme: WidgetTheme | null = null;
  let unsubscribe: (() => void) | null = null;

  // On every threadStore change: re-render if running threads exist,
  // else clear the widget. This is the live-data path — no polling.
  const onStoreChange = (): void => {
    const running = getThreads().some((t) => t.status === "running");
    if (running) {
      if (widgetCtx) requestRender();
    } else {
      clearWidgetIfIdle();
    }
  };

  function renderWidget(width: number): string[] {
    return renderTaskWidget({ threads: getThreads(), width, theme: widgetTheme });
  }

  function requestRender(): void {
    requestWidgetRender?.();
  }

  /**
   * Lazily install the widget + subscription on the first running thread.
   * Idempotent — safe to call on every thread creation.
   */
  function ensureWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    // Subscribe once so future threadStore changes drive renders + idle-clear.
    if (!unsubscribe && subscribe) {
      unsubscribe = subscribe(onStoreChange);
    }
    if (widgetCtx) {
      requestRender();
      return;
    }
    widgetCtx = ctx;
    ignoreStaleExtensionCtx(() =>
      ctx.ui.setWidget("pi-subagent", (tui, theme) => {
        widgetTheme = theme ?? null;
        requestWidgetRender = () => tui.requestRender();
        return {
          render: (width: number) => renderWidget(width),
          invalidate: requestWidgetRender,
          dispose: () => {
            widgetTheme = null;
            requestWidgetRender = null;
          },
        };
      }),
    );
    requestRender();
  }

  /** Clear the widget when no threads are running (called after task completion). */
  function clearWidgetIfIdle(): void {
    const running = getThreads().filter((t) => t.status === "running").length;
    if (running > 0) {
      requestRender();
      return;
    }
    if (widgetCtx) {
      const ctx = widgetCtx;
      ignoreStaleExtensionCtx(() => ctx.ui.setWidget("pi-subagent", undefined));
      widgetCtx = null;
    }
    requestWidgetRender = null;
  }

  function dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
    if (widgetCtx) {
      const ctx = widgetCtx;
      ignoreStaleExtensionCtx(() => ctx.ui.setWidget("pi-subagent", undefined));
      widgetCtx = null;
    }
    widgetTheme = null;
    requestWidgetRender = null;
  }

  return { ensureWidget, requestRender, clearWidgetIfIdle, dispose };
}

/**
 * Wrap a ctx operation so a stale (post-replacement) ExtensionContext
 * doesn't crash. Mirrors pi-task's ignoreStaleExtensionCtx.
 * ponytail: minimal try/catch — the only failure mode is a replaced session.
 */
function ignoreStaleExtensionCtx<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
