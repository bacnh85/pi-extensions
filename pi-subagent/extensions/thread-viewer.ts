/**
 * Thread Viewer — Overlay TUI component for pi-subagent.
 *
 * Displays a single subagent thread's full output in an overlay.
 * Supports keyboard navigation between threads and scrolling.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, Markdown } from "@earendil-works/pi-tui";

import { isFailedResult, getFinalOutput } from "./runner.ts";
import { formatToolCall, getDisplayItems, formatUsageStats } from "./render.ts";
import type { SubagentThread } from "./threads.ts";

// ---------------------------------------------------------------------------
// Theme types
// ---------------------------------------------------------------------------

interface ViewerTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

// ---------------------------------------------------------------------------
// Thread Viewer Component
// ---------------------------------------------------------------------------

export interface ThreadViewerCallbacks {
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}

/** Viewport height for the overlay (estimated lines). Must be > 3. */
const OVERLAY_HEIGHT = 24;
const borderSize = 1;
const truncateFit = function (text: string, width: number): string {
  text = " " + text;
  return truncateToWidth(text, width - ((borderSize*2) +1), "...", true) + " ";

  }

export class ThreadViewer {
  private thread: SubagentThread;
  private callbacks: ThreadViewerCallbacks;
  private theme: ViewerTheme;
  private scrollOffset = 0;
  private cachedWidth?: number;
  private cachedUpdatedAt?: number;
  private cachedLines?: string[];
  private lastThreadId: string | null = null;

  constructor(thread: SubagentThread, callbacks: ThreadViewerCallbacks, theme: ViewerTheme) {
    this.thread = thread;
    this.callbacks = callbacks;
    this.theme = theme;
    this.lastThreadId = thread.id;

  }


  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.callbacks.onClose();
      return;
    }
    if (matchesKey(data, Key.alt("left"))) {
      if (this.callbacks.hasPrev) {
        this.callbacks.onPrev();
      }
      return;
    }
    if (matchesKey(data, Key.alt("right"))) {
      if (this.callbacks.hasNext) {
        this.callbacks.onNext();
      }
      return;
    }
    if (matchesKey(data, Key.up)) {
      if (this.scrollOffset > 0) {
        this.scrollOffset--;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollOffset++;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - OVERLAY_HEIGHT);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += OVERLAY_HEIGHT;
      this.invalidate();
      return;
    }
  }

  render(width: number): string[] {
    // Use updatedAt in cache key so running→completed transitions bust the cache
    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedUpdatedAt === this.thread.updatedAt
    ) {
      return this.renderVisible(this.cachedLines, width);
    }

    const t = this.theme;
    const lines: string[] = [];
    const result = this.thread.result;
    const isErr = result ? isFailedResult(result) : false;
    const status = this.thread.status;

    // Status icon
    let icon: string;
    if (status === "running") icon = t.fg("warning", "⏳");
    else if (status === "aborted") icon = t.fg("error", "✗");
    else if (isErr) icon = t.fg("error", "✗");
    else icon = t.fg("success", "✓");

    // Mode label
    let modeLabel = "";
    if (this.thread.mode === "parallel-task") modeLabel = t.fg("muted", " [parallel]");
    else if (this.thread.mode === "chain-step") modeLabel = t.fg("muted", " [chain]");

    // Header
    const agentColor = this.thread.color ?? "accent";
    let header = `${icon} ${t.fg(agentColor, t.bold(this.thread.agentName))}${modeLabel}`;
    if (status === "running") header += ` ${t.fg("warning", "(running...)")}`;
    else if (status === "aborted") header += ` ${t.fg("error", "[aborted]")}`;
    if (result && isErr && result.stopReason && result.stopReason !== "error" && result.stopReason !== "aborted") {
      const reasonColor = result.stopReason === "timeout" ? "warning" : "error";
      header += ` ${t.fg(reasonColor, `[${result.stopReason}]`)}`;
    }
    lines.push(truncateFit(header, width));

    // Error message
    if (result && isErr && result.errorMessage) {
      const msgColor = result.stopReason === "timeout" ? "warning" : "error";
      lines.push(truncateFit(t.fg(msgColor, `Error: ${result.errorMessage}`), width));
    }

    lines.push("");

    // Task
    lines.push(truncateFit(t.fg("muted", "─── Task ───"), width));
    lines.push(truncateFit(t.fg("dim", this.thread.task), width));
    lines.push("");

    if (status === "running") {
      const now = Date.now();
      const elapsed = Math.floor((now - this.thread.createdAt) / 1000);
      const activity = this.thread.lastActivityAt ? `${Math.floor((now - this.thread.lastActivityAt) / 1000)}s ago (${this.thread.lastActivityLabel})` : "none yet";
      const idleMs = this.thread.inactivityDeadline ? this.thread.inactivityDeadline - now : 0;
      const idle = this.thread.inactivityDeadline ? `${Math.max(0, Math.ceil(idleMs / 1000))}s remaining` : "pending";
      lines.push(truncateFit(t.fg(idleMs < 30_000 ? "warning" : "muted", `Elapsed ${elapsed}s · last activity ${activity} · idle ${idle}`), width));
    }
    if (status === "running" && (!result || result.messages.length === 0)) {
      lines.push(truncateFit(t.fg("muted", "(waiting for first message...)"), width));
    } else if (result) {
      const displayItems = getDisplayItems(result.messages);
      const finalOutput = getFinalOutput(result.messages);

      lines.push(truncateFit(t.fg("muted", "─── Output ───"), width));

      if (displayItems.length === 0 && !finalOutput) {
        lines.push(truncateFit(t.fg("muted", "(no output)"), width));
      } else {
        const mdTheme = getMarkdownTheme();

        // Show all display items: text + tool calls
        for (const item of displayItems) {
          if (item.type === "toolCall") {
            lines.push(
              truncateFit(
                t.fg("muted", "→ ") + formatToolCall(item.name, item.args, t.fg.bind(t)),
                width,
              ),
            );
          } else {
            // Assistant text — render as markdown
            const contentWidth = Math.max(1, width - 2);
            const md = new Markdown(item.text.trim(), 0, 0, mdTheme);
            const mdLines = md.render(contentWidth);
            for (const mdLine of mdLines) {
              lines.push(`  ${truncateFit(mdLine, contentWidth)}`);
            }
          }
        }
        // Check if final output not already shown
        const finalAlreadyShown = finalOutput && displayItems.some(
          (it) => it.type === "text" && it.text.includes(finalOutput.slice(0, 100)),
        );
        if (finalOutput && !finalAlreadyShown) {
          const contentWidth = Math.max(1, width - 2);
          const md = new Markdown(finalOutput.trim(), 0, 0, mdTheme);
          for (const mdLine of md.render(contentWidth)) {
            lines.push(`  ${truncateFit(mdLine, contentWidth)}`);
          }
        }
      }

      // Usage stats
      const usageStr = formatUsageStats(result.usage, result.model);
      if (usageStr) {
        lines.push("");
        lines.push(truncateFit(t.fg("dim", usageStr), width));
      }
    }

    lines.push("");

    // Footer navigation hints
    const navParts: string[] = [];
    navParts.push("Esc close");
    if (this.callbacks.hasPrev) navParts.push("alt+← prev");
    if (this.callbacks.hasNext) navParts.push("alt+→ next");
    navParts.push("↑↓ scroll");
    lines.push(truncateFit(t.fg("dim", navParts.join(" · ")), width));

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.cachedUpdatedAt = this.thread.updatedAt;

    return this.renderVisible(lines, width);
  }

  private renderVisible(allLines: string[], width: number): string[] {
    const total = allLines.length;
    const maxVisible = Math.max(3, OVERLAY_HEIGHT);
    const color = this.thread.color ?? "accent";

    // Clamp scrollOffset so the last page shows a full viewport minus one indicator line
    const maxOffset =
      total > maxVisible
        ? Math.max(0, total - (maxVisible - 1))
        : 0;
    const offset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    this.scrollOffset = offset;

    // Reserve space for scroll indicators
    const aboveShown = offset > 0;
    const belowShown = offset + maxVisible < total;
    const indicatorLines = (aboveShown ? 1 : 0) + (belowShown ? 1 : 0);
    const bodyHeight = Math.max(1, maxVisible - indicatorLines);

    const visible = allLines.slice(offset, offset + bodyHeight);

    // Scroll indicator at top
    if (aboveShown) {
      const abmsg = this.theme.fg(color, `↑ ${offset}`) + this.theme.fg("muted", ` more lines above`);
      visible.unshift(truncateFit(
        abmsg,
        width,
      ));
    }
    // Scroll indicator at bottom
    if (belowShown) {
      const remaining = total - offset - bodyHeight;
      const remmsg = this.theme.fg(color, `↓ ${remaining}`) + this.theme.fg("muted", ` more lines below`);
        visible.push(truncateFit(
        remmsg,
        width,
      ));
    }

    // Add border around the visible content
    const borderWidth = width - 2;
    const borderedLines: string[] = [];


    // Top border with colored characters
    const borderColor = this.theme.fg(color, "─");
    const cornerColor = this.theme.fg(color, "┌");
    const bottomCornerColor = this.theme.fg(color, "└");
    const sideBorder = this.theme.fg(color, "│");
    borderedLines.push(cornerColor + borderColor.repeat(borderWidth) + this.theme.fg(color, "┐"));

    // Content with side borders
    for (const line of visible) {
      let borderedLine = sideBorder + line + sideBorder;
      if (line.trim() === "") {
      borderedLine = sideBorder + " ".repeat(Math.max(0, width - ( borderSize * 2))) + sideBorder;
      }
      borderedLines.push(borderedLine);
    }

    // Bottom border with colored characters
    borderedLines.push(bottomCornerColor + borderColor.repeat(borderWidth) + this.theme.fg(color, "┘"));

    return borderedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedUpdatedAt = undefined;
    this.cachedLines = undefined;
  }

  /** Update the thread being displayed (for prev/next navigation). */
  setThread(thread: SubagentThread, callbacks: ThreadViewerCallbacks): void {
    this.thread = thread;
    this.callbacks = callbacks;
    // Only reset scrollOffset when switching to a different thread
    if (this.lastThreadId !== thread.id) {
      this.scrollOffset = 0;
      this.lastThreadId = thread.id;
    }
    this.invalidate();
  }
}
