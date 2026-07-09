import { spawn } from "node:child_process";
import type { WindowsShellKind } from "./shell-detect";
import { getDefaultShell, detectShell } from "./shell-detect";

export interface ExecOptions {
	shell?: WindowsShellKind;
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}

export interface ExecResult {
	command: string;
	shell: WindowsShellKind;
	cwd: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	cancelled: boolean;
}

/**
 * Merge custom env with process.env deduplicating case-insensitively.
 * On Windows, "PATH" and "Path" are the same variable — passing both
 * causes duplicate entries. This keeps the custom value when keys
 * differ only in case.
 */
export function mergeEnv(customEnv: Record<string, string>): Record<string, string> {
	const merged: Record<string, string> = {};

	// Build set of lowercase custom keys for O(1) lookup
	const customLower = new Set<string>();
	for (const key of Object.keys(customEnv)) {
		customLower.add(key.toLowerCase());
	}

	// Copy process.env keys, skipping any that match a custom key case-insensitively
	for (const key of Object.keys(process.env)) {
		if (customLower.has(key.toLowerCase())) continue;
		const val = process.env[key];
		if (val !== undefined) {
			merged[key] = val;
		}
	}

	// Add custom keys (they win)
	for (const [key, val] of Object.entries(customEnv)) {
		merged[key] = val;
	}

	return merged;
}

/**
 * Build the arg array for a given shell kind.
 */
export function buildShellArgs(kind: WindowsShellKind, command: string, distro?: string): { exe: string; args: string[] } {
	switch (kind) {
		case "pwsh":
		case "powershell": {
			const info = detectShell(kind);
			return {
				exe: info.executable,
				args: [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy", "Bypass",
					"-Command", command,
				],
			};
		}
		case "cmd": {
			const comspec = process.env.ComSpec || "cmd.exe";
			return {
				exe: comspec,
				args: ["/c", command],
			};
		}
		case "git-bash": {
			const info = detectShell(kind);
			return {
				exe: info.executable,
				args: ["-lc", command],
			};
		}
		case "wsl": {
			const distroFlag = distro ? ["-d", distro] : [];
			return {
				exe: "wsl.exe",
				args: [...distroFlag, "--", "bash", "-lc", command],
			};
		}
	}
}

/**
 * Execute a command through the specified Windows shell.
 * Returns stdout, stderr, exit code, and cancellation/timeout info.
 */
export function executeCommand(command: string, options: ExecOptions = {}): Promise<ExecResult> {
	const shellKind = options.shell || getDefaultShell().kind;
	const cwd = options.cwd || process.cwd();
	const env = options.env || {};

	// Use WSL_DISTRO from env or config if user set it
	const distro = process.env.PI_WSL_DISTRO || undefined;
	const { exe, args } = buildShellArgs(shellKind, command, distro);

	return new Promise((resolve) => {
		const child = spawn(exe, args, {
			cwd,
			env: mergeEnv(env),
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = options.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
			  }, options.timeoutMs)
			: null;

		child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

		child.on("close", (exitCode, signal) => {
			if (timer) clearTimeout(timer);
			resolve({
				command,
				shell: shellKind,
				cwd,
				exitCode: timedOut ? null : exitCode,
				stdout: stdout.replace(/\r\n/g, "\n"),
				stderr: stderr.replace(/\r\n/g, "\n"),
				timedOut,
				cancelled: signal !== null && !timedOut,
			});
		});

		child.on("error", () => {
			if (timer) clearTimeout(timer);
			resolve({
				command,
				shell: shellKind,
				cwd,
				exitCode: 1,
				stdout,
				stderr: stderr || "Failed to spawn process",
				timedOut: false,
				cancelled: false,
			});
		});
	});
}
