/**
 * logger.ts — stderr logging for pi-model-tools.
 * Two levels: warn (always) and debug (PI_MODEL_TOOLS_DEBUG=1).
 */

declare const process: { env: Record<string, string | undefined>; stderr: { write: (msg: string) => boolean } };

type LogLevel = "warn" | "debug";

const PREFIX: Record<string, string> = {
  warn: "[model-tools:warn]",
  debug: "[model-tools:debug]",
};

let _debugCached: boolean | undefined;
let _formatCached: "plain" | "json" | undefined;

export function isDebugEnabled(): boolean {
  if (_debugCached === undefined) {
    _debugCached = /^(1|true|yes|on)$/i.test(process.env.PI_MODEL_TOOLS_DEBUG ?? "");
  }
  return _debugCached;
}

function logFormat(): "plain" | "json" {
  if (_formatCached === undefined) {
    _formatCached = process.env.PI_MODEL_TOOLS_LOG_FORMAT === "json" ? "json" : "plain";
  }
  return _formatCached;
}

function emit(level: LogLevel, args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const parts = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 0)));
  const line = logFormat() === "json"
    ? JSON.stringify({ timestamp, level, message: parts.join(" ") })
    : `${PREFIX[level]} ${parts.join(" ")}`;
  try { process.stderr.write(line + "\n"); } catch { /* ignore */ }
}

export function logWarn(...args: unknown[]): void { emit("warn", args); }
export function debugLog(...args: unknown[]): void { if (!isDebugEnabled()) return; emit("debug", args); }
