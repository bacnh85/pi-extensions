import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 50 * 1024; // 50 KB UTF-8
const MAX_OUTPUT_LINES = 2000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

// CLI command groups that have subcommands
const COMMAND_GROUPS = new Set([
	"auth", "source", "artifact", "note", "share", "research",
	"profile", "agent", "skill", "language", "generate", "download",
]);

// Global CLI options that consume a following value arg
const VALUE_OPTIONS = new Set([
	"--storage", "--profile", "-p", "--request-timeout", "--timeout",
	"-n", "--notebook",
	"-o", "--output",
	"-a", "--all",
	"--name", "--title", "--content",
	"-t",
	"-c",
	"-s", "--source",
	"--prompt-file", "--conversation-id", "--note-title",
	"--permission", "--mode", "--scope", "--type", "--format",
	"--seconds",
	"--path",
]);

// Exact command-path patterns that are destructive
const DESTRUCTIVE_PATHS: string[][] = [
	["delete"],                        // top-level notebook delete
	["source", "delete"],
	["source", "delete-by-title"],
	["source", "clean"],
	["artifact", "delete"],
	["note", "delete"],
	["profile", "delete"],
	["skill", "uninstall"],
	["share", "remove"],
	["share", "public"],              // privacy-changing: expose notebook publicly
	["share", "add"],                 // privacy-changing: add collaborator
	["share", "update"],              // privacy-changing: change permissions
	["share", "view-level"],          // privacy-changing: change view access
	["auth", "logout"],
	["clear"],
];

// Commands where a flag triggers destruction (e.g. ask --new, history --clear)
const DESTRUCTIVE_FLAGS: Record<string, string[]> = {
	ask: ["--new"],
	history: ["--clear"],
};

// Command paths that need --yes/-y to avoid a hanging prompt
const REQUIRES_YES = new Set([
	"delete",
	"source.delete",
	"source.delete-by-title",
	"source.clean",
	"artifact.delete",
	"note.delete",
	"profile.delete",
	"share.remove",
	"ask", // for ask --new
]);

// Command paths whose destructive action does NOT support --yes/-y in v0.7.3
const NO_YES_SUPPORT = new Set(["auth.logout", "skill.uninstall", "history", "clear"]);

// Command paths that overwrite workspace files when combined with --force/-f
const FILE_OVERWRITE_PATTERNS: string[][] = [
	["download"],
	["source", "fulltext"],
	["skill", "install"],
];

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Extract the command path and remaining args, skipping global CLI options.
 *
 *  Tracks whether `--` (end-of-options) has been seen. After `--`,
 *  flag-style arguments are treated as positional values, not skipped.
 *  This ensures `["ask", "--new", "-y", "--", "--help"]` is not treated
 *  as a read-only help command — `--help` after `--` is a positional value.
 */
export function extractCommandPath(args: string[]): { path: string[]; rest: string[]; endOfOptions: boolean } {
	const path: string[] = [];
	let i = 0;
	let endOfOptions = false;
	while (i < args.length) {
		const a = args[i];
		if (a === "--") {
			endOfOptions = true;
			i++;
			continue;
		}
		if (!endOfOptions && a.startsWith("-")) {
			if (VALUE_OPTIONS.has(a)) i += 2;
			else i++;
		} else {
			path.push(a);
			i++;
			if (path.length === 1 && COMMAND_GROUPS.has(a)) continue;
			break;
		}
	}
	return { path, rest: args.slice(i), endOfOptions };
}

/** Check whether `--help` or `-h` appears before any `--` (end-of-options).
 *
 *  After `--`, flags like `--help` are positional values, not help flags.
 *  Click respects this convention, so the extension must too.
 *  Skips args that are values of a preceding option: e.g. `--help` as
 *  value of `--storage` is not a help flag, it is a storage path, so
 *  login/interactive gates are not bypassed.
 */
function hasHelpFlag(args: string[]): boolean {
	const dd = args.indexOf("--");
	const preDD = dd === -1 ? args : args.slice(0, dd);
	for (let i = 0; i < preDD.length; i++) {
		if ((preDD[i] === "--help" || preDD[i] === "-h") && !(i > 0 && VALUE_OPTIONS.has(preDD[i - 1]))) {
			return true;
		}
	}
	return false;
}

function arraysMatch(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Check whether args[index] is the value of a preceding option.
 *
 *  Prevents mistaking option values (e.g. `-y` as value of `--storage`,
 *  `--yes` as value of `-n`) for confirmation flags.
 */
function isOptionValue(args: string[], index: number): boolean {
	if (index <= 0) return false;
	return VALUE_OPTIONS.has(args[index - 1]);
}

/** Check if args represent a destructive/state-removing operation.
 *
 *  Uses exact command-path matching so a question like
 *  `ask "how do I delete this"` is not falsely flagged.
 *  Exempts `source clean --dry-run` which is read-only.
 */
export function isDestructive(args: string[]): boolean {
	// --help / -h is read-only, but only when they appear before `--`.
	// After `--`, they are positional values, not help flags.
	if (hasHelpFlag(args)) return false;

	const { path, rest } = extractCommandPath(args);

	// Safe preview: source clean --dry-run is read-only
	if (arraysMatch(path, ["source", "clean"]) && rest.includes("--dry-run")) {
		return false;
	}

	for (const dp of DESTRUCTIVE_PATHS) {
		if (arraysMatch(path, dp)) return true;
	}
	if (path.length > 0 && DESTRUCTIVE_FLAGS[path[0]]) {
		// Scan destructive flags only before the end-of-options marker.
		// After `--`, flags like `--new` are positional values, not options.
		const dd = args.indexOf("--");
		const beforeDD = dd === -1 ? args : args.slice(0, dd);
		return DESTRUCTIVE_FLAGS[path[0]].some((f) => beforeDD.includes(f));
	}

	// File overwrite: --force with file-output commands overwrites
	// workspace files without the user's knowledge.
	// NOTE: -f is NOT a synonym for --force in v0.7.3; `source fulltext -f`
	// means --format, not --force. Only check long-form --force.
	// Uses prefix matching because subcommands (e.g. "download audio")
	// extend the base path.
	const dd = args.indexOf("--");
	const beforeDoubleDash = dd === -1 ? args : args.slice(0, dd);
	const hasForce = beforeDoubleDash.includes("--force");
	if (hasForce) {
		for (const fp of FILE_OVERWRITE_PATTERNS) {
			if (path.length >= fp.length && fp.every((p, i) => path[i] === p)) {
				return true;
			}
		}
	}

	return false;
}

/** Check if a destructive command is missing a required --yes/-y flag.
 *
 *  Does NOT require --yes for commands in NO_YES_SUPPORT (e.g. auth.logout
 *  in CLI v0.7.3 does not accept -y/--yes).
 *  Only scans for -y/--yes before the first `--` (end-of-options) marker.
 *  After `--`, flags are positional values, not CLI options.
 */
export function requiresYesFlag(args: string[]): boolean {
	const { path, rest } = extractCommandPath(args);
	const key = path.join(".");
	if (NO_YES_SUPPORT.has(key)) return false;
	if (!REQUIRES_YES.has(key)) return false;
	if (key === "ask" && !rest.includes("--new")) return false; // ask without --new
	// Only check before `--` (end-of-options marker)
	const dd = args.indexOf("--");
	const beforeDoubleDash = dd === -1 ? args : args.slice(0, dd);
	// Skip args that are values of a preceding option: e.g. `-y` as value
	// of `--storage`, or `--yes` as value of `-n`. Those are not confirmation flags.
	const hasYes = beforeDoubleDash.some(
		(a, i) => (a === "-y" || a === "--yes") && !isOptionValue(beforeDoubleDash, i),
	);
	return !hasYes;
}

/** Check if args contain interactive setup commands that require a terminal. */
export function isBlockedInteractive(args: string[]): { blocked: boolean; message?: string } {
	// --help / -h is read-only, but only before `--` (Click convention)
	if (hasHelpFlag(args)) return { blocked: false };

	const { path } = extractCommandPath(args);
	if (path[0] === "login") {
		return {
			blocked: true,
			message: "'notebooklm login' requires a terminal for browser login. Run it directly in your terminal.",
		};
	}
	return { blocked: false };
}

/** Format args for error messages showing only the command path.
 *
 *  Value-bearing arguments (questions, source text, emails, content)
 *  are redacted to avoid leaking private data through error messages.
 *  The command path is enough to identify the failing operation.
 */
function formatArgsForError(args: string[]): string {
	const { path } = extractCommandPath(args);
	if (path.length === 0) return "(no command)";
	const cmdLine = path.join(" ");
	return Buffer.byteLength(cmdLine, "utf8") <= 500
		? cmdLine
		: cmdLine.slice(0, 200) + "\u2026 [truncated]";
}

/** Truncate output using byte-aware 50 KB / 2000-line limits.
 *
 *  Full output is saved to a private temp file; the temp path is appended
 *  to the returned text so the model can reference it.
 *  Computes actual suffix byte/line size dynamically instead of using a
 *  fixed reserve, guaranteeing the returned text stays within both limits.
 */
export function truncateOutput(text: string): { text: string; truncated: boolean; tempPath?: string } {
	if (!text) return { text: "", truncated: false };

	const lines = text.split("\n");

	if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES && lines.length <= MAX_OUTPUT_LINES) {
		return { text, truncated: false };
	}

	const dir = mkdtempSync(join(tmpdir(), "pi-notebooklm-"));
	const tempPath = join(dir, "full-output.txt");
	writeFileSync(tempPath, text, "utf8");

	// Build suffix notices to determine actual byte/line cost
	const needByteNotice = Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES;
	const needLineNotice = lines.length > MAX_OUTPUT_LINES;
	const byteNotice = "\n\n… [truncated at 50 KB]";
	const lineNotice = `\n\n… [truncated at ${MAX_OUTPUT_LINES} lines]`;
	const pathNotice = `\n\nFull output saved to: ${tempPath}`;

	// Compose the suffix we would append, to measure its actual byte/line cost
	const suffixPieces: string[] = [];
	if (needByteNotice) suffixPieces.push(byteNotice);
	if (needLineNotice) suffixPieces.push(lineNotice);
	suffixPieces.push(pathNotice);
	const fullSuffix = suffixPieces.join("");
	const suffixBytes = Buffer.byteLength(fullSuffix, "utf8");
	const suffixLineCount = fullSuffix.split("\n").length;

	let result = text;

	// Byte-aware truncation using actual suffix byte count
	if (needByteNotice) {
		const limit = Math.max(0, MAX_OUTPUT_BYTES - suffixBytes);
		const buf = Buffer.from(text, "utf8");
		const sliced = buf.slice(0, limit).toString("utf8");
		result = sliced.replace(/\uFFFD+$/g, "");
	}

	// Line-count truncation using actual suffix line count
	const currentLines = result.split("\n");
	if (currentLines.length + suffixLineCount > MAX_OUTPUT_LINES) {
		const lineLimit = Math.max(0, MAX_OUTPUT_LINES - suffixLineCount);
		result = currentLines.slice(0, lineLimit).join("\n");
	}

	// Re-check byte limit after line truncation may have restored bytes
	if (!needByteNotice && result.length > MAX_OUTPUT_BYTES) {
		const limit = Math.max(0, MAX_OUTPUT_BYTES - suffixBytes);
		const buf = Buffer.from(result, "utf8");
		const sliced = buf.slice(0, limit).toString("utf8");
		result = sliced.replace(/\uFFFD+$/g, "");
	}

	const finalSuffix = suffixPieces.join("");

	return { text: result + finalSuffix, truncated: true, tempPath };
}

/** Extract output file paths from args for mutation queue.
 *
 *  Handles:
 *  - `-o <path>` / `--output <path>` flag (source fulltext, etc.)
 *  - `--all <dir>` flag (download all files to a directory)
 *  - `download <type> [path]` — path is the last positional arg after type
 *    (detected via extractCommandPath so global options don't interfere)
 *  - If no explicit path is found for download, queues on cwd as fallback
 *    to serialize concurrent default-filename downloads.
 *
 *  Returns absolute paths resolved against cwd, deduplicated.
 */
export function extractOutputPaths(args: string[], cwd: string): string[] {
	const paths: string[] = [];

	// -o / --output flag: next arg is the output path
	for (let i = 0; i < args.length - 1; i++) {
		if ((args[i] === "-o" || args[i] === "--output") && args[i + 1] && !args[i + 1].startsWith("-")) {
			paths.push(resolve(cwd, args[i + 1]));
		}
	}

	// --all <directory>: download all files to a directory
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === "--all" && args[i + 1] && !args[i + 1].startsWith("-")) {
			paths.push(resolve(cwd, args[i + 1]));
		}
	}

	// download command: detect via extractCommandPath so global options
	// (e.g. --profile work) before "download" don't prevent detection.
	// Path is the last positional arg in the rest after skipping flags
	// and their consumed values.
	const { path: cmdPath, rest } = extractCommandPath(args);
	if (cmdPath.length >= 2 && cmdPath[0] === "download") {
		let lastPosArg: string | undefined;
		for (let i = 0; i < rest.length; i++) {
			if (VALUE_OPTIONS.has(rest[i])) { i++; continue; }
			if (rest[i].startsWith("-")) continue;
			lastPosArg = rest[i];
		}
		if (lastPosArg) {
			paths.push(resolve(cwd, lastPosArg));
		}
	}

	// ponytail: if download command and no explicit output path found,
	// queue on cwd to serialize concurrent default-filename downloads
	if (cmdPath.length >= 2 && cmdPath[0] === "download" && paths.length === 0) {
		paths.push(resolve(cwd, "."));
	}

	// Deduplicate: e.g. --all ./dir and positional path may coincide
	return [...new Set(paths)];
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function piNotebooklmExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "notebooklm",
		label: "NotebookLM CLI",
		description:
			"Run a Google NotebookLM CLI command via notebooklm-py. Covers notebooks, sources, grounded chat, research, Studio artifacts (audio/video/slides), downloads, notes, sharing, and organization.",
		promptSnippet: "Run a Google NotebookLM CLI command via notebooklm-py",
		promptGuidelines: [
			"Use notebooklm auth check --test --json to verify authentication (not just status).",
			"Request --json on supported commands for structured machine-readable output.",
			"Use full notebook IDs and explicit -n/--notebook for parallel agent calls.",
			"Wait for source readiness before chat/generation: use notebooklm source wait or check with notebooklm source list.",
			"Start long generation without --wait, then poll with notebooklm artifact poll or block with artifact wait.",
			"Ask the user before destructive operations, quota-consuming generation, long waits (>2 min), downloads, or sharing changes.",
			"Never pass cookies or credential JSON through this tool.",
		],
		parameters: Type.Object({
			args: Type.Array(Type.String(), {
				description:
					'Arguments to pass to the notebooklm CLI, e.g. ["list", "--json"]. Excludes the notebooklm executable itself.',
				minItems: 1,
			}),
			confirm: Type.Optional(
				Type.Boolean({
					description: "Set true to confirm destructive operations (deletion, logout, new conversation, file overwrite, etc.).",
				}),
			),
			timeout_ms: Type.Optional(
				Type.Number({
					description: "Timeout in milliseconds (default 60000, max 600000).",
					minimum: 1000,
					maximum: MAX_TIMEOUT_MS,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const args: string[] = params.args;
			const timeoutMs = Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

			// -------------------------------------------------------------------
			// Validate inputs
			// -------------------------------------------------------------------
			if (!Array.isArray(args) || args.length === 0) {
				throw new Error("'args' must be a non-empty array of CLI argument strings.");
			}
		// --help / -h only bypass gates when before `--` (Click convention)
		if (!hasHelpFlag(args)) {
			const blocked = isBlockedInteractive(args);
			if (blocked.blocked) throw new Error(blocked.message);

			if (isDestructive(args)) {
				if (!params.confirm) {
					throw new Error(
						"Destructive operation requires `confirm: true`. " +
							`Command: notebooklm ${formatArgsForError(args)}`,
					);
				}
				if (requiresYesFlag(args)) {
					throw new Error(
						"This destructive command can prompt for confirmation and hang. " +
							"Add `--yes` (or `-y`) to the args array to confirm non-interactively. " +
							`Example: args: ${JSON.stringify(formatArgsForError(args))} plus --yes`,
					);
				}
			}
		}

		// -------------------------------------------------------------------
		// Validate: source add accepts exactly one CONTENT per call
		// -------------------------------------------------------------------
		if (args.length >= 3 && args[0] === "source" && args[1] === "add") {
			const { rest } = extractCommandPath(args.slice(2));
			const lastIsArg = rest.length > 0 && !rest[rest.length - 1].startsWith("-");
			const firstContent = rest.find((a) => !a.startsWith("-"));
			if (firstContent && lastIsArg && rest.indexOf(firstContent) !== rest.length - 1) {
				throw new Error(
					"notebooklm source add accepts exactly one source. " +
						"Add sources one at a time: call notebooklm separately for each URL/file/text.",
				);
			}
		}

		// -------------------------------------------------------------------
		// Validate: -n/--notebook after download subcommand must precede type
		// -------------------------------------------------------------------
		if (args[0] === "download") {
			const nbIndex = args.indexOf("-n") === -1 ? args.indexOf("--notebook") : args.indexOf("-n");
			if (nbIndex > 1 && nbIndex < args.length - 1) {
				throw new Error(
					"Place -n/--notebook immediately after 'download', before the artifact type. " +
						"Example: args: [\"download\", \"-n\", \"NOTEBOOK_ID\", \"audio\", ...]",
				);
			}
		}

			// -------------------------------------------------------------------
			// Helper: execute and format result
			// -------------------------------------------------------------------
			const doExec = async () => {
				let result;
				try {
					result = await pi.exec("notebooklm", args, {
						cwd: ctx.cwd,
						signal,
						timeout: timeoutMs,
					});
				} catch (err: unknown) {
					const e = err as Error & { code?: string; killed?: boolean; signal?: string };
					if (e?.message?.includes("ENOENT") || e?.code === "ENOENT") {
						throw new Error("notebooklm CLI not found in PATH. Install with: uv tool install 'notebooklm-py[browser]'");
					}
					if (e?.killed || e?.signal) {
						const isGenerate = args[0] === "generate";
						const hint = isGenerate
							? " Re-run with a longer timeout_ms or use notebooklm artifact poll <id> to check status."
							: "";
						throw new Error(`notebooklm command was cancelled (${e.message || "interrupted"}).${hint}`);
					}
					throw e;
				}

				const stdout = result.stdout ?? "";
				const stderr = result.stderr ?? "";

				// Check killed before exit code: killed may have a nonzero/null code
				if (result.killed) {
					const isGenerate = args[0] === "generate";
					const hint = isGenerate
						? " Re-run with a longer timeout_ms or use notebooklm artifact poll <id> to check status."
						: "";
					throw new Error(
						`notebooklm command was cancelled (${result.code == null ? "timeout" : "interrupted"})${hint}\n` +
							`  Args: notebooklm ${formatArgsForError(args)}`,
					);
				}

				if (result.code !== 0) {
					const msg = (stderr || stdout).slice(0, 2000);
					throw new Error(
						`notebooklm command failed (exit ${result.code})\n` +
							`  Args: notebooklm ${formatArgsForError(args)}\n` +
							`  Error: ${msg || "(empty)"}`,
					);
				}

				const outputText = stdout || stderr || "(empty response)";
				const { text: displayed, truncated, tempPath } = truncateOutput(outputText);

				const details: Record<string, unknown> = { exitCode: result.code };
				if (truncated) {
					details.truncated = true;
					if (tempPath) details.fullOutputPath = tempPath;
				}

				return {
					content: [{ type: "text" as const, text: displayed }],
					details,
				};
			};

			// -------------------------------------------------------------------
			// File mutation queue: serialize concurrent writes to the same path
			// -------------------------------------------------------------------
			const outputPaths = extractOutputPaths(args, ctx.cwd);
			if (outputPaths.length === 1) {
				return withFileMutationQueue(outputPaths[0], doExec);
			}
			if (outputPaths.length > 1) {
				return withFileMutationQueue(outputPaths[0], async () =>
					withFileMutationQueue(outputPaths[1], doExec),
				);
			}
			return doExec();
		},
	});
}
