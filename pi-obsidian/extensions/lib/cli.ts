import { spawnSync } from "node:child_process";

// ponytail: execObsidian is synchronous — spawnSync freezes the event loop for
// up to timeout_ms and no abort signal can cancel it mid-flight. The full fix
// (promise-wrapped async spawn honoring the caller's signal) touches every call
// site: ~16 in index.ts, 6 exported helper signatures, ~40 test fakes — too big
// for tonight (2026-09-29 nightly plan). Until then, clamp model-supplied
// timeout_ms so the worst-case freeze is 120s, not minutes.
const MAX_TIMEOUT_MS = 120_000;

/**
 * Run obsidian CLI with the given arguments.
 * Returns stdout and parsed JSON (if stdout is valid JSON).
 */
export function execObsidian(args: string[], formatJson = false, timeoutMs = 30_000): { stdout: string; stderr: string; parsed: unknown } {
  // Clamp to [1, MAX_TIMEOUT_MS]: 0/negative would mean "no timeout" (unbounded
  // freeze); NaN passes through to spawnSync's ERR_OUT_OF_RANGE unchanged —
  // index.ts already falls back to the 30s default for NaN before calling.
  const ms = Math.min(Math.max(1, timeoutMs), MAX_TIMEOUT_MS);
  const allArgs = formatJson ? [...args, "format=json"] : args;
  const result = spawnSync("obsidian", allArgs, {
    encoding: "utf8",
    timeout: ms,
    killSignal: "SIGKILL",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024, // full-note read output; default 1MiB truncates large notes (ENOBUFS)
  });

  const stdout = (result.stdout ?? "")
    .split("\n")
    .filter((line) => !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d Loading updated app package /.test(line) && !line.includes("Your Obsidian installer is out of date. Please download the latest installer which includes better CLI support"))
    .join("\n");
  const stderr = result.stderr ?? "";

  if (result.signal) {
    throw new Error(
      `obsidian eval timed out (killed via ${result.signal}) after ${ms}ms — ` +
      `the Obsidian app may be blocked by a modal or sync conflict; ` +
      `check/restart Obsidian and retry. Cmd: obsidian ${allArgs.join(" ")}`
    );
  }
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
  return { stdout, stderr, parsed };
}


