import { spawnSync } from "node:child_process";

/** Cross-platform busy-wait (avoids child_process sleep dependency). */
function sleepSync(ms: number) {
	const start = Date.now();
	while (Date.now() - start < ms) { /* busy-wait */ }
}

/**
 * Run obsidian CLI with the given arguments.
 * Retries transient IPC failures ("not running") up to 2 times.
 * Returns stdout and parsed JSON (if stdout is valid JSON).
 */
export function execObsidian(args: string[], formatJson = false, timeoutMs = 30_000): { stdout: string; parsed: unknown } {
	const allArgs = formatJson ? [...args, "format=json"] : args;
	const maxRetries = 2;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const result = spawnSync("obsidian", allArgs, {
			encoding: "utf8",
			timeout: timeoutMs,
			windowsHide: true,
		});

		const stdout = result.stdout ?? "";
		const stderr = result.stderr ?? "";
		const exitCode = result.status ?? 1;

		if ((result.error as any)?.code === "ENOENT") {
			throw new Error("obsidian CLI not found in PATH. Install Obsidian 1.12+ and enable CLI in Settings → General.");
		}

		if (exitCode === 0) {
			let parsed: unknown = stdout;
			try { parsed = JSON.parse(stdout); } catch { /* not JSON, keep raw */ }
			return { stdout, parsed };
		}

		// Retry transient IPC failures (multiple Obsidian instances, race)
		if (/not running|unable to find/i.test(stderr) && attempt < maxRetries) {
			sleepSync(500);
			continue;
		}

		// Non-retryable error — include full context for debugging
		throw new Error(
			`obsidian command failed (exit ${exitCode})\n` +
			`  Cmd: obsidian ${allArgs.join(" ")}\n` +
			`  Stderr: ${(stderr || "(empty)").slice(0, 800)}\n` +
			`  Stdout: ${(stdout || "(empty)").slice(0, 400)}`
		);
	}

	throw new Error(`obsidian command still failing after ${maxRetries} retries. All args: ${allArgs.join(" ")}`);
}

/**
 * Build args array from command + key=value params + flags.
 * Splits the command by space so "tags all" becomes ["tags", "all"].
 *
 * Skips boolean params that overlap with flags (e.g. `overwrite: true`
 * in params AND `"overwrite"` in flags) to avoid duplicate CLI arguments.
 * Also skips known internal keys (`vault`, `timeout_ms`) that are
 * handled separately by the `run`/`runJson` wrappers.
 */
export function buildArgs(command: string, params: Record<string, unknown>, flags: string[] = []): string[] {
	const cmdParts = command.split(/\s+/).filter(Boolean);
	const flagSet = new Set(flags);
	const kv = Object.entries(params).filter(([k, v]) => {
		if (v === undefined || v === false) return false;
		// Skip control params handled externally
		if (k === "vault" || k === "timeout_ms") return false;
		// Skip boolean params that are already in flags (avoid duplicates)
		if (v === true && flagSet.has(k)) return false;
		return true;
	});
	const paramParts = kv.map(([k, v]) => v === true ? k : `${k}=${v}`);
	return [...cmdParts, ...paramParts, ...flags];
}
