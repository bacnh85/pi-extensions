import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { execObsidian } from "./lib/cli";
import {
	formatSearchResults,
	formatTasks,
	formatTasksFiltered,
	formatTags,
	formatLinks,
	formatOutline,
	formatOutgoingLinks,
	formatFileInfo,
	formatProperties,
	formatAliases,
	formatWordCount,
} from "./lib/format";

// ---------------------------------------------------------------------------
// CLI string parser
// ---------------------------------------------------------------------------

/** Read content inside a quoted string, handling \" and \\ escapes. */
function readQuotedContent(s: string, pos: number): string {
	let val = "";
	while (pos < s.length && s[pos] !== '"') {
		if (s[pos] === "\\" && pos + 1 < s.length && (s[pos + 1] === '"' || s[pos + 1] === "\\")) {
			pos++; val += s[pos++];
		} else {
			val += s[pos++];
		}
	}
	return val;
}

/**
 * Parse a CLI command string into argument tokens, respecting quoted values.
 * Values with spaces MUST be quoted. Bare quotes inside a word (e.g. after `=`)
 * start an inline quoted segment: `file="Meeting Notes"` → `file=Meeting Notes`.
 */
function parseCliString(s: string): string[] {
	const args: string[] = [];
	let i = 0;
	while (i < s.length) {
		while (i < s.length && /\s/.test(s[i])) i++;
		if (i >= s.length) break;

		let val = "";
		if (s[i] === '"') {
			i++;
			val = readQuotedContent(s, i);
			i += val.length + 1;
		} else {
			while (i < s.length && !/\s/.test(s[i])) {
				if (s[i] === '"') {
					i++;
					const inner = readQuotedContent(s, i);
					val += inner;
					i += inner.length + 1;
				} else {
					val += s[i++];
				}
			}
		}
		args.push(val);
	}
	return args;
}

/** Extract flags from run string: `key=value` pairs. */
function parseFlags(s: string): Record<string, string> {
	const flags: Record<string, string> = {};
	const re = /(\w[\w-]*)=("(?:[^"\\]|\\.)*"|\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		let val = m[2];
		if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
		flags[m[1]] = val;
	}
	return flags;
}

// ponytail: create parent folder via Obsidian CLI eval, 1 line
function ensureFolder(path: string, vault?: string, timeoutMs = 30_000): void {
	const parent = path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
	if (!parent) return;
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push("eval", `code=app.vault.getAbstractFileByPath(${JSON.stringify(parent)})?true:app.vault.createFolder(${JSON.stringify(parent)},true)`);
	execObsidian(args, false, timeoutMs);
}

// ---------------------------------------------------------------------------
// Higher-level operations beyond raw CLI
// ---------------------------------------------------------------------------

/** Recursive file listing via multiple CLI calls. */
function listFilesRecursive(folder: string, vault?: string, timeoutMs = 30_000): string[] {
	const results: string[] = [];
	const queue = [folder.replace(/\/+$/, "")];
	const seen = new Set<string>();

	while (queue.length > 0) {
		const dir = queue.pop()!;
		const args: string[] = [];
		if (vault) args.push(`vault=${vault}`);
		args.push("files", `folder=${dir}`, "format=json");
		const r = execObsidian(args, false, timeoutMs);
		if (!r.parsed || !Array.isArray(r.parsed)) continue;

		for (const item of r.parsed as string[]) {
			if (seen.has(item)) continue;
			seen.add(item);
			const fullPath = dir ? `${dir}/${item}` : item;
			if (!item.includes(".") && !item.endsWith("/")) {
				queue.push(fullPath);
			}
			results.push(fullPath);
		}
	}
	return results;
}

/** Create a task line in a note under a specific heading. */
function createTaskInNote(
	notePath: string, heading: string, taskText: string,
	vault?: string, timeoutMs = 30_000
): string {
	const readArgs: string[] = [];
	if (vault) readArgs.push(`vault=${vault}`);
	readArgs.push("read", `path=${notePath}`);
	const readR = execObsidian(readArgs, false, timeoutMs);
	const content = readR.stdout;
	const lines = content.split("\n");

	let headingIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith("#") && trimmed.replace(/^#+\s*/, "") === heading) {
			headingIdx = i;
			break;
		}
	}

	if (headingIdx === -1) {
		const taskLine = `\n## ${heading}\n- [ ] ${taskText}\n`;
		const appendArgs: string[] = [];
		if (vault) appendArgs.push(`vault=${vault}`);
		appendArgs.push("append", `path=${notePath}`, `content=${escapeCliValue(taskLine)}`);
		execObsidian(appendArgs, false, timeoutMs);
		return `Created heading "${heading}" and added task.`;
	}

	const match = lines[headingIdx].match(/^(#+)\s/);
	const headingLevel = match ? match[1].length : 2;
	let sectionEnd = lines.length;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		const m = lines[i].match(/^(#+)\s/);
		if (m && m[1].length <= headingLevel) { sectionEnd = i; break; }
	}

	lines.splice(sectionEnd, 0, `- [ ] ${taskText}`);
	const writeArgs: string[] = [];
	if (vault) writeArgs.push(`vault=${vault}`);
	writeArgs.push("create", `path=${notePath}`, "overwrite=true", `content=${escapeCliValue(lines.join("\n"))}`);
	execObsidian(writeArgs, false, timeoutMs);
	return `Added task "${taskText}" under heading "${heading}".`;
}



/** Create a note from a template with frontmatter values filled in. */
function createFromTemplate(
	templateName: string, noteName: string, folder: string,
	fill: Record<string, string>, vault?: string, timeoutMs = 30_000
): string {
	const readArgs: string[] = [];
	if (vault) readArgs.push(`vault=${vault}`);
	readArgs.push("read", `file=${templateName}`);
	const template = execObsidian(readArgs, false, timeoutMs).stdout;

	let content = template;
	for (const [key, val] of Object.entries(fill)) {
		content = content.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"), val);
	}

	const notePath = folder ? `${folder}/${noteName}` : noteName;
	const writeArgs: string[] = [];
	if (vault) writeArgs.push(`vault=${vault}`);
	writeArgs.push("create", `path=${notePath}`, "overwrite=true", `content=${escapeCliValue(content)}`);
	execObsidian(writeArgs, false, timeoutMs);
	return `Created note "${notePath}" from template "${templateName}".`;
}

function escapeCliValue(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t");
}

// ponytail: renameTag via Obsidian eval — 15 lines, not 140
function renameTag(from: string, to: string, vault?: string, timeoutMs = 30_000): string {
	const fqFrom = JSON.stringify(from);
	const fqTo = JSON.stringify(to);
	const script = `
const files = app.vault.getMarkdownFiles();
let u = 0, s = 0;
for (const f of files) {
  let c = await app.vault.read(f);
  const o = c;
  let m = c.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) { s++; continue; }
  let fm = m[1];
  let nfm = fm.replace(/\btags\b[^]*?(?=\n---|$)/g, (tl) => tl.replaceAll(${fqFrom}, ${fqTo}));
  if (nfm === fm) { s++; continue; }
  c = '---\n' + nfm + '\n---' + c.slice(m[0].length);
  await app.vault.modify(f, c); u++;
}
return \`tag-rename: \${u} files updated, \${s} skipped.\`;
`.trim();
	// ponytail: pass script through read-from-note or inline. Inline via eval.
	const evalArgs: string[] = [];
	if (vault) evalArgs.push(`vault=${vault}`);
	evalArgs.push("eval", `code=(async function(){${script}})()`);
	return execObsidian(evalArgs, false, timeoutMs).stdout.trim() || "Done.";
}

// ---------------------------------------------------------------------------
// Route JSON output to the correct formatter based on command
// ---------------------------------------------------------------------------

function formatObsidianOutput(cmdString: string, parsed: unknown): string {
	if (cmdString.startsWith("search")) {
		const flags = parseFlags(cmdString);
		return formatSearchResults(parsed, flags.group === "file");
	}
	if (cmdString.startsWith("tasks ") || cmdString.startsWith("tasks")) {
		const flags = parseFlags(cmdString);
		if (flags.group === "file" && flags.status) {
			return formatTasksFiltered(parsed, flags.status as "open" | "done" | "all");
		}
		if (flags.group === "file") return formatTasks(parsed, true);
		if (flags.status) return formatTasksFiltered(parsed, flags.status as "open" | "done" | "all");
		return formatTasks(parsed);
	}
	if (cmdString.startsWith("tag ") || cmdString.startsWith("tags")) return formatTags(parsed);
	if (cmdString.startsWith("property:") || cmdString.startsWith("properties")) return formatProperties(parsed);
	if (cmdString.startsWith("backlinks")) return formatLinks(parsed, "Backlinks");
	if (cmdString.startsWith("links")) return formatOutgoingLinks(parsed);
	if (cmdString.startsWith("outline")) return formatOutline(parsed);
	if (cmdString.startsWith("aliases")) return formatAliases(parsed);
	if (cmdString.startsWith("wordcount")) return formatWordCount(parsed);
	if (cmdString.startsWith("file ")) return formatFileInfo(parsed);
	return JSON.stringify(parsed, null, 2);
}

// ---------------------------------------------------------------------------
// Tool wrapper
// ---------------------------------------------------------------------------

function tool(body: (p: Record<string, unknown>) => string) {
	return async function execute() {
		try {
			const text = body(arguments[1] as Record<string, unknown>);
			return { content: [{ type: "text" as const, text }], details: {} };
		} catch (err: any) {
			throw new Error(err.message ?? String(err));
		}
	};
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function piObsidianExtension(pi: ExtensionAPI) {

	pi.registerTool({
		name: "obsidian",
		label: "Run Obsidian CLI Command",
		description: "Run any Obsidian CLI command against the vault: read, write, create, search, delete, move, rename, append, prepend, tasks, properties, history, daily notes, templates, bookmarks, plugins, and more. For create/write with complex content containing double quotes, use content_from=SourceNoteName instead of content=.",
		promptSnippet: "Run an Obsidian CLI command on the vault",
		promptGuidelines: [
			"Run any Obsidian CLI command via the `run` parameter.",
			"Format: `<command> <key=value> ... <flag>`",
			"Quote values with spaces: `file=\"My Note\"`, `content=\"# Title\\n\\nBody\"`.",
			"For content with double quotes, use `content_from=SourceNoteName` to read from a vault note instead.",
			"For complex JS eval, use `eval file=ScriptNoteName` to execute from a vault note.",
			"Boolean flags: `permanent`, `overwrite`, `total`, `verbose`, `inline`, `silent`.",
			"Add `format=json` for structured output (search, tasks, tags, outline, backlinks).",
			"Use `file=` for wikilink names, `path=` for exact paths.",
			"",
			"=== Commands ===",
			"  read file=\"Meeting Notes\"              — read by wikilink",
			"  read path=\"folder/note.md\"              — read by path",
			"  create path=note.md overwrite=true content=\"# Title\"  — create/overwrite",
			"  create path=note.md overwrite=true content_from=SourceNote  — read content from note",
			"  append path=note.md content=\"text\"       — append to end",
			"  prepend path=note.md content=\"# Header\"  — prepend to beginning",
			"  delete path=old.md permanent=true         — permanently delete",
			"  move file=Note to=\"01 Projects/\"         — move to folder",
			"  rename file=Note name=\"New Name\"         — rename in place",
			"  search query=roadmap limit=10             — full-text search",
			"  tags counts=true sort=count format=json   — list tags with counts",
			"  tag name=\"#type/reference\" verbose         — tag details + files",
			"  tag-rename from=\"#old\" to=\"#new\"          — rename a tag across all files",
			"  property:set file=Note name=status value=active  — set frontmatter",
			"  properties format=json                      — vault-wide properties",
			"  tasks format=json                            — all tasks",
			"  tasks format=json group=file                 — tasks grouped by file",
			"  tasks format=json status=open                — only open tasks",
			"  task-create path=note.md heading=\"Tasks\" text=\"New task\"  — create a task",
			"  create-from-template template=\"...\" name=\"...\" folder=\"...\"",
			"  backlinks file=Note format=json             — list backlinks",
			"  outline file=Note                            — heading outline",
			"  links file=Note                              — outgoing wikilinks",
			"  daily:read / daily:append / daily:path      — daily note operations",
			"  vault                                       — vault info",
			"  files folder=\"01 Projects\"                 — list files (direct children)",
			"  files folder=\"/\"                            — list root files",
			"  files folder=\"01 Projects\" recursive        — recursive file listing",
			"  history file=Note / diff file=Note from=1 to=3",
			"  templates                                   — list templates",
			"  eval code=\"app.vault.getFiles().length\"     — run JS inline",
			"  eval file=ScriptNoteName                    — run JS from a vault note",
		],
		parameters: Type.Object({
			run: Type.String({
				description: "Full Obsidian CLI command. Use content_from=NoteName for content with quotes, eval file=NoteName for complex JS."
			}),
			vault: Type.Optional(Type.String({ description: "Target vault name. Defaults to most recently focused." })),
			timeout_ms: Type.Optional(Type.Number({ description: "Command timeout in milliseconds (default 30000 ms = 30s)." })),
		}),
		execute: tool((p) => {
			let raw = (p.run as string).trim();
			if (!raw) throw new Error("'run' is required.");
			const cmds = raw.split(/\s+/);
			const cmd = cmds[0];
			const timeoutMs = (p.timeout_ms as number) ?? 30_000;
			const vaultOpt = p.vault as string | undefined;

			// --- Fix B4: files folder="/" → list root children ---
			if (cmd === "files") {
				const flags = parseFlags(raw);
				const folder = flags.folder ?? "";

				// Handle root folder
				if (folder === "/" || folder === "") {
					if (raw.includes("recursive")) {
						return listFilesRecursive(folder, vaultOpt, timeoutMs).sort().join("\n") || "No files found.";
					}
					const args: string[] = [];
					if (vaultOpt) args.push(`vault=${vaultOpt}`);
					args.push("files", "folder=/", "format=json");
					try {
						const r = execObsidian(args, false, timeoutMs);
						if (r.parsed && Array.isArray(r.parsed) && r.parsed.length > 0) {
							return (r.parsed as string[]).sort().join("\n");
						}
					} catch {
						// Fall through to return empty
					}
					return "No files found at root.";
				}

				// Recursive listing
				if (raw.includes("recursive")) {
					const files = listFilesRecursive(folder, vaultOpt, timeoutMs);
					if (files.length === 0) return "No files found.";
					return files.sort().join("\n");
				}
			}

			// --- Fix B5: tag-rename command ---
			if (cmd === "tag-rename") {
				const flags = parseFlags(raw);
				const from = flags.from || "";
				const to = flags.to || "";
				if (!from || !to) throw new Error("'from' and 'to' are required for tag-rename.");
				return renameTag(from, to, vaultOpt, timeoutMs);
			}

			// --- eval: inline or read from vault note, then exec ---
			if (cmd === "eval") {
				const flags = parseFlags(raw);
				const file = flags.file || "";
				let code = flags.code || "";
				if (file) {
					const readArgs: string[] = [];
					if (vaultOpt) readArgs.push(`vault=${vaultOpt}`);
					readArgs.push("read", `path=${file}`);
					code = execObsidian(readArgs, false, timeoutMs).stdout;
				}
				if (!code) throw new Error("'code=' or 'file=' is required for eval.");
				const evalArgs: string[] = [];
				if (vaultOpt) evalArgs.push(`vault=${vaultOpt}`);
				evalArgs.push("eval", `code=(async function(){${code}})()`);
				return execObsidian(evalArgs, false, timeoutMs).stdout.trim() || "Done.";
			}

			// --- content_from: read from vault note, write via CLI ---
			if (cmd === "create" || cmd === "write" || cmd === "overwrite") {
				const flags = parseFlags(raw);
				const contentFrom = flags.content_from || "";
				const path = flags.path || "";

				if (contentFrom && path) {
					const readArgs: string[] = [];
					if (vaultOpt) readArgs.push(`vault=${vaultOpt}`);
					readArgs.push("read", `path=${contentFrom}`);
					const content = execObsidian(readArgs, false, timeoutMs).stdout;
					ensureFolder(path, vaultOpt, timeoutMs);
					const createArgs: string[] = [];
					if (vaultOpt) createArgs.push(`vault=${vaultOpt}`);
					createArgs.push("create", `path=${path}`, `content=${escapeCliValue(content)}`);
					if (raw.includes("overwrite=true")) createArgs.push("overwrite=true");
					return (execObsidian(createArgs, false, timeoutMs).stdout.trim() || `Created note from "${contentFrom}".`);
				}
				if (path) ensureFolder(path, vaultOpt, timeoutMs);
			}

			// ponytail: property:set array values — strip space after commas, 1 regex
			if (cmd === "property:set") {
				raw = raw.replace(/(value=)\[([^\]]*)\]/g, (_, p, inner) => p + "[" + inner.replace(/,\s*/g, ",") + "]");
			}

			// --- Standard CLI passthrough ---
			let args = parseCliString(raw);
			// ponytail: rejoin value= that split at commas (Obsidian CLI limitation)
			if (cmd === "property:set") {
				const ai = args.findIndex(a => a.startsWith("value="));
				if (ai >= 0 && !args[ai].endsWith("]")) {
					const joined = [args[ai].slice(6), ...args.slice(ai + 1)].join(" ");
					args = [...args.slice(0, ai), `value=${joined}`, ...args.slice(ai + 2)];
				}
			}

			if (vaultOpt) args.unshift(`vault=${vaultOpt}`);

			const r = execObsidian(args, false, timeoutMs);

			// Route JSON output to formatters
			if (r.parsed && typeof r.parsed !== "string") {
				return formatObsidianOutput(raw, r.parsed);
			}
			return r.stdout.trim() || "Done.";
		}),
	});
}
