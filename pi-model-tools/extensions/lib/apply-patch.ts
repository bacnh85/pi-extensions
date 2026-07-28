/**
 * apply-patch.ts — Codex-style V4D patch parser + applier for the `apply_patch`
 * tool. The model emits only `@@` context + `-`/`+` change lines (a small diff),
 * which is far easier for weaker models to reproduce verbatim than a large
 * str_replace oldText block.
 *
 * Format (mirrors OpenAI Codex `apply_patch`):
 *   *** Begin Patch
 *   *** Add File: path/to/new.txt
 *   +content line 1
 *   +content line 2
 *   *** Delete File: path/to/old.txt
 *   *** Update File: path/to/existing.ts
 *   @@ context line (unchanged, for anchoring)
 *   -removed line
 *   +added line
 *    unchanged context line (leading space preserved)
 *   *** Update File: a.ts → b.ts   (rename)
 *   *** End Patch
 *
 * Divergence from Codex: context+removed blocks must match UNIQUELY (Codex
 * takes the first match). Silent wrong-location edits are worse than a clear
 * error, and this matches pi's own `edit` philosophy.
 */

import { readFile, writeFile, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type FileOpKind = "add" | "delete" | "update";

export interface Hunk {
  /** Ordered lines: context (with leading space stripped) + removed + added. */
  context: string[];
  removed: string[];
  added: string[];
}

export interface FileOp {
  kind: FileOpKind;
  path: string;
  /** For update-with-rename: the new path. */
  movePath?: string;
  hunks: Hunk[];
}

export interface ParsedPatch {
  ops: FileOp[];
}

export class PatchParseError extends Error {}

// ── Parser ──

function stripLeadingSpace(line: string): string {
  // In an update hunk, every payload line begins with a marker: ' ', '-', '+'.
  // A literal leading space is the "context" marker and is part of the content.
  return line.length > 0 ? line.slice(1) : "";
}

export function parsePatch(patch: string): ParsedPatch {
  const lines = patch.split("\n");
  const ops: FileOp[] = [];
  let i = 0;

  // Optional *** Begin Patch header.
  if (i < lines.length && lines[i].trim() === "*** Begin Patch") i++;

  let current: FileOp | null = null;
  const finalize = () => { if (current) { ops.push(current); current = null; } };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "*** End Patch") { finalize(); break; }
    if (trimmed === "*** Begin Patch") continue;

    if (trimmed.startsWith("*** ")) {
      finalize();
      current = parseFileHeader(trimmed);
      continue;
    }

    if (!current) {
      if (trimmed.length === 0) continue; // tolerate blank lines between ops
      throw new PatchParseError(`Unexpected patch line outside a file section: ${JSON.stringify(line)}`);
    }

    // `@@ <text>` introduces a new hunk; the text after `@@ ` is the anchor
    // context line. A bare `@@` just flushes/separates hunks.
    if (line.startsWith("@@")) {
      if (current.kind === "add") throw new PatchParseError("'@@' is invalid in an *** Add File section");
      current.hunks.push({ context: [], removed: [], added: [] });
      const anchor = line.slice(2);
      if (anchor.startsWith(" ")) {
        current.hunks[current.hunks.length - 1].context.push(anchor.slice(1));
      } else if (anchor.length > 0) {
        // tolerate `@@text` with no space
        current.hunks[current.hunks.length - 1].context.push(anchor);
      }
      continue;
    }

    // Payload lines only valid inside update/add.
    if (current.kind === "delete") {
      throw new PatchParseError(`*** Delete File sections must not contain payload lines: ${JSON.stringify(line)}`);
    }

    if (line.startsWith("+")) {
      // Add-File payload ('+' lines) and Update added-lines share this path;
      // content is the text after the '+' marker.
      current.hunks.push({ context: [], removed: [], added: [stripLeadingSpace(line)] });
      continue;
    }
    if (line.startsWith("-")) {
      if (current.kind === "add") throw new PatchParseError(`'-' lines are invalid in an *** Add File section`);
      current.hunks.push({ context: [], removed: [], added: [] });
      current.hunks[current.hunks.length - 1].removed.push(stripLeadingSpace(line));
      continue;
    }
    // In an Add section, a blank line is a literal empty content line.
    if (current.kind === "add" && line === "") {
      current.hunks.push({ context: [], removed: [], added: [""] });
      continue;
    }
    // Any other line in an Update section is context. Models frequently omit
    // the leading-space context marker, so be lenient: treat the line verbatim.
    // (In an Add section, only '+' lines are valid — anything else is an error.)
    if (current.kind === "add") {
      throw new PatchParseError(`Invalid Add File payload line (expected '+'): ${JSON.stringify(line)}`);
    }
    if (line.startsWith(" ")) {
      current.hunks.push({ context: [], removed: [], added: [] });
      current.hunks[current.hunks.length - 1].context.push(stripLeadingSpace(line));
    } else {
      current.hunks.push({ context: [], removed: [], added: [] });
      current.hunks[current.hunks.length - 1].context.push(line);
    }
    continue;
  }

  finalize();
  if (ops.length === 0) throw new PatchParseError("Patch contains no file operations.");
  return { ops };
}

function parseFileHeader(header: string): FileOp {
  // *** Add File: path   /   *** Delete File: path   /   *** Update File: path [→ newPath]
  const addMatch = header.match(/^\*\*\* Add File:\s*(.+)$/);
  if (addMatch) return { kind: "add", path: addMatch[1].trim(), hunks: [] };
  const delMatch = header.match(/^\*\*\* Delete File:\s*(.+)$/);
  if (delMatch) return { kind: "delete", path: delMatch[1].trim(), hunks: [] };
  const updMatch = header.match(/^\*\*\* Update File:\s*(.+?)(?:\s*(?:->|→)\s*(.+))?$/);
  if (updMatch) {
    return { kind: "update", path: updMatch[1].trim(), movePath: updMatch[2]?.trim(), hunks: [] };
  }
  throw new PatchParseError(`Unrecognized file header: ${JSON.stringify(header)}`);
}

// ── Hunk assembly: collapse the marker-stream into ordered hunk groups ──

interface AssembledHunk {
  /** Lines before the first `-`/`+`: pure context (anchor). */
  context: string[];
  /** Removed + added payload, in emission order. */
  removed: string[];
  added: string[];
}

/** Merge adjacent context/removed/added markers into coherent hunks. */
function assembleHunks(raw: Hunk[]): AssembledHunk[] {
  const out: AssembledHunk[] = [];
  let cur: AssembledHunk = { context: [], removed: [], added: [] };
  let started = false;
  const flush = () => {
    if (started) out.push(cur);
    cur = { context: [], removed: [], added: [] };
    started = false;
  };
  for (const h of raw) {
    if (h.context.length) {
      if (started && (cur.removed.length || cur.added.length)) flush();
      cur.context.push(...h.context);
    }
    if (h.removed.length || h.added.length) {
      started = true;
      cur.removed.push(...h.removed);
      cur.added.push(...h.added);
    }
  }
  if (started) out.push(cur);
  return out;
}

// ── seekSequence: Codex's progressive fuzzy matcher (4 passes) ──

function normalizeAscii(s: string): string {
  return s.trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function eqExact(a: string, b: string) { return a === b; }
function eqRstrip(a: string, b: string) { return a.trimEnd() === b.trimEnd(); }
function eqTrim(a: string, b: string) { return a.trim() === b.trim(); }
function eqUnicode(a: string, b: string) { return normalizeAscii(a) === normalizeAscii(b); }

/**
 * Count matches of `pattern` lines within `lines`, trying progressively
 * lenient equality. Returns count and first start index under the strictest
 * pass that yields any match.
 */
export function seekSequence(lines: string[], pattern: string[]): { count: number; firstIndex: number; exact: boolean } {
  if (pattern.length === 0) return { count: 0, firstIndex: -1, exact: true };
  if (pattern.length > lines.length) return { count: 0, firstIndex: -1, exact: true };
  for (const eq of [eqExact, eqRstrip, eqTrim, eqUnicode]) {
    let count = 0;
    let firstIndex = -1;
    for (let i = 0; i <= lines.length - pattern.length; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!eq(lines[i + j], pattern[j])) { ok = false; break; }
      }
      if (ok) {
        count++;
        if (firstIndex === -1) firstIndex = i;
      }
    }
    if (count > 0) return { count, firstIndex, exact: eq === eqExact };
  }
  return { count: 0, firstIndex: -1, exact: true };
}

// ── Applier ──

function stripBom(s: string): string { return s.startsWith("\uFEFF") ? s.slice(1) : s; }
function normalizeLF(s: string): string { return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }
function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  if (lf === -1) return "\n";
  if (crlf === -1) return "\n";
  return crlf < lf ? "\r\n" : "\n";
}
function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Resolve a patch path the same way pi's built-in tools do: relative paths
 * resolve under cwd, absolute paths are honored anywhere. (pi's resolveToCwd
 * does NOT restrict absolute paths to cwd; matching that behavior keeps
 * apply_patch compatible with edits the model references by absolute path.) */
function resolvePathLikePi(p: string, cwd: string): string {
  const expanded = p.startsWith("~") ? (process.env.HOME ?? "") + p.slice(1) : p;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export interface AppliedFile {
  path: string;
  /** For updates: the before/after content for diffing. */
  before?: string;
  after?: string;
  kind: FileOpKind;
}

export interface ApplyResult {
  files: AppliedFile[];
  /** false if any hunk matched only via fuzzy (non-exact) pass. */
  exact: boolean;
  /** Unified diff string across all updated files. */
  diff: string;
}

/**
 * Apply a parsed patch's ops to the filesystem under cwd. Requires unique
 * context+removed matches for every update hunk. Returns per-file before/after
 * and a combined unified diff.
 */
export async function applyPatchToFiles(parsed: ParsedPatch, cwd: string): Promise<ApplyResult> {
  let exact = true;
  const files: AppliedFile[] = [];
  const diffParts: string[] = [];
  const applied: string[] = [];

  for (const op of parsed.ops) {
    const abs = resolvePathLikePi(op.path, cwd);
    try {
      if (op.kind === "delete") {
        const before = await withFileMutationQueue(abs, async () => {
          const raw = await readOptional(abs);
          if (raw === undefined) throw new Error(`Cannot delete (not found): ${op.path}`);
          await unlink(abs);
          return raw;
        });
        files.push({ path: op.path, before, after: "", kind: "delete" });
        applied.push(op.path);
        continue;
      }

      if (op.kind === "add") {
        const content = op.hunks.map((h) => h.added.join("\n")).join("\n");
        await withFileMutationQueue(abs, async () => {
          if ((await readOptional(abs)) !== undefined) throw new Error(`Cannot add (already exists): ${op.path}`);
          await writeFile(abs, content, "utf-8");
        });
        files.push({ path: op.path, before: "", after: content, kind: "add" });
        applied.push(op.path);
        continue;
      }

      // update
      const destAbs = op.movePath ? resolvePathLikePi(op.movePath, cwd) : abs;
      const { before, after } = await withFileMutationQueue(destAbs, async () => {
        const raw = await readOptional(abs);
        if (raw === undefined) throw new Error(`Cannot update (not found): ${op.path}`);
        const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
        const ending = detectLineEnding(stripBom(raw));
        const beforeContent = normalizeLF(stripBom(raw));
        const hunks = assembleHunks(op.hunks);

        let work = beforeContent.split("\n");
        const newHunks: { start: number; removedLen: number; added: string[] }[] = [];

        for (const h of hunks) {
          const anchor = [...h.context, ...h.removed];
          const { count, firstIndex, exact: hExact } = seekSequence(work, anchor);
          if (!hExact) exact = false;
          if (count === 0) throw new Error(`Hunk context not found in ${op.path}. Ensure context lines match the file.`);
          if (count > 1) throw new Error(`Hunk context is ambiguous (${count} matches) in ${op.path}. Add more surrounding context lines to make it unique.`);
          const removedStart = firstIndex + h.context.length;
          newHunks.push({ start: removedStart, removedLen: h.removed.length, added: h.added });
        }

        for (const h of [...newHunks].sort((a, b) => b.start - a.start)) {
          work = [...work.slice(0, h.start), ...h.added, ...work.slice(h.start + h.removedLen)];
        }

        const afterContent = work.join("\n");
        if (op.movePath && op.movePath !== op.path) {
          if ((await readOptional(destAbs)) !== undefined) throw new Error(`Cannot rename onto existing file: ${op.movePath}`);
          const outContent = bom + restoreLineEndings(afterContent, ending);
          await unlink(abs);
          await writeFile(destAbs, outContent, "utf-8");
        } else {
          const outContent = bom + restoreLineEndings(afterContent, ending);
          await writeFile(abs, outContent, "utf-8");
        }
        return { before: beforeContent, after: afterContent };
      });

      files.push({ path: op.movePath ?? op.path, before, after, kind: "update" });
      diffParts.push(generateUnifiedPatch(op.movePath ?? op.path, before, after));
      applied.push(op.movePath ?? op.path);
    } catch (err) {
      // Report any files already applied before this op failed, so the model
      // doesn't blindly re-apply the whole patch (and hit mismatches).
      const appliedNote = applied.length > 0 ? ` (already applied: ${applied.join(", ")})` : "";
      throw new Error(`${err instanceof Error ? err.message : String(err)}${appliedNote}`);
    }
  }

  return { files, exact, diff: diffParts.join("\n").trimEnd() };
}

async function readOptional(abs: string): Promise<string | undefined> {
  try {
    const buf = await readFile(abs);
    return buf.toString("utf-8");
  } catch {
    return undefined;
  }
}
