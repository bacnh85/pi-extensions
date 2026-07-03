/**
 * Parameter normalization logic for pi-serena.
 * Extracted from index.ts so it can be tested without importing pi-coding-agent.
 */

export function normalizeProject(project: unknown): string {
	return typeof project === "string" && project.trim() ? project : process.cwd();
}

export function normalizeContext(context: unknown): string {
	return typeof context === "string" && context.trim() ? context : "ide";
}

export function normalizeTimeoutMs(timeoutMs: unknown): number | undefined {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
	return timeoutMs;
}

export function stripControlParams(params: Record<string, unknown>): { project: string; context: string; timeoutMs: number | undefined; params: Record<string, unknown> } {
	const { project, context, timeout_ms, ...toolParams } = params;
	return { project: normalizeProject(project), context: normalizeContext(context), timeoutMs: normalizeTimeoutMs(timeout_ms), params: toolParams };
}

export function normalizeSearchPatternParams(params: Record<string, unknown>): Record<string, unknown> {
	const normalized = { ...params };
	if (normalized.substring_pattern === undefined && normalized.pattern !== undefined) {
		normalized.substring_pattern = normalized.pattern;
	}
	delete normalized.pattern;
	// multiline is not supported by the Python backend; validation above catches true values.
	// Strip it here as a safety net to avoid TypeError.
	delete normalized.multiline;
	return normalized;
}

export function normalizeFindReferencesParams(params: Record<string, unknown>): Record<string, unknown> {
	const normalized = { ...params };
	delete normalized.include_body;
	return normalized;
}

export function normalizeReplaceContentParams(params: Record<string, unknown>): Record<string, unknown> {
	const normalized = { ...params };
	delete normalized.old_string;
	delete normalized.new_string;
	delete normalized.content;
	delete normalized.regex;
	return normalized;
}

export function validateReplaceContentParams(params: Record<string, unknown>): string | undefined {
	if (typeof params.needle !== "string") return "serena_replace_content requires string parameter 'needle'.";
	if (typeof params.repl !== "string") return "serena_replace_content requires string parameter 'repl'.";
	if (params.mode !== "literal" && params.mode !== "regex") return "serena_replace_content requires mode to be 'literal' or 'regex'.";
	return undefined;
}
