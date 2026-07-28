/**
 * edit-repair.ts — helpers that harden the built-in `edit` tool against the
 * two documented failure modes for weaker models:
 *
 *  1. read-tool contamination: `read` appends truncation/continuation notices
 *     to file content; models copy them into oldText, where they don't exist
 *     in the file → every match (exact and fuzzy) fails.
 *  2. leading-whitespace drift: pi's matcher normalizes trailing whitespace
 *     only; Codex's seek_sequence also tolerates leading-ws differences.
 *
 * Pure + testable. The wiring (prepareArguments/execute) lives in index.ts.
 */

/** Strip a UTF-8 BOM if present. */
export function stripBom(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

/** Normalize CRLF/CR to LF. */
export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * The exact read-tool notice patterns that contaminate oldText
 * (see pi-coding-agent dist/core/tools/read.js).
 * Each is anchored on its distinctive shape so it cannot match real source.
 */
const READ_CONTAMINATION_PATTERNS: RegExp[] = [
  // [Showing lines A-B of C (50KB limit). Use offset=N to continue.]
  /\n{1,2}\[Showing lines \d+-\d+ of \d+(?: \([^)]+\))?\.\s*Use offset=\d+ to continue\.\]/g,
  // [N more lines in file. Use offset=N to continue.]
  /\n{1,2}\[\d+ more lines in file\.\s*Use offset=\d+ to continue\.\]/g,
  // [Line X is SIZE, exceeds 50KB limit. Use bash: sed -n ...]
  /\n\[Line \d+ is [^,]+, exceeds [^\]]+ limit\.[^\]]*\]/g,
];

/**
 * Strip read-tool contamination notices from an oldText string.
 * Returns the cleaned text and whether anything changed.
 * Safe: these notice shapes never legitimately appear inside matched source.
 */
export function stripReadContamination(text: string): { text: string; changed: boolean } {
  let changed = false;
  let out = text;
  for (const re of READ_CONTAMINATION_PATTERNS) {
    const next = out.replace(re, "");
    if (next !== out) changed = true;
    out = next;
  }
  return { text: out, changed };
}

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.split("\n");
}

/**
 * Count contiguous block matches of oldText in content, tolerating
 * per-line leading+trailing whitespace differences (Codex seek_sequence pass 3).
 * Returns the number of matches and the start line of the first match.
 */
export function findTrimMatch(content: string, oldText: string): { count: number; firstIndex: number } {
  const fileLines = splitLines(content).map((l) => l.trim());
  const patternLines = splitLines(oldText).map((l) => l.trim());
  // Drop a single trailing empty pattern line so a stray trailing newline in
  // oldText doesn't break an otherwise-exact block match.
  if (patternLines.length > 1 && patternLines[patternLines.length - 1] === "") patternLines.pop();
  if (patternLines.length === 0 || patternLines.length > fileLines.length) return { count: 0, firstIndex: -1 };

  let count = 0;
  let firstIndex = -1;
  for (let i = 0; i <= fileLines.length - patternLines.length; i++) {
    let ok = true;
    for (let j = 0; j < patternLines.length; j++) {
      if (fileLines[i + j] !== patternLines[j]) { ok = false; break; }
    }
    if (ok) {
      count++;
      if (firstIndex === -1) firstIndex = i;
    }
  }
  return { count, firstIndex };
}

/**
 * Extract the ACTUAL file bytes for a matched block (with real indentation),
 * given the content and the 0-based start line + block length. Used to rebuild
 * oldText from the file so the core matcher's exact pass succeeds.
 */
export function fileBytesForBlock(content: string, startLine: number, blockLen: number): string {
  const lines = splitLines(content);
  return lines.slice(startLine, startLine + blockLen).join("\n");
}

/**
 * Compute a retry edit set after a trim-tolerant re-match. Returns the rebuilt
 * edits (oldText taken from the file's real bytes so the core exact matcher
 * succeeds) when there is exactly one trim match, otherwise null. Pure/testable
 * — the orchestration (read file, catch throw, retry) lives in index.ts.
 *
 * IMPORTANT: blockLen drops a single trailing empty line to stay in sync with
 * findTrimMatch, which pops one trailing empty pattern line before matching.
 */
export function computeRetryEdit(fileContent: string, edits: { oldText: string; newText: string }[], failIdx: number): { fixedEdits: { oldText: string; newText: string }[] } | null {
  const idx = Math.min(failIdx, edits.length - 1);
  const failing = edits[idx];
  const oldText = typeof failing?.oldText === "string" ? failing.oldText : "";
  if (!oldText) return null;
  const decontaminated = stripReadContamination(oldText).text;
  const { count, firstIndex } = findTrimMatch(fileContent, decontaminated);
  if (count !== 1) return null;
  const patternLines = decontaminated.split("\n");
  if (patternLines.length > 1 && patternLines[patternLines.length - 1] === "") patternLines.pop();
  const realOld = fileBytesForBlock(fileContent, firstIndex, patternLines.length);
  const fixedEdits = edits.map((e, i) => i === idx ? { ...e, oldText: realOld } : e);
  return { fixedEdits };
}

/**
 * Return a numbered snippet of the file region most similar to oldText, to help
 * the model self-correct on an unresolvable mismatch. Picks the window with the
 * most overlapping (trimmed) lines.
 */
export function nearestBlock(content: string, oldText: string, ctx = 6): string {
  const fileLines = splitLines(content);
  const patternSet = new Set(splitLines(oldText).map((l) => l.trim()).filter((l) => l.length > 0));
  if (patternSet.size === 0 || fileLines.length === 0) return "";

  const window = Math.max(ctx, Math.min(40, fileLines.length));
  let bestStart = 0;
  let bestScore = -1;
  for (let i = 0; i <= fileLines.length - window; i++) {
    let score = 0;
    for (let j = 0; j < window; j++) {
      if (patternSet.has(fileLines[i + j].trim())) score++;
    }
    if (score > bestScore) { bestScore = score; bestStart = i; }
  }

  const width = String(fileLines.length).length;
  const start = Math.max(0, bestStart - 1);
  const end = Math.min(fileLines.length, bestStart + window + 1);
  const shown = fileLines.slice(start, end).map((l, idx) => {
    const num = String(start + idx + 1).padStart(width, " ");
    return `${num} | ${l}`;
  });
  return `Nearest matching region (lines ${start + 1}-${end}):\n${shown.join("\n")}`;
}

/**
 * Parse the failing edit index from an edit-tool error message.
 * Returns the 0-based index, or 0 when it can't be determined (single-edit).
 */
export function parseFailedEditIndex(message: string): number {
  const m = message.match(/edits\[(\d+)\]/i);
  return m ? Number(m[1]) : 0;
}

/** True if an error message/result indicates an edit match failure. */
export function isEditMismatchError(message: string): boolean {
  return /could not find|oldtext must match exactly|found \d+ occurrences|text must be unique|provide more context to make it unique/i.test(message);
}
