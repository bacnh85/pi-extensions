/**
 * Task history registry — durable metadata for listing and re-run.
 *
 * Persists completed task metadata under .pi/subagent-history.json so the user
 * can review past delegations via `/subagent history`. This is metadata ONLY:
 * in-process SDK cannot resume a live session, so we never advertise "resume".
 *
 * On session start, any `running` entries from a prior session (crash/restart)
 * are marked `interrupted` — honest about the architectural ceiling.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HistoryStatus = "completed" | "failed" | "aborted" | "timeout" | "interrupted" | "running";

export interface HistoryEntry {
  id: string;
  agent: string;
  task: string;
  status: HistoryStatus;
  startedAt: number;
  completedAt?: number;
  summary?: string;
  cwd?: string;
  background?: boolean;
  model?: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const HISTORY_FILE = "subagent-history.json";

/** Maximum history entries kept on disk. */
export const MAX_HISTORY_ENTRIES = 200;

export function getHistoryPath(piDir: string): string {
  return join(piDir, HISTORY_FILE);
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

function readJsonArray(file: string): HistoryEntry[] {
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function readHistory(piDir: string): HistoryEntry[] {
  return readJsonArray(getHistoryPath(piDir));
}

export function appendHistory(piDir: string, entry: HistoryEntry): void {
  const file = getHistoryPath(piDir);
  const entries = readJsonArray(file);
  // Upsert by id — if the id exists, replace it.
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  writeHistory(piDir, entries);
  // ponytail: bound the file inline — every append trims, so the file can
  // never grow unbounded no matter which caller forgets to trim.
  trimHistory(piDir, MAX_HISTORY_ENTRIES);
}

export function writeHistory(piDir: string, entries: HistoryEntry[]): void {
  const file = getHistoryPath(piDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
}

export function findHistory(piDir: string, id: string): HistoryEntry | undefined {
  return readHistory(piDir).find((e) => e.id === id);
}

/**
 * On session start, mark any `running` entries from a prior session as
 * `interrupted`. We cannot resume them (in-process SDK sessions don't survive
 * a restart). Honest about the architectural ceiling.
 */
export function markInterruptedOnRestart(piDir: string): number {
  const entries = readHistory(piDir);
  let changed = 0;
  for (const e of entries) {
    if (e.status === "running") {
      e.status = "interrupted";
      changed++;
    }
  }
  if (changed > 0) writeHistory(piDir, entries);
  return changed;
}

/**
 * Keep the history file bounded — trim to the most recent N entries by
 * completedAt (or startedAt as fallback). Returns the new length.
 */
export function trimHistory(piDir: string, maxEntries = 200): number {
  const entries = readHistory(piDir);
  if (entries.length <= maxEntries) return entries.length;
  entries.sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt));
  const trimmed = entries.slice(0, maxEntries);
  writeHistory(piDir, trimmed);
  return trimmed.length;
}
