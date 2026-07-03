// Unified search orchestrator.
// Probes backend availability and adaptively tries backends:
//   SearXNG (self-hosted) for broad discovery,
//   Brave (hosted API) for precision/inline content,
//   Firecrawl as last-resort search.

import { findEnvValue, cwdFromContext, includeProjectEnv, normalizeSearxngBaseUrl } from "./config";
import { fetchBraveResults } from "./brave";
import { fetchSearxngResults } from "./searxng";
import { firecrawlRequest, type FirecrawlResult } from "./firecrawl";
import { loadFirecrawlConfig, loadSearxngConfig, type FirecrawlConfig } from "./config";
import { fetchReadableContent } from "./content";
import { sanitizeSnippet } from "./format";

export type SearchBackend = "searxng" | "brave" | "firecrawl";
export type SearchAttemptStatus = "skipped" | "success" | "empty" | "error";

export interface SearchParams {
	query: string;
	count?: number;
	freshness?: string;
	country?: string;
	backend?: "auto" | SearchBackend;
	engines?: string;
	include_content?: boolean;
	content_chars?: number;
	timeout_ms?: number;
	signal?: AbortSignal;
	/** Internal: caller-provided ctx for env lookup. */
	_ctx?: Record<string, unknown>;
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	age: string;
	content: string;
	backend: string;
}

export interface SearchAttempt {
	backend: SearchBackend;
	status: SearchAttemptStatus;
	message: string;
	resultCount: number;
}

export interface SearchDiagnostics {
	results: SearchResult[];
	attempts: SearchAttempt[];
	selectedBackend: SearchBackend | "";
	backendOrder: SearchBackend[];
}

interface BackendConfig {
	searxng: { configured: boolean; baseUrl: string };
	brave: { configured: boolean; apiKey: string };
	firecrawl: { configured: boolean; config: FirecrawlConfig | null };
}

function probeBackends(ctx?: Record<string, unknown>): BackendConfig {
	const cwd = cwdFromContext(ctx ?? {});
	const trusted = includeProjectEnv(ctx ?? {});

	let searxngBaseUrl: string;
	try {
		const searxngConfig = loadSearxngConfig({}, cwd, trusted);
		searxngBaseUrl = searxngConfig.baseUrl;
	} catch {
		searxngBaseUrl = normalizeSearxngBaseUrl();
	}

	const braveKey = findEnvValue("BRAVE_API_KEY", cwd, trusted);

	let fcConfig: FirecrawlConfig | null = null;
	try {
		fcConfig = loadFirecrawlConfig({}, cwd, trusted);
	} catch {
		// Not configured or unsafe to use from this context.
	}

	return {
		searxng: { configured: true, baseUrl: searxngBaseUrl },
		brave: { configured: Boolean(braveKey.value), apiKey: braveKey.value ?? "" },
		firecrawl: { configured: fcConfig !== null, config: fcConfig },
	};
}

async function searchSearxng(params: SearchParams): Promise<SearchResult[]> {
	const cfg = loadSearxngConfig(
		{ ...(params.engines ? { engines: params.engines } : {}) } as Record<string, unknown>,
		cwdFromContext(params._ctx ?? {}),
		includeProjectEnv(params._ctx ?? {}),
	);
	const raw = await fetchSearxngResults(
		{ query: params.query, count: params.count ?? 5, engines: params.engines, timeout_ms: params.timeout_ms } as Record<string, unknown>,
		cfg.baseUrl,
		params.signal,
	);
	return (raw.results || []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.snippet ?? "",
		age: r.publishedDate ?? "",
		content: "",
		backend: "searxng",
	}));
}

async function searchBrave(params: SearchParams, backends: BackendConfig): Promise<SearchResult[]> {
	if (!backends.brave.configured) throw new Error("Brave not configured (no BRAVE_API_KEY)");
	const raw = await fetchBraveResults(
		params.query,
		params.count ?? 5,
		params.country ?? "US",
		params.freshness ?? "",
		backends.brave.apiKey,
		params.signal,
	);
	const results = raw.map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.snippet ?? "",
		age: r.age ?? "",
		content: "",
		backend: "brave",
	}));
	if (params.include_content && results.length > 0) {
		const maxChars = params.content_chars ?? 5000;
		await Promise.all(
			results.map(async (r) => {
				try {
					const article = await fetchReadableContent(r.url, params.timeout_ms ?? 10000, params.signal);
					r.content = article.markdown.slice(0, maxChars);
				} catch (e: any) {
					r.content = `(Fetch error for ${r.url}: ${sanitizeError(e)})`;
				}
			}),
		);
	}
	return results;
}

async function searchFirecrawl(params: SearchParams, backends: BackendConfig): Promise<SearchResult[]> {
	if (!backends.firecrawl.configured || !backends.firecrawl.config) {
		throw new Error("Firecrawl not configured (no FIRECRAWL_API_URL)");
	}
	const body: Record<string, unknown> = {
		query: params.query,
		limit: Math.min(100, Math.max(1, params.count ?? 5)),
		sources: [{ type: "web" }],
		...(params.country ? { country: String(params.country).toUpperCase() } : {}),
	};
	const result = await firecrawlRequest(backends.firecrawl.config, "POST", "/search", body, true, params.signal) as FirecrawlResult;
	const rootData = result.data as Record<string, unknown> | undefined;
	const web = (rootData?.web as unknown[]) || [];
	const news = (rootData?.news as unknown[]) || [];
	const items = [...web, ...news];
	return items.map((r: any) => ({
		title: sanitizeSnippet(r.title ?? r.metadata?.title ?? ""),
		url: r.url ?? r.metadata?.sourceURL ?? "",
		snippet: sanitizeSnippet(r.description ?? r.snippet ?? ""),
		age: "",
		content: r.markdown ? String(r.markdown).slice(0, params.content_chars ?? 5000) : "",
		backend: "firecrawl",
	}));
}

function isPrecisionQuery(params: SearchParams): boolean {
	const query = params.query.trim();
	const lower = query.toLowerCase();
	if (params.include_content) return true;
	if (/\bsite:[^\s]+/i.test(query)) return true;
	if (/"[^"]+"/.test(query)) return true;
	if (/\b(docs?|documentation|api|github|repo|repository|changelog|release|issue|bug|sdk|package)\b/i.test(query)) return true;
	const terms = query.split(/\s+/).filter(Boolean);
	if (terms.length > 0 && terms.length <= 4 && /\b[A-Z][A-Za-z0-9_-]{2,}\b/.test(query)) return true;
	if (/\b[a-z0-9-]+\.(com|dev|io|org|net|app|ai|tv)\b/i.test(lower)) return true;
	return false;
}

export function selectSearchBackendOrder(params: SearchParams): SearchBackend[] {
	if (params.backend && params.backend !== "auto") return [params.backend];
	if (params.engines && !params.include_content) return ["searxng", "brave", "firecrawl"];
	if (isPrecisionQuery(params)) return ["brave", "searxng", "firecrawl"];
	return ["searxng", "brave", "firecrawl"];
}

function sanitizeError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/X-Subscription-Token\s*[:=]\s*[^\s]+/gi, "X-Subscription-Token: [REDACTED]")
		.replace(/api[_-]?key[=:][^\s&]+/gi, "api_key=[REDACTED]")
		.slice(0, 500);
}

function isConfigured(backend: SearchBackend, backends: BackendConfig): boolean {
	if (backend === "searxng") return backends.searxng.configured;
	if (backend === "brave") return backends.brave.configured;
	return backends.firecrawl.configured;
}

async function runBackend(backend: SearchBackend, params: SearchParams, backends: BackendConfig): Promise<SearchResult[]> {
	if (backend === "searxng") return searchSearxng(params);
	if (backend === "brave") return searchBrave(params, backends);
	return searchFirecrawl(params, backends);
}

export async function searchWithDiagnostics(params: SearchParams): Promise<SearchDiagnostics> {
	const backends = probeBackends(params._ctx);
	const backendOrder = selectSearchBackendOrder(params);
	const attempts: SearchAttempt[] = [];

	for (const backend of backendOrder) {
		if (!isConfigured(backend, backends)) {
			attempts.push({ backend, status: "skipped", message: `${backend} is not configured`, resultCount: 0 });
			continue;
		}
		try {
			const results = await runBackend(backend, params, backends);
			if (results.length > 0) {
				attempts.push({ backend, status: "success", message: `Selected ${backend}`, resultCount: results.length });
				return { results, attempts, selectedBackend: backend, backendOrder };
			}
			attempts.push({ backend, status: "empty", message: `${backend} returned 0 results`, resultCount: 0 });
		} catch (e) {
			attempts.push({ backend, status: "error", message: sanitizeError(e), resultCount: 0 });
			if (params.backend && params.backend !== "auto") break;
		}
	}

	const diagnostics = attempts.map((a) => `${a.backend}: ${a.status}${a.message ? ` (${a.message})` : ""}`).join("\n");
	throw new Error(
		`All web search backends failed or returned no results.\n${diagnostics}\n` +
		"Use backend to force a provider or check configuration with web_status.",
	);
}

/** Compatibility wrapper returning only results. */
export async function universalSearch(params: SearchParams): Promise<SearchResult[]> {
	return (await searchWithDiagnostics(params)).results;
}
