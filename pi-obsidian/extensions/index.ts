import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { execObsidian, buildArgs } from "./lib/cli";
import { formatSearchResults, formatTasks, formatTags, formatLinks } from "./lib/format";

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

function run(cmd: string, p: Record<string, unknown>, flags: string[] = [], json = false): string {
	const args = buildArgs(cmd, p, flags);
	if (p.vault) args.unshift(`vault=${p.vault}`);
	const r = execObsidian(args, json, (p.timeout_ms as number) ?? 30_000);
	return json ? "" : r.stdout.trim();
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
		parameters: Type.Object({
			name: Type.String({ description: "Note name (without extension)." }),
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
			return run("create", p, flags) || `Created note "${p.name}".`;
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
			if (p.matches) flags.push("matches");
			if (p.total) flags.push("total");
			const parsed = runJson("search", p, flags);
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
		name: "obsidian_property_set",
		label: "Set Property",
		description: "Set a frontmatter property on a note. Supports typed values (text, date, number, checkbox).",
		promptSnippet: "Set a frontmatter property on an Obsidian note",
		parameters: Type.Object({
			name: Type.String({ description: "Property name." }),
			value: Type.String({ description: "Property value." }),
			type: Type.Optional(Type.String({ description: "Value type: text, date, number, checkbox." })),
			...fileRef, ...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			return run("property:set", p) || "Property set.";
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
			const flags: string[] = [];
			if (p.counts) flags.push("counts");
			if (p.total) flags.push("total");
			return formatTags(runJson("tags all", p, flags));
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
		parameters: Type.Object({
			...fileRef,
			permanent: Type.Optional(Type.Boolean({ default: false, description: "Delete permanently instead of trash." })),
			...vaultParam, ...timeoutParam,
		}),
		execute: tool((p) => {
			if (!p.file && !p.path) throw new Error("Either 'file' or 'path' is required.");
			const flags = p.permanent ? ["permanent"] : [];
			return run("delete", p, flags) || "Deleted.";
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
}
