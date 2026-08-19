import { spawn } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { WindowsShellKind } from "./shell-detect";
import { getDefaultShell, detectShell } from "./shell-detect";
import { toWindowsPath, parseWslUncPath } from "./path-utils";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ExecOptions {
  shell?: WindowsShellKind;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Streaming callback: invoked with decoded output chunks as they arrive.
   * Fires for BOTH stdout and stderr (interleaved, terminal-like ordering) so
   * the preview mirrors what a user sees in a real terminal. The final
   * ExecResult separates the two streams with stdout/stderr fields. */
  onChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
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
      const common = ["-NoLogo", "-NoProfile", "-NonInteractive"];
      // ponytail: no -ExecutionPolicy on -Command/-EncodedCommand paths (issue
      // #20 L4): execution policy only gates script *files*; it never applies to
      // -Command. Keep Bypass only if a future -File path is added.
      // ponytail: -EncodedCommand only for fragile inputs (multiline/long); keeps simple cmds debuggable on -Command
      return shouldEncode(command)
        ? { exe: info.executable, args: [...common, "-EncodedCommand", encodeForPwsh(command)] }
        : { exe: info.executable, args: [...common, "-Command", command] };
    }
    case "cmd": return { exe: process.env.ComSpec || "cmd.exe", args: ["/c", command] };
    case "git-bash": return { exe: detectShell(kind).executable, args: ["-lc", command] };
    case "wsl": return { exe: detectShell("wsl").executable, args: [...(distro ? ["-d", distro] : []), "--", "bash", "-lc", command] };
  }
}

/** Resolve the WSL distro to target: prefer a distro embedded in a WSL UNC cwd
 * (\wsl.localhost\<distro>\...), fall back to PI_WSL_DISTRO env, then default. */
export function resolveWslDistro(shellKind: WindowsShellKind, cwd?: string): string | undefined {
  if (shellKind === "wsl" && cwd) {
    const unc = parseWslUncPath(cwd);
    if (unc?.distro) return unc.distro;
  }
  return process.env.PI_WSL_DISTRO || undefined;
}

/** Whether a PowerShell command is too fragile for `-Command` and needs `-EncodedCommand`.
 * Triggers on multi-line or long commands. Note: single-line commands with complex
 * nested quoting are NOT encoded — those rely on Node's argv escaping and remain
 * debuggable on the readable -Command path. */
export function shouldEncode(command: string): boolean {
  return command.length > 2000 || /[\r\n]/.test(command);
}

/** Base64-encode a command as UTF-16LE for PowerShell `-EncodedCommand`. */
export function encodeForPwsh(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
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
  const { exe, args } = buildShellArgs(shellKind, command, resolveWslDistro(shellKind, options.cwd));

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
    const append = (current: string, chunk: Buffer, decoder: StringDecoder, stream: "stdout" | "stderr") => {
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) { truncated = true; return current; }
      const slice = chunk.subarray(0, remaining);
      const text = decoder.write(slice);
      outputBytes += slice.length;
      if (slice.length < chunk.length) truncated = true;
      if (text && options.onChunk) options.onChunk(text, stream);
      return current + text;
    };
    const terminate = () => stop(child);
    const onAbort = () => { aborted = true; terminate(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs) : undefined;
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, stdoutDecoder, "stdout"); if (truncated) terminate(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, stderrDecoder, "stderr"); if (truncated) terminate(); });
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      if (stdoutTail && options.onChunk) options.onChunk(stdoutTail, "stdout");
      if (stderrTail && options.onChunk) options.onChunk(stderrTail, "stderr");
      stdout += stdoutTail;
      stderr += stderrTail;
      if (truncated) stderr += `${stderr ? "\n" : ""}[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
      resolve({ command, shell: shellKind, cwd, exitCode: timedOut || aborted ? null : exitCode, stdout: stdout.replace(/\r\n/g, "\n"), stderr: (stderr || spawnError || "").replace(/\r\n/g, "\n"), timedOut, cancelled: aborted });
    };
    child.on("close", code => finish(code));
    child.on("error", () => finish(1, "Failed to spawn process"));
  });
}
