import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { detectShell, detectAllShells, getDefaultShell } from "./lib/shell-detect";
import type { WindowsShellKind } from "./lib/shell-detect";
import { executeCommand as execCmd } from "./lib/shell-exec";
import type { ExecOptions } from "./lib/shell-exec";
import * as pathUtils from "./lib/path-utils";
import { classifyCommand } from "./lib/safety";
import { runDoctor, formatDoctorReport, parseWslDistros } from "./lib/doctor";
import { buildShellGuidance } from "./lib/prompts";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const systemExe = (name: string) => join(process.env.SystemRoot || "C:\\Windows", "System32", name);

const sk = Type.Union([Type.Literal("pwsh"), Type.Literal("powershell"), Type.Literal("cmd"), Type.Literal("git-bash"), Type.Literal("wsl")]);
const tp = Type.Optional(Type.Number({ description: "Timeout in ms." }));
const cs = { timeout_ms: tp };

function tr(text: string) { return Promise.resolve({ content: [{ type: "text" as const, text }], details: {} }); }
function rs(shell?: WindowsShellKind): WindowsShellKind {
  return shell || getDefaultShell().kind;
}

// in-memory audit log
const _log: { shell: string; command: string; exitCode: number | null; timedOut: boolean }[] = [];
function _fmt() {
  if (!_log.length) return "No commands executed yet.";
  return _log.map((e, i) => {
    const tag = e.timedOut ? " [TIMED OUT]" : "";
    const cmd = e.command.length > 300 ? e.command.slice(0, 300) + "\u2026" : e.command;
    return `[${i + 1}] ${e.shell}  exit:${e.exitCode}${tag}\n    cmd: ${cmd}`;
  }).join("\n\n");
}

export default function piWindowsToolsExtension(pi: ExtensionAPI) {
  if (process.env.PI_WINDOWS_TOOLS_ENABLED === "false") return;
  // Session-scoped allows from the "Allow for this session" prompt choice.
  const sessionAllowedCommands = new Set<string>();
  pi.on("session_start", () => { sessionAllowedCommands.clear(); });
  // ── Shell tools ──
  pi.registerTool({ name: "windows_shell_detect", label: "Windows: Detect Shells", description: "Detect available Windows shells.", promptSnippet: "Detect available Windows shells", promptGuidelines: ["Use to check what shells are available."], parameters: Type.Object({ ...cs }),
    execute() { return tr(detectAllShells().map(s => `  ${s.available ? "\u2713" : "\u2717"} ${s.displayName}${s.version ? " " + s.version : ""}`).join("\n")); } });

  pi.registerTool({ name: "windows_shell_exec", label: "Windows: Execute Command", description: "Execute a command through a Windows shell.", promptSnippet: "Execute a command through a Windows shell",
    promptGuidelines: ["Use for PowerShell/cmd/WSL-native commands (pwsh, Get-*, Set-*, wsl, cmd).", "For plain read-only inspection (ls, grep, find), use bash — it runs automatically in plan mode without a confirmation prompt.", 'Use shell:"wsl" for WSL.', "Dangerous commands require confirmation."],
    parameters: Type.Object({ command: Type.String(), shell: Type.Optional(sk), cwd: Type.Optional(Type.String()), timeout_ms: tp }),
    async execute(_id, p, signal, onUpdate, ctx) {
      const opts: ExecOptions = { shell: rs(p.shell as WindowsShellKind | undefined), cwd: p.cwd || ctx?.cwd || process.cwd(), timeoutMs: p.timeout_ms, signal };
      const safe = classifyCommand(p.command);
      if (safe.risk === "confirm") {
        if (!ctx?.hasUI) return tr(`Command requires confirmation but UI is unavailable: ${safe.reasons.join("; ")}`);
        // ponytail: session-allow keyed by first token — BUT interpreter/wrapper
        // tokens run arbitrary payloads, so those key on the full command
        // (one approval must not silence the danger gate for the interpreter).
        const INTERPRETER_TOKENS = new Set(["pwsh", "powershell", "cmd", "cmd.exe", "wsl", "wsl.exe", "bash", "sh", "node", "npx", "python", "python3", "git-bash"]);
        const raw = p.command.trim();
        const firstToken = raw.split(/\s+/)[0] || "";
        const allowKey = INTERPRETER_TOKENS.has(firstToken.toLowerCase()) || /\.exe$/i.test(firstToken)
          ? `cmd:${raw}`
          : firstToken;
        if (allowKey && sessionAllowedCommands.has(allowKey)) {
          // approved "Allow for this session" earlier
        } else {
          const clip = (s: string) => {
            const c = String(s).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
            return c.length > 120 ? c.slice(0, 120) + "…" : c;
          };
          const isInterpreter = INTERPRETER_TOKENS.has(firstToken.toLowerCase()) || /\.exe$/i.test(firstToken);
          const choice = await ctx.ui.select(
            `Run dangerous Windows command?\n\nCommand: ${clip(raw)}\n\nRisk: ${safe.reasons.join("; ")}\n\n"Allow for this session" ${isInterpreter ? "remembers only this exact command" : `remembers \`${clip(firstToken)}\` commands until the session ends.`}`,
            ["Allow once", "Allow for this session", "Deny"],
          );
          if (choice === "Allow for this session") sessionAllowedCommands.add(allowKey);
          else if (choice !== "Allow once") return tr("Command cancelled by user.");
        }
      }
      // ponytail: SDK OutputAccumulator is internal; throttled onChunk buffer suffices, add temp-file spill if builds regularly exceed 1MB
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let flush: (() => void) | undefined;
      if (onUpdate) {
        let streamed = "";
        let dirty = false;
        flush = () => { flushTimer = undefined; if (!dirty) return; dirty = false; onUpdate({ content: [{ type: "text" as const, text: streamed }], details: {} }); };
        // Preview interleaves stdout+stderr (terminal-like); the final result below separates them.
        opts.onChunk = (chunk: string) => { streamed += chunk; dirty = true; if (!flushTimer) flushTimer = setTimeout(flush!, 120); };
        onUpdate({ content: [], details: {} });
      }
      try {
        const r = await execCmd(p.command, opts);
        _log.push({ shell: opts.shell as string, command: p.command, exitCode: r.exitCode, timedOut: r.timedOut });
        let o = `Exit code: ${r.exitCode}\n`;
        if (r.timedOut) o += "Status: TIMED OUT\n";
        if (r.cancelled) o += "Status: CANCELLED\n";
        if (r.stdout) o += `\n--- stdout ---\n${r.stdout}\n`;
        if (r.stderr) o += `\n--- stderr ---\n${r.stderr}\n`;
        if (safe.risk === "confirm") o += `\n\u26a0\ufe0f  ${safe.reasons.join("; ")}`;
        return tr(o);
      } finally {
        if (flushTimer) clearTimeout(flushTimer);
        flush?.();
      }
    } });

  // ── Audit tools ──
  pi.registerTool({ name: "windows_audit_log", label: "Windows: Audit Log", description: "Show command history and exit codes.", promptSnippet: "Show Windows command audit log", promptGuidelines: ["Use to see what was executed."],
    parameters: Type.Object({ clear: Type.Optional(Type.Boolean({ description: "Clear after viewing." })), ...cs }),
    execute(_id, p) { const out = _fmt(); if (p.clear) _log.length = 0; return tr(out); } });

  // ── Path tools ──
  pi.registerTool({ name: "windows_path_to_windows", label: "Windows: Convert to Windows Format", description: "Convert POSIX/WSL path to C:\\...", promptSnippet: "Convert path to Windows", promptGuidelines: ["Use when you have /c/ or /mnt/c/ path."], parameters: Type.Object({ path: Type.String(), ...cs }),
    execute(_id, p) { return tr(pathUtils.toWindowsPath(p.path)); } });
  pi.registerTool({ name: "windows_path_to_wsl", label: "Windows: Convert to WSL", description: "Convert Windows path to /mnt/c/...", promptSnippet: "Convert path to WSL", promptGuidelines: ["Use to pass Windows path to WSL."], parameters: Type.Object({ path: Type.String(), ...cs }),
    execute(_id, p) { return tr(pathUtils.toWslPath(p.path)); } });
  pi.registerTool({ name: "windows_path_to_gitbash", label: "Windows: Convert to Git Bash", description: "Convert Windows path to /c/...", promptSnippet: "Convert path to Git Bash", promptGuidelines: ["Use to pass Windows path to Git Bash."], parameters: Type.Object({ path: Type.String(), ...cs }),
    execute(_id, p) { return tr(pathUtils.toPosixPath(p.path)); } });
  pi.registerTool({ name: "windows_path_quote", label: "Windows: Quote Path", description: "Quote a path for a Windows shell.", promptSnippet: "Quote path for shell", promptGuidelines: ["Each shell has different quoting rules."], parameters: Type.Object({ path: Type.String(), shell: Type.Optional(sk), ...cs }),
    execute(_id, p) { return tr(pathUtils.quoteForShell(p.path, rs(p.shell as WindowsShellKind | undefined))); } });

  // ── Safety tools ──
  pi.registerTool({ name: "windows_safety_classify", label: "Windows: Classify Safety", description: "Check if command is dangerous.", promptSnippet: "Classify command safety", promptGuidelines: ["Returns 'safe' or 'confirm'."], parameters: Type.Object({ command: Type.String(), ...cs }),
    execute(_id, p) { const r = classifyCommand(p.command); return tr(`Risk: ${r.risk}${r.reasons.length ? "\nReasons:\n  \u2022 " + r.reasons.join("\n  \u2022 ") : ""}`); } });

  // ── Doctor tools ──
  pi.registerTool({ name: "windows_doctor", label: "Windows: Doctor", description: "Detect installed developer tools.", promptSnippet: "Run Windows doctor", promptGuidelines: ["Checks PATH, WSL, long paths, dev mode."], parameters: Type.Object({ format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])), ...cs }),
    execute(_id, p) { const r = runDoctor(); return tr(p.format === "json" ? JSON.stringify(r, null, 2) : formatDoctorReport(r)); } });
  pi.registerTool({ name: "windows_tool_discover", label: "Windows: Discover Tool", description: "Check if a tool is in PATH.", promptSnippet: "Check tool availability", promptGuidelines: ["Use to verify a tool is installed."], parameters: Type.Object({ name: Type.String(), ...cs }),
    execute(_id, p) { try { const r = execFileSync(systemExe("where.exe"), [p.name], { cwd: homedir(), encoding: "utf8", timeout: 3000 }); return tr(`\u2713 ${p.name} at:\n${r.split(/\r?\n/).filter(Boolean).map(x => "  " + x).join("\n")}`); } catch { return tr(`\u2717 ${p.name} not in PATH`); } } });
  pi.registerTool({ name: "windows_wsl_list_distros", label: "Windows: List WSL Distros", description: "List installed WSL distros.", promptSnippet: "List WSL distros", promptGuidelines: ["See what distros are available."], parameters: Type.Object({ ...cs }),
    execute() { try { const d = parseWslDistros(execFileSync(systemExe("wsl.exe"), ["-l", "-q"], { cwd: homedir(), timeout: 5000 })); return tr(d.length ? "Installed WSL distros:\n  \u2022 " + d.join("\n  \u2022 ") : "No WSL distros found."); } catch { return tr("WSL not available."); } } });

  // ── Commands ──
  pi.registerCommand("windows-doctor", { description: "Run Windows Tools Doctor.", handler: async (_a, ctx) => { ctx?.ui?.notify?.("Windows Doctor complete.", "info"); process.stdout.write(formatDoctorReport(runDoctor()) + "\n"); } });
  pi.registerCommand("windows-shell", { description: "Show/set default shell.", handler: async (a, ctx) => {
    const arg = (a || "").trim().toLowerCase();
    if (arg) {
      if (!["pwsh", "powershell", "cmd", "git-bash", "wsl"].includes(arg)) { ctx?.ui?.notify?.("Invalid shell", "warning"); return; }
      const info = detectShell(arg as WindowsShellKind);
      if (!info.available) { ctx?.ui?.notify?.(`${info.displayName} unavailable.`, "warning"); return; }
      process.env.PI_WINDOWS_SHELL = arg;
      ctx?.ui?.notify?.(`Shell: ${info.displayName}`, "info"); return;
    }
    const c = getDefaultShell();
    process.stdout.write(`Current shell: ${c.displayName} (${c.kind})\nExecutable: ${c.executable}\n`);
  } });

  // ── Agent prompt ──
  pi.on("before_agent_start", async (event) => {
    if (process.env.PI_WINDOWS_TOOLS_ENABLED === "false" || process.platform !== "win32") return;
    return { systemPrompt: `${event.systemPrompt}\n\n---\n\n## Windows Environment\n\n${buildShellGuidance(rs())}` };
  });
}
