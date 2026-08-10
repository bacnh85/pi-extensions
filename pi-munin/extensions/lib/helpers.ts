import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import dotenv from "dotenv";

// ---------------------------------------------------------------------------
// Environment loading
// ---------------------------------------------------------------------------

export function piConfigDirs(): string[] {
  return process.env.PI_CODING_AGENT_DIR
    ? [process.env.PI_CODING_AGENT_DIR]
    : [path.join(os.homedir(), ".pi", "agent"), path.join(os.homedir(), ".pi", "agents")];
}

export function loadEnv(cwd = process.cwd(), includeCwd = true): Record<string, string> {
  const env: Record<string, string> = {};
  const candidates = [
    ...(includeCwd ? [path.resolve(cwd, ".env.local"), path.resolve(cwd, ".env")] : []),
    ...piConfigDirs().flatMap((dir) => [path.join(dir, ".env.local"), path.join(dir, ".env")]),
  ];
  for (const file of candidates) {
    try {
      for (const [key, value] of Object.entries(dotenv.parse(readFileSync(file)))) {
        if (env[key] === undefined) env[key] = value;
      }
    } catch {
      // Missing or unreadable env files are optional.
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Munin config
// ---------------------------------------------------------------------------

export interface MuninConfig {
  apiKey: string;
  projectId: string;
  baseUrl: string;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Munin base URL must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Munin base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Munin base URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Munin base URL must not contain a query or fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function getMuninConfig(
  params: Record<string, unknown>,
  cwd = process.cwd(),
  includeCwdEnv = false,
): MuninConfig {
  const fileEnv = loadEnv(cwd, includeCwdEnv);
  const explicitApiKey = typeof params.api_key === "string" && params.api_key ? params.api_key : undefined;
  const explicitBaseUrl = typeof params.base_url === "string" && params.base_url ? params.base_url : undefined;
  if (explicitBaseUrl && !explicitApiKey) {
    throw new Error("An explicit api_key is required when overriding base_url");
  }
  const apiKey = explicitApiKey || process.env.MUNIN_API_KEY || fileEnv.MUNIN_API_KEY;
  const projectId = (typeof params.project === "string" && params.project)
    || process.env.MUNIN_PROJECT
    || fileEnv.MUNIN_PROJECT;
  const baseUrl = normalizeBaseUrl(
    explicitBaseUrl || process.env.MUNIN_BASE_URL || fileEnv.MUNIN_BASE_URL || "https://munin.kalera.ai",
  );

  if (!apiKey) {
    throw new Error("MUNIN_API_KEY is required. Set it in your environment, .env.local/.env, or pass api_key.");
  }
  if (!projectId) {
    throw new Error("MUNIN_PROJECT is required. Set it in your environment, .env.local/.env, or pass project.");
  }
  return { apiKey, projectId, baseUrl };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export const OUTPUT_MAX_BYTES = DEFAULT_MAX_BYTES;
export const OUTPUT_MAX_LINES = DEFAULT_MAX_LINES;

export function truncateText(text: string): string {
  const result = truncateHead(text, {
    maxLines: OUTPUT_MAX_LINES,
    maxBytes: OUTPUT_MAX_BYTES,
  });
  if (!result.truncated) return result.content;
  return `${result.content}\n\n[Munin output truncated: showing ${result.outputLines} of ${result.totalLines} lines / ${result.outputBytes} of ${result.totalBytes} bytes.]`;
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
  if (memory.score !== undefined) parts.push(`Score: ${memory.score}`);
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
  const nested = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  const total = container.total ?? nested?.total;
  if (Array.isArray(nested?.memories)) data = nested.memories;
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
  if (!formatted) return "No memories found.";
  return total !== undefined ? `${formatted}\n\nTotal: ${total}` : formatted;
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

export function classifyError(error: unknown): { type: string; message: string; remediation?: Remediation } {
  const err = error instanceof Error ? error : new Error(String(error));
  const remediation = extractRemediation(err);
  const code = String((err as Error & { code?: unknown }).code ?? "").toUpperCase();
  const structuredTypes: Record<string, string> = {
    AUTH_INVALID: "auth",
    VALIDATION_ERROR: "validation",
    FEATURE_DISABLED: "feature_disabled",
    RATE_LIMITED: "rate_limit",
    ERR_STALE_PROTOCOL: "stale_protocol",
    NOT_FOUND: "not_found",
  };
  if (structuredTypes[code]) return { type: structuredTypes[code], message: err.message, remediation };

  const message = err.message.toLowerCase().replace(/_/g, " ");
  const name = err.name.toLowerCase();
  if (name === "aborterror" || message.includes("timeout") || message.includes("timed out") || message.includes("etimed") || message.includes("aborterror")) {
    return { type: "timeout", message: err.message };
  }
  if (name === "munintransporterror" || message.includes("network") || message.includes("econn") || message.includes("socket") || message.includes("fetch failed")) {
    return { type: "network", message: err.message };
  }
  if (message.includes("unauthorized") || message.includes("invalid api key")) return { type: "auth", message: err.message };
  if (message.includes("validation") || message.includes("invalid request")) return { type: "validation", message: err.message };
  if (message.includes("feature disabled") || message.includes("not supported")) return { type: "feature_disabled", message: err.message };
  if (message.includes("rate limit") || message.includes("too many requests") || /\b429\b/.test(message)) return { type: "rate_limit", message: err.message };
  if (message.includes("e2ee") || message.includes("encryption")) return { type: "e2ee", message: err.message };
  if (message.includes("stale protocol")) return { type: "stale_protocol", message: err.message };
  if (message.includes("not found")) return { type: "not_found", message: err.message };
  return { type: "unknown", message: err.message };
}

// ponytail: only redacts the env-var name, not heuristic base64 (fragile, false positives).
export function sanitizeErrorMessage(error: Error): string {
  return error.message.replace(/MUNIN_API_KEY[=\s]+[A-Za-z0-9+/=_-]{4,}/gi, "MUNIN_API_KEY=[REDACTED]");
}

// ---------------------------------------------------------------------------
// ERR_STALE_PROTOCOL remediation (server setup handshake)
// ---------------------------------------------------------------------------

export interface Remediation {
  action?: string;
  url?: string;
  version_from?: string | null;
  version_to?: string;
  acknowledge_after_reading?: {
    action: string;
    payload: { version: string };
  };
}

/** Pull the server's remediation block from an SDK error's `details`. Null-safe. */
export function extractRemediation(error: unknown): Remediation | undefined {
  const err = error instanceof Error ? error : new Error(String(error));
  const details = (err as Error & { details?: unknown }).details;
  if (details && typeof details === "object") {
    const remediation = (details as { remediation?: unknown }).remediation;
    if (remediation && typeof remediation === "object") {
      return remediation as Remediation;
    }
  }
  return undefined;
}

/** Human-readable remediation suffix for an error message. Empty string when none.
 *  Server-provided url/action are validated + sanitized: url must be http(s) (rejects
 *  javascript:/file:/data: and non-URLs), control chars stripped, phrased as data not
 *  an imperative to avoid a prompt-injection vector via a malicious/buggy server. */
export function formatRemediation(remediation: Remediation | undefined): string {
  if (!remediation) return "";
  const parts: string[] = [];
  const safeUrl = sanitizeRemediationUrl(remediation.url);
  const hasUrl = !!safeUrl;
  if (safeUrl) parts.push(`Setup guide: ${safeUrl}`);
  if (remediation.version_to) {
    const action = sanitizeRemediationToken(remediation.acknowledge_after_reading?.action) || "acknowledge_setup";
    const safeVersion = sanitizeRemediationToken(remediation.version_to);
    if (safeVersion) parts.push(`${hasUrl ? "then " : ""}run ${action} with version ${safeVersion}`);
  }
  if (!parts.length) return "";
  return ` Setup handshake required: ${parts.join(" ")}.`;
}

// C0 control + DEL + Unicode control/format chars that enable injection or deceptive rendering:
// bidi overrides (U+202E), zero-width (U+200B-200D), Unicode line/para separators (U+2028/2029),
// LTR/RTL marks (U+200E/200F), isolates (U+2066-2069), BOM/ZWNBSP (U+FEFF).
const REMEDIATION_CTRL_RE = /[\r\n\t\x00-\x1f\x7f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

/** Allow only clean http(s) URLs. Rejects non-URLs, non-http schemes, URLs with credentials
 *  (mirrors normalizeBaseUrl's policy), and any URL containing control/bidi/format chars. */
function sanitizeRemediationUrl(url: string | undefined): string {
  if (!url || typeof url !== "string") return "";
  if (REMEDIATION_CTRL_RE.test(url)) return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    // No credentials — matches normalizeBaseUrl's reject policy.
    if (u.username || u.password) return "";
    return u.href;
  } catch {
    return "";
  }
}

/** Strip C0/DEL + Unicode control/format chars from a short token (action name / version). */
function sanitizeRemediationToken(token: string | undefined): string {
  if (!token || typeof token !== "string") return "";
  return token.replace(/[\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff\r\n\t\x00-\x1f\x7f]/g, "");
}


