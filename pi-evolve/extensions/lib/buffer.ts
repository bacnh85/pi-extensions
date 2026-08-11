// Trajectory buffer — in-memory ring of recent tool calls + outcomes.
// ponytail: in-memory only, capped; sealed snapshots are short-lived. Never
// persists raw input — inputDigest is truncated + redacted before reaching here.

export interface TrajectoryEntry {
  ts: number;
  tool: string;
  toolCallId?: string;
  inputDigest: string;
  status?: "ok" | "error";
  errorCategory?: string;
  usage?: { input?: number; output?: number };
}

export class TrajectoryBuffer {
  private entries: TrajectoryEntry[] = [];
  private readonly cap: number;

  constructor(cap = 200) {
    this.cap = cap;
  }

  /** Record a tool call. Returns the entry so callers can attach results. */
  record(tool: string, inputDigest: string, toolCallId?: string): TrajectoryEntry {
    const entry: TrajectoryEntry = { ts: Date.now(), tool, inputDigest };
    if (toolCallId) entry.toolCallId = toolCallId;
    this.entries.push(entry);
    if (this.entries.length > this.cap) this.entries.shift();
    return entry;
  }

  /** Mark the matching entry: prefer toolCallId, fall back to most-recent unmatched tool name. */
  markResult(tool: string, isError: boolean, errorCategory?: string, toolCallId?: string): void {
    // Match by toolCallId first — correct for parallel calls to the same tool.
    if (toolCallId) {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const e = this.entries[i];
        if (e.toolCallId === toolCallId && e.status === undefined) {
          e.status = isError ? "error" : "ok";
          if (errorCategory) e.errorCategory = errorCategory;
          return;
        }
      }
    }
    // Fallback: most recent unmatched entry for this tool name.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.tool === tool && e.status === undefined) {
        e.status = isError ? "error" : "ok";
        if (errorCategory) e.errorCategory = errorCategory;
        return;
      }
    }
  }

  /** Attach usage to the most recent entry. */
  recordUsage(usage: { input?: number; output?: number }): void {
    const last = this.entries[this.entries.length - 1];
    if (last) last.usage = usage;
  }

  /** Freeze and return a copy for the reflect tool. Does not clear. */
  snapshot(): TrajectoryEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get size(): number {
    return this.entries.length;
  }

  /** Count entries with status error. */
  get errorCount(): number {
    return this.entries.filter((e) => e.status === "error").length;
  }

  clear(): void {
    this.entries = [];
  }
}

// Known secret key names — matched as JSON/YAML/header keys (with a following
// quote + delimiter), NOT as bare prose substrings, to avoid false positives.
const SECRET_KEY_RE = /("(?:api[_-]?key|token|password|passwd|secret|credential[s]?|authorization)"\s*[:=]\s*"|"?(?:api[_-]?key|token|password|passwd|secret|credential[s]?)\s*[:=]\s*"?)/gi;

/** Truncate + redact a tool input object into a ≤maxLen char digest string.
 *  Strips common secret patterns before stringifying. Never preserves raw values. */
export function digestInput(input: unknown, maxLen = 200): string {
  if (input === null || input === undefined) return "";
  let text: string;
  try {
    text = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    // ponytail: circular refs throw on stringify — return a safe placeholder.
    return "(unserializable input)";
  }
  // Redact key=value style secrets (JSON, header, or CLI/export style). Group 1 captures
  // the key + delimiter + opening quote; we replace the VALUE that follows. The unquoted
  // alternation catches `export API_KEY=sk-...` / `password: secret` without matching prose.
  text = text.replace(
    /("(?:api[_-]?key|token|password|passwd|secret|credential[s]?|authorization)"\s*[:=]\s*)([^"]*"[^"]*"|'[^']*'|[^\s,}&]+)|(\b(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*)([^\s,}"']+)(?=\s|$|[,}"'])|(Bearer\s+)[A-Za-z0-9._\-+=]+/gi,
    (_m, g1, _g2, g3, g4, g5) => {
      if (g5) return `${g5}[REDACTED]`;
      if (g3 !== undefined) return `${g3}[REDACTED]`;
      return `${g1}[REDACTED]`;
    },
  );
  if (text.length > maxLen) {
    let s = text.slice(0, maxLen);
    // ponytail: don't split a surrogate pair at the boundary.
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
    return s + "…";
  }
  return text;
}

/** Lightweight error categorizer — 6 buckets, no deps. */
export function categorizeError(result: unknown): string | undefined {
  if (!result) return undefined;
  const text = typeof result === "string" ? result.toLowerCase() : JSON.stringify(result).toLowerCase();
  // ponytail: prefix matches without trailing \b — 'ECONNREFUSED' has no boundary after 'econn'.
  if (/timeout|timed out|etimedout|abort/.test(text)) return "timeout";
  if (/econn|enotfound|network|socket|fetch failed|unreachable/.test(text)) return "network";
  if (/unauthorized|invalid api key|forbidden|\b401\b|\b403\b/.test(text)) return "auth";
  if (/not found|\b404\b|enoent/.test(text)) return "not_found";
  if (/validation|invalid|bad request|\b400\b|\b422\b/.test(text)) return "validation";
  if (/parse|syntax|unexpected token/.test(text)) return "parse";
  return "generic";
}

// keep SECRET_KEY_RE referenced for documentation; the inline regex in digestInput
// is the active one. ponytail: extracted list mirrors the inline alternation.
void SECRET_KEY_RE;
