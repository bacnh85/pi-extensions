import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgyOptions {
	prompt: string;
	tier?: "flash" | "flash-lo" | "pro";
	mode?: "plan" | "accept-edits" | "sandbox";
	dir: string;
	timeout_ms: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREFLIGHT_TIMEOUT_MS = 10_000;
const MAX_CAPTURE_BYTES = 64 * 1024;

const TIER_MAP: Record<string, string> = {
	flash: "Gemini 3.5 Flash (High)",
	"flash-lo": "Gemini 3.5 Flash (Low)",
	pro: "Gemini 3.1 Pro (High)",
};

// ---------------------------------------------------------------------------
// Arg builder (pure, testable without mocking)
// ---------------------------------------------------------------------------

export function buildAgyArgs(options: AgyOptions): string[] {
	const model = TIER_MAP[options.tier ?? "flash"] ?? TIER_MAP.flash;
	const timeoutSec = Math.ceil(options.timeout_ms / 1000);

	return [
		"--model",
		model,
		"--print-timeout",
		`${timeoutSec}s`,
		"--add-dir",
		options.dir,
		...(options.mode === "sandbox" ? ["--sandbox"] : ["--mode", options.mode ?? "accept-edits"]),
		"-p",
		options.prompt,
	];
}

// ---------------------------------------------------------------------------
// Spawn helper (resolves via require so tests can mock)
// ---------------------------------------------------------------------------

function getSpawn() {
	return _require("node:child_process").spawn;
}

function appendBounded(chunks: Buffer[], total: number, data: Buffer): number {
	const remaining = MAX_CAPTURE_BYTES - total;
	if (remaining > 0) chunks.push(data.subarray(0, remaining));
	return Math.min(MAX_CAPTURE_BYTES, total + data.length);
}

// ---------------------------------------------------------------------------
// Pre-flight: verify agy binary exists and auth works
// ---------------------------------------------------------------------------

export async function checkAgyHealth(cwd: string, signal?: AbortSignal): Promise<void> {
	const spawn = getSpawn();
	const child = spawn("agy", ["--version"], {
		cwd,
		stdio: ["ignore", "ignore", "pipe"],
		timeout: PREFLIGHT_TIMEOUT_MS,
		signal,
	});

	const stderr: Buffer[] = [];
	let stderrBytes = 0;
	child.stderr.on("data", (d: Buffer) => {
		stderrBytes = appendBounded(stderr, stderrBytes, d);
	});

	let settled = false;

	await new Promise<void>((resolve, reject) => {
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		child.on("error", (err: Error) => {
			done(() => {
				if (signal?.aborted) {
					reject(new Error("agy health check was cancelled"));
				} else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					reject(
						new Error(
							"Antigravity CLI is not installed. Install with: pipx install antigravity or agy --help",
						),
					);
				} else {
					reject(new Error(`agy health check failed: ${err.message}`));
				}
			});
		});
		child.on("close", (code: number | null) => {
			done(() => {
				if (signal?.aborted) {
					reject(new Error("agy health check was cancelled"));
					return;
				}
				if (code === 0) resolve();
				else {
					const msg = Buffer.concat(stderr).toString("utf8").trim();
					const label = code === null ? "timed out" : `exit ${code}`;
					reject(
						new Error(
							`Antigravity CLI is not authenticated or not working (${label}). ${msg || "Run 'agy' interactively in your terminal to authenticate."}`,
						),
					);
				}
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Pre-flight: verify agy can connect to its backend (non-interactive)
// ---------------------------------------------------------------------------

// `agy --mode plan -p "ping"` requires a TTY and doesn't work in spawn.
// Instead we run `agy models` which lists available models without needing
// a TTY and proves the CLI is functional and can reach its backend.
export async function checkAgyConnectivity(cwd: string, signal?: AbortSignal): Promise<void> {
	const spawn = getSpawn();
	const child = spawn("agy", ["models"], {
		cwd,
		stdio: ["ignore", "ignore", "pipe"],
		timeout: PREFLIGHT_TIMEOUT_MS,
		signal,
	});

	const stderr: Buffer[] = [];
	let stderrBytes = 0;
	child.stderr.on("data", (d: Buffer) => {
		stderrBytes = appendBounded(stderr, stderrBytes, d);
	});

	let settled = false;

	await new Promise<void>((resolve, reject) => {
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		child.on("close", (code: number | null) => {
			done(() => {
				if (signal?.aborted) {
					reject(new Error("agy connectivity check was cancelled"));
					return;
				}
				if (code === 0) resolve();
				else {
					const label = code === null ? "timed out" : `exit ${code}`;
					const msg = Buffer.concat(stderr).toString("utf8").trim();
					reject(
						new Error(
							`agy connectivity check failed (${label}). ${msg || "Run 'agy' in the terminal to authenticate."}`,
						),
					);
				}
			});
		});
		child.on("error", (err: Error) => {
			done(() => {
				if (signal?.aborted) {
					reject(new Error("agy connectivity check was cancelled"));
				} else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					reject(
						new Error(
							"Antigravity CLI is not installed. Install with: pipx install antigravity or agy --help",
						),
					);
				} else {
					reject(new Error(`agy connectivity check failed: ${err.message}`));
				}
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Spawn wrapper
// ---------------------------------------------------------------------------

export function spawnAgy(options: AgyOptions, signal: AbortSignal): Promise<string> {
	// ponytail: global lock, per-project locks if concurrent agy calls collide
	const spawn = getSpawn();
	const args = buildAgyArgs(options);

	// Let agy report its own print timeout before Node enforces termination.
	const alignedTimeout = Math.ceil(options.timeout_ms / 1000) * 1000 + 5000;

	return new Promise<string>((resolve, reject) => {
		const child = spawn("agy", args, {
			cwd: options.dir,
			stdio: ["ignore", "pipe", "pipe"],
			signal,
			timeout: alignedTimeout,
		});

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;

		child.stdout.on("data", (d: Buffer) => {
			stdoutBytes = appendBounded(stdout, stdoutBytes, d);
		});
		child.stderr.on("data", (d: Buffer) => {
			stderrBytes = appendBounded(stderr, stderrBytes, d);
		});

		let settled = false;
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		child.on("error", (err: Error) => {
			done(() => {
				if (signal.aborted) {
					reject(new Error("agy was cancelled"));
				} else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					reject(new Error("Antigravity CLI not found in PATH. Install with: pipx install antigravity"));
				} else {
					reject(new Error(`agy spawn failed: ${err.message}`));
				}
			});
		});

		child.on("close", (code: number | null, sig: string | null) => {
			done(() => {
				const out = Buffer.concat(stdout).toString("utf8");
				const err = Buffer.concat(stderr).toString("utf8");
				const combined = out + (err ? `\n${err}` : "");

				if (sig === "SIGTERM" || sig === "SIGKILL" || code === null) {
					reject(new Error(`agy was cancelled (${sig || "timeout"})`));
				} else if (code !== 0) {
					const detail = (err || out).slice(0, 2000).trim();
					reject(new Error(`agy exited with code ${code}:\n${detail || "(no output)"}`));
				} else {
					resolve(combined);
				}
			});
		});
	});
}
