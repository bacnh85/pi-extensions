import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { execObsidian } from "./lib/cli";
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
// CLI string parser
// ---------------------------------------------------------------------------

/**
 * Parse a CLI command string into argument tokens, respecting quoted values.
 *
 * Handles:
 *   read file="Meeting Notes"    → ["read", "file=Meeting Notes"]
 *   search query=hello limit=10  → ["search", "query=hello", "limit=10"]
 *   delete permanent             → ["delete", "permanent"]
 *   eval code="fn()"             → ["eval", "code=fn()"]
 *
 * Values with spaces MUST be quoted. Bare quotes inside a word (e.g. after `=`)
 * start an inline quoted segment: `file="Meeting Notes"` → `file=Meeting Notes`.
 */
function parseCliString(s: string): string[] {
	const args: string[] = [];
	let i = 0;
	while (i < s.length) {
		// Skip whitespace
		while (i < s.length && /\s/.test(s[i])) i++;
		if (i >= s.length) break;

		let val = "";
		// If the arg starts with a quote, it's a fully quoted value
		if (s[i] === '"') {
			i++; // skip opening quote
			while (i < s.length && s[i] !== '"') {
				if (s[i] === "\\" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\")) {
					i++; val += s[i++]; // unescape \" → " and \\ → \
				} else {
					val += s[i++]; // keep everything else as-is (\n, \t pass through literally)
				}
			}
			i++; // skip closing quote
		} else {
			// Bare word — may contain inline quotes after key=
			while (i < s.length && !/\s/.test(s[i])) {
				if (s[i] === '"') {
					// Inline quoted segment (e.g. the value part of key="value with spaces")
					i++;
					while (i < s.length && s[i] !== '"') {
						if (s[i] === "\\" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\")) {
							i++; val += s[i++];
						} else {
							val += s[i++];
						}
					}
					i++; // skip closing quote
				} else {
					val += s[i++];
				}
			}
		}
		args.push(val);
	}
	return args;
}

// ---------------------------------------------------------------------------
// Route JSON output to the correct formatter based on command
// ---------------------------------------------------------------------------

function formatObsidianOutput(cmdString: string, parsed: unknown): string {
	if (cmdString.startsWith("links ")) return formatOutgoingLinks(parsed);
	if (cmdString.startsWith("search")) return formatSearchResults(parsed);
	if (cmdString.startsWith("tasks")) return formatTasks(parsed);
	if (cmdString.startsWith("tags")) return formatTags(parsed);
	if (cmdString.startsWith("backlinks")) return formatLinks(parsed, "Backlinks");
	if (cmdString.startsWith("outline")) return formatOutline(parsed);
	if (cmdString.startsWith("properties")) return formatProperties(parsed);
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
			"Run any Obsidian CLI command using the `run` parameter with the full command and flags.",
			"Format: `<command> <key=value> ... <flag>`",
			"Use `file=` for wikilink names (e.g. `file=\"Meeting Notes\"`). Use `path=` for exact paths.",
			"Quote values with spaces: `file=\"My Note\"`, `query=\"search phrase\"`, `content=\"# Title\\n\\nBody\"`.",
			"Boolean flags: `permanent`, `overwrite`, `total`, `verbose`, `inline`, `silent`.",
			"For structured output, add `format=json`: `search query=x format=json`.",
			"Use `\\\\n` for newlines and `\\\\t` for tabs in content values.",
			"Target a vault: add `vault=\"Vault Name\"` to any command (uses focused vault by default).",
			"",
			"=== Common commands ===",
			"  read file=\"Meeting Notes\"               — read note by wikilink name",
			"  read path=\"folder/note.md\"               — read by exact path",
			"  create name=Note overwrite=true content=\"# Title\"  — create/overwrite note",
			"  append path=note.md content=\"More text\"   — append to end",
			"  prepend path=note.md content=\"Header\"     — prepend to beginning",
			"  delete path=old.md permanent=true          — permanently delete",
			"  move file=Note to=\"01 Projects/\"          — move to folder",
			"  rename file=Note name=\"New Name\"          — rename in place",
			"",
			"=== Search & structure ===",
			"  search query=roadmap limit=10              — search vault",
			"  search query=notes path=\"01 Projects\" format=json  — search with JSON output",
			"  outline file=Note                           — show heading structure",
			"  links file=Note                             — list outgoing wikilinks",
			"  backlinks file=Note format=json             — list backlinks",
			"  unresolved                                  — list broken wikilinks",
			"  orphans                                     — files with no incoming links",
			"  deadends                                    — files with no outgoing links",
			"  file file=Note                              — show file metadata",
			"",
			"=== Tags & properties ===",
			"  tags counts=true sort=count format=json     — list all tags with counts",
			"  tag name=\"#type/reference\" verbose          — get tag details + file list",
			"  property:set file=Note name=status value=active  — set frontmatter property",
			"  property:read file=Note name=status         — read property",
			"  property:remove file=Note name=old-field    — remove property",
			"  properties format=json                       — vault-wide properties with counts",
			"  properties file=Note                         — properties for a specific file",
			"  aliases file=Note verbose                    — list aliases for a file",
			"",
			"=== Tasks ===",
			"  tasks format=json                           — all tasks in vault",
			"  tasks file=todo.md format=json              — tasks in a specific file",
			"  tasks daily format=json                     — tasks from daily note",
			"  task file=todo.md line=12 done              — mark task done",
			"  task file=todo.md line=5 todo               — mark task todo",
			"  task file=todo.md line=8 toggle             — toggle task",
			"  task file=todo.md line=3 status=\">\"        — set custom status",
			"",
			"=== Daily notes ===",
			"  daily:read                                  — read today's daily note",
			"  daily:append content=\"- [ ] Do thing\"       — append to daily note",
			"  daily:prepend content=\"# Morning\"           — prepend to daily note",
			"  daily:path                                  — get daily note path",
			"",
			"=== Vault info ===",
			"  vault                                       — vault name, path, file count, size",
			"  vaults                                      — list known vaults",
			"  version                                     — Obsidian app version",
			"  files folder=\"01 Projects\"                  — list files in folder",
			"  files ext=.png                              — list files by extension",
			"  folders                                     — list all folders",
			"  recents                                     — recent files",
			"  random:read                                 — read a random note",
			"  wordcount file=Note                          — count words/characters",
			"",
			"=== History & versions ===",
			"  history file=Note                            — list version history",
			"  history:read file=Note version=3             — read specific version",
			"  diff file=Note from=1 to=3                   — diff two versions",
			"  history:restore file=Note version=3          — restore a version",
			"",
			"=== Templates ===",
			"  templates                                   — list available templates",
			"  template:read name=Template resolve          — read a template (resolve variables)",
			"  template:insert name=Template                — insert template into current file",
			"",
			"=== Developer ===",
			"  eval code=\"app.vault.getFiles().length\"      — run JS in Obsidian context",
		],
		parameters: Type.Object({
			run: Type.String({
				description: "Full Obsidian CLI command. Examples: 'read file=Meeting Notes', 'create name=Test content=# Hello', 'search query=roadmap limit=5', 'delete path=old.md permanent=true'"
			}),
			vault: Type.Optional(Type.String({ description: "Target vault name. Defaults to most recently focused." })),
			timeout_ms: Type.Optional(Type.Number({ description: "Command timeout in milliseconds. Default 30000." })),
		}),
		execute: tool((p) => {
			const raw = (p.run as string).trim();
			if (!raw) throw new Error("'run' is required.");
			const args = parseCliString(raw);
			if (p.vault) args.unshift(`vault=${p.vault}`);
			const r = execObsidian(args, false, (p.timeout_ms as number) ?? 30_000);
			// If output is valid JSON, route to appropriate formatter
			if (r.parsed && typeof r.parsed !== "string") {
				return formatObsidianOutput(raw, r.parsed);
			}
			return r.stdout.trim() || "Done.";
		}),
	});
}
