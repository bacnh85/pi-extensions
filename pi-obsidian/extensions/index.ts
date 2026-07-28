import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
// Vault guard
// ---------------------------------------------------------------------------

export function obsidianVaultRoot(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  let dir = resolve(cwd);
  while (true) {
    try {
      if (statSync(join(dir, ".obsidian")).isDirectory()) return dir;
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function isObsidianVaultCwd(cwd: string | undefined): boolean {
  return Boolean(obsidianVaultRoot(cwd));
}

function canonicalPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

export function isPathInObsidianVault(path: string | undefined, cwd: string, vaultRoot = obsidianVaultRoot(cwd)): boolean {
  if (!path || !vaultRoot) return false;
  const fromRoot = relative(canonicalPath(vaultRoot), canonicalPath(resolve(cwd, path)));
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

export function parseVaultInfo(output: string): { name: string; path: string } | undefined {
  const name = output.match(/^name\s+(.+)$/m)?.[1]?.trim();
  const path = output.match(/^path\s+(.+)$/m)?.[1]?.trim();
  return name && path ? { name, path } : undefined;
}

export function vaultNameForCwd(cwd: string | undefined, active: { name: string; path: string } | undefined): string | undefined {
  const root = obsidianVaultRoot(cwd);
  return root && active && resolve(active.path) === root ? active.name : undefined;
}

function focusedVaultNameForCwd(cwd: string | undefined): string | undefined {
  return vaultNameForCwd(cwd, parseVaultInfo(execObsidian(["vault"]).stdout));
}

function redirectionDestination(command: string): string | undefined {
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote && command[i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return parseCliString(command.slice(i + (command[i + 1] === ">" ? 2 : 1)).trim())[0];
  }
  return undefined;
}

export function isVaultFilesystemBashCommand(command: unknown, cwd: string, vaultRoot = obsidianVaultRoot(cwd)): boolean {
  if (typeof command !== "string" || !vaultRoot) return false;
  const trimmed = command.trim();
  if (/[;&|`$()]/.test(trimmed)) return true;
  const tokens = parseCliString(trimmed);
  while (tokens[0] === "command" || tokens[0] === "env") tokens.shift();
  while (tokens[0]?.startsWith("-")) tokens.shift();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) tokens.shift();
  const commandName = basename(tokens.shift() ?? "");
  if (!commandName) return false;
  const args = tokens;
  const targets = (values: string[]) => values.filter((value) => !value.startsWith("-"));
  const hasVaultTarget = (values: string[]) => values.some((value) => isPathInObsidianVault(value, cwd, vaultRoot));
  const inPlaceFiles = (values: string[]) => {
    let programSeen = false;
    const files: string[] = [];
    for (let i = 0; i < values.length; i++) {
      if (values[i] === "-e") { i++; programSeen = true; continue; }
      if (values[i].startsWith("-")) continue;
      if (!programSeen) { programSeen = true; continue; }
      files.push(values[i]);
    }
    return files;
  };

  if (/^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint)|build|lint)\b/.test(trimmed)
    || /^git\s+(?:status|diff|log|branch)\b/.test(trimmed)
    || /^(?:node|python|python3)\s+--version\b/.test(trimmed)
    || ["pwd", "which"].includes(commandName)) return false;
  if (["ls", "find"].includes(commandName)) {
    const locations = targets(args);
    return locations.length === 0 || hasVaultTarget(locations);
  }
  if (["cat", "cp", "mv", "rm", "touch", "mkdir", "rmdir", "tee", "unlink"].includes(commandName)) return hasVaultTarget(targets(args));
  if (commandName === "truncate") return hasVaultTarget(targets(args).filter((value) => !/^\d+$/.test(value)));
  if (["head", "tail"].includes(commandName)) return hasVaultTarget(targets(args).filter((value) => !/^\d+$/.test(value)));
  if (["grep", "rg", "ag", "ack"].includes(commandName)) {
    const values = targets(args);
    const recursive = args.some((value) => value === "-r" || value === "-R" || value === "--recursive");
    return (["rg", "ag", "ack"].includes(commandName) || recursive) && values.length <= 1
      || values.length > 1 && isPathInObsidianVault(values.at(-1), cwd, vaultRoot);
  }
  if (["echo", "printf"].includes(commandName)) return isPathInObsidianVault(redirectionDestination(trimmed), cwd, vaultRoot);
  if (["sed", "perl"].includes(commandName) && args.some((value) => /^-i(?:.|$)|^--in-place(?:=|$)|^-.*i/.test(value))) return hasVaultTarget(inPlaceFiles(args));
  return true;
}

// ---------------------------------------------------------------------------
// CLI string parser
// ---------------------------------------------------------------------------

export function readQuotedContent(s: string, pos: number): { value: string; endPos: number } {
  let val = "";
  while (pos < s.length && s[pos] !== '"') {
    if (s[pos] === "\\" && pos + 1 < s.length) {
      const next = s[pos + 1];
      if (next === '"' || next === "\\") {
        pos++; val += s[pos++];
      } else if (next === "n") { pos += 2; val += "\n"; }
      else if (next === "t") { pos += 2; val += "\t"; }
      else if (next === "r") { pos += 2; val += "\r"; }
      else { val += s[pos++]; } // passthrough unknown escapes
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
  // Use parseCliString so escape sequences (\n, \t) are handled consistently
  const args = parseCliString(s);
  for (const arg of args) {
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      flags[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Write note content via base64-encoded eval.
//
// The Obsidian CLI's content= parser only understands \n and \t escapes —
// backslashes, quotes, pipes, and literal \n all get corrupted.  And on
// Windows the argv ceiling (~8 KB) silently truncates large payloads.
// Base64-encoding the content and decoding inside eval eliminates BOTH
// problems: no escaping needed, and large content is split into safe
// base64 chunks that are reassembled via read+modify.
// ---------------------------------------------------------------------------

const MAX_B64_CHUNK = 6000; // chars per eval call (safe under Windows cmd.exe ~8 KB ceiling)

/** Decode a base64 string to UTF-8 inside the Obsidian app context. */
const b64Decode = (chunk: string) => `decodeURIComponent(escape(atob(${JSON.stringify(chunk)})))`;

/** Ensure parent folders exist before writing. */
const ensureFolder = (notePath: string) =>
  `const p=${JSON.stringify(notePath)}.replace(/\\\\/g,'/').split('/').slice(0,-1).join('/');` +
  `if(p&&!app.vault.getAbstractFileByPath(p))await app.vault.createFolder(p,true);`;

/** Build the chunk-0 eval script for the given mode and base64 chunk. */
export function buildFirstScript(
  notePath: string,
  mode: "create" | "overwrite" | "append" | "prepend",
  b64Chunk0: string
): string {
  const t = JSON.stringify(notePath);
  const c0 = b64Decode(b64Chunk0);
  let body: string;
  if (mode === "create") {
    body = `const t=${t};if(app.vault.getAbstractFileByPath(t))throw new Error('File already exists: '+t);${ensureFolder(notePath)}await app.vault.create(t,${c0});return 'ok'`;
  } else if (mode === "overwrite") {
    body = `const t=${t};const e=app.vault.getAbstractFileByPath(t);const c=${c0};if(e){await app.vault.modify(e,c);return 'ok'}${ensureFolder(notePath)}await app.vault.create(t,c);return 'ok'`;
  } else if (mode === "append") {
    body = `const t=${t};const e=app.vault.getAbstractFileByPath(t);const c=${c0};if(e){const o=await app.vault.read(e);await app.vault.modify(e,o+c);return 'ok'}${ensureFolder(notePath)}await app.vault.create(t,c);return 'ok'`;
  } else { // prepend
    body = `const t=${t};const e=app.vault.getAbstractFileByPath(t);const c=${c0};if(e){const o=await app.vault.read(e);const m=o.match(/^---\\s*\\n[\\s\\S]*?\\n---\\s*\\n/);const i=m?m[0].length:0;await app.vault.modify(e,o.slice(0,i)+c+o.slice(i));return 'ok'}${ensureFolder(notePath)}await app.vault.create(t,c);return 'ok'`;
  }
  return `(async function(){try{${body}}catch(e){return 'Error: '+String(e&&e.message||e)}})()`;
}

/** Build a chunk-append eval script for chunks 1..N. */
export function buildChunkScript(notePath: string, b64Chunk: string): string {
  const t = JSON.stringify(notePath);
  return `(async function(){try{const f=app.vault.getAbstractFileByPath(${t});if(!f)throw new Error('File not found after chunk 0');const o=await app.vault.read(f);await app.vault.modify(f,o+${b64Decode(b64Chunk)});return 'ok'}catch(e){return 'Error: '+String(e&&e.message||e)}})()`;
}

/** Build an eval script that reads the file back and returns "length hash". */
export function buildVerifyScript(notePath: string): string {
  const t = JSON.stringify(notePath);
  return `(async function(){try{const f=app.vault.getAbstractFileByPath(${t});if(!f)throw new Error('not found after write');const s=await app.vault.read(f);const b=unescape(encodeURIComponent(s));let h=5381;for(let i=0;i<b.length;i++)h=((h<<5)+h+b.charCodeAt(i))>>>0;return h+' '+b.length}catch(e){return 'Error: '+String(e&&e.message||e)}})()`;
}

/** Compute a djb2 hash + byte length for a UTF-8 string, matching the in-eval formula. */
export function djb2Utf8(s: string): { hash: number; bytes: number } {
  // ponytail: djb2 length+hash; full-content compare if a collision ever bites
  const buf = Buffer.from(s, "utf8");
  let h = 5381;
  for (let i = 0; i < buf.length; i++)
    h = ((h << 5) + h + buf[i]) >>> 0;
  return { hash: h, bytes: buf.length };
}

/**
 * Write note content via base64-encoded eval.  Handles create, overwrite,
 * append, and prepend modes.  Splits large content into base64 chunks that
 * each fit in a single eval call, reassembling via read+modify.
 *
 * After all chunks are written, a read-back verification confirms the content
 * was written correctly, decoupling success from what the CLI eval echoes.
 *
 * Throws on any failure (empty output, eval "Error:" prefix, or verification
 * mismatch).
 */
export function vaultWrite(
  notePath: string,
  content: string,
  mode: "create" | "overwrite" | "append" | "prepend",
  vault?: string,
  timeoutMs = 30_000,
  exec: (args: string[], formatJson?: boolean, timeoutMs?: number) => { stdout: string; stderr: string; parsed: unknown } = execObsidian
): string {
  const j = JSON.stringify;
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const b64Chunks: string[] = [];
  for (let i = 0; i < b64.length; i += MAX_B64_CHUNK) b64Chunks.push(b64.slice(i, i + MAX_B64_CHUNK));
  if (b64Chunks.length === 0) b64Chunks.push("");

  const run = (script: string, label: string): string => {
    const args: string[] = [];
    if (vault) args.push(`vault=${vault}`);
    args.push("eval", `code=${script}`);
    const result = exec(args, false, timeoutMs);
    const out = result.stdout.trim().replace(/^=>\s?/, "");
    const stderr = (result.stderr || "").trim();
    if (!out || /^Error[:\s]/.test(out)) {
      throw new Error(
        `vaultWrite ${label} failed for "${notePath}": ${out || "(no output)"}` +
        (stderr ? `\n  Stderr: ${stderr.slice(0, 500)}` : "") +
        `\n  Script: ${script.slice(0, 200).replace(/\n/g, "\\n")}...`
      );
    }
    return out;
  };

  // --- first chunk: mode-specific initial write ---
  const status = run(buildFirstScript(notePath, mode, b64Chunks[0]), mode);

  // --- remaining chunks: always read+append to end ---
  for (let i = 1; i < b64Chunks.length; i++) {
    run(buildChunkScript(notePath, b64Chunks[i]), `chunk ${i}`);
  }

  // --- verify: read back and confirm content (only for create/overwrite where content = full file) ---
  if (mode === "create" || mode === "overwrite") {
    const verResult = run(buildVerifyScript(notePath), "verify");
    if (verResult.startsWith("Error:")) {
      throw new Error(`vaultWrite ${mode} verification failed for "${notePath}": ${verResult}`);
    }
    const [verHash, verBytes] = verResult.split(" ", 2).map(Number);
    const expected = djb2Utf8(content);
    if (verHash !== expected.hash || verBytes !== expected.bytes) {
      throw new Error(
        `vaultWrite ${mode} verification failed for "${notePath}": ` +
        `written ${verBytes} bytes (hash ${verHash}), expected ${expected.bytes} bytes (hash ${expected.hash})`
      );
    }
  }

  // Return a bridge-constructed success message (decoupled from eval echo)
  const modeLabels: Record<string, string> = {
    create: "Created",
    overwrite: "Updated",
    append: "Appended to",
    prepend: "Prepended to",
  };
  return `${modeLabels[mode]}: ${notePath}`;
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
    `const hlm=ls[hi].match(/^(#+)\\s*/);const hl=hlm?hlm[1].length:1;`,
    `let se=ls.length;`,
    `for(let i=hi+1;i<ls.length;i++){const m=ls[i].match(/^(#+)\\s*/);if(m&&m[1].length<=hl){se=i;break;}}`,
    `ls.splice(se,0,'- [ ] '+${j(taskText)});`,
    `await app.vault.modify(f,ls.join('\\n'));`,
    `return'Task added.';`,
  ].join("");
  const args: string[] = [];
  if (vault) args.push(`vault=${vault}`);
  args.push("eval", `code=(async function(){${script}})()`);
  const _out301 = execObsidian(args, false, timeoutMs).stdout.trim().replace(/^=>\s?/, "");
  if (!_out301 || /^Error[:\s]/.test(_out301)) return _out301 || `Added task "${taskText}" under heading "${heading}".`;
  return _out301;
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
  const _out332 = execObsidian(args, false, timeoutMs).stdout.trim().replace(/^=>\s?/, "");
  if (!_out332 || /^Error[:\s]/.test(_out332)) return _out332 || `Created note "${notePath}" from template "${templateName}".`;
  return _out332;
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
  const _out359 = execObsidian(args, false, timeoutMs).stdout.trim().replace(/^=>\s?/, "");
  if (!_out359 || /^Error[:\s]/.test(_out359)) return _out359 || "Done.";
  return _out359;
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
    `let nfm=fm.replace(/\\btags\\b[^]*?(?=\\n---|$)/g,(tl)=>tl.replace(new RegExp('\\\\b'+ff.replace(/[.*+?^\x24{}()|[\\]\\\\]/g,'\\\\$&')+'\\\\b','g'),tt));`,
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
  const _out390 = execObsidian(args, false, timeoutMs).stdout.trim().replace(/^=>\s?/, "");
  if (!_out390 || /^Error[:\s]/.test(_out390)) return _out390 || "Done.";
  return _out390;
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
  const _out434 = execObsidian(args, false, timeoutMs).stdout.trim().replace(/^=>\s?/, "");
  if (!_out434 || /^Error[:\s]/.test(_out434)) return _out434 || "No changes.";
  return _out434;
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
  const _out453 = execObsidian(args, false, timeoutMs).stdout.trim().replace(/^=>\s?/, "");
  if (!_out453 || /^Error[:\s]/.test(_out453)) return _out453 || "Done.";
  return _out453;
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
  const _out485 = execObsidian(args, false, timeoutMs).stdout.trim().replace(/^=>\s?/, "");
  if (!_out485 || /^Error[:\s]/.test(_out485)) return _out485 || "Done.";
  return _out485;
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
      if (flags.status && !["open", "done", "all"].includes(flags.status)) {
        return `Invalid status "${flags.status}". Use open, done, or all.`;
      }
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

function tool(body: (p: Record<string, unknown>, ctx: { cwd?: string }) => string) {
  return async function execute(_id: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, ctx: { cwd?: string }) {
    const text = body(params, ctx ?? {});
    return { content: [{ type: "text" as const, text }], details: {} };
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function piObsidianExtension(pi: ExtensionAPI) {

  pi.on("tool_call", (event, ctx) => {
    const vaultRoot = obsidianVaultRoot(ctx.cwd);
    if (!vaultRoot) return;
    const input = event.input as Record<string, unknown>;
    const path = typeof input.path === "string" ? input.path : undefined;
    const targetsVault = isPathInObsidianVault(path, ctx.cwd, vaultRoot);
    if ((["read", "write", "edit", "ls", "find", "grep"].includes(event.toolName) && (targetsVault || (["ls", "find", "grep"].includes(event.toolName) && !path)))
      || (event.toolName === "bash" && isVaultFilesystemBashCommand(input.command, ctx.cwd, vaultRoot))) {
      return {
        block: true,
        reason: `Obsidian vault detected at ${vaultRoot}. Use obsidian with vault="<vault name>" for vault files; use explicit external paths for non-vault work.`,
      };
    }
  });

  pi.registerTool({
    name: "obsidian",
    label: "Run Obsidian CLI Command",
    description: "Run an Obsidian CLI command on the vault. Commands: read, write, search, tasks, tags, eval.",
    promptSnippet: "Run an Obsidian CLI command on the vault",
    promptGuidelines: [
      "Use obsidian—not bash, read, write, edit, ls, find, or grep—for every operation on files in an Obsidian vault; pass vault=<name> if it is not the focused vault.",
      "Format: `<command> <key=value> ... <flag>`",
      "Quote spaces: `file=\"My Note\"`, content=`# Title`.",
      "content_from=SourceNoteName to clone an existing note's content.",
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
    execute: tool((p, ctx) => {
      let raw = (p.run as string).trim();
      if (!raw) throw new Error("'run' is required.");
      const cmd = raw.split(/\s+/)[0];
      if (cmd.startsWith("daily:") && !["daily:read", "daily:append", "daily:prepend"].includes(cmd)) {
        throw new Error(`Command "${cmd}" is only available via the Obsidian desktop app and is not supported in CLI mode.`);
      }
      const flags = parseFlags(raw);
      const explicitVault = (p.vault as string | undefined) ?? flags.vault;
      const v = explicitVault ?? focusedVaultNameForCwd(ctx.cwd);
      if (!v && isObsidianVaultCwd(ctx.cwd)) {
        throw new Error("This cwd is an Obsidian vault but it is not the focused vault. Supply vault=\"<vault name>\" to avoid operating on another vault.");
      }
      const cliArgs = () => parseCliString(raw).filter((arg) => !arg.startsWith("vault="));
      const timeoutMs = (p.timeout_ms as number) ?? (flags.timeout_ms ? parseInt(flags.timeout_ms) : 30_000);

      // --- files: recursive, root, normal, missing-property ---
      if (cmd === "files") {
        if (flags["missing-property"]) {
          return filesMissingProperty(flags["missing-property"], v, timeoutMs);
        }
        const folder = flags.folder ?? "";
        const isRoot = folder === "/" || folder === "";
        if (isRoot || raw.includes("recursive")) {
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
        eArgs.push("eval", `code=(async function(){try{${code}}catch(e){return 'Error: '+String(e&&e.message||e)}})()`);
        const evalOut = execObsidian(eArgs, false, timeoutMs).stdout.trim().replace(/^=>\s?/, "");
        if (!evalOut || /^Error[:\s]/.test(evalOut)) throw new Error(`eval returned no result or error: ${evalOut || "(empty)"}`);
        return evalOut;
      }

      // --- create/write/overwrite: route through vaultWrite (base64+eval) ---
      if (cmd === "create" || cmd === "write" || cmd === "overwrite") {
        const path = flags.path || flags.file || "";
        if (!path) throw new Error("'path=' (or 'file=') is required for create/write/overwrite.");
        let content = flags.content ?? "";
        if (flags.content_from) {
          const rArgs: string[] = [];
          if (v) rArgs.push(`vault=${v}`);
          rArgs.push("read", `path=${flags.content_from}`);
          content = execObsidian(rArgs, false, timeoutMs).stdout;
        }
        const overwrite = cmd !== "create" || raw.includes("overwrite=true");
        return vaultWrite(path, content, overwrite ? "overwrite" : "create", v, timeoutMs);
      }

      // --- append/prepend with content: route through vaultWrite (base64+eval) ---
      if ((cmd === "append" || cmd === "prepend") && flags.content !== undefined) {
        const path = flags.path || flags.file || "";
        if (!path) throw new Error(`'path=' (or 'file=') is required for ${cmd}.`);
        return vaultWrite(path, flags.content, cmd, v, timeoutMs);
      }

      // --- property:set with array values ---
      if (cmd === "property:set") {
        const args = cliArgs();
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
            return r.stdout.trim() || `Command "property:set" produced no output.`;
          }
        }
      }

      // --- Standard CLI passthrough (B1/B6: normalize file= and bare paths) ---
      const args = cliArgs();
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
      const out = r.stdout.trim();
      return out || `Command "${cmd}" produced no output.`;
    }),
  });
}
