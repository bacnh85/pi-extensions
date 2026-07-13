import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

// ---------------------------------------------------------------------------
// Environment loading
// ---------------------------------------------------------------------------

export function piConfigDirs(): string[] {
	return process.env.PI_CODING_AGENT_DIR
		? [process.env.PI_CODING_AGENT_DIR]
		: [path.join(os.homedir(), ".pi", "agent"), path.join(os.homedir(), ".pi", "agents")];
}

export function loadEnv(cwd = process.cwd(), includeCwd = true): void {
	const candidates: string[] = [
		...(includeCwd ? [path.resolve(cwd, ".env.local"), path.resolve(cwd, ".env")] : []),
		...piConfigDirs().flatMap((dir) => [path.join(dir, ".env.local"), path.join(dir, ".env")]),
	];
	for (const file of candidates) {
		dotenv.config({ path: file });
	}
}

// ---------------------------------------------------------------------------
// Munin config
// ---------------------------------------------------------------------------

export interface MuninConfig {
	apiKey: string;
	projectId: string;
	baseUrl: string;
}

// ponytail: simple module-level cache, no TTL — config doesn't change mid-process.
const configCache = new Map<string, MuninConfig>();

export function getMuninConfig(
	params: Record<string, unknown>,
	cwd = process.cwd(),
	includeCwdEnv = false
): MuninConfig {
	const cacheKey = `${cwd}|${includeCwdEnv}|${JSON.stringify(params, Object.keys(params).sort())}`;
	const cached = configCache.get(cacheKey);
	if (cached) return cached;

	loadEnv(cwd, includeCwdEnv);
	const explicitApiKey = params.api_key as string | undefined;
	const explicitBaseUrl = params.base_url as string | undefined;
	const apiKey = explicitApiKey || process.env.MUNIN_API_KEY;
	const projectId = (params.project as string) || process.env.MUNIN_PROJECT;
	const baseUrl = explicitBaseUrl || process.env.MUNIN_BASE_URL || "https://munin.kalera.ai";

	if (!apiKey) {
		throw new Error("MUNIN_API_KEY is required. Set it in your environment, .env.local/.env, or pass api_key.");
	}
	if (!projectId) {
		throw new Error("MUNIN_PROJECT is required. Set it in your environment, .env.local/.env, or pass project.");
	}
	const config: MuninConfig = { apiKey, projectId, baseUrl };
	configCache.set(cacheKey, config);
	return config;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export const OUTPUT_MAX_BYTES = 50 * 1024;
export const OUTPUT_MAX_LINES = 2_000;

export function truncateText(text: string): string {
	const lines = text.split("\n");
	let output = lines.slice(0, OUTPUT_MAX_LINES).join("\n");
	while (Buffer.byteLength(output, "utf8") > OUTPUT_MAX_BYTES) {
		output = output.slice(0, Math.max(0, output.length - 1024));
	}
	if (lines.length > OUTPUT_MAX_LINES || output.length < text.length) {
		output += `\n\n[Munin output truncated to ${OUTPUT_MAX_LINES} lines / ${OUTPUT_MAX_BYTES} bytes.]`;
	}
	return output;
}

export function normalizeMemory(item: unknown): Record<string, unknown> {
	const wrapper = item as { memory?: Record<string, unknown>; score?: unknown };
	if (wrapper?.memory) {
		return { ...wrapper.memory, score: wrapper.score };
	}
	return (item as Record<string, unknown>) || {};
}

export function formatMemory(memory: Record<string, unknown>): string {
	const parts: string[] = [];
	if (memory.key) parts.push(`Key: ${memory.key}`);
	if (memory.id && memory.id !== memory.key) parts.push(`ID: ${memory.id}`);
	if (memory.title) parts.push(`Title: ${memory.title}`);
	if (memory.tags) {
		const tags = Array.isArray(memory.tags) ? memory.tags.join(", ") : String(memory.tags);
		parts.push(`Tags: ${tags}`);
	}
	if (memory.updatedAt || memory.updated) {
		parts.push(`Updated: ${(memory.updatedAt ?? memory.updated) as string}`);
	}
	if (memory.createdAt || memory.created) {
		parts.push(`Created: ${(memory.createdAt ?? memory.created) as string}`);
	}
	const content = (memory.content ?? memory.text ?? memory.body ?? memory.value ?? "") as string;
	if (content) parts.push(`Content:\n${content}`);
	return parts.join("\n");
}

// ponytail: handles { data: [...] }, { data: { memories: [...] } }, and raw arrays — 3 shapes the SDK actually returns. Throw for unknown.
export function formatMemories(result: unknown): string {
	if (!result || typeof result !== "object") return String(result);
	const container = result as Record<string, unknown>;
	let data = container.data ?? container.items ?? container.result ?? result;
	if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data as Record<string, unknown>).memories)) {
		data = (data as Record<string, unknown>).memories as unknown[];
	}
	const items = Array.isArray(data) ? data.filter(Boolean) : [data].filter(Boolean);
	if (items.length === 0) return "No memories found.";
	const formatted = items
		.map((item: unknown, index: number) => {
			const memory = normalizeMemory(item);
			const formatted = formatMemory(memory);
			// Skip items that produced no useful fields (meaningless data)
			if (!formatted) return null;
			return `--- Memory ${index + 1} ---\n${formatted}`;
		})
		.filter(Boolean)
		.join("\n\n");
	return formatted || "No memories found.";
}

export function toTextResult(result: unknown): string {
	if (result === null || result === undefined) return "No result.";
	if (typeof result === "string") return truncateText(result);
	const formatted = formatMemories(result);
	return truncateText(formatted);
}

/**
 * Format Munin server capabilities into a clean structured text output.
 * Capabilities are not memory objects, so they need dedicated formatting.
 */
export function formatCapabilities(caps: Record<string, unknown>): string {
	const lines = ["--- Munin Server Capabilities ---"];
	const meta = caps.metadata as Record<string, unknown> | undefined;
	if (caps.specVersion) lines.push(`Spec Version: ${caps.specVersion}`);
	if (meta?.serverVersion) lines.push(`Server Version: ${meta.serverVersion}`);
	const actions = caps.actions as Record<string, string[]> | undefined;
	if (actions?.core?.length) lines.push(`Core Actions: ${actions.core.join(", ")}`);
	if (actions?.optional?.length) lines.push(`Optional Actions: ${actions.optional.join(", ")}`);
	const features = Object.entries(caps.features as Record<string, { supported: boolean }> || {});
	if (features.length) lines.push(`Features: ${features.map(([n, i]) => `${n} ${i?.supported ? "✓" : "✗"}`).join(", ")}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function parseTags(tags: unknown): string[] {
	if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
	if (typeof tags === "string") return tags.split(",").map((tag) => tag.trim()).filter(Boolean);
	return [];
}

export function validateMemoryTags(tags: unknown): { ok: true; tags: string[] } | { ok: false; message: string; tags: string[] } {
	const tagList = parseTags(tags);
	const hasTypeTag = tagList.some((tag: string) => tag.startsWith("type:"));
	const hasDomainTag = tagList.some((tag: string) => tag.startsWith("domain:"));
	if (!hasTypeTag || !hasDomainTag) {
		return {
			ok: false,
			message: `Tag validation failed: Memory must have at least one "type:" tag AND one "domain:" tag. Provided tags: ${tagList.join(", ") || "none"}`,
			tags: tagList,
		};
	}
	return { ok: true, tags: tagList };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export function validateMemoryKey(key: unknown): string {
	if (!key || typeof key !== "string") {
		throw new Error("Memory key must be a non-empty string");
	}
	if (key.trim().length === 0) {
		throw new Error("Memory key cannot be empty or whitespace only");
	}
	if (key.length > 200) {
		throw new Error("Memory key must be less than 200 characters");
	}
	if (!/^[a-zA-Z0-9-_/]+$/.test(key)) {
		throw new Error("Memory key can only contain alphanumeric characters, hyphens, underscores, and forward slashes");
	}
	return key;
}

export function validateSearchQuery(query: unknown): string {
	if (!query || typeof query !== "string") {
		throw new Error("Search query must be a non-empty string");
	}
	if (query.trim().length === 0) {
		throw new Error("Search query cannot be empty or whitespace only");
	}
	if (query.length > 1000) {
		throw new Error("Search query must be less than 1000 characters");
	}
	return query.trim();
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function classifyError(error: unknown): { type: string; message: string } {
	const err = error instanceof Error ? error : new Error(String(error));
	const message = err.message.toLowerCase().replace(/_/g, " ");
	if (message.includes("unauthorized") || message.includes("invalid api key")) {
		return { type: "auth", message: err.message };
	}
	if (message.includes("e2ee") || message.includes("encryption")) {
		return { type: "e2ee", message: err.message };
	}
	if (message.includes("stale protocol")) {
		return { type: "stale_protocol", message: err.message };
	}
	if (message.includes("not found")) {
		return { type: "not_found", message: err.message };
	}
	if (message.includes("timeout") || message.includes("etimed")) {
		return { type: "timeout", message: err.message };
	}
	if (message.includes("network") || message.includes("econn") || message.includes("socket")) {
		return { type: "network", message: err.message };
	}
	return { type: "unknown", message: err.message };
}

// ponytail: only redacts the env-var name, not heuristic base64 (fragile, false positives).
export function sanitizeErrorMessage(error: Error): string {
	return error.message.replace(/MUNIN_API_KEY[=\s]+[A-Za-z0-9+/=_-]{4,}/gi, "MUNIN_API_KEY=[REDACTED]");
}


