/**
 * Thread Viewer — Overlay TUI component for pi-subagent.
 *
 * Displays a single subagent thread's full output in an overlay.
 * Supports keyboard navigation between threads and scrolling.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, Markdown } from "@earendil-works/pi-tui";
import type { Message } from "@earendil-works/pi-ai";

import { type SubAgentResult, isFailedResult, getResultOutput, getFinalOutput } from "./runner.ts";
import { formatUsageStats } from "./render.ts";
import type { SubagentThread } from "./threads.ts";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Safe type guards for tool-call arguments
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback = "..."): string {
	return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

// ---------------------------------------------------------------------------
// Tool-call formatting (same as render.ts)
// ---------------------------------------------------------------------------

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: string, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = asString(args.command);
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = asString(args.file_path ?? args.path);
			const filePath = shortenPath(rawPath);
			const offset = asNumber(args.offset);
			const limit = asNumber(args.limit);
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = asString(args.file_path ?? args.path);
			const filePath = shortenPath(rawPath);
			const content = asString(args.content, "");
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = asString(args.file_path ?? args.path);
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = asString(args.path, ".");
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = asString(args.pattern, "*");
			const rawPath = asString(args.path, ".");
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = asString(args.pattern);
			const rawPath = asString(args.path, ".");
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) {
					items.push({ type: "text", text: part.text });
				} else if (part.type === "toolCall") {
					items.push({
						type: "toolCall",
						name: part.name,
						args: asRecord(part.arguments),
					});
				}
			}
		}
	}
	return items;
}

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

export class ThreadViewer {
	private thread: SubagentThread;
	private callbacks: ThreadViewerCallbacks;
	private theme: ViewerTheme;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedUpdatedAt?: number;
	private cachedLines?: string[];

	constructor(thread: SubagentThread, callbacks: ThreadViewerCallbacks, theme: ViewerTheme) {
		this.thread = thread;
		this.callbacks = callbacks;
		this.theme = theme;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.callbacks.onClose();
			return;
		}
		if (matchesKey(data, Key.alt("left"))) {
			if (this.callbacks.hasPrev) {
				this.scrollOffset = 0;
				this.callbacks.onPrev();
			}
			return;
		}
		if (matchesKey(data, Key.alt("right"))) {
			if (this.callbacks.hasNext) {
				this.scrollOffset = 0;
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
		let header = `${icon} ${t.fg("toolTitle", t.bold(this.thread.agentName))}${modeLabel}`;
		if (status === "running") header += ` ${t.fg("warning", "(running...)")}`;
		else if (status === "aborted") header += ` ${t.fg("error", "[aborted]")}`;
		if (result && isErr && result.stopReason && result.stopReason !== "error" && result.stopReason !== "aborted") {
			const reasonColor = result.stopReason === "timeout" ? "warning" : "error";
			header += ` ${t.fg(reasonColor, `[${result.stopReason}]`)}`;
		}
		lines.push(truncateToWidth(header, width));

		// Error message
		if (result && isErr && result.errorMessage) {
			const msgColor = result.stopReason === "timeout" ? "warning" : "error";
			lines.push(truncateToWidth(t.fg(msgColor, `Error: ${result.errorMessage}`), width));
		}

		lines.push("");

		// Task
		lines.push(truncateToWidth(t.fg("muted", "─── Task ───"), width));
		lines.push(truncateToWidth(t.fg("dim", this.thread.task), width));
		lines.push("");

		if (status === "running" && (!result || result.messages.length === 0)) {
			lines.push(truncateToWidth(t.fg("muted", "(waiting for first message...)"), width));
		} else if (result) {
			const displayItems = getDisplayItems(result.messages);
			const finalOutput = getFinalOutput(result.messages);

			lines.push(truncateToWidth(t.fg("muted", "─── Output ───"), width));

			if (displayItems.length === 0 && !finalOutput) {
				lines.push(truncateToWidth(t.fg("muted", "(no output)"), width));
			} else {
				const mdTheme = getMarkdownTheme();

				// Show all display items: text + tool calls
				for (const item of displayItems) {
					if (item.type === "toolCall") {
						lines.push(
							truncateToWidth(
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
							lines.push(`  ${truncateToWidth(mdLine, contentWidth)}`);
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
						lines.push(`  ${truncateToWidth(mdLine, contentWidth)}`);
					}
				}
			}

			// Usage stats
			const usageStr = formatUsageStats(result.usage, result.model);
			if (usageStr) {
				lines.push("");
				lines.push(truncateToWidth(t.fg("dim", usageStr), width));
			}
		}

		lines.push("");

		// Footer navigation hints
		const navParts: string[] = [];
		navParts.push("Esc close");
		if (this.callbacks.hasPrev) navParts.push("alt+← prev");
		if (this.callbacks.hasNext) navParts.push("alt+→ next");
		navParts.push("↑↓ scroll");
		lines.push(truncateToWidth(t.fg("dim", navParts.join(" · ")), width));

		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedUpdatedAt = this.thread.updatedAt;

		return this.renderVisible(lines, width);
	}

	private renderVisible(allLines: string[], width: number): string[] {
		const total = allLines.length;
		const maxVisible = Math.max(3, OVERLAY_HEIGHT);

		// Clamp scrollOffset so the last page shows a full viewport minus one indicator line
		const maxOffset =
			total > maxVisible
				? Math.max(0, total - (maxVisible - 1))
				: 0;
		const offset = Math.max(0, Math.min(this.scrollOffset, maxOffset));

		// Reserve space for scroll indicators
		const aboveShown = offset > 0;
		const belowShown = offset + maxVisible < total;
		const indicatorLines = (aboveShown ? 1 : 0) + (belowShown ? 1 : 0);
		const bodyHeight = Math.max(1, maxVisible - indicatorLines);

		const visible = allLines.slice(offset, offset + bodyHeight);

		// Scroll indicator at top
		if (aboveShown) {
			visible.unshift(truncateToWidth(
				this.theme.fg("muted", `↑ ${offset} more lines above`),
				width,
			));
		}
		// Scroll indicator at bottom
		if (belowShown) {
			const remaining = total - offset - bodyHeight;
			visible.push(truncateToWidth(
				this.theme.fg("muted", `↓ ${remaining} more lines below`),
				width,
			));
		}

		return visible;
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
		this.scrollOffset = 0;
		this.invalidate();
	}
}
