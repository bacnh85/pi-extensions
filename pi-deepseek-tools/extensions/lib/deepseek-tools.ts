declare const process: { env: Record<string, string | undefined> };

export const OPENCODE_GO_PROVIDER = "opencode-go";
export const DEEPSEEK_V4_FLASH_MODEL = "deepseek-v4-flash";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenCodeGoDeepSeekV4FlashModel(model?: { provider?: string; id?: string }): boolean {
	return model?.provider === OPENCODE_GO_PROVIDER && model?.id === DEEPSEEK_V4_FLASH_MODEL;
}

/** @deprecated Use isOpenCodeGoDeepSeekV4FlashModel. Kept as a compatibility alias with Flash-only semantics. */
export function isDeepSeekV4Model(provider?: string, modelId?: string): boolean {
	return provider === OPENCODE_GO_PROVIDER && modelId === DEEPSEEK_V4_FLASH_MODEL;
}

/** @deprecated Use isOpenCodeGoDeepSeekV4FlashModel. Kept as a compatibility alias with Flash-only semantics. */
export function isOpenCodeGoDeepSeekV4Model(model?: { provider?: string; id?: string }): boolean {
	return isOpenCodeGoDeepSeekV4FlashModel(model);
}

export function selectionGuidanceEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return !/^(0|false|no|off)$/i.test(env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE ?? "");
}

export function strictSerenaEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return /^(1|true|yes|on)$/i.test(env.PI_DEEPSEEK_TOOLS_STRICT_SERENA ?? "");
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
	return !/[|;&<>`$()]|\b(if|for|while|case|xargs|sudo|env|cd)\b/.test(command);
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
	if (/^sed\s+-n\s+['"]?\d+(,\d+)?p['"]?\s+\S+\s*$/.test(trimmed) && activeTools.includes("read")) return "read";
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

export function deepSeekSelectionGuidance(activeTools: readonly string[]): string {
	const serenaActive = activeTools.some((tool) => tool.startsWith("serena_"));
	const fileToolsActive = hasAnyTool(activeTools, ["ls", "grep", "find", "read", "edit", "bash"]);
	const parts = ["OpenCode Go DeepSeek V4 Flash tool-selection rules for Pi:"];

	parts.push("1. Call exactly one provided Pi tool name; never invent tool names such as read_file, search_files, or list_directory.");

	if (serenaActive) {
		parts.push(
			"2. For code-symbol, source navigation, declaration, implementation, reference, rename, or refactor tasks, first use Serena: serena_get_symbols_overview for source-file outlines, serena_find_symbol for functions/classes/methods/variables, serena_find_declaration or serena_find_implementations for definitions/interfaces, and serena_find_referencing_symbols before public behavior changes or renames.",
			"3. Use read for docs, config, generated output, non-code files, or after Serena identifies the relevant code region.",
		);
	}

	if (fileToolsActive) {
		parts.push(
			"4. Path fields are filesystem paths, never markdown links or auto-links.",
			"5. For exact file/text work, use ls, find, grep, or read rather than shelling out. Use bash only for real commands such as tests, builds, git, package-manager, or process execution.",
			"6. For edits, inspect with the right tool first and then call edit; do not invent missing tools.",
		);
	}

	return parts.join("\n");
}
