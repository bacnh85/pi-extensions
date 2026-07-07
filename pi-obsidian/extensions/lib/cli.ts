import { spawnSync } from "node:child_process";

/**
 * Run obsidian CLI with the given arguments.
 * Returns stdout and parsed JSON (if stdout is valid JSON).
 */
export function execObsidian(args: string[], formatJson = false, timeoutMs = 30_000): { stdout: string; parsed: unknown } {
	const allArgs = formatJson ? [...args, "format=json"] : args;

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

	if (exitCode !== 0) {
		const msg = /not running/i.test(stderr)
			? "Obsidian is not running. Start the Obsidian desktop app first."
			: `obsidian command failed (exit ${exitCode}): ${stderr || stdout.slice(0, 200)}`;
		throw new Error(msg);
	}

	let parsed: unknown = stdout;
	try { parsed = JSON.parse(stdout); } catch { /* not JSON, keep raw */ }

	return { stdout, parsed };
}

/**
 * Build args array from command + key=value params + flags.
 */
export function buildArgs(command: string, params: Record<string, unknown>, flags: string[] = []): string[] {
	const kv = Object.entries(params).filter(([_, v]) => v !== undefined && v !== false);
	const paramParts = kv.map(([k, v]) => v === true ? k : `${k}=${v}`);
	return [command, ...paramParts, ...flags];
}
