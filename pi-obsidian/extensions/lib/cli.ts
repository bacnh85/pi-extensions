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
		throw new Error(
			`obsidian command failed (exit ${exitCode})\n` +
			`  Cmd: obsidian ${allArgs.join(" ")}\n` +
			`  Stderr: ${(stderr || "(empty)").slice(0, 800)}\n` +
			`  Stdout: ${(stdout || "(empty)").slice(0, 400)}`
		);
	}

	let parsed: unknown = stdout;
	try { parsed = JSON.parse(stdout); } catch { /* not JSON, keep raw */ }
	return { stdout, parsed };
}


