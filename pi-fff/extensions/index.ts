/**
 * pi-fff: FFF-powered file search extension for pi
 *
 * Overrides built-in `find` and `grep` tools with FFF and adds FFF-backed
 * @-mention autocomplete suggestions to the interactive editor.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  Text,
} from "@earendil-works/pi-tui";
import type {
  GrepCursor,
  GrepMatch,
  GrepMode,
  GrepResult,
  MixedItem,
  SearchResult,
} from "@ff-labs/fff-node";
import { FileFinder } from "@ff-labs/fff-node";
import { Type } from "@sinclair/typebox";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { buildQuery, normalizeExcludes, normalizePathConstraint } from "./lib/query";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const GREP_MAX_LINE_LENGTH = 500;
const GREP_MAX_FILE_SIZE = 10 * 1024 * 1024;

const VALID_MODES = ["tools-and-ui", "tools-only", "override"] as const;
type FffMode = (typeof VALID_MODES)[number];

// ---------------------------------------------------------------------------
// Cursor store — simple bounded Map for pagination cursors
// ---------------------------------------------------------------------------

class BoundedMap<V> {
  private map = new Map<string, V>();
  private counter = 0;
  constructor(private maxSize: number, private prefix: string) {}
  store(value: V): string {
    const id = `${this.prefix}:${++this.counter}`;
    this.map.set(id, value);
    if (this.map.size > this.maxSize) {
      const first = this.map.keys().next().value;
      if (first) this.map.delete(first);
    }
    return id;
  }
  get(id: string): V | undefined {
    return this.map.get(id);
  }
}

interface GrepCursorState {
  tool: "grep";
  cwd: string;
  cursor: GrepCursor;
  query: string;
  scope?: string;
  hiddenFile?: boolean;
  exclude?: string | string[];
  glob?: string;
  mode: GrepMode;
  smartCase: boolean;
  context?: number;
  outputMode: GrepOutputMode;
  pageSize: number;
}

interface MultiGrepCursorState {
  tool: "multi";
  cwd: string;
  cursor: GrepCursor;
  patterns: string[];
  scope?: string;
  hiddenFile?: boolean;
  exclude?: string | string[];
  constraints?: string;
  smartCase: boolean;
  context?: number;
  outputMode: GrepOutputMode;
  pageSize: number;
}

type StoredGrepCursor = GrepCursorState | MultiGrepCursorState;
const cursorStore = new BoundedMap<StoredGrepCursor>(200, "grep");

// Find pagination uses a page-index cursor: native `fileSearch` takes
// pageIndex/pageSize, so the cursor is just the next page index paired with
// the query+limit that produced it. Stored tokens are opaque IDs to the agent.
interface FindCursor {
  cwd: string;
  query: string;
  pattern: string;
  pageSize: number;
  nextPageIndex: number;
  scope?: string;
  exclude?: string | string[];
}

const findCursorStore = new BoundedMap<FindCursor>(200, "find");

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
  const trimmed = line.trimEnd();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

function stripLeadingAt(value: string): string {
  return value.trim().replace(/^@/, "");
}

function companionStem(filePath: string): string {
  return path.posix.basename(filePath)
    .replace(/\.(test|spec|story|stories|type|types|style|styles|d|module)\./g, ".")
    .replace(/\.[^.]+$/, "");
}

function boundedText(text: string): { text: string; truncation?: TruncationResult } {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return { text };
  const cursorNotice = text.match(/\[[^\]]*cursor="[^"]+"[^\]]*\]$/)?.[0];
  return {
    text: `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]${cursorNotice ? `\n\n${cursorNotice}` : ""}`,
    truncation,
  };
}

const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;

// Shared annotation helper for both find-output paths and grep-output file
// headers. Returns at most ONE tag so output stays scannable. Priority:
// git-dirty (most actionable — file is changing right now) beats frecency
// (historically often-touched). Keeping one function ensures the two tools
// never drift in how they surface git/frecency signal.
function fffFileAnnotation(item: {
  gitStatus?: string;
  totalFrecencyScore?: number;
  accessFrecencyScore?: number;
}): string {
  const git = item.gitStatus;
  if (git && git !== "clean" && git !== "unknown" && git !== "") {
    return `  [${git} in git]`;
  }

  const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  if (frecency >= HOT_FRECENCY) return "  [VERY often touched file]";
  if (frecency >= WARM_FRECENCY) return "  [often touched file]";

  return "";
}

// fff-core native definition classifier (byte-level scanner in Rust) is enabled
// via GrepOptions.classifyDefinitions. Each GrepMatch carries isDefinition for
// downstream consumers; pi-fff does NOT use it to re-sort.
//
// Ordering policy: NO CUSTOM SORTING. The engine already returns items in
// frecency order (most-accessed files first). pi-fff only groups consecutive
// matches into per-file blocks and preserves whatever order the engine
// provided — inside a file we keep matches in source-line order because the
// engine emits them that way.

function formatGrepOutput(
  result: GrepResult,
  options?: { outputMode?: GrepOutputMode; explicitContext?: number },
): string {
  if (result.items.length === 0) return "No matches found";
  const outputMode = options?.outputMode ?? "content";

  // count mode: file: count per file
  if (outputMode === "count") {
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const item of result.items) {
      if (!counts.has(item.relativePath)) order.push(item.relativePath);
      counts.set(item.relativePath, (counts.get(item.relativePath) ?? 0) + 1);
    }
    return order.map((p) => `${p}: ${counts.get(p)}`).join("\n");
  }

  // files_with_matches mode: one preview per file, with definition auto-expand
  if (outputMode === "files_with_matches") {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const match of result.items) {
      if (!seen.has(match.relativePath)) {
        seen.add(match.relativePath);
        lines.push(`${match.relativePath}${fffFileAnnotation(match)}`);
        lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);
        if (options?.explicitContext !== undefined) {
          match.contextAfter
            ?.slice(0, options.explicitContext)
            .forEach((line: string, i: number) =>
              lines.push(` ${match.lineNumber + 1 + i}| ${truncateLine(line)}`),
            );
        } else appendDefContext(lines, match, "|");
      }
    }
    return lines.join("\n");
  }

  // content mode (default) — with definition auto-expand
  const hasExplicitContext = options?.explicitContext !== undefined;
  const explicitContext = options?.explicitContext ?? 0;
  const lines: string[] = [];
  let currentFile = "";

  for (const match of result.items) {
    if (match.relativePath !== currentFile) {
      if (lines.length > 0) lines.push("");
      currentFile = match.relativePath;
      lines.push(`${currentFile}${fffFileAnnotation(match)}`);
    }

    const before = match.contextBefore?.slice(-explicitContext) ?? [];
    before.forEach((line: string, i: number) => {
      const lineNum = match.lineNumber - before.length + i;
      lines.push(` ${lineNum}- ${truncateLine(line)}`);
    });

    lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);

    if (hasExplicitContext) {
      match.contextAfter?.slice(0, explicitContext).forEach((line: string, i: number) => {
        const lineNum = match.lineNumber + 1 + i;
        lines.push(` ${lineNum}- ${truncateLine(line)}`);
      });
    } else appendDefContext(lines, match, "-");
  }

  return lines.join("\n");
}

// Weak-match threshold is derived from the query length, matching the
// scoring formula in crates/fff-core/src/score.rs: a perfect match scores
// `len * 16`, so we treat anything below 50% of that as scattered fuzzy noise.
// When the top score is weak, trim output to a small sample instead of dumping
// the full limit worth of noise into the agent's context.
const FIND_WEAK_SAMPLE_SIZE = 5;
const DEFAULT_RESOLVE_LIMIT = 8;

function weakScoreThreshold(pattern: string): number {
  const perfect = pattern.length * 16;
  return Math.floor((perfect * 50) / 100);
}

type GrepOutputMode = "content" | "files_with_matches" | "count";

function appendDefContext(lines: string[], match: GrepMatch, prefix: string): void {
  if (!match.isDefinition) return;
  const after = match.contextAfter?.slice(0, 3) ?? [];
  for (let i = 0; i < after.length; i++) {
    lines.push(` ${match.lineNumber + 1 + i}${prefix} ${truncateLine(after[i])}`);
  }
}

function scoreDominates(top?: { matchType?: string; exactMatch?: boolean; total?: number } | null, second?: { total?: number } | null): boolean {
  if (!top) return false;
  return top.matchType === "exact" || top.exactMatch === true || !second || (top.total ?? 0) > (second.total ?? 0) * 2;
}

type GrepResultFormat = { content: { type: "text"; text: string }[]; details: { totalMatched: number; totalFiles: number } };

function formatGrepResult(
  result: GrepResult,
  outputMode: GrepOutputMode | undefined,
  explicitContext: number | undefined,
  extras?: {
    regexFallbackError?: string;
    fuzzyNotice?: string | null;
    cursorState?:
      | Omit<GrepCursorState, "cursor">
      | Omit<MultiGrepCursorState, "cursor">;
  },
): GrepResultFormat {
  let output = formatGrepOutput(result, { outputMode, explicitContext });
  const notices: string[] = [];
  if (extras?.regexFallbackError) notices.push(`Invalid regex: ${extras.regexFallbackError}, used literal match`);
  if (result.nextCursor && extras?.cursorState) {
    notices.push(
      `Continue with cursor="${cursorStore.store({ ...extras.cursorState, cursor: result.nextCursor } as StoredGrepCursor)}"`,
    );
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  if (extras?.fuzzyNotice) output = `[${extras.fuzzyNotice}]\n${output}`;
  return { content: [{ type: "text", text: output }], details: { totalMatched: result.totalMatched, totalFiles: result.totalFiles } };
}

interface FormattedFind {
  output: string;
  weak: boolean;
  shownCount: number;
}

function formatFindOutput(
  result: SearchResult,
  limit: number,
  pattern: string,
  pageIndex = 0,
): FormattedFind {
  if (result.items.length === 0) {
    return {
      output: "No files found matching pattern",
      weak: false,
      shownCount: 0,
    };
  }

  // Peek at the top native score to decide whether results are scattered
  // fuzzy noise (query length-scaled threshold from score.rs).
  const topScore = result.scores[0]?.total ?? 0;
  const weak = topScore < weakScoreThreshold(pattern);
  const effective = weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit;
  const shown = result.items.slice(0, effective);

  const items: string[] = [];

  // On first page, add a "→ Read" hint when the top candidate strongly dominates
  if (pageIndex === 0 && shown.length > 0 && scoreDominates(result.scores[0], result.scores[1])) {
    const label = result.scores[0]?.matchType === "exact" || result.scores[0]?.exactMatch ? "exact match!" : "best match";
    items.push(`→ Read ${shown[0].relativePath} (${label})`);
  }

  items.push(...shown.map((item) => `${item.relativePath}${fffFileAnnotation(item)}`));

  return {
    output: items.join("\n"),
    weak,
    shownCount: shown.length,
  };
}

// ---------------------------------------------------------------------------
// Mention autocomplete helpers
// ---------------------------------------------------------------------------

function extractAtPrefix(textBeforeCursor: string): string | null {
  const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
  return match?.[1] ?? null;
}

function buildAtCompletionValue(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function createFffMentionProvider(
  getItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] || "";
      const prefix = extractAtPrefix(currentLine.slice(0, cursorCol));
      if (!prefix || options.signal.aborted) return null;

      const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1);
      const items = await getItems(query, options.signal);
      return options.signal.aborted || items.length === 0 ? null : { items, prefix };
    },
    applyCompletion(_lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = _lines[cursorLine] || "";
      const before = currentLine.slice(0, cursorCol - prefix.length);
      const after = currentLine.slice(cursorCol);
      const newLine = before + item.value + after;
      const newCursorCol = cursorCol - prefix.length + item.value.length;
      return {
        lines: [..._lines.slice(0, cursorLine), newLine, ..._lines.slice(cursorLine + 1)],
        cursorLine,
        cursorCol: newCursorCol,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function fffExtension(pi: ExtensionAPI) {
  let finder: FileFinder | null = null;
  let finderCwd: string | null = null;
  // Concurrent ensureFinder() callers share the same in-flight promise so
  // FileFinder.create() (which takes native DB locks) runs at most once per
  // base path at a time — otherwise parallel tool calls would race and
  // deadlock at the native layer (issue #403).
  let finderPromise: Promise<FileFinder> | null = null;
  let activeCwd = process.cwd();

  let currentMode: FffMode = "tools-and-ui";
  let grepName = "ffgrep";
  let findName = "fffind";
  let frecencyDbPath: string | undefined;
  let historyDbPath: string | undefined;
  let enableFsRootScanning = false;
  let toolsRegistered = false;

  function resolveRuntimeConfig() {
    // Pi populates extension flag values only after loading extension factories.
    const configuredMode = pi.getFlag("fff-mode") ?? process.env.PI_FFF_MODE;
    currentMode = VALID_MODES.includes(configuredMode as FffMode)
      ? (configuredMode as FffMode)
      : "tools-and-ui";
    grepName = currentMode === "override" ? "grep" : "ffgrep";
    findName = currentMode === "override" ? "find" : "fffind";

    frecencyDbPath =
      (pi.getFlag("fff-frecency-db") as string | undefined) ??
      process.env.FFF_FRECENCY_DB;
    historyDbPath =
      (pi.getFlag("fff-history-db") as string | undefined) ??
      process.env.FFF_HISTORY_DB;

    const rootScanFlag = pi.getFlag("fff-enable-root-scan");
    const rootScanEnv = process.env.FFF_ENABLE_ROOT_SCAN;
    enableFsRootScanning =
      rootScanFlag === true ||
      rootScanFlag === "true" ||
      rootScanFlag === "1" ||
      (rootScanFlag == null && (rootScanEnv === "1" || rootScanEnv === "true"));
  }

  function ensureFinder(cwd: string): Promise<FileFinder> {
    if (finderPromise) return finderPromise;
    if (finder && !finder.isDestroyed && finderCwd === cwd)
      return Promise.resolve(finder);

    finderPromise = (async () => {
      if (finder && !finder.isDestroyed) {
        finder.destroy();
        finder = null;
        finderCwd = null;
      }

      const result = FileFinder.create({
        basePath: cwd,
        frecencyDbPath,
        historyDbPath,
        aiMode: true,
        enableHomeDirScanning: true,
        enableFsRootScanning,
      });

      if (!result.ok)
        throw new Error(`Failed to create FFF file finder: ${result.error}`);

      finder = result.value;
      finderCwd = cwd;
      await finder.waitForScan(15000);
      return finder;
    })().finally(() => {
      finderPromise = null;
    });

    return finderPromise;
  }

  function resolveExplicitHiddenScope(pathConstraint: string | undefined) {
    if (!pathConstraint) return null;
    const normalized = normalizePathConstraint(pathConstraint, activeCwd);
    if (!normalized) return null;

    const segments = normalized.replace(/\/$/, "").split("/");
    const globIndex = segments.findIndex((segment) => /[*?[{]/.test(segment));
    const scopeSegments = globIndex < 0 ? segments : segments.slice(0, globIndex);
    const scope = scopeSegments.join("/");
    if (!scope || !scopeSegments.some((segment) => segment.startsWith("."))) return null;

    const absoluteScope = path.resolve(activeCwd, scope);
    try {
      return {
        scope: scope.replaceAll(path.sep, "/"),
        absoluteScope,
        constraint: globIndex < 0 ? undefined : segments.slice(globIndex).join("/"),
        stat: statSync(absoluteScope),
      };
    } catch {
      return null;
    }
  }

  function rebaseScopedExcludes(
    exclude: string | string[] | undefined,
    scope: string,
  ): { excludeAll: boolean; values?: string[] } {
    const prefix = `${scope.replace(/\/$/, "")}/`;
    const values: string[] = [];
    for (const negated of normalizeExcludes(exclude, activeCwd)) {
      const constraint = negated.slice(1);
      if (constraint === prefix || constraint === scope) return { excludeAll: true };
      if (constraint.startsWith(prefix)) {
        values.push(constraint.slice(prefix.length));
      } else if (!constraint.replace(/\/$/, "").includes("/") || constraint.startsWith("**/")) {
        values.push(constraint);
      }
    }
    return { excludeAll: false, values: values.length > 0 ? values : undefined };
  }

  async function withExplicitHiddenFinder<T>(
    pathConstraint: string | undefined,
    run: (finder: FileFinder, scope: string, cwd: string, constraint?: string) => T,
  ): Promise<{ scope: string; value: T } | null> {
    const resolved = resolveExplicitHiddenScope(pathConstraint);
    if (!resolved?.stat.isDirectory()) return null;

    const created = FileFinder.create({
      basePath: resolved.absoluteScope,
      // ponytail: scoped fallback is ephemeral; sharing workspace DBs risks native lock contention.
      aiMode: true,
      enableHomeDirScanning: true,
      enableFsRootScanning,
    });
    if (!created.ok) return null;

    const scopedFinder = created.value;
    try {
      await scopedFinder.waitForScan(15000);
      return {
        scope: resolved.scope,
        value: run(scopedFinder, resolved.scope, resolved.absoluteScope, resolved.constraint),
      };
    } finally {
      scopedFinder.destroy();
    }
  }

  function matchesExplicitFile(
    relativePath: string,
    pattern: string,
    exclude: string | string[] | undefined,
  ): boolean {
    const candidate = relativePath.replaceAll(path.sep, "/");
    const basename = path.posix.basename(candidate);
    const matchesConstraint = (constraint: string) => {
      if (constraint.endsWith("/")) return candidate.startsWith(constraint);
      if (/[*?[{]/.test(constraint)) {
        try {
          return path.matchesGlob(candidate, constraint) || path.matchesGlob(basename, constraint);
        } catch {
          return false;
        }
      }
      return candidate === constraint || basename === constraint;
    };
    if (normalizeExcludes(exclude, activeCwd).some((value) => matchesConstraint(value.slice(1)))) {
      return false;
    }
    if (!pattern || pattern === "*") return true;
    if (/[*?[{]/.test(pattern)) return matchesConstraint(pattern);

    const target = candidate.toLowerCase();
    return pattern.toLowerCase().split(/\s+/).filter(Boolean).every((term) => {
      let index = 0;
      for (const char of target) if (char === term[index]) index++;
      return index === term.length;
    });
  }

  function emptyGrepResult(totalFiles = 0): GrepResult {
    return {
      items: [],
      totalMatched: 0,
      totalFilesSearched: 0,
      totalFiles,
      filteredFileCount: 0,
      nextCursor: null,
    };
  }

  function prefixGrepResult(result: GrepResult, scope: string): GrepResult {
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        relativePath: `${scope}/${item.relativePath}`,
      })),
    };
  }

  function grepExplicitHiddenFile(
    pathConstraint: string | undefined,
    patterns: string[],
    options: {
      mode: GrepMode;
      smartCase: boolean;
      context: number;
      pageSize: number;
      exclude?: string | string[];
      glob?: string;
      offset?: number;
    },
  ): GrepResult | null {
    const resolved = resolveExplicitHiddenScope(pathConstraint);
    if (!resolved?.stat.isFile()) return null;
    if (!matchesExplicitFile(resolved.scope, options.glob ?? "*", options.exclude)) {
      return emptyGrepResult(1);
    }

    const smartInsensitive = options.smartCase && patterns.every((pattern) => pattern === pattern.toLowerCase());
    const matchers = patterns.map((pattern) => {
      if (options.mode === "regex") {
        const insensitive = pattern.match(/^\(\?i:(.*)\)$/s);
        try {
          const regex = new RegExp(insensitive?.[1] ?? pattern, insensitive || smartInsensitive ? "i" : "");
          return (line: string) => regex.test(line);
        } catch {
          const literal = insensitive?.[1] ?? pattern;
          const needle = smartInsensitive ? literal.toLowerCase() : literal;
          return (line: string) => (smartInsensitive ? line.toLowerCase() : line).includes(needle);
        }
      }
      const needle = smartInsensitive ? pattern.toLowerCase() : pattern;
      return (line: string) => {
        const candidate = smartInsensitive ? line.toLowerCase() : line;
        if (options.mode === "plain") return candidate.includes(needle);
        let index = 0;
        for (const char of candidate) if (char === needle[index]) index++;
        return index === needle.length;
      };
    });

    const offset = options.offset ?? 0;
    const items: GrepMatch[] = [];
    const before: string[] = [];
    const pending: Array<{ item: GrepMatch; remaining: number }> = [];
    let matched = 0;
    let hasMore = false;
    let lineNumber = 1;
    let stopMatching = false;

    const processLine = (rawLine: string) => {
      const line = rawLine.replace(/\r$/, "");
      for (const entry of pending) {
        entry.item.contextAfter!.push(line);
        entry.remaining--;
      }
      while (pending[0]?.remaining === 0) pending.shift();

      if (!stopMatching && matchers.some((matcher) => matcher(line))) {
        if (matched >= offset) {
          if (items.length >= options.pageSize) {
            hasMore = true;
            stopMatching = true;
          } else {
            const item = {
              relativePath: resolved.scope,
              fileName: path.posix.basename(resolved.scope),
              lineNumber,
              lineContent: line,
              contextBefore: [...before],
              contextAfter: [],
            } as unknown as GrepMatch;
            items.push(item);
            if (options.context > 0) pending.push({ item, remaining: options.context });
          }
        }
        matched++;
      }

      if (options.context > 0) {
        before.push(line);
        if (before.length > options.context) before.shift();
      }
      lineNumber++;
      return stopMatching && pending.length === 0;
    };

    const fd = openSync(resolved.absoluteScope, "r");
    try {
      if (fstatSync(fd).size > GREP_MAX_FILE_SIZE) return emptyGrepResult(1);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const decoder = new StringDecoder("utf8");
      let remainder = "";
      let bytesReadTotal = 0;
      let done = false;
      while (!done) {
        const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        bytesReadTotal += bytesRead;
        if (bytesReadTotal > GREP_MAX_FILE_SIZE || buffer.subarray(0, bytesRead).includes(0)) {
          return emptyGrepResult(1);
        }
        const chunk = remainder + decoder.write(buffer.subarray(0, bytesRead));
        let start = 0;
        for (;;) {
          const newline = chunk.indexOf("\n", start);
          if (newline < 0) {
            remainder = chunk.slice(start);
            break;
          }
          if (processLine(chunk.slice(start, newline))) {
            done = true;
            break;
          }
          start = newline + 1;
        }
      }
      if (!done) processLine(remainder + decoder.end());
    } finally {
      closeSync(fd);
    }

    const nextOffset = offset + items.length;
    return {
      items,
      totalMatched: items.length,
      totalFilesSearched: 1,
      totalFiles: 1,
      filteredFileCount: 1,
      nextCursor: hasMore
        ? { __brand: "GrepCursor", _offset: nextOffset } as GrepCursor
        : null,
    };
  }

  async function searchExplicitHiddenScope(
    pathConstraint: string | undefined,
    pattern: string,
    exclude: string | string[] | undefined,
    pageIndex: number,
    pageSize: number,
  ): Promise<SearchResult | null> {
    const resolved = resolveExplicitHiddenScope(pathConstraint);
    if (!resolved) return null;

    if (resolved.stat.isFile()) {
      if (pageIndex > 0 || !matchesExplicitFile(resolved.scope, pattern, exclude)) return null;
      return {
        items: [{ relativePath: resolved.scope, fileName: path.basename(resolved.scope) } as SearchResult["items"][number]],
        scores: [{ total: Number.MAX_SAFE_INTEGER, matchType: "exact", exactMatch: true } as SearchResult["scores"][number]],
        totalMatched: 1,
        totalFiles: 1,
      };
    }

    const rebased = rebaseScopedExcludes(exclude, resolved.scope);
    if (rebased.excludeAll) {
      return { items: [], scores: [], totalMatched: 0, totalFiles: 0 };
    }
    const searched = await withExplicitHiddenFinder(pathConstraint, (scopedFinder, scope, cwd, constraint) => {
      const scopedQuery = buildQuery(constraint, pattern, rebased.values, cwd);
      const result = scopedFinder.fileSearch(scopedQuery, { pageIndex, pageSize });
      if (!result.ok) return null;
      return {
        ...result.value,
        items: result.value.items.map((item) => ({
          ...item,
          relativePath: `${scope}/${item.relativePath}`,
        })),
      };
    });
    return searched?.value ?? null;
  }

  async function searchOverrideFind(
    finder: FileFinder,
    pattern: string,
    searchPath: string | undefined,
    limit: number,
  ) {
    const pathScope = searchPath ? normalizePathConstraint(searchPath, activeCwd) : null;
    const hidden = resolveExplicitHiddenScope(searchPath ?? pattern);
    let result: SearchResult;

    if (hidden?.stat.isFile()) {
      const matched = matchesExplicitFile(hidden.scope, searchPath ? pattern : hidden.scope, undefined);
      result = matched
        ? {
            items: [{ relativePath: searchPath ? path.posix.basename(hidden.scope) : hidden.scope, fileName: path.posix.basename(hidden.scope) } as SearchResult["items"][number]],
            scores: [{ total: Number.MAX_SAFE_INTEGER, matchType: "exact", exactMatch: true } as SearchResult["scores"][number]],
            totalMatched: 1,
            totalFiles: 1,
          }
        : { items: [], scores: [], totalMatched: 0, totalFiles: 0 };
    } else if (hidden?.stat.isDirectory()) {
      const localPattern = searchPath ? pattern : hidden.constraint ?? "*";
      const scoped = await withExplicitHiddenFinder(hidden.scope, (target) =>
        target.glob(localPattern, { pageSize: limit }),
      );
      if (!scoped?.value.ok) {
        return { content: [{ type: "text" as const, text: "No files found matching pattern" }], details: undefined };
      }
      result = {
        ...scoped.value.value,
        items: scoped.value.value.items.map((item) => ({
          ...item,
          relativePath: searchPath ? item.relativePath : `${hidden.scope}/${item.relativePath}`,
        })),
      };
    } else {
      const scope = pathScope?.replace(/\/$/, "");
      const scopedPattern = scope ? `${scope}/${pattern}` : pattern;
      const searched = finder.glob(scopedPattern, { pageSize: limit });
      if (!searched.ok) {
        return { content: [{ type: "text" as const, text: `Search failed: ${searched.error}` }], details: undefined };
      }
      result = {
        ...searched.value,
        items: searched.value.items.map((item) => ({
          ...item,
          relativePath: scope && item.relativePath.startsWith(`${scope}/`)
            ? item.relativePath.slice(scope.length + 1)
            : item.relativePath,
        })),
      };
    }

    const output = result.items.map((item) => item.relativePath).join("\n") || "No files found matching pattern";
    return {
      content: [{ type: "text" as const, text: output }],
      details: result.totalMatched > result.items.length
        ? { resultLimitReached: limit }
        : undefined,
    };
  }

  function destroyFinder() {
    if (finder && !finder.isDestroyed) {
      finder.destroy();
      finder = null;
      finderCwd = null;
    }
  }

  async function getMentionItems(
    query: string,
    signal: AbortSignal,
  ): Promise<AutocompleteItem[]> {
    if (signal.aborted) return [];
    const f = await ensureFinder(activeCwd);
    if (signal.aborted) return [];

    const result = f.mixedSearch(query, { pageSize: 20 });
    if (!result.ok) return [];

    return result.value.items.slice(0, 20).map((mixed: MixedItem) => {
      if (mixed.type === "directory") {
        return {
          value: buildAtCompletionValue(mixed.item.relativePath),
          label: mixed.item.dirName,
          description: mixed.item.relativePath,
        };
      }
      return {
        value: buildAtCompletionValue(mixed.item.relativePath),
        label: mixed.item.fileName,
        description: mixed.item.relativePath,
      };
    });
  }

  function registerAutocompleteProvider(ctx: {
    ui: {
      addAutocompleteProvider: (
        factory: (current: AutocompleteProvider) => AutocompleteProvider,
      ) => void;
    };
  }) {
    ctx.ui.addAutocompleteProvider((current) => {
      const mentionProvider = createFffMentionProvider(getMentionItems);

      return {
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          if (currentMode !== "tools-only") {
            try {
              const mentionResult = await mentionProvider.getSuggestions(
                lines,
                cursorLine,
                cursorCol,
                options,
              );
              if (mentionResult) return mentionResult;
            } catch {
              // Delegate when FFF lookup is unavailable.
            }
          }

          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return (
            current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
          );
        },
      };
    });
  }

  // --- Flags / lifecycle ---

  pi.registerFlag("fff-mode", {
    description: "FFF mode: tools-and-ui | tools-only | override",
    type: "string",
  });

  pi.registerFlag("fff-frecency-db", {
    description: "Path to the frecency database (overrides FFF_FRECENCY_DB env)",
    type: "string",
  });

  pi.registerFlag("fff-history-db", {
    description: "Path to the query history database (overrides FFF_HISTORY_DB env)",
    type: "string",
  });

  pi.registerFlag("fff-enable-root-scan", {
    description:
      "Allow indexing when launched from the filesystem root (also: FFF_ENABLE_ROOT_SCAN env)",
    type: "boolean",
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      activeCwd = ctx.cwd;
      resolveRuntimeConfig();
      registerTools();
      if (currentMode === "override") {
        const available = new Set(pi.getAllTools().map((tool) => tool.name));
        const active = pi.getActiveTools();
        const overrides = ["find", "grep"].filter(
          (name) => available.has(name) && !active.includes(name),
        );
        if (overrides.length > 0) pi.setActiveTools([...active, ...overrides]);
      }
      registerAutocompleteProvider(ctx);
      await ensureFinder(activeCwd);
    } catch (e: unknown) {
      ctx.ui.notify(
        `FFF init failed: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    destroyFinder();
  });

  function registerTools() {
    if (toolsRegistered) return;
    toolsRegistered = true;

  // --- Shared render helpers ---

  const renderTextResult = (
    result: { content?: { type: string; text?: string }[] },
    options: { expanded?: boolean },
    theme: any,
    context: any,
    maxLines = 15,
  ) => {
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    const output = result.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
    if (!output) {
      text.setText(theme.fg("muted", "No output"));
      return text;
    }

    const lines = output.split("\n");
    const displayLines = lines.slice(0, options.expanded ? lines.length : maxLines);
    let content = `\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
    if (lines.length > displayLines.length) {
      content += theme.fg(
        "muted",
        `\n... (${lines.length - displayLines.length} more lines)`,
      );
    }
    text.setText(content);
    return text;
  };

  const registerBoundedTool = (tool: any) => {
    const execute = tool.execute;
    pi.registerTool({
      ...tool,
      async execute(...args: any[]) {
        const result = await execute(...args);
        let truncation: TruncationResult | undefined;
        const content = result.content?.map((item: any) => {
          if (item.type !== "text") return item;
          const bounded = boundedText(item.text);
          truncation ??= bounded.truncation;
          return { ...item, text: bounded.text };
        });
        return {
          ...result,
          content,
          details: truncation
            ? { ...(result.details ?? {}), truncation }
            : result.details,
        };
      },
    });
  };

  // --- grep tool ---

  const grepSchema = currentMode === "override"
    ? Type.Object({
        pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
        path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
        glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
        ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
        literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
        context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
      })
    : Type.Object({
        pattern: Type.String({ description: "Literal text or regex" }),
        path: Type.Optional(Type.String({ description: "Dir prefix (src/), filename (main.rs), or glob (*.ts, src/**/*.cc)." })),
        exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Exclude paths — dir prefix, filename, or glob." })),
        caseSensitive: Type.Optional(Type.Boolean({ description: "Force case-sensitive (smart-case by default)." })),
        context: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines before+after" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, description: `Max matches (default ${DEFAULT_GREP_LIMIT})` })),
        outputMode: Type.Optional(Type.String({ description: "'content' (default), 'files_with_matches', or 'count'" })),
        cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
      });

  registerBoundedTool({
    name: grepName,
    label: grepName,
    description: `Grep contents. Smart-case, regex auto-detect, git-aware, frecency-ranked.`,
    promptSnippet: "Grep contents",
    promptGuidelines: [
      "Bare identifiers preferred. Literal queries most efficient.",
      "Use path/include, exclude/noise.",
      "caseSensitive=true for exact case (smart-case by default).",
      "After 1-2 greps, read top match.",
    ],
    parameters: grepSchema,

    async execute(_toolCallId: any, params: any, signal: AbortSignal | undefined) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const override = currentMode === "override";
      const stored = !override && params.cursor ? cursorStore.get(params.cursor) : undefined;
      if (params.cursor && (!stored || stored.tool !== "grep" || stored.cwd !== activeCwd)) {
        return {
          content: [{ type: "text", text: "Invalid or expired grep cursor. Start the search again without cursor." }],
          details: override ? undefined : { totalMatched: 0, totalFiles: 0 },
        };
      }

      let f;
      try {
        f = await ensureFinder(activeCwd);
        if (signal?.aborted) throw new Error("Operation aborted");
      } catch {
        return {
          content: [{ type: "text", text: "FFF search unavailable in this directory. Try a different working directory or use built-in find instead." }],
          details: currentMode === "override" ? undefined : { totalMatched: 0, totalFiles: 0 },
        };
      }

      const resumed = stored?.tool === "grep" ? stored : undefined;
      const pageSize = resumed?.pageSize ?? Math.max(1, Math.floor(params.limit ?? (override ? 100 : DEFAULT_GREP_LIMIT)));
      const explicitContext = resumed?.context ?? (params.context === undefined
        ? undefined
        : Math.max(0, Math.floor(params.context)));
      const contextLines = explicitContext ?? 0;
      const outputMode = resumed?.outputMode ?? (params.outputMode as GrepOutputMode | undefined) ?? "content";

      let query = resumed?.query;
      let mode = resumed?.mode;
      let smartCase = resumed?.smartCase;
      let scope = resumed?.scope;
      let manualFile = resumed?.hiddenFile ?? false;
      let searchPattern = params.pattern;
      let hasRegexSyntax = false;
      try {
        if (!query || !mode || smartCase === undefined) {
          if (override) {
            mode = params.literal ? "plain" : "regex";
            if (params.ignoreCase) {
              searchPattern = mode === "plain" ? searchPattern.toLowerCase() : `(?i:${searchPattern})`;
              smartCase = true;
            } else smartCase = false;
            const withGlob = params.glob
              ? buildQuery(params.glob, searchPattern, undefined, activeCwd)
              : searchPattern;
            query = buildQuery(params.path, withGlob, undefined, activeCwd);
          } else {
            query = buildQuery(params.path, searchPattern, params.exclude, activeCwd);
            hasRegexSyntax =
              searchPattern !== searchPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            mode = hasRegexSyntax ? "regex" : "plain";
            if (mode === "regex") {
              try {
                new RegExp(searchPattern);
              } catch {
                mode = "plain";
              }
            }
            smartCase = params.caseSensitive !== true;
          }
        }
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid path constraint: ${(e as Error).message}. Try without path/exclude constraints.` }],
          details: override ? undefined : { totalMatched: 0, totalFiles: 0 },
        };
      }

      if (!query || !mode || smartCase === undefined) {
        return {
          content: [{ type: "text", text: "Search failed: invalid grep state" }],
          details: currentMode === "override" ? undefined : { totalMatched: 0, totalFiles: 0 },
        };
      }

      let scopeExcluded = false;
      if (!resumed) {
        const hidden = resolveExplicitHiddenScope(params.path);
        if (hidden?.stat.isFile()) {
          scope = hidden.scope;
          query = searchPattern;
          manualFile = true;
        } else if (hidden?.stat.isDirectory()) {
          scope = hidden.scope;
          const rebased = rebaseScopedExcludes(params.exclude, hidden.scope);
          scopeExcluded = rebased.excludeAll;
          query = override
            ? buildQuery(hidden.constraint, buildQuery(params.glob, searchPattern, undefined, hidden.absoluteScope), undefined, hidden.absoluteScope)
            : buildQuery(hidden.constraint, searchPattern, rebased.values, hidden.absoluteScope);
        }
      }

      const p = params.pattern.trim();
      const isWildcardOnly =
        !override &&
        hasRegexSyntax &&
        /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(p);
      if (isWildcardOnly) {
        return {
          content: [{ type: "text", text: `Pattern '${params.pattern}' matches everything — grep needs a concrete substring or identifier.` }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }

      const runGrep = (
        target: FileFinder,
        targetQuery: string,
        targetMode: GrepMode,
        cursor: GrepCursor | null,
      ) => target.grep(targetQuery, {
        mode: targetMode,
        smartCase,
        pageSize,
        maxMatchesPerFile: Math.min(pageSize, 50),
        cursor,
        beforeContext: contextLines,
        afterContext: Math.max(contextLines, explicitContext === undefined ? 3 : contextLines),
        classifyDefinitions: true,
      });

      let grepResult;
      try {
        if (scopeExcluded) {
          grepResult = { ok: true as const, value: emptyGrepResult() };
        } else if (manualFile && scope) {
          const manual = grepExplicitHiddenFile(scope, [query!], {
            mode,
            smartCase,
            context: contextLines,
            pageSize,
            offset: resumed?.cursor._offset,
            exclude: resumed?.exclude,
            glob: resumed?.glob,
          });
          grepResult = manual ? { ok: true as const, value: manual } : undefined;
        } else if (scope) {
          const scoped = await withExplicitHiddenFinder(scope, (target) =>
            runGrep(target, query!, mode!, resumed?.cursor ?? null),
          );
          grepResult = scoped?.value;
          if (grepResult?.ok) grepResult = { ok: true, value: prefixGrepResult(grepResult.value, scope) };
        } else {
          grepResult = runGrep(f, query!, mode!, resumed?.cursor ?? null);
        }
      } catch (e) {
        return {
          content: [{ type: "text", text: `Search error: ${(e as Error).message}` }],
          details: override ? undefined : { totalMatched: 0, totalFiles: 0 },
        };
      }
      if (!grepResult) {
        return {
          content: [{ type: "text", text: "Search failed: hidden path scope is unavailable" }],
          details: override ? undefined : { totalMatched: 0, totalFiles: 0 },
        };
      }
      if (!grepResult.ok) {
        return {
          content: [{ type: "text", text: `Search failed: ${grepResult.error}` }],
          details: override ? undefined : { totalMatched: 0, totalFiles: 0 },
        };
      }

      let result = grepResult.value;
      let fuzzyNotice: string | null = null;
      if (!override && !resumed && !scopeExcluded && result.items.length === 0 && mode !== "regex") {
        try {
          let fuzzy;
          if (manualFile && scope) {
            const manual = grepExplicitHiddenFile(scope, [query!], {
              mode: "fuzzy",
              smartCase,
              context: contextLines,
              pageSize,
              exclude: params.exclude,
              glob: params.glob,
            });
            fuzzy = manual ? { ok: true as const, value: manual } : undefined;
          } else if (scope) {
            const scoped = await withExplicitHiddenFinder(scope, (target) =>
              runGrep(target, query!, "fuzzy", null),
            );
            fuzzy = scoped?.value;
            if (fuzzy?.ok) fuzzy = { ok: true as const, value: prefixGrepResult(fuzzy.value, scope) };
          } else {
            fuzzy = runGrep(f, query!, "fuzzy", null);
          }
          if (fuzzy?.ok && fuzzy.value.items.length > 0) {
            mode = "fuzzy";
            fuzzyNotice = "0 exact matches. Maybe you meant this?";
            result = fuzzy.value;
          }
        } catch {
          // Keep the exact-search result when fuzzy fallback is unavailable.
        }
      }

      const formatted = formatGrepResult(result, outputMode, explicitContext, {
        regexFallbackError: result.regexFallbackError,
        fuzzyNotice,
        cursorState: override
          ? undefined
          : {
              tool: "grep",
              cwd: activeCwd,
              query: query!,
              scope,
              hiddenFile: manualFile,
              exclude: resumed?.exclude ?? params.exclude,
              glob: resumed?.glob ?? params.glob,
              mode: mode!,
              smartCase,
              context: explicitContext,
              outputMode,
              pageSize,
            },
      });
      if (!override) return formatted;

      const details: { matchLimitReached?: number; linesTruncated?: boolean } = {};
      if (result.nextCursor) details.matchLimitReached = pageSize;
      if (result.items.some((item) =>
        [item.lineContent, ...(item.contextBefore ?? []), ...(item.contextAfter ?? [])]
          .some((line) => line.trimEnd().length > GREP_MAX_LINE_LENGTH))) {
        details.linesTruncated = true;
      }
      return {
        content: formatted.content,
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },

    renderCall(args: any, theme: any, context: any) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const pattern = args?.pattern ?? "";
      const path = args?.path ?? ".";
      let content =
        theme.fg("toolTitle", theme.bold(grepName)) +
        " " +
        theme.fg("accent", `/${pattern}/`) +
        theme.fg("toolOutput", ` in ${path}`);
      if (args?.limit !== undefined)
        content += theme.fg("toolOutput", ` limit ${args.limit}`);
      if (args?.cursor) content += theme.fg("muted", ` (page)`);
      text.setText(content);
      return text;
    },

    renderResult(result: any, options: any, theme: any, context: any) {
      return renderTextResult(result, options, theme, context, 15);
    },
  });

  // --- find tool ---

  const findSchema = currentMode === "override"
    ? Type.Object({
        pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
        path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
      })
    : Type.Object({
        pattern: Type.String({ description: "Fuzzy filename/glob search. Frecency-ranked, git-aware. Multi-word narrows (AND)." }),
        path: Type.Optional(Type.String({ description: "Dir prefix (src/), filename (main.rs), or glob (*.ts, src/**/*.cc)." })),
        exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Exclude paths — dir prefix, filename, or glob." })),
        limit: Type.Optional(Type.Integer({ minimum: 1, description: `Max results per page (default ${DEFAULT_FIND_LIMIT})` })),
        cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
      });

  registerBoundedTool({
    name: findName,
    label: findName,
    description: `Fuzzy path/glob search. Whole-path matching, frecency-ranked, git-aware.`,
    promptSnippet: "Find files by path or glob",
    promptGuidelines: [
      "Whole-path matching: 'profile' hits 'chrome/browser/profiles/x.cc' too.",
      "1-2 terms best; extra words narrow.",
      "Use for paths, use grep for content.",
      "Exact match: glob in `path` like '**/profile.h'. Bare patterns are fuzzy.",
      "List dir: path: 'dir/**' with empty/wildcard pattern.",
      "exclude: 'test/,*.min.js' to cut noise.",
    ],
    parameters: findSchema,

    async execute(_toolCallId: any, params: any, signal: AbortSignal | undefined) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const override = currentMode === "override";
      const resumed = !override && params.cursor ? findCursorStore.get(params.cursor) : undefined;
      if (params.cursor && (!resumed || resumed.cwd !== activeCwd)) {
        return {
          content: [{ type: "text", text: "Invalid or expired find cursor. Start the search again without cursor." }],
          details: override ? undefined : { totalMatched: 0, totalFiles: 0, pageIndex: 0, hasMore: false },
        };
      }

      let f;
      try {
        f = await ensureFinder(activeCwd);
        if (signal?.aborted) throw new Error("Operation aborted");
      } catch {
        return {
          content: [{ type: "text", text: "FFF search unavailable in this directory. Try a different working directory." }],
          details: override ? undefined : { totalMatched: 0, totalFiles: 0, pageIndex: 0, hasMore: false },
        };
      }

      if (override) {
        return searchOverrideFind(
          f,
          params.pattern,
          params.path,
          Math.max(1, Math.floor(params.limit ?? 1000)),
        );
      }

      // Resume from a prior cursor if supplied — cursor owns query+pageSize so
      // the agent can't accidentally mix patterns across pages.
      const effectiveLimit = resumed
        ? resumed.pageSize
        : Math.max(1, Math.floor(params.limit ?? (override ? 1000 : DEFAULT_FIND_LIMIT)));
      let query;
      try {
        query = resumed
          ? resumed.query
          : buildQuery(params.path, params.pattern, params.exclude, activeCwd);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid path constraint: ${(e as Error).message}. Try without path/exclude constraints.` }],
          details: override ? undefined : { totalMatched: 0, totalFiles: 0, pageIndex: 0, hasMore: false },
        };
      }
      const pattern = resumed ? resumed.pattern : params.pattern;
      const pageIndex = resumed?.nextPageIndex ?? 0;
      const scope = resumed?.scope ?? params.path;

      let searchResult;
      try {
        if (resolveExplicitHiddenScope(scope)) {
          searchResult = {
            ok: true as const,
            value: (await searchExplicitHiddenScope(
              scope,
              pattern,
              resumed?.exclude ?? params.exclude,
              pageIndex,
              effectiveLimit,
            )) ?? { items: [], scores: [], totalMatched: 0, totalFiles: 0 },
          };
        } else {
          searchResult = f.fileSearch(query, {
            pageIndex,
            pageSize: effectiveLimit,
          });
        }
      } catch (e) {
        return {
          content: [{ type: "text", text: `Search error: ${(e as Error).message}` }],
          details: override ? undefined : { totalMatched: 0, totalFiles: 0, pageIndex: 0, hasMore: false },
        };
      }
      if (!searchResult.ok) {
        return {
          content: [{ type: "text", text: `Search failed: ${searchResult.error}` }],
          details: override ? undefined : { totalMatched: 0, totalFiles: 0, pageIndex: 0, hasMore: false },
        };
      }

      const result = searchResult.value;
      const formatted = override
        ? {
            output: result.items
              .slice(0, effectiveLimit)
              .map((item) => item.relativePath)
              .join("\n") || "No files found matching pattern",
            weak: false,
            shownCount: Math.min(result.items.length, effectiveLimit),
          }
        : formatFindOutput(result, effectiveLimit, pattern, pageIndex);
      let output = formatted.output;

      // Infer hasMore: native fileSearch fills pageSize when more results
      // exist, so if we got a full page AND totalMatched exceeds what we've
      // shown so far there's another page to fetch.
      const shownSoFar = pageIndex * effectiveLimit + result.items.length;
      const hasMore =
        result.items.length >= effectiveLimit && result.totalMatched > shownSoFar;

      const notices: string[] = [];
      if (formatted.weak && formatted.shownCount > 0)
        notices.push(
          `Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result.totalMatched}.`,
        );

      if (!override && !formatted.weak && hasMore) {
        const remaining = result.totalMatched - shownSoFar;
        const cursorId = findCursorStore.store({
          cwd: activeCwd,
          query,
          pattern,
          pageSize: effectiveLimit,
          nextPageIndex: pageIndex + 1,
          scope,
          exclude: resumed?.exclude ?? params.exclude,
        });
        notices.push(
          `${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursorId}" to continue`,
        );
      }

      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      if (override) {
        return {
          content: [{ type: "text", text: output }],
          details: hasMore ? { resultLimitReached: effectiveLimit } : undefined,
        };
      }
      return {
        content: [{ type: "text", text: output }],
        details: {
          totalMatched: result.totalMatched,
          totalFiles: result.totalFiles,
          pageIndex,
          hasMore,
        },
      };
    },

    renderCall(args: any, theme: any, context: any) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const pattern = args?.pattern ?? "";
      const path = args?.path ?? ".";
      let content =
        theme.fg("toolTitle", theme.bold(findName)) +
        " " +
        theme.fg("accent", pattern) +
        theme.fg("toolOutput", ` in ${path}`);
      if (args?.limit !== undefined)
        content += theme.fg("toolOutput", ` (limit ${args.limit})`);
      if (args?.cursor) content += theme.fg("muted", ` (page)`);
      text.setText(content);
      return text;
    },

    renderResult(result: any, options: any, theme: any, context: any) {
      return renderTextResult(result, options, theme, context, 20);
    },
  });

  // --- resolve_file tool ---

  const resolveFileSchema = Type.Object({
    pattern: Type.String({
      description:
        "Fuzzy file path query. Turn vague reference ('auth middleware') into exact path.",
    }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: `Max candidates when ambiguous (default ${DEFAULT_RESOLVE_LIMIT})`,
      }),
    ),
  });

  registerBoundedTool({
    name: "resolve_file",
    label: "Resolve File",
    description:
      "Resolve fuzzy file ref to exact path. Auto-resolves when one candidate dominates.",
    promptSnippet: "Resolve a fuzzy file reference",
    promptGuidelines: [
      "Use for vague refs like 'auth middleware' instead of exact path.",
      "Returns resolved path or ranked candidates.",
      "2-3 word queries produce best results.",
    ],
    parameters: resolveFileSchema,

    async execute(_toolCallId: any, params: any, signal: AbortSignal | undefined) {
      if (signal?.aborted) throw new Error("Operation aborted");

      let f;
      try {
        f = await ensureFinder(activeCwd);
        if (signal?.aborted) throw new Error("Operation aborted");
      } catch {
        return {
          content: [{ type: "text", text: "FFF search unavailable in this directory." }],
          details: { resolved: false, totalMatched: 0 },
        };
      }
      const limit = params.limit ?? DEFAULT_RESOLVE_LIMIT;
      const pattern = stripLeadingAt(params.pattern);

      let result;
      try {
        result = f.fileSearch(pattern, { pageSize: Math.max(limit, 2) });
      } catch (e) {
        return {
          content: [{ type: "text", text: `Search error: ${(e as Error).message}` }],
          details: { resolved: false, totalMatched: 0 },
        };
      }
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Search failed: ${result.error}` }],
          details: { resolved: false, totalMatched: 0 },
        };
      }

      if (result.value.items.length === 0) {
        return {
          content: [{ type: "text", text: `No files matched "${pattern}".` }],
          details: { resolved: false, totalMatched: 0 },
        };
      }

      const topResult = result.value.items[0];
      const topScore = result.value.scores[0];
      const secondScore = result.value.scores[1];

      // Auto-resolve when top candidate dominates or is an exact match
      if (scoreDominates(topScore, secondScore)) {
        return {
          content: [
            {
              type: "text",
              text: `→ Read ${topResult.relativePath}${fffFileAnnotation(topResult)}`,
            },
          ],
          details: {
            resolved: true,
            totalMatched: result.value.totalMatched,
          },
        };
      }

      // Ambiguous — return ranked candidates
      const candidates = result.value.items
        .slice(0, limit)
        .map(
          (item, i) =>
            `${i + 1}. ${item.relativePath}${fffFileAnnotation(item)}`,
        )
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Ambiguous reference. Top candidates:\n${candidates}`,
          },
        ],
        details: {
          resolved: false,
          totalMatched: result.value.totalMatched,
        },
      };
    },
  });

  // --- fff_multi_grep tool ---

  const multiGrepSchema = Type.Object({
    patterns: Type.Array(Type.String({ description: "Literal pattern" }), {
      minItems: 1,
      maxItems: 10,
      description: "Literal patterns, one pass. For renames, aliases, or spelling variants.",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "Dir prefix (src/), filename (main.rs), or glob (*.ts, src/**/*.cc).",
      }),
    ),
    exclude: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
          "Exclude paths — dir prefix, filename, or glob.",
      }),
    ),
    context: Type.Optional(
      Type.Integer({ minimum: 0, description: "Context lines before+after" }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: `Max matches (default ${DEFAULT_GREP_LIMIT})`,
      }),
    ),
    outputMode: Type.Optional(
      Type.String({
        description: "'content' (default), 'files_with_matches', or 'count'",
      }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Pagination cursor" }),
    ),
    caseSensitive: Type.Optional(
      Type.Boolean({
        description:
          "caseSensitive=true for exact case (smart-case by default).",
      }),
    ),
  });

  registerBoundedTool({
    name: "fff_multi_grep",
    label: "FFF Multi Grep",
    description:
      "Search for any of multiple literal patterns in one pass. For renamed symbols, aliases, or spelling variants.",
    promptSnippet: "Grep for multiple patterns",
    promptGuidelines: [
      "2-10 literal patterns, one indexed pass.",
      "Use for renames, migrations, or multiple related terms.",
      "Use path/exclude to scope, outputMode for conciseness.",
    ],
    parameters: multiGrepSchema,

    async execute(_toolCallId: any, params: any, signal: AbortSignal | undefined) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const stored = params.cursor ? cursorStore.get(params.cursor) : undefined;
      if (params.cursor && (!stored || stored.tool !== "multi" || stored.cwd !== activeCwd)) {
        return {
          content: [{ type: "text", text: "Invalid or expired multi-grep cursor. Start the search again without cursor." }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }

      let f;
      try {
        f = await ensureFinder(activeCwd);
        if (signal?.aborted) throw new Error("Operation aborted");
      } catch {
        return {
          content: [{ type: "text", text: "FFF search unavailable in this directory." }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }
      const resumed = stored?.tool === "multi" ? stored : undefined;
      const pageSize = resumed?.pageSize ?? Math.max(1, Math.floor(params.limit ?? DEFAULT_GREP_LIMIT));
      const patterns = resumed?.patterns ?? params.patterns;
      const explicitContext = resumed?.context ?? (params.context === undefined
        ? undefined
        : Math.max(0, Math.floor(params.context)));
      const contextLines = explicitContext ?? 0;
      const smartCase = resumed?.smartCase ?? params.caseSensitive !== true;
      const outputMode = resumed?.outputMode ?? (params.outputMode as GrepOutputMode | undefined) ?? "content";
      let scope = resumed?.scope;
      let manualFile = resumed?.hiddenFile ?? false;
      let constraints = resumed?.constraints;
      let scopeExcluded = false;
      try {
        if (!resumed) {
          constraints = buildQuery(params.path, "", params.exclude, activeCwd) || undefined;
          const hidden = resolveExplicitHiddenScope(params.path);
          if (hidden?.stat.isFile()) {
            scope = hidden.scope;
            manualFile = true;
          } else if (hidden?.stat.isDirectory()) {
            scope = hidden.scope;
            const rebased = rebaseScopedExcludes(params.exclude, hidden.scope);
            scopeExcluded = rebased.excludeAll;
            constraints = buildQuery(hidden.constraint, "", rebased.values, hidden.absoluteScope) || undefined;
          }
        }
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid path constraint: ${(e as Error).message}.` }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }

      const runMultiGrep = (
        target: FileFinder,
        targetConstraints: string | undefined,
        cursor: GrepCursor | null,
      ) => target.multiGrep({
        patterns,
        constraints: targetConstraints,
        cursor,
        beforeContext: contextLines,
        afterContext: Math.max(contextLines, explicitContext === undefined ? 3 : contextLines),
        pageSize,
        maxMatchesPerFile: Math.min(pageSize, 50),
        smartCase,
        classifyDefinitions: true,
      });

      let grepResult;
      try {
        if (scopeExcluded) {
          grepResult = { ok: true as const, value: emptyGrepResult() };
        } else if (manualFile && scope) {
          const manual = grepExplicitHiddenFile(scope, patterns, {
            mode: "plain",
            smartCase,
            context: contextLines,
            pageSize,
            offset: resumed?.cursor._offset,
            exclude: resumed?.exclude,
          });
          grepResult = manual ? { ok: true as const, value: manual } : undefined;
        } else if (scope) {
          const scoped = await withExplicitHiddenFinder(scope, (target) =>
            runMultiGrep(target, constraints, resumed?.cursor ?? null),
          );
          grepResult = scoped?.value;
          if (grepResult?.ok) grepResult = { ok: true, value: prefixGrepResult(grepResult.value, scope) };
        } else {
          grepResult = runMultiGrep(f, constraints, resumed?.cursor ?? null);
        }
      } catch (e) {
        return {
          content: [{ type: "text", text: `Search error: ${(e as Error).message}` }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }

      if (!grepResult) {
        return {
          content: [{ type: "text", text: "Search failed: hidden path scope is unavailable" }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }
      if (!grepResult.ok) {
        return {
          content: [{ type: "text", text: `Search failed: ${grepResult.error}` }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }

      const result = grepResult.value;
      return formatGrepResult(result, outputMode, explicitContext, {
        cursorState: {
          tool: "multi",
          cwd: activeCwd,
          patterns,
          scope,
          hiddenFile: manualFile,
          exclude: resumed?.exclude ?? params.exclude,
          constraints,
          smartCase,
          context: explicitContext,
          outputMode,
          pageSize,
        },
      });
    },
  });

  // --- related_files tool ---

  const relatedFilesSchema = Type.Object({
    path: Type.String({
      description:
        "File path (relative or fuzzy) to find companion files for (tests, types, styles, stories).",
    }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: `Max related files (default ${DEFAULT_RESOLVE_LIMIT})`,
      }),
    ),
  });

  registerBoundedTool({
    name: "related_files",
    label: "Related Files",
    description:
      "Find companion files by stem matching (tests, types, styles).",
    promptSnippet: "Find companion files",
    promptGuidelines: [
      "Pass any file path. Strips test/spec/story/types/styles/.d/.module suffixes.",
      "Great for finding test files or type defs for a module.",
    ],
    parameters: relatedFilesSchema,

    async execute(_toolCallId: any, params: any, signal: AbortSignal | undefined) {
      if (signal?.aborted) throw new Error("Operation aborted");

      let f;
      try {
        f = await ensureFinder(activeCwd);
        if (signal?.aborted) throw new Error("Operation aborted");
      } catch {
        return {
          content: [{ type: "text", text: "FFF search unavailable in this directory." }],
          details: { reference: "", related: [] },
        };
      }
      const limit = params.limit ?? DEFAULT_RESOLVE_LIMIT;
      const referenceQuery = stripLeadingAt(params.path);

      // Resolve the reference file first
      let refResult;
      try {
        refResult = f.fileSearch(referenceQuery, { pageSize: limit * 2 });
      } catch (e) {
        return {
          content: [{ type: "text", text: `Search error: ${(e as Error).message}` }],
          details: { reference: "", related: [] },
        };
      }
      if (!refResult.ok) {
        return {
          content: [{ type: "text", text: `Search failed: ${refResult.error}` }],
          details: { reference: "", related: [] },
        };
      }
      if (refResult.value.items.length === 0) {
        return {
          content: [{ type: "text", text: `No file matched "${referenceQuery}".` }],
          details: { reference: "", related: [] },
        };
      }

      const referencePath = refResult.value.items[0].relativePath;

      const stem = companionStem(referencePath);

      const referenceDir = path.posix.dirname(referencePath);

      // Search only the reference directory for files with the same stem.
      let relatedResult;
      try {
        relatedResult = f.fileSearch(
          buildQuery(referenceDir === "." ? undefined : `${referenceDir}/`, stem),
          { pageSize: limit * 3 },
        );
      } catch (e) {
        return {
          content: [{ type: "text", text: `Search error: ${(e as Error).message}` }],
          details: { reference: "", related: [] },
        };
      }
      if (!relatedResult.ok) {
        return {
          content: [{ type: "text", text: `Search failed: ${relatedResult.error}` }],
          details: { reference: "", related: [] },
        };
      }

      // Filter out the reference file and keep normalized-stem companions in
      // the same directory only.
      const related = relatedResult.value.items
        .filter((item) => item.relativePath !== referencePath)
        .filter((item) => {
          if (path.posix.dirname(item.relativePath) !== referenceDir) return false;
          return companionStem(item.relativePath) === stem;
        })
        .slice(0, limit);

      if (related.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No related files found for "${referencePath}".`,
            },
          ],
          details: { reference: referencePath, related: [] },
        };
      }

      const output = [
        `Related files for ${referencePath}:`,
        ...related.map(
          (item, i) => `${i + 1}. ${item.relativePath}${fffFileAnnotation(item)}`,
        ),
      ].join("\n");

      return {
        content: [{ type: "text", text: output }],
        details: {
          reference: referencePath,
          related: related.map((i) => i.relativePath),
        },
      };
    },
  });
  }

  // --- commands ---

  pi.registerCommand("fff-mode", {
    description: "Show or set FFF mode: /fff-mode [tools-and-ui | tools-only | override]",
    handler: async (args, ctx) => {
      const arg = (args || "").trim();

      // No args - show current mode
      if (!arg) {
        ctx.ui.notify(`Current mode: '${currentMode}' (flag: ${pi.getFlag("fff-mode") ?? "unset"})`, "info");
        return;
      }

      // Validate and set mode
      if (!VALID_MODES.includes(arg as FffMode)) {
        ctx.ui.notify(`Usage: /fff-mode [${VALID_MODES.join(" | ")}]`, "warning");
        return;
      }

      const flagMode = pi.getFlag("fff-mode");
      if (VALID_MODES.includes(flagMode as FffMode) && flagMode !== arg) {
        ctx.ui.notify(`Mode is fixed by --fff-mode=${flagMode}. Restart without the flag to change it.`, "warning");
        return;
      }

      const newMode = arg as FffMode;
      const oldMode = currentMode;
      currentMode = newMode;
      process.env.PI_FFF_MODE = newMode;

      if ((oldMode === "override") !== (newMode === "override")) {
        ctx.ui.notify(`Mode changed: '${oldMode}' → '${newMode}'. Reloading tools...`, "info");
        await ctx.reload();
        return;
      }
      ctx.ui.notify(`Mode changed: '${oldMode}' → '${newMode}'`, "info");
    },
  });

  pi.registerCommand("fff-health", {
    description: "Show FFF file finder health and status",
    handler: async (_args, ctx) => {
      if (!finder || finder.isDestroyed) {
        ctx.ui.notify("FFF not initialized", "warning");
        return;
      }

      const health = finder.healthCheck();
      if (!health.ok) {
        ctx.ui.notify(`Health check failed: ${health.error}`, "error");
        return;
      }

      const h = health.value;
      const lines = [
        `FFF v${h.version}`,
        `Mode: ${currentMode}`,
        `Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
        `Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
        `Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
        `Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
      ];

      const progress = finder.getScanProgress();
      if (progress.ok) {
        lines.push(
          `Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`,
        );
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("fff-rescan", {
    description: "Trigger FFF to rescan files",
    handler: async (_args, ctx) => {
      if (!finder || finder.isDestroyed) {
        ctx.ui.notify("FFF not initialized", "warning");
        return;
      }

      const result = finder.scanFiles();
      if (!result.ok) {
        ctx.ui.notify(`Rescan failed: ${result.error}`, "error");
        return;
      }

      ctx.ui.notify("FFF rescan triggered", "info");
    },
  });
}
