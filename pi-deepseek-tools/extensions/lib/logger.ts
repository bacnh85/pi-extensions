/**
 * logger.ts — stderr logging for pi-deepseek-tools
 *
 * Two levels: warn (always) and debug (PI_DEEPSEEK_TOOLS_DEBUG=1).
 * JSON format via PI_DEEPSEEK_TOOLS_LOG_FORMAT=json.
 *
 * ponytail: binary toggle. No info/trace levels — nobody reads them.
 */

declare const process: { env: Record<string, string | undefined>; stderr: { write: (msg: string) => boolean } };

type LogLevel = "warn" | "debug";

const PREFIX: Record<string, string> = {
	warn: "[deepseek-tools:warn]",
	debug: "[deepseek-tools:debug]",
};

let _debugCached: boolean | undefined;
let _formatCached: "plain" | "json" | undefined;

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
		// ignore write errors
	}
}

/** Always emitted: warning message. */
export function logWarn(...args: unknown[]): void {
	emit("warn", args);
}

/** Emitted only when PI_DEEPSEEK_TOOLS_DEBUG=1. */
export function debugLog(...args: unknown[]): void {
	if (!isDebugEnabled()) return;
	emit("debug", args);
}
