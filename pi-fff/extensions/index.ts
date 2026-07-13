/**
 * pi-fff: FFF-powered file search extension for pi
 *
 * Overrides built-in `find` and `grep` tools with FFF and adds FFF-backed
 * @-mention autocomplete suggestions to the interactive editor.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { buildQuery } from "./lib/query";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const GREP_MAX_LINE_LENGTH = 500;

const VALID_MODES = ["tools-and-ui", "tools-only", "override"] as const;
type FffMode = (typeof VALID_MODES)[number];

// ---------------------------------------------------------------------------
// Cursor store — simple bounded Map for pagination cursors
// ---------------------------------------------------------------------------

class BoundedMap<V> {
  private map = new Map<string, V>();
  private counter = 0;
  constructor(private maxSize: number) {}
  store(value: V): string {
    const id = `${++this.counter}`;
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

const cursorStore = new BoundedMap<GrepCursor>(200);

// Find pagination uses a page-index cursor: native `fileSearch` takes
// pageIndex/pageSize, so the cursor is just the next page index paired with
// the query+limit that produced it. Stored tokens are opaque IDs to the agent.
interface FindCursor {
  query: string;
  pattern: string;
  pageSize: number;
  nextPageIndex: number;
}

const findCursorStore = new BoundedMap<FindCursor>(200);

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
  const trimmed = line.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
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
        appendDefContext(lines, match, "|");
      }
    }
    return lines.join("\n");
  }

  // content mode (default) — with definition auto-expand
  const explicitContext = (options?.explicitContext ?? 0) > 0;
  const lines: string[] = [];
  let currentFile = "";

  for (const match of result.items) {
    if (match.relativePath !== currentFile) {
      if (lines.length > 0) lines.push("");
      currentFile = match.relativePath;
      lines.push(`${currentFile}${fffFileAnnotation(match)}`);
    }

    match.contextBefore?.forEach((line: string, i: number) => {
      const lineNum = match.lineNumber - match.contextBefore!.length + i;
      lines.push(` ${lineNum}- ${truncateLine(line)}`);
    });

    lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);

    if (explicitContext) {
      match.contextAfter?.forEach((line: string, i: number) => {
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
  explicitContext: number,
  extras?: { regexFallbackError?: string; fuzzyNotice?: string | null },
): GrepResultFormat {
  let output = formatGrepOutput(result, { outputMode, explicitContext });
  const notices: string[] = [];
  if (extras?.regexFallbackError) notices.push(`Invalid regex: ${extras.regexFallbackError}, used literal match`);
  if (result.nextCursor) notices.push(`Continue with cursor="${cursorStore.store(result.nextCursor)}"`);
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

  // Mode resolution: flag > env > default
  let currentMode: FffMode =
    (pi.getFlag("fff-mode") as FffMode) ??
    (process.env.PI_FFF_MODE as FffMode) ??
    "tools-and-ui";

  const grepName = currentMode === "override" ? "grep" : "ffgrep";
  const findName = currentMode === "override" ? "find" : "fffind";

  // DB path resolution: flag > env > undefined (use fff-node defaults)
  const frecencyDbPath =
    (pi.getFlag("fff-frecency-db") as string | undefined) ??
    process.env.FFF_FRECENCY_DB ??
    undefined;
  const historyDbPath =
    (pi.getFlag("fff-history-db") as string | undefined) ??
    process.env.FFF_HISTORY_DB ??
    undefined;

  // Root scanning opt-in: flag (boolean) > env ("1"/"true") > false.
  // FFF refuses to init at / unless this is set. Home dir scanning is on by
  // default for pi — launching pi from $HOME is a normal flow.
  const rootScanFlag = pi.getFlag("fff-enable-root-scan");
  const rootScanEnv = process.env.FFF_ENABLE_ROOT_SCAN;
  const enableFsRootScanning =
    rootScanFlag === true ||
    rootScanFlag === "true" ||
    rootScanFlag === "1" ||
    (rootScanFlag == null && (rootScanEnv === "1" || rootScanEnv === "true"));

  function ensureFinder(cwd: string): Promise<FileFinder> {
    if (finder && !finder.isDestroyed && finderCwd === cwd)
      return Promise.resolve(finder);
    if (finderPromise) return finderPromise;

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

      // Restore persisted mode from session entries. This handles session
      // resume after process restart where env vars are lost, and ensures
      // the env var is set for the next /reload in the same session.
      const entries = ctx.sessionManager?.getEntries();
      if (entries) {
        const modeEntry = [...entries]
          .reverse()
          .find(
            (e: { type: string; customType?: string }) =>
              e.type === "custom" && e.customType === "fff-mode",
          );
        if (
          modeEntry &&
          typeof (modeEntry as any).data?.mode === "string" &&
          VALID_MODES.includes((modeEntry as any).data.mode as FffMode)
        ) {
          const restored = (modeEntry as any).data.mode as FffMode;
          if (restored !== currentMode) {
            currentMode = restored;
          }
        }
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

  // --- grep tool ---

  const grepSchema = Type.Object({
    pattern: Type.String({
      description: "Literal text or regex",
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
    caseSensitive: Type.Optional(
      Type.Boolean({
        description:
          "Force case-sensitive (smart-case by default).",
      }),
    ),
    context: Type.Optional(
      Type.Number({ description: "Context lines before+after" }),
    ),
    limit: Type.Optional(
      Type.Number({
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
  });

  pi.registerTool({
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

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");

      let f;
      try {
        f = await ensureFinder(activeCwd);
        if (signal?.aborted) throw new Error("Operation aborted");
      } catch {
        return {
          content: [{ type: "text", text: "FFF search unavailable in this directory. Try a different working directory or use built-in find instead." }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }
      const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
      let query;
      try {
        query = buildQuery(params.path, params.pattern, params.exclude, activeCwd);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid path constraint: ${(e as Error).message}. Try without path/exclude constraints.` }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }
      // Auto-detect: regex if the pattern has regex metacharacters AND parses
      // as a valid regex, otherwise plain literal. The fuzzy fallback below
      // only kicks in for plain mode — regex queries are intentional.
      const hasRegexSyntax =
        params.pattern !== params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let mode: GrepMode = hasRegexSyntax ? "regex" : "plain";
      if (mode === "regex") {
        try {
          new RegExp(params.pattern);
        } catch {
          mode = "plain";
        }
      }

      // Guard: the agent keeps calling grep with '.*' or similar wildcard-only regex
      // to try to read a whole file. That's not what grep is for — return a terse error
      // steering them to a real pattern, preventing dozens of wasted retries.
      const p = params.pattern.trim();
      const isWildcardOnly =
        hasRegexSyntax &&
        /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(
          p,
        );

      if (isWildcardOnly) {
        return {
          content: [
            {
              type: "text",
              text: `Pattern '${params.pattern}' matches everything — grep needs a concrete substring or identifier. Example: \`pattern: 'MyClass'\` or \`pattern: 'export function'\`.`,
            },
          ],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }

      // caseSensitive override flips smartCase off; omitting it keeps smart-case
      // (case-insensitive when pattern is all lowercase).
      const smartCase = params.caseSensitive !== true;
      const explicitContext = params.context ?? 0;

      // Always request a little context so definition auto-expand can work.
      let grepResult;
      try {
        grepResult = f.grep(query, {
          mode,
          smartCase,
          maxMatchesPerFile: Math.min(effectiveLimit, 50),
          cursor: (params.cursor ? cursorStore.get(params.cursor) : null) ?? null,
          beforeContext: explicitContext,
          afterContext: Math.max(explicitContext, 3),
          classifyDefinitions: true,
        });
      } catch (e) {
        return {
          content: [{ type: "text", text: `Search error: ${(e as Error).message}` }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }

      if (!grepResult.ok) {
        return {
          content: [{ type: "text", text: `Search failed: ${grepResult.error}` }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }

      let result = grepResult.value;
      let fuzzyNotice: string | null = null;

      // automatic fuzzy fallback allows to broad the queries and find different cases
      if (result.items.length === 0 && !params.cursor && mode !== "regex") {
        let fuzzy;
        try {
          fuzzy = f.grep(params.pattern, {
            mode: "fuzzy",
            smartCase,
            maxMatchesPerFile: Math.min(effectiveLimit, 50),
            cursor: null,
            beforeContext: 0,
            afterContext: 0,
            classifyDefinitions: true,
          });
        } catch {
          fuzzy = null;
        }

        if (fuzzy?.ok && fuzzy.value.items.length > 0) {
          fuzzyNotice = `0 exact matches. Maybe you meant this?`;
          result = fuzzy.value;
        }
      }

      const outputMode = params.outputMode as GrepOutputMode | undefined;
      return formatGrepResult(result, outputMode, explicitContext, { regexFallbackError: result.regexFallbackError, fuzzyNotice });
    },

    renderCall(args, theme, context) {
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

    renderResult(result, options, theme, context) {
      return renderTextResult(result, options, theme, context, 15);
    },
  });

  // --- find tool ---

  const findSchema = Type.Object({
    pattern: Type.String({
      description:
        "Fuzzy filename/glob search. Frecency-ranked, git-aware. Multi-word narrows (AND).",
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
    limit: Type.Optional(
      Type.Number({
        description: `Max results per page (default ${DEFAULT_FIND_LIMIT})`,
      }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Pagination cursor" }),
    ),
  });

  pi.registerTool({
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

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");

      let f;
      try {
        f = await ensureFinder(activeCwd);
        if (signal?.aborted) throw new Error("Operation aborted");
      } catch {
        return {
          content: [{ type: "text", text: "FFF search unavailable in this directory. Try a different working directory." }],
          details: { totalMatched: 0, totalFiles: 0, pageIndex: 0, hasMore: false },
        };
      }

      // Resume from a prior cursor if supplied — cursor owns query+pageSize so
      // the agent can't accidentally mix patterns across pages.
      const resumed = params.cursor ? findCursorStore.get(params.cursor) : undefined;
      const effectiveLimit = resumed
        ? resumed.pageSize
        : Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);
      let query;
      try {
        query = resumed
          ? resumed.query
          : buildQuery(params.path, params.pattern, params.exclude, activeCwd);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid path constraint: ${(e as Error).message}. Try without path/exclude constraints.` }],
          details: { totalMatched: 0, totalFiles: 0, pageIndex: 0, hasMore: false },
        };
      }
      const pattern = resumed ? resumed.pattern : params.pattern;
      const pageIndex = resumed?.nextPageIndex ?? 0;

      let searchResult;
      try {
        searchResult = f.fileSearch(query, {
          pageIndex,
          pageSize: effectiveLimit,
        });
      } catch (e) {
        return {
          content: [{ type: "text", text: `Search error: ${(e as Error).message}` }],
          details: { totalMatched: 0, totalFiles: 0, pageIndex: 0, hasMore: false },
        };
      }
      if (!searchResult.ok) {
        return {
          content: [{ type: "text", text: `Search failed: ${searchResult.error}` }],
          details: { totalMatched: 0, totalFiles: 0, pageIndex: 0, hasMore: false },
        };
      }

      const result = searchResult.value;
      const formatted = formatFindOutput(result, effectiveLimit, pattern, pageIndex);
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

      if (!formatted.weak && hasMore) {
        const remaining = result.totalMatched - shownSoFar;
        const cursorId = findCursorStore.store({
          query,
          pattern,
          pageSize: effectiveLimit,
          nextPageIndex: pageIndex + 1,
        });
        notices.push(
          `${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursorId}" to continue`,
        );
      }

      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
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

    renderCall(args, theme, context) {
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

    renderResult(result, options, theme, context) {
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
      Type.Number({
        description: `Max candidates when ambiguous (default ${DEFAULT_RESOLVE_LIMIT})`,
      }),
    ),
  });

  pi.registerTool({
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

    async execute(_toolCallId, params, signal) {
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
      const limit = Math.max(1, params.limit ?? DEFAULT_RESOLVE_LIMIT);

      let result;
      try {
        result = f.fileSearch(params.pattern, { pageSize: limit });
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
          content: [{ type: "text", text: `No files matched "${params.pattern}".` }],
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
      Type.Number({ description: "Context lines before+after" }),
    ),
    limit: Type.Optional(
      Type.Number({
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

  pi.registerTool({
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

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");

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
      const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
      let query;
      try {
        query = buildQuery(params.path, "", params.exclude, activeCwd);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid path constraint: ${(e as Error).message}.` }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }
      const explicitContext = params.context ?? 0;

      let grepResult;
      try {
        grepResult = f.multiGrep({
          patterns: params.patterns,
          constraints: query || undefined,
          cursor: (params.cursor ? cursorStore.get(params.cursor) : null) ?? null,
          beforeContext: explicitContext,
          afterContext: Math.max(explicitContext, 3),
          maxMatchesPerFile: Math.min(effectiveLimit, 50),
          smartCase: params.caseSensitive !== true,
          classifyDefinitions: true,
        });
      } catch (e) {
        return {
          content: [{ type: "text", text: `Search error: ${(e as Error).message}` }],
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
      const outputMode = params.outputMode as GrepOutputMode | undefined;
      return formatGrepResult(result, outputMode, explicitContext);
    },
  });

  // --- related_files tool ---

  const relatedFilesSchema = Type.Object({
    path: Type.String({
      description:
        "File path (relative or fuzzy) to find companion files for (tests, types, styles, stories).",
    }),
    limit: Type.Optional(
      Type.Number({
        description: `Max related files (default ${DEFAULT_RESOLVE_LIMIT})`,
      }),
    ),
  });

  pi.registerTool({
    name: "related_files",
    label: "Related Files",
    description:
      "Find companion files by stem matching (tests, types, styles).",
    promptSnippet: "Find companion files",
    promptGuidelines: [
      "Pass any file path. Strips test/spec/.d/.module suffixes.",
      "Great for finding test files or type defs for a module.",
    ],
    parameters: relatedFilesSchema,

    async execute(_toolCallId, params, signal) {
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
      const limit = Math.max(1, params.limit ?? DEFAULT_RESOLVE_LIMIT);

      // Resolve the reference file first
      let refResult;
      try {
        refResult = f.fileSearch(params.path, { pageSize: limit * 2 });
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
          content: [{ type: "text", text: `No file matched "${params.path}".` }],
          details: { reference: "", related: [] },
        };
      }

      const referencePath = refResult.value.items[0].relativePath;

      // Extract stem: strip test/spec/stories/.d/.module suffixes, then extension
      const stem = (referencePath.split("/").pop() ?? referencePath)
        .replace(/\.(test|spec|stories)\./g, ".")
        .replace(/\.d\./g, ".")
        .replace(/\.module\./g, ".")
        .replace(/\.[^.]+$/, "");

      // Search for files with the same stem
      let relatedResult;
      try {
        relatedResult = f.fileSearch(stem, { pageSize: limit * 3 });
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

      // Filter out the reference file and limit
      const related = relatedResult.value.items
        .filter((item) => item.relativePath !== referencePath)
        .filter((item) => {
          const candidateBase = item.relativePath.split("/").pop() ?? "";
          const refDir = referencePath.substring(0, referencePath.lastIndexOf("/"));
          return (
            candidateBase.includes(stem) ||
            item.relativePath.includes(`${refDir}/${stem}`)
          );
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

      const newMode = arg as FffMode;
      const oldMode = currentMode;
      currentMode = newMode;

      pi.appendEntry("fff-mode", { mode: newMode });

      const note =
        (oldMode === "override") !== (newMode === "override")
          ? " (tool name change requires /reload)"
          : "";
      ctx.ui.notify(`Mode changed: '${oldMode}' → '${newMode}'${note}`, "info");
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
