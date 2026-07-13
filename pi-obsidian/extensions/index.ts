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

export function readQuotedContent(s: string, pos: number): { value: string; endPos: number } {
	let val = "";
	while (pos < s.length && s[pos] !== '"') {
		if (s[pos] === "\\" && pos + 1 < s.length && (s[pos + 1] === '"' || s[pos + 1] === "\\")) {
			pos++; val += s[pos++];
		} else {
			val += s[pos++];
		}
	}
	return { value: val, endPos: pos };
}

export function parseCliString(s: string): string[] {
	const args: string[] = [];
	let i = 0;
	while (i < s.length) {
		while (i < s.length && /\s/.test(s[i])) i++;
		if (i >= s.length) break;
		let val = "";
		if (s[i] === '"') { i++; const r = readQuotedContent(s, i); val = r.value; i = r.endPos + 1; }
		else {
			while (i < s.length && !/\s/.test(s[i])) {
				if (s[i] === '"') { i++; const r = readQuotedContent(s, i); val += r.value; i = r.endPos + 1; }
				else { val += s[i++]; }
			}
		}
		args.push(val);
	}
	return args;
}

export function parseFlags(s: string): Record<string, string> {
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

export function escapeCliValue(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
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
	if (!noteName.includes(".")) noteName += ".md";
	const notePath = folder ? `${folder}/${noteName}` : noteName;
	// ponytail: normalize template name, fallback to name-based search
	const tplName = templateName.endsWith(".md") ? templateName : templateName + ".md";
	const script = [
		`const nameToFind=${j(tplName)};`,
		`let tf=app.vault.getAbstractFileByPath(nameToFind);`,
		`if(!tf){`,
		`const all=app.vault.getMarkdownFiles();`,
		`const matches=all.filter(f=>f.name.toLowerCase()===nameToFind.toLowerCase());`,
		`if(matches.length===1)tf=matches[0];`,
		`else if(matches.length>1)return'Multiple templates match \"'+nameToFind+'\". Use full path.';`,
		`}`,
		`if(!tf)return'Template not found: '+nameToFind;`,
		`let c=await app.vault.read(tf);`,
		`const fl=${JSON.stringify(fill)};`,
		`for(const[k,v]of Object.entries(fl))c=c.replace(new RegExp('\\\\{\\\\{\\\\s*'+k.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')+'\\\\s*\\\\}\\\\}','g'),v);`,
		`c=c.replace(/\\{\\{date:([^}]+)\\}\\}/g,(_,f)=>{const d=new Date();return f.replace(/YYYY/g,d.getFullYear()).replace(/MM/g,('0'+(d.getMonth()+1)).slice(-2)).replace(/DD/g,('0'+d.getDate()).slice(-2)).replace(/HH/g,('0'+d.getHours()).slice(-2)).replace(/mm/g,('0'+d.getMinutes()).slice(-2));});`,
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

function propertyRename(from: string, to: string, filePath?: string, vault?: string, timeoutMs = 30_000): string {
	const j = JSON.stringify;
	const scopeFilter = filePath
		? [`const files=[app.vault.getAbstractFileByPath(${j(filePath)})].filter(Boolean);`]
		: [`const files=app.vault.getMarkdownFiles();`];
	const script = [
		...scopeFilter,
		`const ff=${j(from)},tt=${j(to)};`,
		`let u=0,s=0;`,
		`for(const f of files){`,
		`let c=await app.vault.read(f);`,
		`let m=c.match(/^---\\s*\\n([\\s\\S]*?)\\n---/);`,
		`if(!m){s++;continue;}`,
		`let fm=m[1];`,
		`let nfm=fm.split('\\n').map(l=>l.startsWith(ff+':')?tt+l.slice(ff.length):l).join('\\n');`,
		`if(nfm===fm){s++;continue;}`,
		`c='---\\n'+nfm+'\\n---'+c.slice(m[0].length);`,
		`await app.vault.modify(f,c);u++;}`,
		`const scopeMsg=${j(filePath ? `Renamed in "${filePath}".` : "Global rename across all files. Use `file=...` to scope to one file.")};`,
		`return scopeMsg+' '+u+' properties renamed ('+s+' skipped).';`,
	].join("");
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push("eval", `code=(async function(){${script}})()`);
	return execObsidian(args, false, timeoutMs).stdout.trim() || "Done.";
}

function renameTag(from: string, to: string, preview: boolean, vault?: string, timeoutMs = 30_000): string {
	const script = [
		`const ff=${JSON.stringify(from)},tt=${JSON.stringify(to)};`,
		`const preview=${preview ? "true" : "false"};`,
		`let u=0,s=0;`,
		`const results=[];`,
		`for(const f of app.vault.getMarkdownFiles()){`,
		`let c=await app.vault.read(f);`,
		`const o=c;`,
		`let m=c.match(/^---\\s*\\n([\\s\\S]*?)\\n---/);`,
		`if(!m){s++;continue;}`,
		`let fm=m[1];`,
		`let nfm=fm.replace(/\\btags\\b[^]*?(?=\\n---|$)/g,(tl)=>tl.replaceAll(ff,tt));`,
		`if(nfm===fm){s++;continue;}`,
		`if(preview){`,
		`results.push('[DRY-RUN] '+f.path+': would update tag '+ff+' -> '+tt);`,
		`}else{`,
		`c='---\\n'+nfm+'\\n---'+c.slice(m[0].length);`,
		`await app.vault.modify(f,c);`,
		`results.push(f.path);`,
		`}`,
		`u++;}`,
		`const header=preview?'tag-rename dry-run: ':'tag-rename: ';`,
		`return header+u+' updated, '+s+' skipped.\\n'+results.join('\\n');`,
	].join("");
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push("eval", `code=(async function(){${script}})()`);
	return execObsidian(args, false, timeoutMs).stdout.trim() || "Done.";
}

function searchReplace(
	query: string,
	replace: string,
	flags: { regex?: boolean; preview?: boolean },
	vault?: string,
	timeoutMs = 30_000
): string {
	const j = JSON.stringify;
	const useRegex = flags.regex ?? false;
	const preview = flags.preview ?? false;
	const script = [
		`const q=${j(query)},r=${j(replace)};`,
		`const useRegex=${useRegex};`,
		`const preview=${preview};`,
		`let results=[];`,
		`for(const f of app.vault.getMarkdownFiles()){`,
		`let c=await app.vault.read(f);`,
		`let nc=c;`,
		`if(useRegex){`,
		`try{const re=new RegExp(q,'g');nc=c.replace(re,r);}`,
		`catch(e){results.push(f.path+': regex error: '+e.message);continue;}`,
		`}else{`,
		`nc=c.split(q).join(r);`,
		`}`,
		`if(nc!==c){`,
		`if(preview){`,
		`const idx=c.indexOf(q);`,
		`const start=Math.max(0,idx-40);`,
		`const end=Math.min(c.length,idx+q.length+40);`,
		`results.push(f.path+': '+JSON.stringify(c.slice(start,end)));`,
		`}else{`,
		`await app.vault.modify(f,nc);`,
		`results.push(f.path);`,
		`}`,
		`}`,
		`}`,
		`return results.length+' file(s):\\n'+results.join('\\n');`,
	].join("");
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push("eval", `code=(async function(){${script}})()`);
	return execObsidian(args, false, timeoutMs).stdout.trim() || "No changes.";
}

function filesMissingProperty(property: string, vault?: string, timeoutMs = 30_000): string {
	const script = [
		`const prop=${JSON.stringify(property)};`,
		`const missing=[];`,
		`for(const f of app.vault.getMarkdownFiles()){`,
		`let c=await app.vault.read(f);`,
		`let m=c.match(/^---\\s*\\n([\\s\\S]*?)\\n---/);`,
		`if(!m){missing.push(f.path+' (no frontmatter)');continue;}`,
		`if(!m[1].includes(prop+':'))missing.push(f.path);`,
		`}`,
		`if(missing.length===0)return 'All files have "'+prop+'".';`,
		`return missing.length+' file(s) missing "'+prop+'":\\n'+missing.join('\\n');`,
	].join("");
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push("eval", `code=(async function(){${script}})()`);
	return execObsidian(args, false, timeoutMs).stdout.trim() || "Done.";
}

function frontmatterWrap(vault?: string, timeoutMs = 30_000): string {
	const script = [
		`let u=0,s=0;`,
		`for(const f of app.vault.getMarkdownFiles()){`,
		`let c=await app.vault.read(f);`,
		`if(c.match(/^---\\s*\\n/)){s++;continue;}`,
		`const lines=c.split('\\n');`,
		`let firstRealLine=-1;`,
		`for(let i=0;i<lines.length;i++){if(lines[i].trim()){firstRealLine=i;break;}}`,
		`if(firstRealLine<0){s++;continue;}`,
		`const fl=lines[firstRealLine].trim();`,
		`if(!fl.startsWith('title:')&&!fl.startsWith('tags:')){s++;continue;}`,
		`let fmEnd=lines.length;`,
		`let afterFirst=false;`,
		`for(let i=firstRealLine+1;i<lines.length;i++){`,
		`const t=lines[i].trim();`,
		`if(t.startsWith('#')||t.startsWith('---')){fmEnd=i;break;}`,
		`if(afterFirst&&!t){fmEnd=i;break;}`,
		`if(t)afterFirst=true;`,
		`}`,
		`const fm=lines.slice(firstRealLine,fmEnd).join('\\n');`,
		`const body=lines.slice(fmEnd).join('\\n');`,
		`await app.vault.modify(f,'---\\n'+fm+'\\n---\\n'+body);u++;`,
		`}`,
		`return u+' files wrapped ('+s+' skipped).';`,
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
	const cmd = cmdString.split(/\s+/)[0];
	const flags = parseFlags(cmdString);
	switch (cmd) {
		case "search":
			return formatSearchResults(parsed, flags.group === "file");
		case "tasks":
			if (flags.group === "file" && flags.status) return formatTasksFiltered(parsed, flags.status as "open" | "done" | "all");
			if (flags.group === "file") return formatTasks(parsed, true);
			if (flags.status) return formatTasksFiltered(parsed, flags.status as "open" | "done" | "all");
			return formatTasks(parsed);
		case "tag":
		case "tags":
			return formatTags(parsed);
		case "properties":
			return formatProperties(parsed);
		case "backlinks":
			return formatLinks(parsed, "Backlinks");
		case "links":
			return formatOutgoingLinks(parsed);
		case "outline":
			return formatOutline(parsed);
		case "aliases":
			return formatAliases(parsed);
		case "wordcount":
			return formatWordCount(parsed);
		case "file":
			return formatFileInfo(parsed);
		default:
			return JSON.stringify(parsed, null, 2);
	}
}

// ---------------------------------------------------------------------------
// Tool wrapper
// ---------------------------------------------------------------------------

function tool(body: (p: Record<string, unknown>) => string) {
	return async function execute(_id: string, params: Record<string, unknown>) {
		const text = body(params);
		return { content: [{ type: "text" as const, text }], details: {} };
	};
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function piObsidianExtension(pi: ExtensionAPI) {

	pi.registerTool({
		name: "obsidian",
		label: "Run Obsidian CLI Command",
		description: "Run an Obsidian CLI command on the vault. Commands: read, write, search, tasks, tags, eval.",
		promptSnippet: "Run an Obsidian CLI command on the vault",
		promptGuidelines: [
			"Format: `<command> <key=value> ... <flag>`",
			"Quote spaces: `file=\"My Note\"`, content=`# Title`.",
			"content_from=SourceNoteName for content with quotes.",
			"eval file=ScriptNoteName for JS from vault note.",
			"format=json for structured output (search, tasks, tags).",
			"Boolean flags: permanent, overwrite, total, verbose, inline, silent.",
			"file= for wikilinks, path= for exact paths.",
			"Commands: read, create, write, append, prepend, delete, move, rename,",
			"  search, tags, tag-rename, property:set, property:rename, properties,",
			"  tasks, task-create, create-from-template,",
			"  backlinks, outline, links, daily:*,",
			"  vault, files, history, diff, templates, eval, bookmarks, plugins,",
			"  frontmatter:wrap.",
			"move: `destination=<path>` accepted as alias for `to=<path>`.",
			"Search with replace: `search query=text replace=new regex=true preview=true`",
			"Files by missing property: `files missing-property=created`",
			"Property rename: `property:rename from=date to=created`",
			"Frontmatter wrap: `frontmatter:wrap`",
			"search --replace uses preview=true for dry-run; omit to apply.",
		],
		parameters: Type.Object({
			run: Type.String({
				description: "Full Obsidian CLI command via \`run\` param."
			}),
			vault: Type.Optional(Type.String({ description: "Target vault. Default: most recent." })),
			timeout_ms: Type.Optional(Type.Number({ description: "Timeout ms (default 30000)." })),
		}),
		execute: tool((p) => {
			let raw = (p.run as string).trim();
			if (!raw) throw new Error("'run' is required.");
			const cmd = raw.split(/\s+/)[0];
			if (cmd.startsWith("daily:") && !["daily:read", "daily:append", "daily:prepend"].includes(cmd)) {
				throw new Error(`Command "${cmd}" is only available via the Obsidian desktop app and is not supported in CLI mode.`);
			}
			const v = p.vault as string | undefined;
			const flags = parseFlags(raw);
			const timeoutMs = (p.timeout_ms as number) ?? (flags.timeout_ms ? parseInt(flags.timeout_ms) : 30_000);

			// --- files: recursive, root, normal, missing-property ---
			if (cmd === "files") {
				if (flags["missing-property"]) {
					return filesMissingProperty(flags["missing-property"], v, timeoutMs);
				}
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
							if (typeof r.parsed === "string" && r.parsed.trim()) {
								const files = r.parsed.trim().split("\n").filter(Boolean).sort();
								if (files.length > 0) return files.join("\n");
							}
							if (r.parsed && Array.isArray(r.parsed) && r.parsed.length > 0) return (r.parsed as string[]).sort().join("\n");
						} catch { /* fall through */ }
						return "No files found.";
					}
					return listFilesRecursive(isRoot ? "" : folder, v, timeoutMs);
				}
				const args: string[] = [];
				if (v) args.push(`vault=${v}`);
				args.push("files", `folder=${folder}`, "format=json");
				try {
					const r = execObsidian(args, false, timeoutMs);
					if (typeof r.parsed === "string" && r.parsed.trim()) {
						const files = r.parsed.trim().split("\n").filter(Boolean).sort();
						if (files.length > 0) return files.join("\n");
					}
					if (r.parsed && Array.isArray(r.parsed) && r.parsed.length > 0) return (r.parsed as string[]).sort().join("\n");
				} catch { /* fall through */ }
				return "No files found.";
			}

			// --- enhanced note operations ---
			if (cmd === "task-create") {
				if ((!flags.path && !flags.file) || !flags.heading || !flags.text) throw new Error("'path' (or 'file'), 'heading' and 'text' required.");
				const notePath = flags.path || flags.file;
				return createTaskInNote(notePath, flags.heading, flags.text, v, timeoutMs);
			}
			if (cmd === "create-from-template") {
				if (!flags.template || !flags.name) throw new Error("'template' and 'name' required.");
				const fill = Object.fromEntries(Object.entries(flags).filter(([key]) => !["template", "name", "folder"].includes(key)));
				return createFromTemplate(flags.template, flags.name, flags.folder ?? "", fill, v, timeoutMs);
			}

			// --- tag-rename (B4: preview support added) ---
			if (cmd === "tag-rename") {
				if (!flags.from || !flags.to) throw new Error("'from' and 'to' required.");
				const preview = flags.preview === "true" || flags.preview === "1";
				return renameTag(flags.from, flags.to, preview, v, timeoutMs);
			}

			// --- property:rename (B5: optional file/path scoping added) ---
			if (cmd === "property:rename") {
				if (!flags.from || !flags.to) throw new Error("'from' and 'to' required.");
				const filePath = flags.file || flags.path || undefined;
				return propertyRename(flags.from, flags.to, filePath, v, timeoutMs);
			}

			// --- search with replace ---
			if (cmd === "search" && flags.replace) {
				const regex = flags.regex === "true" || flags.regex === "1";
				const preview = flags.preview === "true" || flags.preview === "1";
				return searchReplace(flags.query || "", flags.replace, { regex, preview }, v, timeoutMs);
			}

			// --- search with empty query → match everything ---
			if (cmd === "search" && !flags.query) {
				const folder = flags.path || flags.folder || "";
				if (folder) {
					const sArgs: string[] = [];
					if (v) sArgs.push(`vault=${v}`);
					sArgs.push("files", `folder=${folder}`, "format=json");
					const r = execObsidian(sArgs, false, timeoutMs);
					if (r.parsed && typeof r.parsed !== "string") return formatObsidianOutput(raw, r.parsed);
					return r.stdout.trim() || "No files found.";
				}
				return listFilesRecursive("", v, timeoutMs);
			}

			// --- frontmatter:wrap ---
			if (cmd === "frontmatter:wrap") {
				return frontmatterWrap(v, timeoutMs);
			}

			// --- eval: inline or from note (B7: auto-add return for bare expressions) ---
			if (cmd === "eval") {
				let code = flags.code || "";
				if (flags.file) {
					const rArgs: string[] = [];
					if (v) rArgs.push(`vault=${v}`);
					rArgs.push("read", `path=${flags.file}`);
					code = execObsidian(rArgs, false, timeoutMs).stdout;
				}
				if (!code) throw new Error("'code=' or 'file=' required.");
				// ponytail: auto-add return for simple bare expressions
				const trimmed = code.trim();
				if (
					!trimmed.startsWith("return ") &&
					!trimmed.startsWith("if") &&
					!trimmed.startsWith("for") &&
					!trimmed.startsWith("while") &&
					!trimmed.startsWith("{") &&
					!trimmed.startsWith("const ") &&
					!trimmed.startsWith("let ") &&
					!trimmed.startsWith("var ") &&
					!trimmed.startsWith("async") &&
					!trimmed.startsWith("function") &&
					!trimmed.startsWith("try") &&
					!trimmed.startsWith("switch") &&
					code.length < 200 &&
					!code.includes(";")
				) {
					code = "return " + trimmed;
				}
				const eArgs: string[] = [];
				if (v) eArgs.push(`vault=${v}`);
				eArgs.push("eval", `code=(async function(){${code}})()`);
				return execObsidian(eArgs, false, timeoutMs).stdout.trim() || "Done.";
			}

			// --- create/write (B1: normalize file= to path= for CLI) ---
			if (cmd === "create" || cmd === "write" || cmd === "overwrite") {
				const path = flags.path || flags.file || "";
				if (flags.content_from && path) {
					const rArgs: string[] = [];
					if (v) rArgs.push(`vault=${v}`);
					rArgs.push("read", `path=${flags.content_from}`);
					const content = execObsidian(rArgs, false, timeoutMs).stdout;
					const cArgs: string[] = [];
					if (v) cArgs.push(`vault=${v}`);
					cArgs.push("create", `path=${path}`, `content=${escapeCliValue(content)}`);
					if (cmd !== "create" || raw.includes("overwrite=true")) cArgs.push("overwrite=true");
					return execObsidian(cArgs, false, timeoutMs).stdout.trim() || `Created note from "${flags.content_from}".`;
				}
				// Normal create/write: rewrite args so CLI gets path= instead of file=
				if (path) {
					const cArgs = parseCliString(raw);
					// Obsidian CLI has no 'write' command — normalize to 'create'
					if (cArgs[0] === "write" || cArgs[0] === "overwrite") {
						cArgs[0] = "create";
					}
					// Replace any file= or path= arg with the resolved path=
					for (let i = 1; i < cArgs.length; i++) {
						if (cArgs[i].startsWith("file=") || cArgs[i].startsWith("path=")) {
							cArgs[i] = `path=${path}`;
							break;
						}
					}
					if (cmd !== "create" || raw.includes("overwrite=true")) {
						if (!cArgs.includes("overwrite=true")) cArgs.push("overwrite=true");
					}
					if (v) cArgs.unshift(`vault=${v}`);
					return execObsidian(cArgs, false, timeoutMs).stdout.trim() || "Done.";
				}
			}

			// --- property:set with array values ---
			if (cmd === "property:set") {
				const args = parseCliString(raw);
				const ai = args.findIndex(a => a.startsWith("value="));
				if (ai >= 0) {
					let end = ai + 1;
					while (end < args.length && !/^\w[\w-]*=/.test(args[end])) end++;
					const value = [args[ai].slice(6), ...args.slice(ai + 1, end)].join(" ");
					if (value.startsWith("[") && value.endsWith("]")) {
						const fixed = [...args.slice(0, ai), ...args.slice(end)];
						const ti = fixed.findIndex(a => a.startsWith("type="));
						if (ti >= 0) fixed.splice(ti, 1);
						fixed.splice(ai, 0, "type=list", `value=${value.slice(1, -1)}`);
						if (v) fixed.unshift(`vault=${v}`);
						const r = execObsidian(fixed, false, timeoutMs);
						return r.stdout.trim() || "Done.";
					}
				}
			}

			// --- Standard CLI passthrough (B1/B6: normalize file= and bare paths) ---
			const args = parseCliString(raw);
			// ponytail: normalize bare positional arg to path= for read/append/prepend
			if (args.length >= 2 && !args[1].includes("=")) {
				args[1] = "path=" + args[1];
			}
			// R2: normalize file= to path= for delete (create/write handled earlier, this is fallback)
			for (let i = 1; i < args.length; i++) {
				if (args[i].startsWith("file=") && args[0] === "delete") {
					args[i] = "path=" + args[i].slice(5);
				}
			}
			// B9: normalize destination= to to= for move (backward-compatible alias),
			//     and infer file extension on to= from source filename when missing.
			//     Obsidian CLI treats to= without extension as a folder (e.g. Dest/Src.md
			//     instead of Dest.md), so we append the source's extension or default .md.
			if (cmd === "move") {
				const di = args.findIndex(a => a.startsWith("destination="));
				if (di >= 0) args[di] = "to=" + args[di].slice(12);
				const ti = args.findIndex(a => a.startsWith("to="));
				const fi = args.findIndex(a => a.startsWith("file=") || a.startsWith("path="));
				if (ti >= 0 && fi >= 0) {
					const toVal = args[ti].slice(3);
					const srcVal = args[fi].slice(5);
					const toLast = toVal.split("/").pop() || "";
					const srcLast = srcVal.split("/").pop() || "";
					if (toLast && !toLast.includes(".")) {
						const ext = srcLast.includes(".") ? srcLast.slice(srcLast.lastIndexOf(".")) : ".md";
						args[ti] = "to=" + toVal + ext;
					}
				}
			}
			if (v) args.unshift(`vault=${v}`);
			const r = execObsidian(args, false, timeoutMs);
			if (r.parsed && typeof r.parsed !== "string") return formatObsidianOutput(raw, r.parsed);
			return r.stdout.trim() || "Done.";
		}),
	});
}
