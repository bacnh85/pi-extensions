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

function parseCliString(s: string): string[] {
	const args: string[] = [];
	let i = 0;
	while (i < s.length) {
		while (i < s.length && /\s/.test(s[i])) i++;
		if (i >= s.length) break;
		let val = "";
		if (s[i] === '"') { i++; val = readQuotedContent(s, i); i += val.length + 1; }
		else {
			while (i < s.length && !/\s/.test(s[i])) {
				if (s[i] === '"') { i++; const inner = readQuotedContent(s, i); val += inner; i += inner.length + 1; }
				else { val += s[i++]; }
			}
		}
		args.push(val);
	}
	return args;
}

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

function escapeCliValue(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

// ---------------------------------------------------------------------------
// Higher-level operations via single eval calls
// ---------------------------------------------------------------------------

function listFilesRecursive(folder: string, vault?: string, timeoutMs = 30_000): string {
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push("eval", `code=app.vault.getFiles().filter(f=>f.path.startsWith(${JSON.stringify(folder)})).map(f=>f.path).sort().join('\\n')`);
	const out = execObsidian(args, false, timeoutMs).stdout.trim();
	return out || "No files found.";
}

function createTaskInNote(notePath: string, heading: string, taskText: string, vault?: string, timeoutMs = 30_000): string {
	const j = JSON.stringify;
	const script = [
		`const f=app.vault.getAbstractFileByPath(${j(notePath)});`,
		`if(!f)return'File not found.';`,
		`let c=await app.vault.read(f);`,
		`const ls=c.split('\\n');`,
		`let hi=-1;`,
		`for(let i=0;i<ls.length;i++){const t=ls[i].trim();if(t.startsWith('#')&&t.replace(/^#+\\s*/,'')===${j(heading)}){hi=i;break;}}`,
		`if(hi<0){await app.vault.modify(f,c+'\\n## '+${j(heading)}+'\\n- [ ] '+${j(taskText)}+'\\n');return'Created heading and task.';}`,
		`const hl=ls[hi].match(/^(#+)\\s/)[1].length;`,
		`let se=ls.length;`,
		`for(let i=hi+1;i<ls.length;i++){const m=ls[i].match(/^(#+)\\s/);if(m&&m[1].length<=hl){se=i;break;}}`,
		`ls.splice(se,0,'- [ ] '+${j(taskText)});`,
		`await app.vault.modify(f,ls.join('\\n'));`,
		`return'Task added.';`,
	].join("");
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push("eval", `code=(async function(){${script}})()`);
	return execObsidian(args, false, timeoutMs).stdout.trim() || `Added task "${taskText}" under heading "${heading}".`;
}

function createFromTemplate(templateName: string, noteName: string, folder: string, fill: Record<string, string>, vault?: string, timeoutMs = 30_000): string {
	const j = JSON.stringify;
	const notePath = folder ? `${folder}/${noteName}` : noteName;
	const script = [
		`const tf=app.vault.getAbstractFileByPath(${j(templateName)});`,
		`if(!tf)return'Template not found.';`,
		`let c=await app.vault.read(tf);`,
		`const fl=${JSON.stringify(fill)};`,
		`for(const[k,v]of Object.entries(fl))c=c.replace(new RegExp('\\\\{\\\\{\\\\s*'+k+'\\\\s*\\\\}\\\\}','g'),v);`,
		`const p=${j(notePath)}.replace(/\\\\/g,'/').split('/').slice(0,-1).join('/');`,
		`if(p&&!app.vault.getAbstractFileByPath(p))await app.vault.createFolder(p,true);`,
		`await app.vault.create(${j(notePath)},c);`,
		`return'Created.';`,
	].join("");
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push("eval", `code=(async function(){${script}})()`);
	return execObsidian(args, false, timeoutMs).stdout.trim() || `Created note "${notePath}" from template "${templateName}".`;
}

function renameTag(from: string, to: string, vault?: string, timeoutMs = 30_000): string {
	const script = [
		`const ff=${JSON.stringify(from)},tt=${JSON.stringify(to)};`,
		`let u=0,s=0;`,
		`for(const f of app.vault.getMarkdownFiles()){`,
		`let c=await app.vault.read(f);`,
		`const o=c;`,
		`let m=c.match(/^---\\s*\\n([\\s\\S]*?)\\n---/);`,
		`if(!m){s++;continue;}`,
		`let fm=m[1];`,
		`let nfm=fm.replace(/\\btags\\b[^]*?(?=\\n---|$)/g,(tl)=>tl.replaceAll(ff,tt));`,
		`if(nfm===fm){s++;continue;}`,
		`c='---\\n'+nfm+'\\n---'+c.slice(m[0].length);`,
		`await app.vault.modify(f,c);u++;}`,
		`return 'tag-rename: '+u+' updated, '+s+' skipped.';`,
	].join("");
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push("eval", `code=(async function(){${script}})()`);
	return execObsidian(args, false, timeoutMs).stdout.trim() || "Done.";
}

// ---------------------------------------------------------------------------
// Route JSON output to formatters
// ---------------------------------------------------------------------------

function formatObsidianOutput(cmdString: string, parsed: unknown): string {
	if (cmdString.startsWith("search")) {
		const flags = parseFlags(cmdString);
		return formatSearchResults(parsed, flags.group === "file");
	}
	if (cmdString.startsWith("tasks ") || cmdString.startsWith("tasks")) {
		const flags = parseFlags(cmdString);
		if (flags.group === "file" && flags.status) return formatTasksFiltered(parsed, flags.status as "open" | "done" | "all");
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
			const cmd = raw.split(/\s+/)[0];
			const timeoutMs = (p.timeout_ms as number) ?? 30_000;
			const v = p.vault as string | undefined;
			const flags = parseFlags(raw);

			// --- files: recursive, root, normal ---
			if (cmd === "files") {
				const folder = flags.folder ?? "";
				const isRoot = folder === "/" || folder === "";
				if (isRoot || raw.includes("recursive")) {
					if (!isRoot && !raw.includes("recursive")) {
						// Specific non-root, non-recursive — pass through
						const args: string[] = [];
						if (v) args.push(`vault=${v}`);
						args.push("files", `folder=${folder}`, "format=json");
						try {
							const r = execObsidian(args, false, timeoutMs);
							if (r.parsed && Array.isArray(r.parsed) && r.parsed.length > 0) return (r.parsed as string[]).sort().join("\n");
						} catch { /* fall through */ }
						return "No files found.";
					}
					return listFilesRecursive(folder, v, timeoutMs);
				}
				const args: string[] = [];
				if (v) args.push(`vault=${v}`);
				args.push("files", `folder=${folder}`, "format=json");
				try {
					const r = execObsidian(args, false, timeoutMs);
					if (r.parsed && Array.isArray(r.parsed) && r.parsed.length > 0) return (r.parsed as string[]).sort().join("\n");
				} catch { /* fall through */ }
				return "No files found.";
			}

			// --- tag-rename ---
			if (cmd === "tag-rename") {
				if (!flags.from || !flags.to) throw new Error("'from' and 'to' required.");
				return renameTag(flags.from, flags.to, v, timeoutMs);
			}

			// --- eval: inline or from note ---
			if (cmd === "eval") {
				let code = flags.code || "";
				if (flags.file) {
					const rArgs: string[] = [];
					if (v) rArgs.push(`vault=${v}`);
					rArgs.push("read", `path=${flags.file}`);
					code = execObsidian(rArgs, false, timeoutMs).stdout;
				}
				if (!code) throw new Error("'code=' or 'file=' required.");
				const eArgs: string[] = [];
				if (v) eArgs.push(`vault=${v}`);
				eArgs.push("eval", `code=(async function(){${code}})()`);
				return execObsidian(eArgs, false, timeoutMs).stdout.trim() || "Done.";
			}

			// --- create/write with content_from ---
			if (cmd === "create" || cmd === "write" || cmd === "overwrite") {
				const path = flags.path || "";
				if (flags.content_from && path) {
					const rArgs: string[] = [];
					if (v) rArgs.push(`vault=${v}`);
					rArgs.push("read", `path=${flags.content_from}`);
					const content = execObsidian(rArgs, false, timeoutMs).stdout;
					// ensure parent folder via single eval call
					if (path.includes("/") || path.includes("\\")) {
						const eArgs: string[] = [];
						if (v) eArgs.push(`vault=${v}`);
						eArgs.push("eval", `code=(async()=>{const p=${JSON.stringify(path)}.replace(/\\\\/g,'/'),d=p.slice(0,p.lastIndexOf('/'));if(d&&!app.vault.getAbstractFileByPath(d))await app.vault.createFolder(d,true)})()`);
						execObsidian(eArgs, false, timeoutMs);
					}
					const cArgs: string[] = [];
					if (v) cArgs.push(`vault=${v}`);
					cArgs.push("create", `path=${path}`, `content=${escapeCliValue(content)}`);
					if (raw.includes("overwrite=true")) cArgs.push("overwrite=true");
					return execObsidian(cArgs, false, timeoutMs).stdout.trim() || `Created note from "${flags.content_from}".`;
				}
				if (path && (path.includes("/") || path.includes("\\"))) {
					const eArgs: string[] = [];
					if (v) eArgs.push(`vault=${v}`);
					eArgs.push("eval", `code=(async()=>{const p=${JSON.stringify(path)}.replace(/\\\\/g,'/'),d=p.slice(0,p.lastIndexOf('/'));if(d&&!app.vault.getAbstractFileByPath(d))await app.vault.createFolder(d,true)})()`);
					execObsidian(eArgs, false, timeoutMs);
				}
			}

			// --- property:set with arrays — rejoin split tokens ---
			if (cmd === "property:set") {
				const args = parseCliString(raw);
				const ai = args.findIndex(a => a.startsWith("value="));
				if (ai >= 0 && !args[ai].endsWith("]")) {
					const joined = [args[ai].slice(6), ...args.slice(ai + 1)].join(" ");
					const fixed = [...args.slice(0, ai), `value=${joined}`, ...args.slice(ai + 2)];
					if (v) fixed.unshift(`vault=${v}`);
					const r = execObsidian(fixed, false, timeoutMs);
					return r.stdout.trim() || "Done.";
				}
			}

			// --- Standard CLI passthrough ---
			const args = parseCliString(raw);
			if (v) args.unshift(`vault=${v}`);
			const r = execObsidian(args, false, timeoutMs);
			if (r.parsed && typeof r.parsed !== "string") return formatObsidianOutput(raw, r.parsed);
			return r.stdout.trim() || "Done.";
		}),
	});
}
