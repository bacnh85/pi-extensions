/**
 * Sender-side persistent outbound queue with retry (opt-in: `queue.enabled`).
 *
 * Every queued message is written to `<piDir>/a2a_queue/<messageId>.json`
 * BEFORE the first HTTP attempt (atomic tmp+rename, mode 0600), removed on
 * success, and re-attempted with exponential backoff + jitter when delivery
 * failed in a way that means "receiver down / transient". A background drain
 * (started by index.ts at session start) resumes pending entries, so messages
 * queued while a peer was down are delivered later and survive sender restarts.
 *
 * Guarantees (and non-guarantees):
 *  - At-least-once delivery attempts. The messageId is stable across retries;
 *    a receiver running pi-a2a dedupes on (caller identity, messageId)
 *    (`server.dedupeTtlSec`), so a retry after an ambiguous timeout does not
 *    create a second task. Receivers that do not dedupe may see duplicates.
 *  - Only the REDACTED message text is persisted (same redaction as the wire).
 *    Credentials are never written: the peer is re-resolved by label from the
 *    live config at every attempt.
 *  - Retry classes: ECONNREFUSED / EHOSTUNREACH / ENETUNREACH / ETIMEDOUT /
 *    ECONNRESET / EAI_AGAIN / reply timeout / HTTP 5xx / HTTP 429 (honoring
 *    Retry-After). NOT retried: 4xx (400/401/403/404 …), JSON-RPC errors on a
 *    2xx, SSRF/URL refusals, unknown connection errors.
 *  - Bounded: `maxSize` pending entries (when full, a NEW message is sent
 *    once without queueing — never evicting an accepted one), `ttlSec` per
 *    entry (expired entries are deleted, logged, and surfaced in status),
 *    optional `maxAttempts`.
 *
 * This module has no dependency on the HTTP client: delivery is injected.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config + types
// ---------------------------------------------------------------------------

export interface QueueConfig {
  /** Master switch. false (default) = exact pre-queue behavior. */
  enabled: boolean;
  /** Max pending entries on disk. When full a new message is NOT queued. */
  maxSize: number;
  /** Max age of a pending entry in seconds; older entries are dropped. */
  ttlSec: number;
  /** First retry delay (ms); doubles per failed attempt. */
  baseDelayMs: number;
  /** Cap on the backoff delay (ms). */
  maxDelayMs: number;
  /** Max TOTAL attempts (first try included). 0 = limited by ttlSec only. */
  maxAttempts: number;
}

export const QUEUE_DEFAULTS: QueueConfig = {
  enabled: false,
  maxSize: 100,
  ttlSec: 3600,
  baseDelayMs: 2000,
  maxDelayMs: 300_000,
  maxAttempts: 0,
};

export interface QueueEntry {
  v: 1;
  /** Stable A2A Message.messageId — reused verbatim on every retry. */
  messageId: string;
  /** Peer label as the caller gave it (name or URL); re-resolved per attempt. */
  agent: string;
  /** Already-redacted outbound text. */
  message: string;
  contextId: string;
  asyncDispatch: boolean;
  sessionId?: string;
  createdAt: number;
  /** Delivery attempts started so far. */
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

/** Error carrying the facts the retry policy needs. `message` text is the
 *  same text the pre-queue client threw. */
export class A2ASendError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly code?: string;
  constructor(
    message: string,
    info: { retryable?: boolean; status?: number; retryAfterMs?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "A2ASendError";
    this.retryable = info.retryable === true;
    this.status = info.status;
    this.retryAfterMs = info.retryAfterMs;
    this.code = info.code;
  }
}

/** Connection-level error codes that mean "receiver down or network blip". */
const RETRYABLE_NET_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Pull a Node/undici error code out of a fetch failure (code may sit on the
 *  error, its `cause`, or an AggregateError's members — happy-eyeballs). */
export function networkErrorCode(e: any): string | undefined {
  const seen = new Set<any>();
  const stack = [e];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (typeof cur.code === "string" && RETRYABLE_NET_CODES.has(cur.code)) return cur.code;
    if (cur.cause) stack.push(cur.cause);
    if (Array.isArray(cur.errors)) stack.push(...cur.errors);
  }
  return undefined;
}

/** HTTP statuses worth retrying: 429 and every 5xx. 4xx is never retried. */
export function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || (typeof status === "number" && status >= 500 && status <= 599);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) to ms. */
export function parseRetryAfterMs(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}

export function isRetryableError(e: unknown): boolean {
  return e instanceof A2ASendError && e.retryable;
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/**
 * Delay before the next attempt, after `failedAttempts` (>= 1) failures:
 * base * 2^(n-1), capped at maxDelayMs, with -20%..0% jitter (so the cap is a
 * hard ceiling). A server Retry-After wins when larger, but never beyond the
 * entry TTL horizon (`ttlSec`).
 */
export function backoffDelayMs(
  failedAttempts: number,
  q: QueueConfig,
  opts: { retryAfterMs?: number; random?: () => number } = {},
): number {
  const rnd = opts.random ?? Math.random;
  const exp = q.baseDelayMs * 2 ** Math.min(Math.max(failedAttempts - 1, 0), 30);
  const capped = Math.min(q.maxDelayMs, exp);
  const delay = Math.round(capped * (0.8 + 0.2 * rnd()));
  const ra = opts.retryAfterMs;
  if (ra !== undefined && ra > delay) return Math.min(ra, q.ttlSec * 1000);
  return delay;
}

// ---------------------------------------------------------------------------
// Disk storage (style: lib/persistence.ts — sync fs, best-effort)
// ---------------------------------------------------------------------------

export function queueDir(piDir: string): string {
  return join(piDir, "a2a_queue");
}

function entryPath(piDir: string, messageId: string): string {
  const safe = messageId.replace(/[^A-Za-z0-9_-]/g, "");
  return join(queueDir(piDir), `${safe || "msg-unknown"}.json`);
}

/** Atomic write: temp file + rename (a crash never leaves a torn entry). */
export function writeEntry(piDir: string, e: QueueEntry): boolean {
  try {
    const dir = queueDir(piDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = entryPath(piDir, e.messageId);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(e), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

export function removeEntry(piDir: string, messageId: string): void {
  try {
    rmSync(entryPath(piDir, messageId), { force: true });
  } catch {
    /* best-effort */
  }
}

function isEntry(x: any): x is QueueEntry {
  return (
    x &&
    typeof x === "object" &&
    typeof x.messageId === "string" &&
    typeof x.agent === "string" &&
    typeof x.message === "string" &&
    typeof x.contextId === "string" &&
    Number.isFinite(x.createdAt) &&
    Number.isFinite(x.attempts) &&
    Number.isFinite(x.nextAttemptAt)
  );
}

/** Pending entries, oldest first. Corrupt files are quarantined (`.corrupt`)
 *  so one bad file cannot wedge the drain; stale `.tmp` files are ignored. */
export function loadQueue(piDir: string): QueueEntry[] {
  const dir = queueDir(piDir);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: QueueEntry[] = [];
  for (const f of files) {
    const p = join(dir, f);
    try {
      const j = JSON.parse(readFileSync(p, "utf-8"));
      if (isEntry(j)) out.push(j);
      else renameSync(p, p + ".corrupt");
    } catch {
      try {
        renameSync(p, p + ".corrupt");
      } catch {
        /* racing delete */
      }
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId));
}

/** True when at least one pending entry exists (cheap: one readdir). */
export function hasPending(piDir: string): boolean {
  try {
    return readdirSync(queueDir(piDir)).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Drop log (expired / exhausted / rejected) — surfaced by queueStatus()
// ---------------------------------------------------------------------------

const DROP_LOG = "dropped.jsonl";
const DROP_LOG_MAX_BYTES = 256 * 1024;

export interface DropRecord {
  ts: string;
  messageId: string;
  agent: string;
  reason: "expired" | "exhausted" | "rejected";
  attempts: number;
  detail?: string;
}

/** Record a dropped entry. Never stores message text. Rotates at 256 KB. */
export function recordDrop(piDir: string, e: QueueEntry, reason: DropRecord["reason"], detail?: string): void {
  const line = `[a2a-queue] dropped ${e.messageId} → ${e.agent}: ${reason}${detail ? ` (${detail})` : ""} after ${e.attempts} attempt(s)`;
  console.warn(line);
  try {
    const dir = queueDir(piDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = join(dir, DROP_LOG);
    try {
      if (statSync(p).size > DROP_LOG_MAX_BYTES) renameSync(p, p + ".1");
    } catch {
      /* no log yet */
    }
    const rec: DropRecord = {
      ts: new Date().toISOString(),
      messageId: e.messageId,
      agent: e.agent,
      reason,
      attempts: e.attempts,
      detail: detail?.slice(0, 300),
    };
    appendFileSync(p, JSON.stringify(rec) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

export function recentDrops(piDir: string, limit = 5): DropRecord[] {
  try {
    const lines = readFileSync(join(queueDir(piDir), DROP_LOG), "utf-8").split("\n").filter(Boolean);
    const recs: DropRecord[] = [];
    for (const l of lines.slice(-limit)) {
      try {
        recs.push(JSON.parse(l));
      } catch {
        /* skip torn line */
      }
    }
    return recs;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export function isExpired(e: QueueEntry, q: QueueConfig, now: number): boolean {
  return q.ttlSec > 0 && now - e.createdAt > q.ttlSec * 1000;
}

/** Persist a new entry. `full` = at maxSize (after sweeping expired ones);
 *  `io` = the disk write failed. In both cases the caller still sends once,
 *  without queueing. */
export function enqueue(
  piDir: string,
  e: QueueEntry,
  q: QueueConfig,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: "full" | "io" } {
  let pending = loadQueue(piDir);
  for (const old of pending) {
    if (isExpired(old, q, now)) {
      removeEntry(piDir, old.messageId);
      recordDrop(piDir, old, "expired");
    }
  }
  pending = pending.filter((x) => !isExpired(x, q, now));
  if (pending.length >= Math.max(1, q.maxSize)) return { ok: false, reason: "full" };
  return writeEntry(piDir, e) ? { ok: true } : { ok: false, reason: "io" };
}

// ---------------------------------------------------------------------------
// Attempt + drain
// ---------------------------------------------------------------------------

/** Entries with an attempt currently running (inline or drain) — never run
 *  the same message twice concurrently from this process. */
const inFlight = new Set<string>();

export type AttemptOutcome<T> =
  | { kind: "delivered"; value: T }
  | { kind: "retry"; error: unknown; nextAttemptAt: number }
  | { kind: "failed"; error: unknown; reason: "rejected" | "exhausted" };

/**
 * One delivery attempt for an entry that is ALREADY on disk (see `enqueue`:
 * persist-before-send). On success the file is removed; on a retryable failure
 * the attempt count, last error and next due time are rewritten atomically; on
 * a permanent failure (or attempts exhausted) the file is removed and `failed`
 * is returned (the caller decides whether that is a thrown error or a logged
 * drop). A crash mid-send leaves the file, so the next start retries it with
 * the same messageId.
 */
export async function attemptEntry<T>(opts: {
  piDir: string;
  entry: QueueEntry;
  q: QueueConfig;
  deliver: (entry: QueueEntry) => Promise<T>;
  now?: () => number;
  random?: () => number;
}): Promise<AttemptOutcome<T>> {
  const { piDir, entry, q } = opts;
  const now = opts.now ?? Date.now;
  inFlight.add(entry.messageId);
  entry.attempts += 1;
  try {
    const value = await opts.deliver(entry);
    removeEntry(piDir, entry.messageId);
    return { kind: "delivered", value };
  } catch (error: any) {
    entry.lastError = String(error?.message ?? error).slice(0, 300);
    if (!isRetryableError(error)) {
      removeEntry(piDir, entry.messageId);
      return { kind: "failed", error, reason: "rejected" };
    }
    if (q.maxAttempts > 0 && entry.attempts >= q.maxAttempts) {
      removeEntry(piDir, entry.messageId);
      return { kind: "failed", error, reason: "exhausted" };
    }
    entry.nextAttemptAt =
      now() + backoffDelayMs(entry.attempts, q, { retryAfterMs: (error as A2ASendError).retryAfterMs, random: opts.random });
    writeEntry(piDir, entry);
    return { kind: "retry", error, nextAttemptAt: entry.nextAttemptAt };
  } finally {
    inFlight.delete(entry.messageId);
  }
}

export type DrainEvent<T = unknown> =
  | { type: "delivered"; entry: QueueEntry; value: T }
  | { type: "retry"; entry: QueueEntry; error: unknown; nextAttemptAt: number }
  | { type: "dropped"; entry: QueueEntry; reason: DropRecord["reason"]; detail?: string };

let draining = false;

/**
 * One drain pass over the persisted queue: drop expired entries, then attempt
 * every due entry. Entries to the SAME peer are processed oldest-first and the
 * pass stops for that peer at its first non-due/failed entry (FIFO per peer,
 * no hammering a down receiver); different peers run concurrently.
 */
export async function drainDue<T>(opts: {
  piDir: string;
  q: QueueConfig;
  deliver: (entry: QueueEntry) => Promise<T>;
  onEvent?: (ev: DrainEvent<T>) => void;
  now?: () => number;
  random?: () => number;
}): Promise<{ delivered: number; retried: number; dropped: number }> {
  const stats = { delivered: 0, retried: 0, dropped: 0 };
  if (draining) return stats;
  draining = true;
  try {
    const now = opts.now ?? Date.now;
    const byAgent = new Map<string, QueueEntry[]>();
    for (const e of loadQueue(opts.piDir)) {
      if (isExpired(e, opts.q, now())) {
        removeEntry(opts.piDir, e.messageId);
        recordDrop(opts.piDir, e, "expired");
        stats.dropped += 1;
        opts.onEvent?.({ type: "dropped", entry: e, reason: "expired" });
        continue;
      }
      const g = byAgent.get(e.agent) ?? [];
      g.push(e);
      byAgent.set(e.agent, g);
    }
    await Promise.all(
      [...byAgent.values()].map(async (group) => {
        for (const e of group) {
          if (inFlight.has(e.messageId) || e.nextAttemptAt > now()) break;
          const out = await attemptEntry({ ...opts, entry: e });
          if (out.kind === "delivered") {
            stats.delivered += 1;
            opts.onEvent?.({ type: "delivered", entry: e, value: out.value });
            continue;
          }
          if (out.kind === "retry") {
            stats.retried += 1;
            opts.onEvent?.({ type: "retry", entry: e, error: out.error, nextAttemptAt: out.nextAttemptAt });
            break;
          }
          stats.dropped += 1;
          const detail = String((out.error as any)?.message ?? out.error);
          recordDrop(opts.piDir, e, out.reason, detail);
          opts.onEvent?.({ type: "dropped", entry: e, reason: out.reason, detail });
        }
      }),
    );
  } finally {
    draining = false;
  }
  return stats;
}

/** Start the periodic background drain. The first tick runs immediately (that
 *  is the "resume at extension start" path). Timer is unref'd. Returns stop(). */
export function startDrainLoop(opts: { tick: () => Promise<void>; intervalMs?: number }): () => void {
  let stopped = false;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await opts.tick();
    } catch {
      /* a tick failure must never kill the loop */
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), 0);
  const t = setInterval(() => void run(), opts.intervalMs ?? 5000);
  first.unref?.();
  t.unref?.();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(t);
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function queueStatus(piDir: string, q: QueueConfig, now: number = Date.now()): string[] {
  const pending = loadQueue(piDir);
  const drops = recentDrops(piDir);
  if (!q.enabled && pending.length === 0 && drops.length === 0) return [];
  const lines: string[] = [];
  lines.push(
    `Outbound queue: ${q.enabled ? "enabled" : "DISABLED (entries kept on disk, not retried)"} — ` +
      `${pending.length}/${q.maxSize} pending, ttl ${q.ttlSec}s, retry ${q.baseDelayMs}ms→${q.maxDelayMs}ms` +
      `${q.maxAttempts > 0 ? `, max ${q.maxAttempts} attempts` : ""}`,
  );
  for (const e of pending.slice(0, 10)) {
    const due = e.nextAttemptAt - now;
    lines.push(
      `  - ${e.messageId} → ${e.agent}: attempt ${e.attempts}, age ${Math.round((now - e.createdAt) / 1000)}s, ` +
        `${due > 0 ? `next in ${Math.ceil(due / 1000)}s` : "due now"}${e.lastError ? `, last error: ${e.lastError}` : ""}`,
    );
  }
  if (pending.length > 10) lines.push(`  … +${pending.length - 10} more`);
  if (drops.length > 0) {
    lines.push(`Recently dropped (${drops.length}, newest last):`);
    for (const d of drops) {
      lines.push(`  - ${d.ts} ${d.messageId} → ${d.agent}: ${d.reason} after ${d.attempts} attempt(s)${d.detail ? ` (${d.detail})` : ""}`);
    }
  }
  return lines;
}
