/**
 * TUI rendering for pi-subagent.
 *
 * Renders sub-agent results in collapsed and expanded views.
 * Collapsed: status icon, agent name, last few items, usage stats.
 * Expanded (Ctrl+O): full task text, all tool calls, final markdown output.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Message } from "@earendil-works/pi-ai";
import { type SubAgentResult, isFailedResult, getResultOutput, getFinalOutput } from "./runner.ts";

// ---------------------------------------------------------------------------
// Safe type guards
// ---------------------------------------------------------------------------

export function asString(value: unknown, fallback = "..."): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// Duration formatting (inline to avoid a widget↔render import cycle)
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function formatUsageStats(
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens?: number; turns?: number },
  model?: string,
  opts?: { toolCount?: number; durationMs?: number },
): string {
  const parts: string[] = [];
  if (opts?.toolCount) parts.push(`${opts.toolCount} toolcall${opts.toolCount > 1 ? "s" : ""}`);
  if (opts?.durationMs && opts.durationMs > 0) parts.push(formatMs(opts.durationMs));
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

export function formatToolCall(
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
      const content = asString(args.content, "");
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
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

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
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

/**
 * First prose line of a markdown answer: skips code fences (delimiter AND
 * interior), ATX headings, blockquotes, bullets, ordered lists, and tables.
 * Returns "" when no prose line exists.
 */
function firstProseLine(raw: string): string {
  let inFence = false;
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Toggle fenced code blocks (``` or ~~~, optionally with a language tag).
    if (/^[`~]{3,}/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Skip structural markdown lines.
    if (/^(#{1,6}\s|\s*[>|*+-]\s|\s*\d+\.\s|\|)/.test(line)) continue;
    return line;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Single agent result
// ---------------------------------------------------------------------------

export function renderSingleResult(
  result: SubAgentResult,
  expanded: boolean,
  theme: { fg: (c: any, t: string) => string; bold: (t: string) => string },
  agentColor?: string,
): Container | Text {
  const isError = isFailedResult(result);
  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const displayItems = expanded ? getDisplayItems(result.messages) : [];
  const finalOutput = getResultOutput(result);
  const toolCount = result.messages.filter((m) => m.role === "toolResult").length;

  if (expanded) {
    const mdTheme = getMarkdownTheme();
    const container = new Container();
    let header = `${icon} ${theme.fg(agentColor ?? "toolTitle", theme.bold(result.agent))}`;
    if (isError && result.stopReason) {
      const reasonColor = result.stopReason === "timeout" ? "warning" : "error";
      header += ` ${theme.fg(reasonColor, `[${result.stopReason}]`)}`;
    }
    container.addChild(new Text(header, 0, 0));
    if (isError && result.errorMessage) {
      const messageColor = result.stopReason === "timeout" ? "warning" : "error";
      container.addChild(new Text(theme.fg(messageColor, `Error: ${result.errorMessage}`), 0, 0));
    }
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
    container.addChild(new Text(theme.fg("dim", result.task), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
    if (displayItems.length === 0 && !finalOutput) {
      container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
    } else {
      for (const item of displayItems) {
        if (item.type === "toolCall") {
          container.addChild(
            new Text(
              theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
              0, 0,
            ),
          );
        }
      }
      if (finalOutput) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
      }
    }
    const usageStr = formatUsageStats(result.usage, result.model);
    if (usageStr) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
    }
    if (result.patch) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("success", "🌿 worktree"), 0, 0));
      const patchLines = result.patch.split("\n").length;
      container.addChild(new Text(theme.fg("dim", `${patchLines} diff lines — merge explicitly via apply_patch/cherry-pick`), 0, 0));
      if (result.patch !== "(no changes)") {
        container.addChild(new Text(theme.fg("muted", result.patch.slice(0, 2000)), 0, 0));
      }
    }
    return container;
  }

  // Collapsed — compact: icon + agent, answer preview, usage, hint.
  // No tool-call trace here (Claude Code / pi-task style) — the trace lives
  // in Ctrl+O (expanded) and /agent (thread viewer).
  let text = `${icon} ${theme.fg(agentColor ?? "toolTitle", theme.bold(result.agent))}`;
  if (isError && result.stopReason) {
    const reasonColor = result.stopReason === "timeout" ? "warning" : "error";
    text += ` ${theme.fg(reasonColor, `[${result.stopReason}]`)}`;
  }
  if (isError && result.errorMessage) {
    const messageColor = result.stopReason === "timeout" ? "warning" : "error";
    text += `\n${theme.fg(messageColor, `Error: ${result.errorMessage}`)}`;
  }
  // Success preview: first prose line of the final answer, skipping markdown
  // structural lines (fences + interior, headings, bullets, tables). Error
  // results show their message once on the Error: line; never echo under ⎿.
  const rawOutput = getFinalOutput(result.messages);
  if (!isError) {
    const prose = firstProseLine(rawOutput);
    if (prose) {
      const preview = prose.length > 200 ? `${prose.slice(0, 197)}...` : prose;
      text += `\n${theme.fg("dim", `⎿ ${preview}`)}`;
    } else if (rawOutput.trim() === "" && displayItems.length === 0) {
      text += `\n${theme.fg("muted", "(no output)")}`;
    } else if (rawOutput.trim() !== "") {
      // All-structural output (headings/bullets/fences only) — still say so.
      text += `\n${theme.fg("dim", "⎿ (markdown answer — Ctrl+O to view)")}`;
    }
  } else if (!result.errorMessage && rawOutput.trim() === "" && !result.stderr) {
    // Error with no message, no stderr, no assistant output — say so.
    // (When errorMessage IS set, the Error: line above already conveys it.)
    text += `\n${theme.fg("muted", "(no output)")}`;
  }
  const usageStr = formatUsageStats(result.usage, result.model, { toolCount, durationMs: result.durationMs });
  if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
  if (result.patch) text += `\n${theme.fg("success", "🌿 worktree")} (${result.patch.split("\n").length} diff lines)`;
  // Hint: getResultOutput always returns at least "(no output)", so finalOutput
  // is always truthy — show the hint whenever there's any trace to expand.
  if (displayItems.length > 0 || (finalOutput && finalOutput !== "(no output)") || result.messages.length > 0) {
    text += `\n${theme.fg("muted", "(Ctrl+O to expand · /agent for full thread)")}`;
  }
  return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Aggregate helpers
// ---------------------------------------------------------------------------

export function aggregateUsage(results: SubAgentResult[]) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.turns += r.usage.turns;
  }
  return total;
}
