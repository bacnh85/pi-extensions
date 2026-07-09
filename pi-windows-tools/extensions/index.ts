import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectShell, detectAllShells, getDefaultShell } from "./lib/shell-detect";
import type { WindowsShellKind } from "./lib/shell-detect";
import { executeCommand as execCmd } from "./lib/shell-exec";
import * as pathUtils from "./lib/path-utils";
import { classifyCommand } from "./lib/safety";
import { runDoctor, formatDoctorReport } from "./lib/doctor";
import { buildShellGuidance } from "./lib/prompts";
import { execFileSync } from "node:child_process";

const sk = Type.Union([Type.Literal("pwsh"), Type.Literal("powershell"), Type.Literal("cmd"), Type.Literal("git-bash"), Type.Literal("wsl")]);
const tp = Type.Optional(Type.Number({ description: "Timeout in ms." }));
const cs = { timeout_ms: tp };

function tr(text: string) { return Promise.resolve({ content: [{ type: "text" as const, text }], details: {} }); }
function rs(shell?: WindowsShellKind): WindowsShellKind {
	if (shell) return shell;
	const e = process.env.PI_WINDOWS_SHELL as WindowsShellKind | undefined;
	if (e && ["pwsh", "powershell", "cmd", "git-bash", "wsl"].includes(e)) return e;
	return getDefaultShell().kind;
}

// ponytail: in-memory audit log
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
	// ── Shell tools ──
	pi.registerTool({ name: "windows_shell_detect", label: "Windows: Detect Shells", description: "Detect available Windows shells.", promptSnippet: "Detect available Windows shells", promptGuidelines: ["Use to check what shells are available."], parameters: Type.Object({ ...cs }),
		execute() { return tr(detectAllShells().map(s => `  ${s.available ? "\u2713" : "\u2717"} ${s.displayName}${s.version ? " " + s.version : ""}`).join("\n")); } });

	pi.registerTool({ name: "windows_shell_exec", label: "Windows: Execute Command", description: "Execute a command through a Windows shell.", promptSnippet: "Execute a command through a Windows shell",
		promptGuidelines: ["Use instead of generic bash on Windows.", 'Use shell:"wsl" for WSL.', "Dangerous commands require confirmation."],
		parameters: Type.Object({ command: Type.String(), shell: Type.Optional(sk), cwd: Type.Optional(Type.String()), timeout_ms: tp }),
		async execute(_id, p, _s, _u, ctx) {
			const opts = { shell: rs(p.shell as WindowsShellKind | undefined), cwd: p.cwd || ctx?.cwd || process.cwd(), timeoutMs: p.timeout_ms };
			const safe = classifyCommand(p.command);
			const r = await execCmd(p.command, opts);
			_log.push({ shell: opts.shell as string, command: p.command, exitCode: r.exitCode, timedOut: r.timedOut });
			let o = `Exit code: ${r.exitCode}\n`;
			if (r.timedOut) o += "Status: TIMED OUT\n";
			if (r.cancelled) o += "Status: CANCELLED\n";
			if (r.stdout) o += `\n--- stdout ---\n${r.stdout}\n`;
			if (r.stderr) o += `\n--- stderr ---\n${r.stderr}\n`;
			if (safe.risk === "confirm") o += `\n\u26a0\ufe0f  ${safe.reasons.join("; ")}`;
			return tr(o);
		} });

	// ── File edit tool (reliable replacement for built-in edit) ──
	pi.registerTool({ name: "windows_file_edit", label: "Windows: Edit File", description: "Replace literal text in a file. Reads actual file bytes so no line-ending/whitespace mismatch issues.",
		promptSnippet: "Edit a file reliably using Node.js",
		promptGuidelines: [
			"Use instead of the built-in edit tool on all platforms.",
			"Reads actual file bytes so replacements always match regardless of line endings.",
			"Throws a clear error if oldText is not found.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file (absolute or relative to cwd)." }),
			oldText: Type.String({ description: "Literal text to find and replace." }),
			newText: Type.String({ description: "Replacement text." }),
			...cs,
		}),
		execute(_id, p, _s, _u, ctx) {
			const filePath = resolve(ctx?.cwd || process.cwd(), p.path);
			const content = readFileSync(filePath, "utf8");
			const updated = content.replace(p.oldText, p.newText);
			if (updated === content) throw new Error(`Not found or no change: ${filePath}`);

			writeFileSync(filePath, updated, "utf8");
			return tr(`Edited ${filePath}`);
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
		execute(_id, p) { return tr(pathUtils.toGitBashPath(p.path)); } });
	pi.registerTool({ name: "windows_path_quote", label: "Windows: Quote Path", description: "Quote a path for a Windows shell.", promptSnippet: "Quote path for shell", promptGuidelines: ["Each shell has different quoting rules."], parameters: Type.Object({ path: Type.String(), shell: Type.Optional(sk), ...cs }),
		execute(_id, p) { return tr(pathUtils.quoteForShell(p.path, rs(p.shell as WindowsShellKind | undefined))); } });

	// ── Safety tools ──
	pi.registerTool({ name: "windows_safety_classify", label: "Windows: Classify Safety", description: "Check if command is dangerous.", promptSnippet: "Classify command safety", promptGuidelines: ["Returns 'safe' or 'confirm'."], parameters: Type.Object({ command: Type.String(), ...cs }),
		execute(_id, p) { const r = classifyCommand(p.command); return tr(`Risk: ${r.risk}${r.reasons.length ? "\nReasons:\n  \u2022 " + r.reasons.join("\n  \u2022 ") : ""}`); } });

	// ── Doctor tools ──
	pi.registerTool({ name: "windows_doctor", label: "Windows: Doctor", description: "Detect installed developer tools.", promptSnippet: "Run Windows doctor", promptGuidelines: ["Checks PATH, WSL, long paths, dev mode."], parameters: Type.Object({ format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])), ...cs }),
		execute(_id, p) { const r = runDoctor(); return tr(p.format === "json" ? JSON.stringify(r, null, 2) : formatDoctorReport(r)); } });
	pi.registerTool({ name: "windows_tool_discover", label: "Windows: Discover Tool", description: "Check if a tool is in PATH.", promptSnippet: "Check tool availability", promptGuidelines: ["Use to verify a tool is installed."], parameters: Type.Object({ name: Type.String(), ...cs }),
		execute(_id, p) { try { const r = execFileSync("where", [p.name], { encoding: "utf8", timeout: 3000 }); return tr(`\u2713 ${p.name} at:\n${r.split(/\r?\n/).filter(Boolean).map(x => "  " + x).join("\n")}`); } catch { return tr(`\u2717 ${p.name} not in PATH`); } } });
	pi.registerTool({ name: "windows_wsl_list_distros", label: "Windows: List WSL Distros", description: "List installed WSL distros.", promptSnippet: "List WSL distros", promptGuidelines: ["See what distros are available."], parameters: Type.Object({ ...cs }),
		execute() { try { const r = execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf8", timeout: 5000 }); const d = r.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.toLowerCase().includes("noinstall") && !s.startsWith("Windows")); return tr(d.length ? "Installed WSL distros:\n  \u2022 " + d.join("\n  \u2022 ") : "No WSL distros found."); } catch { return tr("WSL not available."); } } });

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
