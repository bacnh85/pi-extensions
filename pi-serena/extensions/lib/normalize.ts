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

// ponytail: normalizeSearchPatternParams, normalizeFindReferencesParams, normalizeReplaceContentParams, validateReplaceContentParams — inlined into tool handlers
