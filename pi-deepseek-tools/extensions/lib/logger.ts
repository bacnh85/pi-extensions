/**
 * logger.ts — conditional stderr debug logging for pi-deepseek-tools
 *
 * Controlled by PI_DEEPSEEK_TOOLS_DEBUG=1 in the environment.
 * Logs go to stderr so they never interfere with tool outputs or JSON-mode sessions.
 */

declare const process: { env: Record<string, string | undefined>; stderr: { write: (msg: string) => boolean } };

let _cached: boolean | undefined;

/**
 * Check whether debug logging is enabled.
 * Caches after first call to avoid repeated env-var reads.
 */
export function isDebugEnabled(env: Record<string, string | undefined> = process.env): boolean {
	if (_cached === undefined) {
		_cached = /^(1|true|yes|on)$/i.test(env.PI_DEEPSEEK_TOOLS_DEBUG ?? "");
	}
	return _cached;
}

/** Reset cached value (useful for tests). */
export function _resetDebugCache(): void {
	_cached = undefined;
}

/**
 * Emit a debug log line if PI_DEEPSEEK_TOOLS_DEBUG is enabled.
 * Accepts strings and objects (JSON.stringify for the latter).
 */
export function debugLog(...args: unknown[]): void {
	if (!isDebugEnabled()) return;
	const parts = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a)));
	process.stderr.write(`[deepseek-tools] ${parts.join(" ")}\n`);
}
