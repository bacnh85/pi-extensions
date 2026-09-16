/**
 * A2A conversation persistence — every outbound exchange is written to
 * <piDir>/a2a_conversations/<context>.jsonl so multi-turn conversations
 * survive compaction/restarts (recallable via a2a_history).
 *
 * Pattern: append-only JSONL, one record per message. No schema migrations.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

interface PersistedMessage {
  ts: string;
  role: "user" | "agent";
  text: string;
  taskId?: string;
  peer?: string;
}

function dir(piDir: string): string {
  return join(piDir, "a2a_conversations");
}

function fileFor(piDir: string, contextId: string): string {
  // Sanitise: only allow context- prefix + hex/alphanum.
  const safe = contextId.replace(/[^A-Za-z0-9_-]/g, "");
  return join(dir(piDir), `${safe || "ctx-unknown"}.jsonl`);
}

export function persistMessage(opts: {
  piDir: string;
  contextId: string;
  role: "user" | "agent";
  text: string;
  taskId?: string;
  peer?: string;
}): void {
  try {
    const rec: PersistedMessage = {
      ts: new Date().toISOString(),
      role: opts.role,
      text: opts.text,
      taskId: opts.taskId,
      peer: opts.peer,
    };
    const p = fileFor(opts.piDir, opts.contextId);
    mkdirSync(dir(opts.piDir), { recursive: true });
    appendFileSync(p, JSON.stringify(rec) + "\n", { encoding: "utf-8" });
  } catch {
    /* best-effort persistence */
  }
}

export function loadConversation(piDir: string, contextId: string, limit = 50): PersistedMessage[] {
  const p = fileFor(piDir, contextId);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
    const recs = lines
      .map((l) => {
        try {
          return JSON.parse(l) as PersistedMessage;
        } catch {
          return null;
        }
      })
      .filter((x): x is PersistedMessage => x !== null);
    return recs.slice(-limit);
  } catch {
    return [];
  }
}

export function listConversations(piDir: string): string[] {
  const d = dir(piDir);
  if (!existsSync(d)) return [];
  try {
    return readdirSync(d)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""))
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Child-session transcripts (fleet task #252)
// ---------------------------------------------------------------------------

/** Directory holding dispatched child-session transcripts, one JSONL pi
 *  session per inbound task, named <timestamp>_<taskId>.jsonl. */
export function childTranscriptDir(piDir: string): string {
  return join(piDir, "a2a_sessions");
}

/** Delete child transcripts older than `retentionDays` (by mtime). 0 or
 *  negative = keep forever. Returns the number of files removed. Never
 *  throws — retention is housekeeping, not a dependency. */
export function sweepChildTranscripts(dir: string, retentionDays: number): number {
  if (!(retentionDays > 0)) return 0;
  let removed = 0;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return 0; // no dir yet (or unreadable) — nothing to sweep
  }
  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(dir, f);
    try {
      if (statSync(p).mtimeMs < cutoff) {
        rmSync(p);
        removed += 1;
      }
    } catch {
      /* racing deletion or unreadable file — skip */
    }
  }
  return removed;
}
