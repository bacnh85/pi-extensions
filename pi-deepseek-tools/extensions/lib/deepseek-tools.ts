declare const process: { env: Record<string, string | undefined> };

export const OPENCODE_GO_PROVIDER = "opencode-go";
export const DEEPSEEK_V4_FLASH_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_V4_PRO_MODEL = "deepseek-v4-pro";

const DEEPSEEK_V4_MODELS = new Set([DEEPSEEK_V4_FLASH_MODEL, DEEPSEEK_V4_PRO_MODEL]);

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenCodeGoDeepSeekV4FlashModel(model?: { provider?: string; id?: string }): boolean {
	return model?.provider === OPENCODE_GO_PROVIDER && model?.id === DEEPSEEK_V4_FLASH_MODEL;
}

export function isOpenCodeGoDeepSeekV4ProModel(model?: { provider?: string; id?: string }): boolean {
	return model?.provider === OPENCODE_GO_PROVIDER && model?.id === DEEPSEEK_V4_PRO_MODEL;
}

export function isOpenCodeGoDeepSeekV4Model(model?: { provider?: string; id?: string }): boolean {
	return model?.provider === OPENCODE_GO_PROVIDER && DEEPSEEK_V4_MODELS.has(model?.id ?? "");
}

/**
 * Matches both Flash and Pro under OpenCode Go (always) and optionally
 * under the direct `deepseek` provider when PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1.
 */
export function isDeepSeekV4Model(provider?: string, modelId?: string): boolean {
	const isOpenCodeGo = provider === OPENCODE_GO_PROVIDER && DEEPSEEK_V4_MODELS.has(modelId ?? "");
	if (isOpenCodeGo) return true;
	if (directDeepSeekEnabled()) {
		return provider === "deepseek" && (modelId === DEEPSEEK_V4_FLASH_MODEL || modelId === DEEPSEEK_V4_PRO_MODEL);
	}
	return false;
}

export function selectionGuidanceEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return !/^(0|false|no|off)$/i.test(env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE ?? "");
}

export function strictSerenaEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return /^(1|true|yes|on)$/i.test(env.PI_DEEPSEEK_TOOLS_STRICT_SERENA ?? "");
}

export function reasoningStripEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return /^(1|true|yes|on)$/i.test(env.PI_DEEPSEEK_TOOLS_STRIP_REASONING ?? "");
}

export function directDeepSeekEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return /^(1|true|yes|on)$/i.test(env.PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK ?? "");
}

export function repairEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return !/^(0|false|no|off)$/i.test(env.PI_DEEPSEEK_TOOLS_REPAIR_ENABLED ?? "");
}

/**
 * Combined model check: matches OpenCode Go DeepSeek V4 (Flash + Pro) always,
 * and direct `deepseek` provider when PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1.
 * This is the function runtime hooks should use for gating.
 */
export function isDeepSeekV4ModelByModel(model?: { provider?: string; id?: string }): boolean {
	if (isOpenCodeGoDeepSeekV4Model(model)) return true;
	if (directDeepSeekEnabled()) {
		return model?.provider === "deepseek" && (model?.id === DEEPSEEK_V4_FLASH_MODEL || model?.id === DEEPSEEK_V4_PRO_MODEL);
	}
	return false;
}

export function hasAnyTool(activeTools: readonly string[] | undefined, names: readonly string[]): boolean {
	return Array.isArray(activeTools) && names.some((name) => activeTools.includes(name));
}

function codePathCandidate(value: unknown): string {
	return typeof value === "string" ? value.toLowerCase() : "";
}

function normalizedTarget(value: unknown): string {
	return codePathCandidate(value).split(/[?#]/, 1)[0];
}

export function looksLikeCodePath(value: unknown): boolean {
	const target = normalizedTarget(value);
	return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|scala|rb|php|cs|cpp|cc|cxx|c|h|hpp|swift|sh|bash|zsh|fish|lua|r|jl|ex|exs|erl|hrl|clj|cljs|fs|fsx|ml|mli|dart|vue|svelte)$/i.test(target);
}

export function looksLikeDocsOrConfigPath(value: unknown): boolean {
	const target = normalizedTarget(value);
	return /(^|\/)(readme|changelog|license|copying|package-lock|pnpm-lock|yarn\.lock)(\.[a-z0-9_-]+)?$/.test(target)
		|| /(^|\/)(package|tsconfig|jsconfig|biome|eslint|prettier|vitest|vite|rollup|webpack|babel|jest|mocha|nyc)\.(json|jsonc|ya?ml|toml|js|cjs|mjs)$/.test(target)
		|| /(^|\/)\.([a-z0-9_-]+)(rc|ignore)?$/.test(target)
		|| /\.(md|mdx|txt|json|jsonc|ya?ml|toml|ini|env|lock|csv|tsv|xml|html|css|scss|sass|log)$/i.test(target);
}

export function commandLooksLikeSemanticCodeSearch(command: unknown): boolean {
	if (typeof command !== "string") return false;
	const lowered = command.toLowerCase();
	if (!/\b(rg|grep|ag|ack|sed|awk|cat|find)\b/.test(lowered)) return false;
	if (/\b(ls|pwd|git\s+status|npm\s+(test|run|install)|pnpm\s+(test|run|install)|yarn\s+(test|run|install))\b/.test(lowered)) return false;
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
	if (/^(npm|pnpm|yarn|bun|node|npx|git|make|cargo|go|pytest|python|tsx|tsc)\b/.test(trimmed)) return undefined;
	if (/^ls\b/.test(trimmed) && activeTools.includes("ls")) return "ls";
	if (/^find\b/.test(trimmed) && activeTools.includes("find")) return "find";
	if (/^(grep|rg|ag|ack)\b/.test(trimmed) && activeTools.includes("grep")) return "grep";
	if (/^cat\s+\S+\s*$/.test(trimmed) && activeTools.includes("read")) return "read";
	if (/^head\s+/.test(trimmed) && activeTools.includes("read")) return "read";
	if (/^tail\s+/.test(trimmed) && activeTools.includes("read")) return "read";
	if (/^sed\s+-n\s+['"]?\d+(,\d+)?p['"]?\s+\S+\s*$/.test(trimmed) && activeTools.includes("read")) return "read";
	if (/^(echo|printf)\s.+>\s*\S/.test(trimmed) && activeTools.includes("write")) return "write";
	return undefined;
}

export function isSemanticMissToolCall(toolName: string, input: unknown): boolean {
	if (!isRecord(input)) return false;
	if (toolName === "read") return looksLikeCodePath(input.path) && !looksLikeDocsOrConfigPath(input.path);
	if (toolName === "bash") return commandLooksLikeSemanticCodeSearch(input.command);
	return false;
}

export function missedDedicatedTool(toolName: string, input: unknown, activeTools: readonly string[]): string | undefined {
	if (toolName !== "bash" || !isRecord(input)) return undefined;
	if (commandLooksLikeSemanticCodeSearch(input.command)) return undefined;
	return dedicatedToolForShellCommand(input.command, activeTools);
}

export function findMisuseSuggestion(toolName: string, input: unknown): string | undefined {
	if (toolName !== "find" || !isRecord(input)) return undefined;

	const pattern = typeof input.pattern === "string" ? input.pattern : "";
	const path = typeof input.path === "string" ? input.path : "";
	const combined = `${path} ${pattern}`.trim();

	const knownDocs = /(readme|changelog|license|copying|package\.json|tsconfig\.json|makefile|dockerfile|\.gitignore)/i;
	if (knownDocs.test(combined)) {
		return "read";
	}

	// Directory/glob patterns that look like test discovery → let find through
	if (/(__tests?__|\.(test|spec)\.)/i.test(pattern)) {
		return undefined;
	}

	// No wildcards = looking for a specific named file → should use read
	if (!/[*?\[\]]/.test(combined) && /\S/.test(combined)) {
		return "read";
	}

	return undefined;
}

const guidanceCache = new Map<string, string>();

export function clearGuidanceCache(): void {
	guidanceCache.clear();
}

export function deepSeekSelectionGuidance(activeTools: readonly string[]): string {
	const cacheKey = [...activeTools].sort().join(",");
	const cached = guidanceCache.get(cacheKey);
	if (cached) return cached;

	const serenaActive = activeTools.some((tool) => tool.startsWith("serena_"));
	const parts: string[] = [
		"OpenCode Go DeepSeek V4 tool-selection rules — apply immediately:",
		"",
		"1. Code files → Serena first (serena_get_symbols_overview / serena_find_symbol / serena_find_declaration / serena_find_implementations / serena_find_referencing_symbols). Do NOT use read for code files.",
	];

	if (serenaActive) {
		parts.push(
			"2. Read is for docs, config, logs, generated output, or after Serena identifies the exact code region.",
		);
	}

	parts.push(
		"3. Dedicated tools over bash/find: write > echo>, grep > bash grep, ls > bash ls, find (globs) > bash find, read > bash cat/sed/head.",
		"4. Never invent tool names — use only the exact Pi tool names listed below.",
	);

	const result = parts.join("\n");
	guidanceCache.set(cacheKey, result);
	return result;
}

// ────────────────────────────────────────────────────────
// Error categorization for context-aware recovery hints
// ────────────────────────────────────────────────────────

export type ErrorCategory = "validation" | "tool_not_found" | "rate_limit" | "timeout" | "api_error" | "unknown";

export interface ErrorInfo {
	category: ErrorCategory;
	hint: string;
	toolName: string;
}

/**
 * Categorize a tool-error result into a specific category and produce
 * a targeted recovery hint for the next turn.
 */
export function categorizeToolError(toolName: string, errorResult: unknown): ErrorInfo {
	const text = String(errorResult ?? "").toLowerCase();

	if (/rate limit|429|too many requests|exceeded.*limit/i.test(text)) {
		return { category: "rate_limit", toolName, hint: "The previous tool call was rate-limited. Wait before retrying or simplify the request to reduce API consumption." };
	}
	if (/timed? ?out|timeout/i.test(text)) {
		return { category: "timeout", toolName, hint: "The previous tool call timed out. Use simpler inputs, reduce the scope of the operation, or try a different approach." };
	}
	if (/validation failed|invalid_type|required|missing.*(field|argument|property)/i.test(text)) {
		return { category: "validation", toolName, hint: "The tool call had invalid arguments. Provide all required fields with correct types — strings for text values, arrays for list values, and valid file paths." };
	}
	if (/not found|no such tool|unknown tool|is not a function/i.test(text)) {
		return { category: "tool_not_found", toolName, hint: "Use only the exact Pi tool names provided to you. Never invent tool names like read_file or search_files." };
	}
	if (/4\d{2}|5\d{2}/i.test(text)) {
		return { category: "api_error", toolName, hint: `The tool call to ${toolName} failed. Retry with simpler inputs and ensure all fields are present.` };
	}

	return { category: "unknown", toolName, hint: "The previous tool call(s) had errors. Use simpler tool inputs and provide all required fields explicitly." };
}

// ────────────────────────────────────────────────────────
// Env-var config helpers (move these here to keep parsing
// testable alongside the other toggle functions).
// ────────────────────────────────────────────────────────

/**
 * Maximum tracked tool errors in the error history.
 * Default: 100. Invalid/negative values fall back to 100.
 */
export function maxErrorHistory(env: Record<string, string | undefined> = process.env): number {
	const raw = env.PI_DEEPSEEK_TOOLS_MAX_ERROR_HISTORY;
	if (raw === undefined || raw === "") return 100;
	const val = parseInt(raw, 10);
	return Number.isFinite(val) && val > 0 ? val : 100;
}

/**
 * Flat thinking budget for all turns.
 * Returns undefined when unset (model decides).
 */
export function thinkingBudget(env: Record<string, string | undefined> = process.env): number | undefined {
	const raw = env.PI_DEEPSEEK_TOOLS_THINKING_BUDGET;
	if (raw === undefined || raw === "") return undefined;
	const val = parseInt(raw, 10);
	return Number.isFinite(val) && val >= 0 ? val : undefined;
}

/**
 * Auto-block threshold: number of reminders before blocking a miss pattern.
 * Default 0 (off). Invalid/negative values fall back to 0.
 */
export function autoBlockAfterReminders(env: Record<string, string | undefined> = process.env): number {
	const raw = env.PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS;
	if (raw === undefined || raw === "") return 0;
	const val = parseInt(raw, 10);
	return Number.isFinite(val) && val >= 1 ? val : 0;
}

/**
 * Whether the dangerous-command guard is enabled.
 * Accepts 1/true/yes/on (case-insensitive).
 */
export function blockDangerousEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return /^(1|true|yes|on)$/i.test(env.PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS ?? "");
}

/**
 * Dangerous bash command patterns for optional safety guardrails.
 * Returns a warning message if the command is dangerous, or undefined if safe.
 */
export function checkDangerousCommand(command: unknown): string | undefined {
	if (typeof command !== "string") return undefined;

	const trimmed = command.trim().toLowerCase();

	// ponytail: only 2 patterns that actually happen — rm -rf / (accidental) and dd (hallucination)
	if (/\brm\s+-rf\s+\//.test(trimmed)) {
		return "Recursive delete of root filesystem (`rm -rf /`)";
	}
	if (/\bdd\s+if=\/dev\//.test(trimmed)) {
		return "Destructive dd to block device";
	}
	return undefined;
}


