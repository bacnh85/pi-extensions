import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RouterSettings {
  /** Base URL of the router's OpenAI-compatible API (e.g. http://host:20128/v1). */
  baseUrl: string;
  /** Enable Pi thinking-level controls on router models. Default true. */
  enableReasoning: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Repo-scope settings (`.pi/settings.json` in the working directory). */
const REPO_SETTINGS_PATH = join(process.cwd(), ".pi", "settings.json");

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** User-global settings (lazy — honors PI_CODING_AGENT_DIR set by tests). */
function globalSettingsPath(): string {
  return join(agentDir(), "settings.json");
}

function authPath(): string {
  return join(agentDir(), "auth.json");
}

/** Env names (ROUTER_* with NINE_ROUTER_* legacy aliases), read lazily. */
const envBaseUrl = () => process.env.ROUTER_BASE_URL ?? process.env.NINE_ROUTER_BASE_URL;
const envReasoning = () => process.env.ROUTER_ENABLE_REASONING ?? process.env.NINE_ROUTER_ENABLE_REASONING;

// ── Public API ───────────────────────────────────────────────────────────────

/** Read `router` settings. Precedence: env var > repo `.pi/settings.json` >
 *  global `~/.pi/agent/settings.json` > defaults.
 *  Repo-scope `router.apiKey` is ignored (secrets must not come from a checked-in file). */
export function getSettings(): RouterSettings {
  const saved = readRouterSection(readFileJson(globalSettingsPath())) ?? {};
  const repo = readRouterSection(readFileJson(REPO_SETTINGS_PATH)) ?? {};
  return {
    baseUrl: normalizeUrl(envBaseUrl() || repo.baseUrl || saved.baseUrl || ""),
    enableReasoning:
      parseBooleanFlag(envReasoning()) ?? repo.enableReasoning ?? saved.enableReasoning ?? true,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readFileJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Non-secret fields only; drop any `apiKey` a repo file tries to inject. */
function readRouterSection(json: Record<string, unknown> | null): Partial<RouterSettings> | null {
  if (!json || typeof json.router !== "object" || json.router === null) return null;
  const r = json.router as Record<string, unknown>;
  const out: Partial<RouterSettings> = {};
  if (typeof r.baseUrl === "string" && r.baseUrl.trim()) out.baseUrl = r.baseUrl.trim();
  if (typeof r.enableReasoning === "boolean") out.enableReasoning = r.enableReasoning;
  return out;
}

export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Read the stored API key from `~/.pi/agent/auth.json` (status display only —
 *  request auth resolution is Pi's job via the provider's apiKey config). */
export function readStoredApiKey(): string | undefined {
  const json = readFileJson(authPath());
  const cred = json?.router as { key?: unknown } | undefined;
  return typeof cred?.key === "string" && cred.key ? cred.key : undefined;
}

export function maskApiKey(key: string | undefined): string {
  if (!key) return "(not set)";
  if (key.length <= 8) return key;
  return key.slice(0, 4) + "●".repeat(key.length - 8) + key.slice(-4);
}

export function configSummary(settings: RouterSettings): string {
  const key = process.env.ROUTER_API_KEY
    ? maskApiKey(process.env.ROUTER_API_KEY) + " (env)"
    : maskApiKey(readStoredApiKey());
  const reasoning = settings.enableReasoning
    ? "ON"
    : "OFF (run /router-reasoning to enable thinking levels)";
  return `Endpoint: ${settings.baseUrl || "(not configured)"}
API key: ${key}
Reasoning: ${reasoning}`;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(v)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(v)) return false;
  return undefined;
}
