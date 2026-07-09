export interface AuditEntry {
  timestamp: string;
  shell: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
}

const log: AuditEntry[] = [];
const MAX = 500;

export function record(e: AuditEntry): void {
  log.push(e);
  if (log.length > MAX) log.shift();
}

export function entries(): readonly AuditEntry[] { return log; }
export function clear(): void { log.length = 0; }

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "\u2026";
}

export function format(items?: readonly AuditEntry[]): string {
  const list = items ?? log;
  if (list.length === 0) return "No commands executed yet.";
  return list.map((e, i) => {
    const flags = [e.timedOut && "TIMED OUT", e.cancelled && "CANCELLED"].filter(Boolean);
    const tag = flags.length ? " [" + flags.join(", ") + "]" : "";
    return "[" + (i + 1) + "] " + e.timestamp + "  " + e.shell + "  exit:" + e.exitCode + tag + "\n    cmd: " + truncate(e.command, 300) + "\n    cwd: " + e.cwd;
  }).join("\n\n");
}
