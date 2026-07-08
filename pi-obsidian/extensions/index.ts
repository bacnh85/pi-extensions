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
			i++; // skip opening quote
			val = readQuotedContent(s, i);
			i += val.length + 1; // skip read content + closing quote
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
	// Matches key=value where value may be quoted
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
			// ponytail: items without extension are likely subfolders
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
	// Read note content
	const readArgs: string[] = [];
	if (vault) readArgs.push(`vault=${vault}`);
	readArgs.push("read", `path=${notePath}`);
	const readR = execObsidian(readArgs, false, timeoutMs);
	const content = readR.stdout;
	const lines = content.split("\n");

	// Find the target heading
	let headingIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith("#") && trimmed.replace(/^#+\s*/, "") === heading) {
			headingIdx = i;
			break;
		}
	}

	if (headingIdx === -1) {
		// No heading found — append heading + task
		const taskLine = `\n## ${heading}\n- [ ] ${taskText}\n`;
		const appendArgs: string[] = [];
		if (vault) appendArgs.push(`vault=${vault}`);
		appendArgs.push("append", `path=${notePath}`, `content=${escapeCliValue(taskLine)}`);
		execObsidian(appendArgs, false, timeoutMs);
		return `Created heading "${heading}" and added task.`;
	}

	// Find section end (next heading at <= level)
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
	// Read template content
	const readArgs: string[] = [];
	if (vault) readArgs.push(`vault=${vault}`);
	readArgs.push("read", `file=${templateName}`);
	const template = execObsidian(readArgs, false, timeoutMs).stdout;

	// ponytail: simple frontmatter template filling — replace {{key}} placeholders
	let content = template;
	for (const [key, val] of Object.entries(fill)) {
		content = content.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"), val);
	}

	// Write the new note
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
// Tool wrapper — extracts params, catches errors
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
		description: "Run any Obsidian CLI command against the vault: read, write, create, search, delete, move, rename, append, prepend, tasks, properties, history, daily notes, templates, bookmarks, plugins, and more.",
		promptSnippet: "Run an Obsidian CLI command on the vault",
		promptGuidelines: [
			"Run any Obsidian CLI command via the `run` parameter.",
			"Format: `<command> <key=value> ... <flag>`",
			"Quote values with spaces: `file=\"My Note\"`, `content=\"# Title\\n\\nBody\"`.",
			"Boolean flags: `permanent`, `overwrite`, `total`, `verbose`, `inline`, `silent`.",
			"Add `format=json` for structured output (search, tasks, tags, outline, backlinks).",
			"Use `file=` for wikilink names, `path=` for exact paths.",
			"",
			"=== Commands ===",
			"  read file=\"Meeting Notes\"              — read by wikilink",
			"  read path=\"folder/note.md\"              — read by path",
			"  create path=note.md overwrite=true content=\"# Title\"  — create/overwrite",
			"  append path=note.md content=\"text\"       — append to end",
			"  prepend path=note.md content=\"# Header\"  — prepend to beginning",
			"  delete path=old.md permanent=true         — permanently delete",
			"  move file=Note to=\"01 Projects/\"         — move to folder",
			"  rename file=Note name=\"New Name\"         — rename in place",
			"  search query=roadmap limit=10             — full-text search",
			"  search query=roadmap group=file            — search results grouped by file",
			"  tags counts=true sort=count format=json   — list tags with counts",
			"  tag name=\"#type/reference\" verbose         — tag details + files",
			"  property:set file=Note name=status value=active  — set frontmatter",
			"  properties format=json                      — vault-wide properties",
			"  tasks format=json                            — all tasks",
			"  tasks format=json group=file                 — tasks grouped by file",
			"  tasks format=json status=open                — only open tasks",
			"  tasks format=json group=file status=done     — done tasks grouped by file",
			"  task file=todo.md line=12 done              — mark task done",
			"  task-create path=note.md heading=\"Tasks\" text=\"New task\"  — create a task",
			"  create-from-template template=\"Project Brief\" name=\"New Note\" folder=\"01 Projects\" title=\"My Project\"",
			"  backlinks file=Note format=json             — list backlinks",
			"  outline file=Note                            — heading outline",
			"  links file=Note                              — outgoing wikilinks",
			"  daily:read                                  — read daily note",
			"  daily:append content=\"- [ ] Task\"          — append to daily",
			"  daily:path                                  — daily note path",
			"  vault                                       — vault info",
			"  files folder=\"01 Projects\"                 — list files (direct children)",
			"  files folder=\"01 Projects\" recursive        — recursive file listing",
			"  history file=Note                            — version history",
			"  diff file=Note from=1 to=3                   — diff versions",
			"  templates                                   — list templates",
			"  eval code=\"app.vault.getFiles().length\"     — run JS",
		],
		parameters: Type.Object({
			run: Type.String({
				description: "Full Obsidian CLI command. Examples: 'read file=Meeting Notes', 'create name=Test content=# Hello', 'search query=roadmap limit=5', 'delete path=old.md permanent=true', 'files folder=\"01 Projects\" recursive', 'task-create path=note.md heading=Tasks text=\"New task\"'"
			}),
			vault: Type.Optional(Type.String({ description: "Target vault name. Defaults to most recently focused." })),
			timeout_ms: Type.Optional(Type.Number({ description: "Command timeout in milliseconds (default 30000 ms = 30s)." })),
		}),
		execute: tool((p) => {
			const raw = (p.run as string).trim();
			if (!raw) throw new Error("'run' is required.");
			const cmds = raw.split(/\s+/);
			const cmd = cmds[0];
			const timeoutMs = (p.timeout_ms as number) ?? 30_000;

			// --- High-level operations ---

			// Recursive file listing
			if (cmd === "files" && raw.includes("recursive")) {
				const flags = parseFlags(raw);
				const folder = flags.folder ?? "";
				const files = listFilesRecursive(folder, p.vault as string | undefined, timeoutMs);
				if (files.length === 0) return "No files found.";
				return files.sort().join("\n");
			}

			// Task creation
			if (cmd === "task-create") {
				const flags = parseFlags(raw);
				const path = flags.path || flags.file || "";
				if (!path) throw new Error("'path' is required for task-create.");
				const heading = flags.heading || "Tasks";
				const text = flags.text || "";
				if (!text) throw new Error("'text' is required for task-create.");
				return createTaskInNote(path, heading, text, p.vault as string | undefined, timeoutMs);
			}

			// Create from template
			if (cmd === "create-from-template") {
				const flags = parseFlags(raw);
				const template = flags.template || "";
				const name = flags.name || "";
				if (!template || !name) throw new Error("'template' and 'name' are required for create-from-template.");
				const folder = flags.folder || "";
				const fill: Record<string, string> = {};
				for (const [k, v] of Object.entries(flags)) {
					if (!["template", "name", "folder", "vault"].includes(k)) fill[k] = v;
				}
				return createFromTemplate(template, name, folder, fill, p.vault as string | undefined, timeoutMs);
			}

			// --- Standard CLI passthrough ---
			const args = parseCliString(raw);
			if (p.vault) args.unshift(`vault=${p.vault}`);
			const r = execObsidian(args, false, timeoutMs);

			// Route JSON output to formatters
			if (r.parsed && typeof r.parsed !== "string") {
				return formatObsidianOutput(raw, r.parsed);
			}
			return r.stdout.trim() || "Done.";
		}),
	});
}
