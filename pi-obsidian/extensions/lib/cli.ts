import { spawnSync } from "node:child_process";

/**
 * Run obsidian CLI with the given arguments.
 * Returns stdout and parsed JSON (if stdout is valid JSON).
 */
export function execObsidian(args: string[], formatJson = false, timeoutMs = 30_000): { stdout: string; stderr: string; parsed: unknown } {
  const allArgs = formatJson ? [...args, "format=json"] : args;
  const result = spawnSync("obsidian", allArgs, {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    windowsHide: true,
  });

  const stdout = (result.stdout ?? "")
    .split("\n")
    .filter((line) => !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d Loading updated app package /.test(line) && !line.includes("Your Obsidian installer is out of date. Please download the latest installer which includes better CLI support"))
    .join("\n");
  const stderr = result.stderr ?? "";

  if (result.signal) {
    throw new Error(
      `obsidian eval timed out (killed via ${result.signal}) after ${timeoutMs}ms — ` +
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


