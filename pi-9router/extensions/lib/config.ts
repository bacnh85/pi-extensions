import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface NineRouterConfig {
  baseUrl: string;
  apiKey: string | undefined;
  enableReasoning: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".pi", "agent", "9router-config.json");
const ENV_BASE_URL = process.env.NINE_ROUTER_BASE_URL;
const ENV_API_KEY = process.env.NINE_ROUTER_API_KEY;
const ENV_ENABLE_REASONING = process.env.NINE_ROUTER_ENABLE_REASONING;
const DEFAULT_BASE_URL = "http://localhost:20128/v1";

// ── Public API ───────────────────────────────────────────────────────────────

export function loadConfig(): NineRouterConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<NineRouterConfig>;
    if (!data.baseUrl || typeof data.baseUrl !== "string") return null;
    return {
      baseUrl: normalizeUrl(data.baseUrl),
      apiKey: typeof data.apiKey === "string" && data.apiKey.trim() ? data.apiKey.trim() : undefined,
      enableReasoning: data.enableReasoning === true,
    };
  } catch {
    return null;
  }
}

export function saveConfig(config: NineRouterConfig): void {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ baseUrl: config.baseUrl, apiKey: config.apiKey, enableReasoning: config.enableReasoning }, null, 2) + "\n", {
      mode: 0o600,
    });
  } catch (err) {
    console.error("[pi-9router] Failed to persist config:", err);
  }
}

/** Returns effective config: env vars override saved config, then defaults. */
export function getEffectiveConfig(): NineRouterConfig {
  const saved = loadConfig();
  return {
    baseUrl: normalizeUrl(ENV_BASE_URL || saved?.baseUrl || DEFAULT_BASE_URL),
    apiKey: ENV_API_KEY || saved?.apiKey || undefined,
    enableReasoning: parseBooleanFlag(ENV_ENABLE_REASONING) ?? saved?.enableReasoning ?? true,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function maskApiKey(key: string | undefined): string {
  if (!key || key.length <= 8) return key ?? "(not set)";
  return key.slice(0, 4) + "●".repeat(key.length - 8) + key.slice(-4);
}

export function configSummary(config: NineRouterConfig): string {
  const key = maskApiKey(config.apiKey);
  const reasoning = config.enableReasoning ? "ON" : "OFF";
  return `Endpoint: ${config.baseUrl}\nAPI key: ${key}\nReasoning: ${reasoning}`;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(v)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(v)) return false;
  return undefined;
}
