/**
 * logger.ts — level-aware logging for pi-deepseek-tools
 *
 * Levels: warn (always), debug (PI_DEEPSEEK_TOOLS_DEBUG).
 * Logs go to stderr.
 *
 * When PI_DEEPSEEK_TOOLS_LOG_FORMAT=json, each log line is a structured
 * JSON object for programmatic consumption.
 */

declare const process: { env: Record<string, string | undefined>; stderr: { write: (msg: string) => boolean } };

type LogLevel = "warn" | "debug";

const PREFIX: Record<string, string> = {
	warn: "[deepseek-tools:warn]",
	debug: "[deepseek-tools:debug]",
};

// Cache for env-var lookups.
let _debugCached: boolean | undefined;
let _formatCached: "plain" | "json" | undefined;

/** Check whether debug logging is enabled. */
export function isDebugEnabled(): boolean {
	if (_debugCached === undefined) {
		_debugCached = /^(1|true|yes|on)$/i.test(process.env.PI_DEEPSEEK_TOOLS_DEBUG ?? "");
	}
	return _debugCached;
}

function logFormat(): "plain" | "json" {
	if (_formatCached === undefined) {
		_formatCached = process.env.PI_DEEPSEEK_TOOLS_LOG_FORMAT === "json" ? "json" : "plain";
	}
	return _formatCached;
}

function emit(level: LogLevel, args: unknown[]): void {
	const timestamp = new Date().toISOString();
	const parts = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 0)));

	const line = logFormat() === "json"
		? JSON.stringify({ timestamp, level, message: parts.join(" ") })
		: `${PREFIX[level]} ${parts.join(" ")}`;

	try {
		process.stderr.write(line + "\n");
	} catch {
		// ignore write errors (e.g., stderr closed in tests)
	}
}

/** Always emitted: warning message. */
export function logWarn(...args: unknown[]): void {
	emit("warn", args);
}

/**
 * Emit a debug log line if debug logging is enabled.
 * Accepts strings and objects (JSON.stringify for the latter).
 */
export function debugLog(...args: unknown[]): void {
	if (!isDebugEnabled()) return;
	emit("debug", args);
}
