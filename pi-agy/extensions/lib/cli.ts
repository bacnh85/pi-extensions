import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

const _require = createRequire(import.meta.url);

// Official install is a Go binary (not pipx). macOS/Linux; Windows uses the .ps1 script.
const INSTALL_HINT = "Install agy: curl -fsSL https://antigravity.google/cli/install.sh | bash";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgyModel =
  | "flash-low"
  | "flash-medium"
  | "flash-high"
  | "pro-low"
  | "pro-high"
  | "sonnet"
  | "opus"
  | "gpt-oss";

export interface AgyOptions {
  prompt: string;
  model?: AgyModel;
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

const MODEL_MAP: Record<AgyModel, string> = {
  "flash-low": "gemini-3.6-flash-low",
  "flash-medium": "gemini-3.6-flash-medium",
  "flash-high": "gemini-3.6-flash-high",
  "pro-low": "gemini-3.1-pro-low",
  "pro-high": "gemini-3.1-pro-high",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6-thinking",
  "gpt-oss": "gpt-oss-120b-medium",
};

const TIER_MAP: Record<NonNullable<AgyOptions["tier"]>, string> = {
  flash: MODEL_MAP["flash-high"],
  "flash-lo": MODEL_MAP["flash-low"],
  pro: MODEL_MAP["pro-high"],
};

// ---------------------------------------------------------------------------
// Arg builder (pure, testable without mocking)
// ---------------------------------------------------------------------------

export function buildAgyArgs(options: AgyOptions): string[] {
  const model = options.model
    ? MODEL_MAP[options.model]
    : options.tier
      ? TIER_MAP[options.tier]
      : MODEL_MAP["flash-medium"];
  const timeoutSec = Math.ceil(options.timeout_ms / 1000);
  const mode = options.mode ?? "accept-edits";
  // Headless -p auto-denies write/tool permissions; accept-edits and sandbox both
  // perform writes, so they need explicit auto-approval. plan is read-only.
  const writes = mode !== "plan";
  const json = mode !== "accept-edits"; // structured output for read/preview modes

  return [
    "--model",
    model,
    "--print-timeout",
    `${timeoutSec}s`,
    "--add-dir",
    options.dir,
    ...(mode === "sandbox" ? ["--sandbox"] : ["--mode", mode]),
    ...(writes ? ["--dangerously-skip-permissions"] : []),
    ...(json ? ["--output-format", "json"] : []),
    "-p",
    options.prompt,
  ];
}

// ---------------------------------------------------------------------------
// Prompt builder — phase framing + verify-loop injection (Google Best Practices:
// explore→plan→execute, and instruct the agent to verify its own edits)
// ---------------------------------------------------------------------------

export function buildAgyPrompt(
  prompt: string,
  mode: "plan" | "accept-edits" | "sandbox",
  useDigest: boolean,
  verifyCmd: string | null,
): string {
  const lines: string[] = [];
  if (mode === "plan") lines.push("Explore and produce an implementation plan only; do not edit.");
  else if (mode === "sandbox") lines.push("Work inside the sandbox; changes are isolated for preview.");
  else if (verifyCmd) lines.push(`After editing, run \`${verifyCmd}\` and fix failures until it passes.`);
  if (useDigest) lines.push("Use compact digests, not full file contents.");
  lines.push(prompt);
  return lines.join("\n");
}

// ponytail: npm test covers this JS/TS monorepo; other ecosystems rely on agy auto-reading AGENTS.md
export async function detectVerifyCommand(cwd: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    if (pkg?.scripts?.test) return "npm test";
  } catch {
    // no package.json or not JSON — nothing to inject
  }
  return null;
}

// agy --output-format json emits {status,response,usage,...}; fall back to raw on schema drift
export function parseJsonResponse(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return parsed.response ?? raw;
  } catch {
    return raw;
  }
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
              `Antigravity CLI is not installed. ${INSTALL_HINT}`,
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
              `Antigravity CLI is not installed. ${INSTALL_HINT}`,
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
          reject(new Error(`Antigravity CLI not found in PATH. ${INSTALL_HINT}`));
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
