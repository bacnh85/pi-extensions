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

// ---------------------------------------------------------------------------
// Fix B1/B6: Pre-process run string to escape bare " in content/code values
// ---------------------------------------------------------------------------

/**
 * Before parsing, escape bare double quotes inside known multi-line parameters
 * (content=, code=). This prevents truncation when the value contains unescaped ".
 *
 * Strategy: find `param="` then walk char by char counting escapes until we find
 * the matching closing `"`, escaping any bare `"` along the way.
 */
function preprocessArgValue(raw: string, param: string): string {
	const pattern = `${param}=`;
	let result = "";
	let i = 0;
	while (i < raw.length) {
		const idx = raw.indexOf(pattern, i);
		if (idx < 0) { result += raw.slice(i); break; }
		result += raw.slice(i, idx + pattern.length);
		i = idx + pattern.length;

		// Value must start with quote to need escaping
		if (i >= raw.length || raw[i] !== '"') continue;
		result += '"';
		i++;

		// Walk the quoted value, escaping bare " to \"
		while (i < raw.length) {
			if (raw[i] === '\\' && i + 1 < raw.length && (raw[i + 1] === '"' || raw[i + 1] === '\\')) {
				result += raw[i] + raw[i + 1];
				i += 2;
			} else if (raw[i] === '"') {
				// Check if this is the closing quote or a bare quote inside
				// Peek ahead: if followed by space, end of param, or ) it's closing
				const next = raw[i + 1];
				if (next === undefined || next === ' ' || next === '\t' || next === '\n' || next === ')' || next === ']') {
					result += '"';
					i++;
					break;
				}
				// Bare quote inside content — escape it
				result += '\\"';
				i++;
			} else {
				result += raw[i];
				i++;
			}
		}
	}
	return result;
}

function preprocessRunString(raw: string): string {
	let s = raw;
	// ponytail: handle content= and code= — the two params that carry arbitrary text
	s = preprocessArgValue(s, "content");
	s = preprocessArgValue(s, "code");
	return s;
}

// ---------------------------------------------------------------------------
// Fix B2: Helpers for handling array values in property:set
// ---------------------------------------------------------------------------

/** Check if a string looks like a JSON array `[...]`. */
function looksLikeArray(s: string): boolean {
	const t = s.trim();
	return t.startsWith("[") && t.endsWith("]");
}

/** Parse tokens that may be split across args (e.g. property value with spaces). */
function joinPropertyValue(cmd: string, args: string[], startIdx: number): string[] {
	// For property:set, the value= param may have been split. Rejoin segments.
	if (cmd !== "property:set") return args;

	const result: string[] = [];
	let valAccum: string[] | null = null;

	for (const a of args) {
		if (a.startsWith("value=") || valAccum !== null) {
			if (valAccum === null) {
				valAccum = [a.substring(6)]; // strip "value="
			} else {
				valAccum.push(a);
			}
			// Heuristic: value is complete when it ends with ] or is the last arg
			if (a.endsWith("]") || a === args[args.length - 1]) {
				const joined = valAccum.join(" ");
				result.push(`value=${joined}`);
				valAccum = null;
			}
		} else {
			result.push(a);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Fix B3: Ensure parent directory exists before create
// ---------------------------------------------------------------------------

function ensureFolderExists(path: string, vault?: string, timeoutMs = 30_000): void {
	const parts = path.replace(/\\/g, "/").split("/");
	if (parts.length <= 1) return;
	const folderPath = parts.slice(0, -1).join("/");
	// Check if parent folder exists via files listing
	const checkArgs: string[] = [];
	if (vault) checkArgs.push(`vault=${vault}`);
	checkArgs.push("files", `folder=${folderPath}`, "format=json");
	try {
		execObsidian(checkArgs, false, timeoutMs);
	} catch {
		// Folder doesn't exist — create it with the Obsidian CLI
		// ponytail: mkdir via creating a dummy file and deleting it is fragile;
		// use eval to create the folder via the Obsidian API instead
		const createArgs: string[] = [];
		if (vault) createArgs.push(`vault=${vault}`);
		// The CLI doesn't have native mkdir; try to create the path
		// by writing an empty file — the CLI may create folders implicitly
		const dummyPath = `${folderPath}/.mkdir`;
		const writeArgs: string[] = [];
		if (vault) writeArgs.push(`vault=${vault}`);
		writeArgs.push("create", `path=${dummyPath}`, "overwrite=true", 'content=""');
		try {
			execObsidian(writeArgs, false, timeoutMs);
			// Clean up the dummy file
			const delArgs: string[] = [];
			if (vault) delArgs.push(`vault=${vault}`);
			delArgs.push("delete", `path=${dummyPath}`, "permanent=true");
			execObsidian(delArgs, false, timeoutMs);
		} catch {
			// Give up — let the create command fail with a clear error
		}
	}
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

/** Read a vault note's content and return it. Used by content_from and eval file=. */
function readNoteContent(notePath: string, vault?: string, timeoutMs = 30_000): string {
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push("read", `path=${notePath}`);
	return execObsidian(args, false, timeoutMs).stdout;
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

// ---------------------------------------------------------------------------
// Fix B5: tag-rename command
// ---------------------------------------------------------------------------

function renameTag(from: string, to: string, vault?: string, timeoutMs = 30_000): string {
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push("tags", "format=json");
	const r = execObsidian(args, false, timeoutMs);
	if (!r.parsed || !Array.isArray(r.parsed)) return "No tags found.";

	const tagMap = new Map<string, number>();
	for (const t of r.parsed as Array<{ tag?: string; count?: number }>) {
		const tag = t.tag ?? "";
		if (tag === from || tag === to) tagMap.set(tag, t.count ?? 1);
	}

	if (!tagMap.has(from)) return `Tag "${from}" not found in vault.`;

	// Get all files with the old tag
	const findArgs: string[] = [];
	if (vault) findArgs.push(`vault=${vault}`);
	findArgs.push("tag", `name=${from}`, "verbose", "format=json");
	const findR = execObsidian(findArgs, false, timeoutMs);
	const files = (findR.parsed as Array<{ filename?: string }> | null) ?? [];

	if (files.length === 0) return `No files found with tag "${from}".`;

	let updated = 0;
	let skipped = 0;

	for (const f of files) {
		const filePath = f.filename ?? "";
		if (!filePath) { skipped++; continue; }

		// Read the file
		const readArgs2: string[] = [];
		if (vault) readArgs2.push(`vault=${vault}`);
		readArgs2.push("read", `path=${filePath}`);
		const readR2 = execObsidian(readArgs2, false, timeoutMs);
		const content = readR2.stdout;
		const original = content;

		// Find frontmatter
		const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
		if (!fmMatch) { skipped++; continue; }
		const fm = fmMatch[1];

		// Find tags line
		const lines = fm.split("\n");
		let tagLineIdx = -1;
		for (let li = 0; li < lines.length; li++) {
			if (lines[li].trim().startsWith("tags:")) { tagLineIdx = li; break; }
		}
		if (tagLineIdx < 0) { skipped++; continue; }

		let modified = false;

		// Handle inline array: tags: ["a", "b"]
		const inlineMatch = fm.match(/^tags:\s*\[([\s\S]*?)\]\s*$/m);
		if (inlineMatch) {
			const raw = inlineMatch[1];
			const parts: string[] = [];
			let cur = "";
			let inQ = false;
			const q = '"';
			for (let ci = 0; ci < raw.length; ci++) {
				const ch = raw[ci];
				if (ch === q) { inQ = !inQ; continue; }
				if (ch === "," && !inQ) { parts.push(cur.trim()); cur = ""; continue; }
				cur += ch;
			}
			if (cur.trim()) parts.push(cur.trim());

			const newParts = parts.map((p) => p === from || p === `"${from}"` ? to : p);
			if (newParts.some((p, i) => p !== parts[i])) {
				modified = true;
				const needsQ = (t: string) => t.includes(" ") || t.startsWith("#");
				const inlineStr = newParts.map((t) => needsQ(t) ? `"${t}"` : t).join(", ");
				lines[tagLineIdx] = `tags: [${inlineStr}]`;
			}
		}

		// Handle indented list: tags:\n  - item
		if (lines[tagLineIdx].trim() === "tags:" || lines[tagLineIdx].trim() === "tags") {
			const listItems: Array<{ orig: string; text: string }> = [];
			for (let li2 = tagLineIdx + 1; li2 < lines.length; li2++) {
				const l = lines[li2];
				const trimmed = l.trim();
				if (!trimmed.startsWith("- ")) break;
				const q = '"';
				let text = trimmed.substring(2).trim();
				if (text.startsWith(q)) text = text.substring(1);
				if (text.endsWith(q)) text = text.substring(0, text.length - 1);
				listItems.push({ orig: trimmed, text });
			}

			let changed = false;
			const newItems = listItems.map((item) => {
				if (item.text === from || item.text === `"${from}"`) {
					changed = true;
					const q2 = '"';
					return `  - ${q2}${to}${q2}`;
				}
				return item.orig;
			});

			if (changed) {
				modified = true;
				const before = lines.slice(0, tagLineIdx + 1);
				const after = lines.slice(tagLineIdx + 1 + listItems.length);
				const all = before.concat(newItems).concat(after);
				// Rebuild the frontmatter tag section
				lines.length = 0;
				lines.push(...all);
			}
		}

		if (!modified) { skipped++; continue; }

		const newFm = lines.join("\n");
		const newContent = "---\n" + newFm + "\n---" + content.slice(fmMatch[0].length);
		if (newContent === original) { skipped++; continue; }

		// Write back
		const writeArgs2: string[] = [];
		if (vault) writeArgs2.push(`vault=${vault}`);
		writeArgs2.push("create", `path=${filePath}`, "overwrite=true", `content=${escapeCliValue(newContent)}`);
		execObsidian(writeArgs2, false, timeoutMs);
		updated++;
	}

	return `tag-rename: ${updated} files updated, ${skipped} skipped.`;
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

			// --- Fix B6: eval file=path support ---
			if (cmd === "eval") {
				const flags = parseFlags(raw);
				const file = flags.file || "";
				const code = flags.code || "";

				if (file) {
					// Read script from vault note and execute it
					const readArgs: string[] = [];
					if (vaultOpt) readArgs.push(`vault=${vaultOpt}`);
					readArgs.push("read", `path=${file}`);
					const script = execObsidian(readArgs, false, timeoutMs).stdout;
					// Execute the script via eval in Obsidian
					const evalArgs: string[] = [];
					if (vaultOpt) evalArgs.push(`vault=${vaultOpt}`);
					evalArgs.push("eval", `code=(async function(){${script}})()`);
					const result = execObsidian(evalArgs, false, timeoutMs);
					return result.stdout.trim() || "Script executed (no output).";
				}

				if (code) {
					// Standard inline eval — passes through to CLI
					const evalArgs: string[] = [];
					if (vaultOpt) evalArgs.push(`vault=${vaultOpt}`);
					evalArgs.push("eval", `code=${code}`);
					const result = execObsidian(evalArgs, false, timeoutMs);
					return result.stdout.trim() || "Done.";
				}

				throw new Error("'code=' or 'file=' is required for eval.");
			}

			// --- Fix B1: content_from support for create/write ---
			if (cmd === "create" || cmd === "write" || cmd === "overwrite") {
				const flags = parseFlags(raw);
				const contentFrom = flags.content_from || "";
				const path = flags.path || "";

				if (contentFrom && path) {
					// Read content from the source note
					const content = readNoteContent(contentFrom, vaultOpt, timeoutMs);
					// Build the CLI args with properly escaped content
					const createArgs: string[] = [];
					if (vaultOpt) createArgs.push(`vault=${vaultOpt}`);
					createArgs.push("create", `path=${path}`);
					if (raw.includes("overwrite=true")) createArgs.push("overwrite=true");
					createArgs.push(`content=${escapeCliValue(content)}`);
					// Fix B3: ensure parent folder exists
					ensureFolderExists(path, vaultOpt, timeoutMs);
					const r = execObsidian(createArgs, false, timeoutMs);
					return r.stdout.trim() || `Created note "${path}" from "${contentFrom}".`;
				}

				// Standard create — ensure parent folder exists (Fix B3)
				if (path) ensureFolderExists(path, vaultOpt, timeoutMs);
			}

			// --- Fix B2: handle property:set with array values ---
			if (cmd === "property:set") {
				// Pre-process the raw string to handle array value=[a,b] without spaces
				// (spaces inside array values would have been split by parseCliString)
				const rawNormalized = raw.replace(/(value=)\[([^\]]*)\]/g, (match, prefix, inner) => {
					// Remove spaces after commas inside the array
					return prefix + "[" + inner.replace(/,\s*/g, ",") + "]";
				});
				raw = rawNormalized;
			}

			// --- Fix B1/B6: pre-process to escape bare quotes in content=/code= ---
			raw = preprocessRunString(raw);

			// --- Standard CLI passthrough ---
			let args = parseCliString(raw);

			// Fix B2: rejoin split property:set values
			args = joinPropertyValue(cmd, args, 0);

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
