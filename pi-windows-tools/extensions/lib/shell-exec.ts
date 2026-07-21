import { spawn } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { WindowsShellKind } from "./shell-detect";
import { getDefaultShell, detectShell } from "./shell-detect";
import { toWindowsPath } from "./path-utils";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ExecOptions {
  shell?: WindowsShellKind;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
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

/** Merge custom env with process.env, deduplicating keys case-insensitively. */
export function mergeEnv(customEnv: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  const customLower = new Set(Object.keys(customEnv).map(key => key.toLowerCase()));
  for (const key of Object.keys(process.env)) {
    if (!customLower.has(key.toLowerCase()) && process.env[key] !== undefined) merged[key] = process.env[key]!;
  }
  return { ...merged, ...customEnv };
}

/** Build the arg array for a given shell kind. */
export function buildShellArgs(kind: WindowsShellKind, command: string, distro?: string): { exe: string; args: string[] } {
  switch (kind) {
    case "pwsh":
    case "powershell": {
      const info = detectShell(kind);
      return { exe: info.executable, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command] };
    }
    case "cmd": return { exe: process.env.ComSpec || "cmd.exe", args: ["/c", command] };
    case "git-bash": return { exe: detectShell(kind).executable, args: ["-lc", command] };
    case "wsl": return { exe: detectShell("wsl").executable, args: [...(distro ? ["-d", distro] : []), "--", "bash", "-lc", command] };
  }
}

function stop(child: ReturnType<typeof spawn>) {
  if (process.platform === "win32" && child.pid) {
    spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).unref();
  }
  child.kill();
}

/** Execute a command through the specified Windows shell. */
export function executeCommand(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const shellKind = options.shell || getDefaultShell().kind;
  const cwd = options.cwd && (shellKind === "git-bash" || shellKind === "wsl") ? toWindowsPath(options.cwd) : options.cwd || process.cwd();
  if (options.signal?.aborted) return Promise.resolve({ command, shell: shellKind, cwd, exitCode: null, stdout: "", stderr: "", timedOut: false, cancelled: true });
  const { exe, args } = buildShellArgs(shellKind, command, process.env.PI_WSL_DISTRO || undefined);

  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, env: mergeEnv(options.env || {}) });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const append = (current: string, chunk: Buffer, decoder: StringDecoder) => {
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) { truncated = true; return current; }
      const slice = chunk.subarray(0, remaining);
      const text = decoder.write(slice);
      outputBytes += slice.length;
      if (slice.length < chunk.length) truncated = true;
      return current + text;
    };
    const terminate = () => stop(child);
    const onAbort = () => { aborted = true; terminate(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs) : undefined;
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, stdoutDecoder); if (truncated) terminate(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, stderrDecoder); if (truncated) terminate(); });
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (truncated) stderr += `${stderr ? "\n" : ""}[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
      resolve({ command, shell: shellKind, cwd, exitCode: timedOut || aborted ? null : exitCode, stdout: stdout.replace(/\r\n/g, "\n"), stderr: (stderr || spawnError || "").replace(/\r\n/g, "\n"), timedOut, cancelled: aborted });
    };
    child.on("close", code => finish(code));
    child.on("error", () => finish(1, "Failed to spawn process"));
  });
}
