import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { execObsidian, buildArgs } from "./lib/cli";
import {
	formatSearchResults,
	formatTasks,
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
// Shared schemas
// ---------------------------------------------------------------------------

const fileRef = {
	file: Type.Optional(Type.String({ description: "Resolve name like a wikilink (no extension needed)." })),
	path: Type.Optional(Type.String({ description: "Exact vault-relative path, e.g. 'folder/note.md'." })),
};

const vaultParam = {
	vault: Type.Optional(Type.String({ description: "Target vault name. Defaults to most recently focused." })),
};

const timeoutParam = {
	timeout_ms: Type.Optional(Type.Number({ description: "Command timeout in milliseconds. Default 30000." })),
};

// ---------------------------------------------------------------------------
// Helper: run obsidian
// ---------------------------------------------------------------------------

function run(cmd: string, p: Record<string, unknown>, flags: string[] = []): string {
	const args = buildArgs(cmd, p, flags);
	if (p.vault) args.unshift(`vault=${p.vault}`);
	const r = execObsidian(args, false, (p.timeout_ms as number) ?? 30_000);
	return r.stdout.trim();
}

function runJson(cmd: string, p: Record<string, unknown>, flags: string[] = []): unknown {
	const args = buildArgs(cmd, p, flags);
	if (p.vault) args.unshift(`vault=${p.vault}`);
	return execObsidian(args, true, (p.timeout_ms as number) ?? 30_000).parsed;
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
		name: "obsidian_read",
		label: "Read Note",
		description: "Read content of a note in the Obsidian vault. Specify by name (wikilink) or exact path.",
		promptSnippet: "Read a note from Obsidian vault",
		promptGuidelines: [
			"Use obsidian_read to get note content.",
			"Use `file` for wikilink-style name resolution (e.g. 'Meeting Notes'), or `path` for exact vault-relative path.",
		],
		parameters: Type.Object({ ...fileRef, ...vaultParam, ...timeoutParam }),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			return run("read", p);
		}),
	});

	pi.registerTool({
		name: "obsidian_create",
		label: "Create Note",
		description: "Create a new note in the Obsidian vault. Supports template, silent creation, and overwrite.",
		promptSnippet: "Create a new note in Obsidian vault",
		promptGuidelines: [
			"Use `name` for wikilink-style name resolution (e.g. 'Meeting Notes').",
			"Use `path` for exact vault-relative path (e.g. 'folder/note.md').",
			"If both `name` and `path` are given, `path` wins for file location.",
		],
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Note name (without extension). Omit when `path` is given." })),
			content: Type.Optional(Type.String({ description: "Note content. Use \\n for newlines." })),
			template: Type.Optional(Type.String({ description: "Template name to use." })),
			path: Type.Optional(Type.String({ description: "Exact vault-relative path, e.g. 'folder/note.md'." })),
			silent: Type.Optional(Type.Boolean({ default: false, description: "Create without opening in Obsidian." })),
			overwrite: Type.Optional(Type.Boolean({ default: false, description: "Overwrite if note exists." })),
			newtab: Type.Optional(Type.Boolean({ default: false, description: "Open in a new tab." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			const flags: string[] = [];
			if (p.silent) flags.push("silent");
			if (p.overwrite) flags.push("overwrite");
			if (p.newtab) flags.push("newtab");
			// If path is given, use it as the exact file path; omit name from CLI args
			// to avoid the Obsidian CLI creating "name 1" duplicates.
			const params = p.path ? { ...p, name: undefined } : p;
			return run("create", params, flags) || `Created note "${p.name || p.path}".`;
		}),
	});

	pi.registerTool({
		name: "obsidian_append",
		label: "Append to Note",
		description: "Append content to an existing note. Specify by name (wikilink) or exact path.",
		promptSnippet: "Append content to an Obsidian note",
		parameters: Type.Object({
			content: Type.String({ description: "Content to append. Use \\n for newlines." }),
			...fileRef,
			inline: Type.Optional(Type.Boolean({ default: false, description: "Append inline (no trailing newline)." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			const flags = p.inline ? ["inline"] : [];
			return run("append", p, flags) || "Appended.";
		}),
	});

	pi.registerTool({
		name: "obsidian_prepend",
		label: "Prepend to Note",
		description: "Prepend content to a note. Specify by name (wikilink) or exact path.",
		promptSnippet: "Prepend content to an Obsidian note",
		parameters: Type.Object({
			content: Type.String({ description: "Content to prepend. Use \\n for newlines." }),
			...fileRef,
			inline: Type.Optional(Type.Boolean({ default: false, description: "Prepend inline (no trailing newline)." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			const flags = p.inline ? ["inline"] : [];
			return run("prepend", p, flags) || "Prepended.";
		}),
	});

	pi.registerTool({
		name: "obsidian_search",
		label: "Search Vault",
		description: "Full-text search the Obsidian vault using Obsidian's search index.",
		promptSnippet: "Search the Obsidian vault for notes",
		promptGuidelines: [
			"Use obsidian_search for full-text search across the vault.",
			"Use `path` to scope search to a specific folder.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query." }),
			path: Type.Optional(Type.String({ description: "Scope search to a folder path." })),
			limit: Type.Optional(Type.Number({ default: 10, description: "Max results." })),
			case_sensitive: Type.Optional(Type.Boolean({ default: false, description: "Case-sensitive search." })),
			matches: Type.Optional(Type.Boolean({ default: false, description: "Show match context lines." })),
			total: Type.Optional(Type.Boolean({ default: false, description: "Return match count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			const flags: string[] = [];
			if (p.case_sensitive) flags.push("case");
			if (p.total) return run("search", p, ["total"]);
			// When matches=true, use search:context (returns { file, matches } objects)
			const cmd = p.matches ? "search:context" : "search";
			if (p.matches) flags.push("matches");
			const parsed = runJson(cmd, p, flags);
			return formatSearchResults(parsed);
		}),
	});

	pi.registerTool({
		name: "obsidian_daily_read",
		label: "Read Daily Note",
		description: "Read today's daily note from Obsidian.",
		promptSnippet: "Read today's daily note from Obsidian",
		parameters: Type.Object({ ...vaultParam, ...timeoutParam }),
		execute: tool((p) => run("daily:read", p)),
	});

	pi.registerTool({
		name: "obsidian_daily_append",
		label: "Append to Daily Note",
		description: "Append content to today's daily note in Obsidian.",
		promptSnippet: "Append content to today's Obsidian daily note",
		parameters: Type.Object({
			content: Type.String({ description: "Content to append to today's daily note." }),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => run("daily:append", p) || "Appended to daily note."),
	});

	pi.registerTool({
		name: "obsidian_tasks",
		label: "List Tasks",
		description: "List tasks from Obsidian. Supports daily/all scope and todo/done status filters.",
		promptSnippet: "List tasks from Obsidian vault",
		parameters: Type.Object({
			scope: Type.Optional(Type.Union(
				[Type.Literal("daily"), Type.Literal("all"), Type.Literal("file")],
				{ default: "daily", description: "Task scope: daily, all, or file." },
			)),
			status: Type.Optional(Type.Union(
				[Type.Literal("todo"), Type.Literal("done")],
				{ description: "Filter by completion status." },
			)),
			file: Type.Optional(Type.String({ description: "Filename when scope is 'file'." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			const flags: string[] = [];
			const cmd = p.scope === "daily" ? "tasks daily" : p.scope === "file" ? "tasks file" : "tasks all";
			if (p.status) flags.push(p.status as string);
			const parsed = runJson(cmd, p, flags);
			return formatTasks(parsed);
		}),
	});

	pi.registerTool({
		name: "obsidian_task",
		label: "Task",
		description: "Show or update a task. Supports toggle, done, todo, and custom status.",
		promptSnippet: "Work with a task in Obsidian",
		promptGuidelines: [
			"Use `file` or `path` with `line` to target a specific task.",
			"Use `toggle`, `done`, `todo`, or `status` to change task state.",
			"Use `daily` flag to work with today's daily note.",
		],
		parameters: Type.Object({
			...fileRef,
			line: Type.Optional(Type.Number({ description: "Line number of the task." })),
			toggle: Type.Optional(Type.Boolean({ default: false, description: "Toggle task status." })),
			done: Type.Optional(Type.Boolean({ default: false, description: "Mark as done." })),
			todo: Type.Optional(Type.Boolean({ default: false, description: "Mark as todo." })),
			status: Type.Optional(Type.String({ description: "Set status character (e.g. '>', '-')." })),
			daily: Type.Optional(Type.Boolean({ default: false, description: "Use daily note." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path && !p.daily) throw new Error("Either 'file', 'path', or 'daily' is required.");
			const flags: string[] = [];
			if (p.toggle) flags.push("toggle");
			if (p.done) flags.push("done");
			if (p.todo) flags.push("todo");
			if (p.daily) flags.push("daily");
			// Extract only task-relevant params — skip flags that are already handled
			const params: Record<string, unknown> = { ...p };
			// buildArgs will skip toggle/done/todo/daily since they're boolean true and in flags
			return run("task", params, flags) || "Task updated.";
		}),
	});

	pi.registerTool({
		name: "obsidian_property_set",
		label: "Set Property",
		description: "Set a frontmatter property on a note. Supports typed values (text, date, number, checkbox, array).",
		promptSnippet: "Set a frontmatter property on an Obsidian note",
		promptGuidelines: [
			"Use `type: 'array'` for list properties like `tags`. Pass value as JSON array string, e.g. '[\"#tag1\", \"#tag2\"]'.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Property name." }),
			value: Type.String({ description: "Property value. For type=array, pass a JSON array string." }),
			type: Type.Optional(Type.String({ description: "Value type: text, date, number, checkbox, array." })),
			...fileRef, ...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			const params = { ...p };
			// When type=array and value is a JSON array string, reformat for CLI
			if (p.type === "array" && typeof p.value === "string" && p.value.startsWith("[")) {
				try {
					const arr = JSON.parse(p.value as string);
					if (Array.isArray(arr)) {
						// Re-serialize without spaces so CLI parses as YAML array
						params.value = JSON.stringify(arr);
					}
				} catch { /* not valid JSON, pass through as-is */ }
			}
			return run("property:set", params) || "Property set.";
		}),
	});

	pi.registerTool({
		name: "obsidian_property_read",
		label: "Read Property",
		description: "Read a frontmatter property value from a note.",
		promptSnippet: "Read a frontmatter property from an Obsidian note",
		parameters: Type.Object({
			name: Type.String({ description: "Property name to read." }),
			...fileRef, ...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			return run("property:read", p);
		}),
	});

	pi.registerTool({
		name: "obsidian_backlinks",
		label: "List Backlinks",
		description: "List notes that link to the specified note.",
		promptSnippet: "List backlinks for an Obsidian note",
		parameters: Type.Object({
			...fileRef,
			total: Type.Optional(Type.Boolean({ default: false, description: "Return count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			const flags = p.total ? ["total"] : [];
			return formatLinks(runJson("backlinks", p, flags), "Backlinks");
		}),
	});

	pi.registerTool({
		name: "obsidian_tags",
		label: "List Tags",
		description: "List all tags in the vault with optional frequency counts, sorted by count.",
		promptSnippet: "List tags from the Obsidian vault",
		parameters: Type.Object({
			counts: Type.Optional(Type.Boolean({ default: true, description: "Show tag counts." })),
			sort: Type.Optional(Type.Union(
				[Type.Literal("count"), Type.Literal("name")],
				{ description: "Sort by count or name." }),
			),
			total: Type.Optional(Type.Boolean({ default: false, description: "Return count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (p.total) {
				return run("tags all", p, ["total"]);
			}
			const flags: string[] = [];
			if (p.counts) flags.push("counts");
			return formatTags(runJson("tags all", { sort: p.sort }, flags));
		}),
	});

	pi.registerTool({
		name: "obsidian_tag",
		label: "Tag Info",
		description: "Get info about a specific tag: occurrence count and file list.",
		promptSnippet: "Get tag info from Obsidian vault",
		promptGuidelines: [
			"Use `obsidian_tag` for detailed tag info (file list, count) by tag name.",
			"Use `obsidian_tags` (plural) for bulk listing all tags.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Tag name to look up (e.g. '#type/moc')." }),
			total: Type.Optional(Type.Boolean({ default: false, description: "Return occurrence count only." })),
			verbose: Type.Optional(Type.Boolean({ default: false, description: "Include file list and count." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			const flags: string[] = [];
			if (p.total) flags.push("total");
			if (p.verbose) flags.push("verbose");
			return run("tag", p, flags);
		}),
	});

	pi.registerTool({
		name: "obsidian_orphans",
		label: "List Orphans",
		description: "List files with no incoming links (orphans) in the vault.",
		promptSnippet: "List orphan notes in the Obsidian vault",
		parameters: Type.Object({
			total: Type.Optional(Type.Boolean({ default: false, description: "Return count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => run("orphans", p, p.total ? ["total"] : []) || "No orphans found."),
	});

	pi.registerTool({
		name: "obsidian_unresolved",
		label: "List Unresolved Links",
		description: "List broken/unresolved wikilinks in the vault.",
		promptSnippet: "List unresolved links in the Obsidian vault",
		parameters: Type.Object({
			verbose: Type.Optional(Type.Boolean({ default: false, description: "Show source file details." })),
			total: Type.Optional(Type.Boolean({ default: false, description: "Return count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			const flags: string[] = [];
			if (p.verbose) flags.push("verbose");
			if (p.total) flags.push("total");
			return run("unresolved", p, flags) || "No unresolved links found.";
		}),
	});

	pi.registerTool({
		name: "obsidian_vault_info",
		label: "Vault Info",
		description: "Show Obsidian vault information: name, path, file count, size.",
		promptSnippet: "Show Obsidian vault information",
		parameters: Type.Object({
			info: Type.Optional(Type.Union(
				[Type.Literal("name"), Type.Literal("path")],
				{ description: "Show a specific field." }),
			),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => run("vault", p)),
	});

	pi.registerTool({
		name: "obsidian_files",
		label: "List Files",
		description: "List files in the vault, optionally filtered by folder and extension.",
		promptSnippet: "List files in the Obsidian vault",
		parameters: Type.Object({
			folder: Type.Optional(Type.String({ description: "Filter by folder path." })),
			ext: Type.Optional(Type.String({ description: "Filter by extension (e.g., 'md', 'png')." })),
			total: Type.Optional(Type.Boolean({ default: false, description: "Return count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => run("files", p, p.total ? ["total"] : [])),
	});

	pi.registerTool({
		name: "obsidian_template_read",
		label: "Read Template",
		description: "Read a template from Obsidian's template folder.",
		promptSnippet: "Read an Obsidian template",
		parameters: Type.Object({
			name: Type.String({ description: "Template name." }),
			resolve: Type.Optional(Type.Boolean({ default: false, description: "Resolve template variables." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			const flags = p.resolve ? ["resolve"] : [];
			return run("template:read", p, flags);
		}),
	});

	pi.registerTool({
		name: "obsidian_delete",
		label: "Delete Note",
		description: "Delete a note from the vault (moves to trash by default, or permanently).",
		promptSnippet: "Delete a note from the Obsidian vault",
		promptGuidelines: [
			"Use `file` for wikilink-style name resolution (e.g. 'Meeting Notes').",
			"Use `path` for exact vault-relative path (e.g. 'folder/note.md').",
		],
		parameters: Type.Object({
			...fileRef,
			permanent: Type.Optional(Type.Boolean({ default: false, description: "Delete permanently instead of trash." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			const flags = p.permanent ? ["permanent"] : [];
			// When path is given but not file, extract filename for wikilink resolution
			// (Obsidian CLI's delete command doesn't accept path= parameter)
			if (p.path && !p.file) {
				const pathStr = p.path as string;
				const basename = pathStr.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
				if (basename) {
					const params = { ...p, file: basename };
					delete (params as any).path;
					return run("delete", params, flags) || "Deleted.";
				}
			}
			return run("delete", p, flags) || "Deleted.";
		}),
	});

	pi.registerTool({
		name: "obsidian_write",
		label: "Write Note",
		description: "Write full content to a note. Creates the note if it doesn't exist, overwrites if it does.",
		promptSnippet: "Write content to an Obsidian note",
		promptGuidelines: [
			"Use `file` for wikilink-style name resolution (e.g. 'Meeting Notes').",
			"Use `path` for exact vault-relative path (e.g. 'folder/note.md').",
			"If `file` contains a folder path, it is treated as `path`.",
		],
		parameters: Type.Object({
			content: Type.String({ description: "Full note content to write." }),
			...fileRef,
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			const params: Record<string, unknown> = { content: p.content };
			// Use path directly if given
			if (p.path) {
				let path = p.path as string;
				// Ensure .md extension for exact paths
				if (!path.endsWith(".md")) path += ".md";
				params.path = path;
			} else if (p.file) {
				// If file contains a path separator, treat as path (add .md)
				if (/[/\\]/.test(p.file as string)) {
					let path = p.file as string;
					if (!path.endsWith(".md")) path += ".md";
					params.path = path;
				} else {
					// Simple wikilink name — use as name (CLI adds .md automatically)
					params.name = p.file;
				}
			}
			return run("create", params, ["overwrite"]) || "Written.";
		}),
	});

	pi.registerTool({
		name: "obsidian_history",
		label: "Read Version History",
		description: "List version history for a file, or read a specific version from Obsidian's file recovery.",
		promptSnippet: "Read version history of an Obsidian note",
		parameters: Type.Object({
			...fileRef,
			version: Type.Optional(Type.Number({ description: "Version number to read (omit to list all versions)." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			const cmd = p.version ? "history:read" : "history";
			return run(cmd, p, p.version ? ["format=json"] : []);
		}),
	});

	pi.registerTool({
		name: "obsidian_diff",
		label: "Diff Versions",
		description: "Diff two versions of a file in Obsidian's file recovery.",
		promptSnippet: "Compare two versions of an Obsidian file",
		parameters: Type.Object({
			...fileRef,
			from: Type.Number({ description: "Source version number." }),
			to: Type.Number({ description: "Target version number." }),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			return run("diff", p);
		}),
	});

	pi.registerTool({
		name: "obsidian_history_restore",
		label: "Restore Version",
		description: "Restore a previous version of a file from Obsidian's file recovery.",
		promptSnippet: "Restore an older version of an Obsidian note",
		parameters: Type.Object({
			...fileRef,
			version: Type.Number({ description: "Version number to restore." }),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			return run("history:restore", p) || "Restored.";
		}),
	});

	pi.registerTool({
		name: "obsidian_eval",
		label: "Execute JavaScript",
		description: "Execute JavaScript code in the Obsidian app context (developer tool).",
		promptSnippet: "Run JavaScript in Obsidian",
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript code to execute in Obsidian's context." }),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => run("eval", p)),
	});

	// --------------------------------------------------------------------------
	// Navigation & Structure
	// --------------------------------------------------------------------------

	pi.registerTool({
		name: "obsidian_outline",
		label: "Show Outline",
		description: "Show heading structure (outline) of a note. Returns a tree of headings.",
		promptSnippet: "Show heading outline of an Obsidian note",
		promptGuidelines: [
			"Use obsidian_outline before reading a long note to understand its structure.",
		],
		parameters: Type.Object({
			...fileRef,
			format: Type.Optional(Type.Union(
				[Type.Literal("tree"), Type.Literal("md"), Type.Literal("json")],
				{ default: "tree", description: "Output format." },
			)),
			total: Type.Optional(Type.Boolean({ default: false, description: "Return heading count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			const flags: string[] = [];
			if (p.total) flags.push("total");
			if (p.format === "json") {
				const parsed = runJson("outline", p, flags);
				return formatOutline(parsed);
			}
			return run("outline", p, flags);
		}),
	});

	pi.registerTool({
		name: "obsidian_links",
		label: "List Outgoing Links",
		description: "List outgoing wikilinks from a note. Shows broken links as (broken).",
		promptSnippet: "List outgoing links from an Obsidian note",
		parameters: Type.Object({
			...fileRef,
			total: Type.Optional(Type.Boolean({ default: false, description: "Return link count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			const flags: string[] = [];
			if (p.total) flags.push("total");
			// links doesn't support format=json, use raw text
			const text = run("links", p, flags);
			return formatOutgoingLinks(text);
		}),
	});

	pi.registerTool({
		name: "obsidian_file_info",
		label: "File Info",
		description: "Show metadata about a file: path, size, created/modified dates, word count.",
		promptSnippet: "Show file metadata from Obsidian vault",
		parameters: Type.Object({
			...fileRef,
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			return run("file", p);
		}),
	});

	// --------------------------------------------------------------------------
	// File Operations
	// --------------------------------------------------------------------------

	pi.registerTool({
		name: "obsidian_move",
		label: "Move / Rename File",
		description: "Move or rename a file in the Obsidian vault. Specify destination folder or full new path.",
		promptSnippet: "Move or rename a file in Obsidian vault",
		parameters: Type.Object({
			...fileRef,
			to: Type.String({ description: "Destination folder or full path (e.g. '01 Projects/' or '01 Projects/New Name.md')." }),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			return run("move", p) || "Moved.";
		}),
	});

	pi.registerTool({
		name: "obsidian_rename",
		label: "Rename File",
		description: "Rename a file in the Obsidian vault. Changes only the filename, not the folder.",
		promptSnippet: "Rename a file in Obsidian vault",
		promptGuidelines: [
			"Use `obsidian_rename` to change a file's name without moving it to a different folder.",
			"Use `obsidian_move` to change both path and name.",
		],
		parameters: Type.Object({
			...fileRef,
			name: Type.String({ description: "New file name (without extension)." }),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			return run("rename", p) || "Renamed.";
		}),
	});

	// --------------------------------------------------------------------------
	// Daily Notes
	// --------------------------------------------------------------------------

	pi.registerTool({
		name: "obsidian_daily_prepend",
		label: "Prepend to Daily Note",
		description: "Prepend content to today's daily note in Obsidian.",
		promptSnippet: "Prepend content to today's Obsidian daily note",
		parameters: Type.Object({
			content: Type.String({ description: "Content to prepend to today's daily note." }),
			inline: Type.Optional(Type.Boolean({ default: false, description: "Prepend inline (no trailing newline)." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			const flags = p.inline ? ["inline"] : [];
			return run("daily:prepend", p, flags) || "Prepended to daily note.";
		}),
	});

	pi.registerTool({
		name: "obsidian_daily_path",
		label: "Daily Note Path",
		description: "Get the file path of today's daily note.",
		promptSnippet: "Get today's daily note path from Obsidian",
		parameters: Type.Object({ ...vaultParam, ...timeoutParam }),
		execute: tool((p) => run("daily:path", p)),
	});

	// --------------------------------------------------------------------------
	// Content Tools
	// --------------------------------------------------------------------------

	pi.registerTool({
		name: "obsidian_wordcount",
		label: "Word Count",
		description: "Count words and characters in a note.",
		promptSnippet: "Count words in an Obsidian note",
		parameters: Type.Object({
			...fileRef,
			words: Type.Optional(Type.Boolean({ default: false, description: "Return word count only." })),
			characters: Type.Optional(Type.Boolean({ default: false, description: "Return character count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			const flags: string[] = [];
			if (p.words) flags.push("words");
			if (p.characters) flags.push("characters");
			return run("wordcount", p, flags);
		}),
	});

	// --------------------------------------------------------------------------
	// Vault Overview
	// --------------------------------------------------------------------------

	pi.registerTool({
		name: "obsidian_properties",
		label: "List Properties",
		description: "List all frontmatter properties used across the vault, with occurrence counts.",
		promptSnippet: "List frontmatter properties in the Obsidian vault",
		parameters: Type.Object({
			...fileRef,
			total: Type.Optional(Type.Boolean({ default: false, description: "Return property count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (p.total) {
				return run("properties", p, ["total"]);
			}
			if (p.file || p.path) {
				return run("properties", p);
			}
			// Vault-wide: use JSON with counts
			const parsed = runJson("properties", { counts: true, sort: "count" }, []);
			return formatProperties(parsed);
		}),
	});

	pi.registerTool({
		name: "obsidian_property_remove",
		label: "Remove Property",
		description: "Remove a frontmatter property from a note.",
		promptSnippet: "Remove a frontmatter property from an Obsidian note",
		parameters: Type.Object({
			name: Type.String({ description: "Property name to remove." }),
			...fileRef, ...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			return run("property:remove", p) || "Property removed.";
		}),
	});

	pi.registerTool({
		name: "obsidian_aliases",
		label: "List Aliases",
		description: "List aliases in the vault, or aliases for a specific file.",
		promptSnippet: "List aliases from the Obsidian vault",
		parameters: Type.Object({
			...fileRef,
			total: Type.Optional(Type.Boolean({ default: false, description: "Return alias count only." })),
			verbose: Type.Optional(Type.Boolean({ default: false, description: "Include file paths." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			const flags: string[] = [];
			if (p.total) flags.push("total");
			if (p.verbose) flags.push("verbose");
			return run("aliases", p, flags) || "No aliases.";
		}),
	});

	pi.registerTool({
		name: "obsidian_deadends",
		label: "List Dead-End Notes",
		description: "List files with no outgoing wikilinks (dead ends). Complement to orphans (no incoming links).",
		promptSnippet: "List dead-end notes in Obsidian vault",
		parameters: Type.Object({
			total: Type.Optional(Type.Boolean({ default: false, description: "Return count only." })),
			all: Type.Optional(Type.Boolean({ default: false, description: "Include non-markdown files." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			const flags: string[] = [];
			if (p.total) flags.push("total");
			if (p.all) flags.push("all");
			return run("deadends", p, flags) || "No dead-end notes found.";
		}),
	});

	pi.registerTool({
		name: "obsidian_templates_list",
		label: "List Templates",
		description: "List all available templates in the Obsidian vault.",
		promptSnippet: "List templates in Obsidian vault",
		parameters: Type.Object({
			total: Type.Optional(Type.Boolean({ default: false, description: "Return count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			const flags = p.total ? ["total"] : [];
			return run("templates", p, flags) || "No templates found.";
		}),
	});

	pi.registerTool({
		name: "obsidian_folders",
		label: "List Folders",
		description: "List folders in the vault, optionally filtered by parent folder.",
		promptSnippet: "List folders in Obsidian vault",
		parameters: Type.Object({
			folder: Type.Optional(Type.String({ description: "Filter by parent folder path." })),
			total: Type.Optional(Type.Boolean({ default: false, description: "Return count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => run("folders", p, p.total ? ["total"] : [])),
	});

	pi.registerTool({
		name: "obsidian_vaults",
		label: "List Vaults",
		description: "List all known Obsidian vaults.",
		promptSnippet: "List known Obsidian vaults",
		parameters: Type.Object({
			total: Type.Optional(Type.Boolean({ default: false, description: "Return count only." })),
			verbose: Type.Optional(Type.Boolean({ default: false, description: "Include vault paths." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			const flags: string[] = [];
			if (p.total) flags.push("total");
			if (p.verbose) flags.push("verbose");
			return run("vaults", p, flags);
		}),
	});

	pi.registerTool({
		name: "obsidian_version",
		label: "Obsidian Version",
		description: "Show the installed Obsidian app version.",
		promptSnippet: "Show Obsidian version",
		parameters: Type.Object({ ...vaultParam, ...timeoutParam }),
		execute: tool((p) => run("version", p)),
	});

	pi.registerTool({
		name: "obsidian_recents",
		label: "Recent Files",
		description: "List recently opened files in the Obsidian vault.",
		promptSnippet: "List recently opened files from Obsidian",
		parameters: Type.Object({
			total: Type.Optional(Type.Boolean({ default: false, description: "Return count only." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			const flags = p.total ? ["total"] : [];
			return run("recents", p, flags) || "No recent files.";
		}),
	});

	pi.registerTool({
		name: "obsidian_random",
		label: "Random Note",
		description: "Read a random note from the vault, optionally limited to a folder.",
		promptSnippet: "Read a random note from Obsidian vault",
		parameters: Type.Object({
			folder: Type.Optional(Type.String({ description: "Limit to a specific folder." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => run("random:read", p) || "(no random note available)"),
	});
}
