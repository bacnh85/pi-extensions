/**
 * shell-helpers.ts — shared shell-command analysis + dangerous-command guard.
 *
 * Used by the tool_call hook in pi-model-tools. DeepSeek V4 needs steering
 * (semantic-miss blocking, dedicated-tool reminders); GLM does not per eval.
 * The hook gates steering on family === "deepseek-v4".
 */

import { isRecord } from "./model-detection.ts";

function normalizedTarget(value: unknown): string {
  return (typeof value === "string" ? value.toLowerCase() : "").split(/[?#]/, 1)[0];
}

// Paths Serena cannot index. Steering should NOT fire for these — Serena returns
// empty results for node_modules, dist, build, .d.ts, and generated artifacts.
const SERENA_EXCLUDED_PATH_RE = /\/(node_modules|dist|build|\.git|\.next|\.cache|coverage)\/|\.d\.ts\b/i;

export function looksLikeCodePath(value: unknown): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|scala|rb|php|cs|cpp|cc|cxx|c|h|hpp|swift|sh|bash|zsh|fish|lua|r|jl|ex|exs|erl|hrl|clj|cljs|fs|fsx|ml|mli|dart|vue|svelte)$/i.test(normalizedTarget(value));
}

export function commandLooksLikeSemanticCodeSearch(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const lowered = command.toLowerCase();
  if (!/\b(rg|grep|ag|ack|sed|awk|find)\b/.test(lowered)) return false;
  if (/\b(ls|pwd|git\s+status|npm\s+(test|run|install)|pnpm\s+(test|run|install)|yarn\s+(test|run|install))\b/.test(lowered)) return false;
  if (/^sed\s+-n\b/.test(command.trim().toLowerCase())) return false;
  // Don't steer when the target is outside Serena's indexable scope (node_modules, dist, .d.ts, etc.)
  if (SERENA_EXCLUDED_PATH_RE.test(lowered)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|cc|cxx|c|h|hpp)\b/.test(lowered)
    || /\b(class|function|def|interface|implements|references?|symbol|declaration|implementation|method|variable|rename|refactor)\b/.test(lowered);
}

function commandIsSimple(command: string): boolean {
  return !/[|;&`$()]|\b(if|for|while|case|xargs|sudo|env|cd)\b/.test(command);
}

export function dedicatedToolForShellCommand(command: unknown, activeTools: readonly string[] = []): string | undefined {
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  if (!trimmed || !commandIsSimple(trimmed)) return undefined;
  if (/^(npm|pnpm|yarn|bun|node|npx|git|make|cargo|go|pytest|python|tsx|tsc|awk)\b/.test(trimmed)) return undefined;
  if (/^ls\b/.test(trimmed) && activeTools.includes("ls")) return "ls";
  if (/^find\b/.test(trimmed) && activeTools.includes("find")) return "find";
  if (/^(grep|rg|ag|ack)\b/.test(trimmed) && activeTools.includes("grep")) return "grep";
  if (/^cat\s+\S+\s*$/.test(trimmed) && activeTools.includes("read")) return "read";
  if (/^head\s+/.test(trimmed) && activeTools.includes("read")) return "read";
  if (/^tail\s+/.test(trimmed) && activeTools.includes("read")) return "read";
  if (/^sed\s+-n\b/.test(trimmed)) return undefined;
  if (/^(echo|printf)\s.+>\s*\S/.test(trimmed) && activeTools.includes("write")) return "write";
  return undefined;
}

export function isSemanticMissToolCall(toolName: string, input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (toolName === "bash") return commandLooksLikeSemanticCodeSearch(input.command);
  if (toolName === "grep" || toolName === "ffgrep") return grepLooksLikeSymbolSearch(input);
  return false;
}

function grepLooksLikeSymbolSearch(input: Record<string, unknown>): boolean {
  const rawPattern = typeof input.pattern === "string" ? input.pattern : "";
  const pattern = rawPattern.trim();
  if (!pattern) return false;
  // Quoted pattern = literal text search (error message, exact string), not a symbol lookup
  if (rawPattern.startsWith("'") || rawPattern.startsWith('"') || rawPattern.startsWith("`")) return false;
  const glob = typeof input.glob === "string" ? input.glob : "";
  if (glob && !/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|rb|php|cs|cpp|hpp)$/i.test(glob)) return false;
  const searchPath = typeof input.path === "string" ? input.path : "";
  if (searchPath) {
    const target = normalizedTarget(searchPath);
    // Serena cannot index generated/vendored paths
    if (SERENA_EXCLUDED_PATH_RE.test(target)) return false;
    if (/(^|\/)(readme|changelog|license|copying|package-lock|pnpm-lock|yarn\.lock)(\.[a-z0-9_-]+)?$/.test(target)
      || /(^|\/)(package|tsconfig|jsconfig|biome|eslint|prettier|vitest|vite|rollup|webpack|babel|jest|mocha|nyc)\.(json|jsonc|ya?ml|toml|js|cjs|mjs)$/.test(target)
      || /(^|\/)\.([a-z0-9_-]+)(rc|ignore)?$/.test(target)
      || /\.(md|mdx|txt|json|jsonc|ya?ml|toml|ini|env|lock|csv|tsv|xml|html|css|scss|sass|log)$/i.test(target)) return false;
  }
  if (/^[A-Z_][A-Z_0-9]{3,}$/.test(pattern)) return false;
  return /^[a-zA-Z_$][\w.$]{2,}$/.test(pattern) || /^class\s+\w/i.test(pattern) || /^(function|def|const|let|var|interface|type|enum|export)\s+\w/i.test(pattern);
}

export function missedDedicatedTool(toolName: string, input: unknown, activeTools: readonly string[]): string | undefined {
  if (toolName !== "bash" || !isRecord(input)) return undefined;
  if (commandLooksLikeSemanticCodeSearch(input.command)) return undefined;
  return dedicatedToolForShellCommand(input.command, activeTools);
}

export function suggestBestSerenaCommand(input: unknown, activeTools: readonly string[]): string {
  if (!isRecord(input)) return defaultSerenaSuggest(activeTools);
  const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
  if (pattern && activeTools.includes("serena_find_symbol")) {
    if (/^[a-zA-Z_$][\w.$]{2,}$/.test(pattern)) return `Try: serena_find_symbol({name_path_pattern: "${pattern}"})`;
    if (/^(class|function|def|const|let|var|interface|type|enum|export)\s+(\w+)/i.test(pattern)) return `Try: serena_find_symbol({name_path_pattern: "${RegExp.$2}"})`;
    return defaultSerenaSuggest(activeTools);
  }
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) return defaultSerenaSuggest(activeTools);
  const symbol = extractSymbolFromGrep(command);
  if (symbol && activeTools.includes("serena_find_symbol")) return `Try: serena_find_symbol({name_path_pattern: "${symbol}"})`;
  if (/\bfind\b/.test(command) && /\b(grep|rg|ag)\b/.test(command) && activeTools.includes("serena_search_for_pattern")) {
    const p = extractGrepPattern(command);
    return p ? `Try: serena_search_for_pattern({pattern: "${p}"})` : defaultSerenaSuggest(activeTools);
  }
  return defaultSerenaSuggest(activeTools);
}

function extractSymbolFromGrep(command: string): string | undefined {
  if (!/^\s*(grep|rg|ag|ack)\b/.test(command)) return undefined;
  const tokens: string[] = [];
  const tokenRe = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = tokenRe.exec(command)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
  for (const tok of tokens) {
    if (/^(grep|rg|ag|ack)$/.test(tok) || /^-[a-z0-9A-Z]+$/.test(tok) || /^\*?\.[a-z]+$/.test(tok) || tok === "--" || tok === "-e" || tok === "-f") continue;
    if (/^[a-zA-Z_$][\w.$]*$/.test(tok) && tok.length >= 3) return tok;
  }
  return undefined;
}

function extractGrepPattern(command: string): string | undefined {
  const tokens: string[] = [];
  const tokenRe = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = tokenRe.exec(command)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
  for (const tok of tokens) {
    if (/^(grep|rg|ag|ack|find)$/.test(tok) || /^-[a-z0-9A-Z]+$/.test(tok) || tok === "--" || tok === "-e" || tok === "-exec") continue;
    return tok;
  }
  return undefined;
}

function defaultSerenaSuggest(activeTools: readonly string[]): string {
  return activeTools.includes("serena_get_symbols_overview") ? "Try: serena_get_symbols_overview({relative_path: \"the file\"})" : "Try: serena_get_symbols_overview";
}

// ── Error categorization ──

export type ErrorCategory = "validation" | "tool_not_found" | "path_not_found" | "rate_limit" | "timeout" | "api_error" | "edit_mismatch" | "reasoning_rejected" | "unknown";
export interface ErrorInfo { category: ErrorCategory; hint: string; toolName: string; }

/**
 * Detect a provider 400 caused by accumulated `reasoning_content` fields in
 * prior assistant messages. Providers that don't accept reasoning as input
 * reject the request once the session grows long enough. Matches:
 *  - explicit reasoning-field rejection ("reasoning_content not supported")
 *  - content-length / token-limit overflow that mentions reasoning or tokens
 *    (the classic long-session reasoning-accumulation symptom)
 */
export function detectReasoningRejection(errorText: string): boolean {
  const t = errorText.toLowerCase();
  // Explicit reasoning-field rejection, either word order:
  //   "reasoning_content is not supported" | "Unknown parameter: reasoning_content"
  // Also matches reasoning overflows ("reasoning_content blocks exceeds the maximum").
  if (/\breasoning(?:_content)?\b[^\n]{0,60}\b(?:not (?:allowed|supported|accepted|permitted)|unsupported|invalid|unknown|exceeds?|too many|limit)\b/.test(t)) return true;
  if (/\b(?:not (?:allowed|supported|accepted|permitted)|unsupported|invalid|unknown)[^\n]{0,60}\breasoning(?:_content)?\b/.test(t)) return true;
  // Content-length/token-limit/context-length overflow mentioning tokens/chars/reasoning:
  //   "The prompt is too long: 128000 tokens exceeds the limit"
  //   "The request exceeds the maximum token limit of 64000"
  // Reverse order also matched ("This model's maximum context length is 128000 tokens")
  // so a limit-word preceding the subject is still caught.
  const lengthOverflow = /\b(?:content|prompt|message|input|request|context)\b[^\n]{0,60}\b(?:too long|too many|exceed(?:s|ed)?|maximum|limit)\b/.test(t)
    || /\b(?:maximum|limit)[^\n]{0,40}\b(?:context|content)\b/.test(t);
  if (lengthOverflow && /\btokens?\b|\bcharacters?\b|\breasoning\b/.test(t)) return true;
  return false;
}

export function categorizeToolError(toolName: string, errorResult: unknown): ErrorInfo {
  const text = (isRecord(errorResult) && Array.isArray(errorResult.content)
    ? errorResult.content.map((p) => isRecord(p) && typeof p.text === "string" ? p.text : "").join("\n")
    : String(errorResult ?? "")).toLowerCase();
  // Edit mismatch is checked before rate_limit/timeout because an enriched edit error may
  // append a nearest-region file snippet containing 'timeout'/'429'/'rate limit'
  // strings (e.g. `const timeout = 5000;`, `if (status === 429)`), which would
  // otherwise misclassify as timeout/rate_limit and give the wrong recovery hint.
  if (toolName === "edit" && /could not find (?:edits|the exact text)|old ?text must match exactly|found \d+ occurrences|(?:old)?text must be unique|provide more context to make it unique/i.test(text)) return { category: "edit_mismatch", toolName, hint: "Edit requires exact unique matching. Read a narrow range, copy oldText verbatim, include surrounding lines." };
  if (/rate limit|429|too many requests|exceeded.*limit/i.test(text)) return { category: "rate_limit", toolName, hint: "Rate-limited. Wait before retrying or simplify the request." };
  if (/timed? ?out|timeout/i.test(text)) return { category: "timeout", toolName, hint: "Timed out. Use simpler inputs or reduce scope." };
  if (/validation failed|invalid_type|required|missing.*(field|argument|property)/i.test(text)) return { category: "validation", toolName, hint: "Invalid arguments. Provide all required fields with correct types." };
  if (/enoent|no such file or directory|(?:file|path) not found/i.test(text)) return { category: "path_not_found", toolName, hint: "Path missing or guessed. Discover the exact path with find first." };
  if (/no such tool|unknown tool|is not a function|tool\s+\S+\s+(?:was\s+)?not found/i.test(text)) return { category: "tool_not_found", toolName, hint: "Use only exact Pi tool names. Never invent names like read_file." };
  if (/(?:http(?: status)?|status(?: code)?|api(?: error)?)[^\n]{0,20}[45]\d{2}\b|\b[45]\d{2}\s+(?:bad request|unauthorized|forbidden|not found|conflict|too many requests|internal server error|bad gateway|service unavailable|gateway timeout)\b/i.test(text)) return { category: "api_error", toolName, hint: `Tool call to ${toolName} failed. Retry with simpler inputs.` };
  return { category: "unknown", toolName, hint: "Previous tool call(s) had errors. Use simpler inputs." };
}

// ── Dangerous command guard ──

export function checkDangerousCommand(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim().toLowerCase();
  for (const [, args] of trimmed.matchAll(/\brm\s+([^;&|\n]+)/g)) {
    const recursive = /(?:^|\s)(?:-[a-z]*r[a-z]*|--recursive)(?:\s|$)/.test(args);
    const forced = /(?:^|\s)(?:-[a-z]*f[a-z]*|--force)(?:\s|$)/.test(args);
    const absolute = /(?:^|\s)(?:--\s+)?(?:["']\/[^"']*["']|\/\S*)(?:\s|$)/.test(args);
    if (recursive && forced && absolute) return "Forced recursive delete of an absolute path";
  }
  if (/\bdd\b[^\n;&|]*\bof=["']?\/dev\/(?:sd[a-z]\d*|vd[a-z]\d*|xvd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|disk\d+|rdisk\d+|loop\d+|md\d+|mapper\/[a-z0-9._+-]+)\b/.test(trimmed)) return "Destructive dd write to a block device";
  return undefined;
}
