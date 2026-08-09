import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BASE_URL, fetchModels, mapModel, type CommandCodeModelRaw } from "./lib/client.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Short timeout for background discovery — Pi never blocks startup on a slow
 *  or unreachable Command Code endpoint. */
const STARTUP_DISCOVERY_TIMEOUT_MS = 5_000;

/** Disk cache for raw model list so session restore finds models instantly
 *  without waiting for the background HTTP fetch. */
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi");
const MODEL_CACHE_PATH = join(CACHE_DIR, "commandcode-models.json");

const ENV_BASE_URL = process.env.COMMAND_CODE_BASE_URL;
const ENV_API_KEY = process.env.COMMAND_CODE_API_KEY;

const PROVIDER_ID = "commandcode";

// ── Model cache ──────────────────────────────────────────────────────────────

function readModelCache(): CommandCodeModelRaw[] | null {
  try {
    if (!existsSync(MODEL_CACHE_PATH)) return null;
    const raw = JSON.parse(readFileSync(MODEL_CACHE_PATH, "utf8")) as unknown;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    // ponytail: validate just the first entry's shape — if it has an id, trust the rest
    if (!raw[0] || typeof (raw[0] as Record<string, unknown>).id !== "string") return null;
    return raw as CommandCodeModelRaw[];
  } catch {
    return null;
  }
}

function writeModelCache(models: CommandCodeModelRaw[]): void {
  if (models.length === 0) return;
  try {
    mkdirSync(dirname(MODEL_CACHE_PATH), { recursive: true });
    writeFileSync(MODEL_CACHE_PATH, JSON.stringify(models) + "\n", { mode: 0o600 });
  } catch {
    // cache write failure is non-fatal — next startup just falls back to fetch
  }
}

// ── Provider lifecycle ───────────────────────────────────────────────────────

function effectiveBaseUrl(): string {
  return (ENV_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Register the provider. Models are registered via refreshModels so Pi's
 *  catalog refresh (run after /login completes and on startup) populates them.
 *  apiKey env-interpolation makes /login auto-available AND resolvable from
 *  COMMAND_CODE_API_KEY without login. */
function registerProvider(pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: "Command Code",
    baseUrl: effectiveBaseUrl(),
    apiKey: "$COMMAND_CODE_API_KEY",
    api: "openai-completions",
    refreshModels: async (context) => {
      // Restore from disk cache instantly if the network is unavailable.
      if (!context.allowNetwork || context.signal.aborted) {
        const cached = readModelCache();
        return cached ? cached.map(mapModel) : [];
      }

      // apiKey is only safe to read from context.credential (resolved by Pi
      // after /login) or env. Never assume a global.
      const apiKey = context.credential?.type === "api_key" ? context.credential.key : ENV_API_KEY;

      const baseUrl = effectiveBaseUrl();
      const raw = await fetchModels(baseUrl, apiKey, context.signal);
      writeModelCache(raw);
      return raw.map(mapModel);
    },
  });
}

/** Background model discovery with a short timeout. Used only at startup so
 *  the disk cache stays current; /login and catalog refresh handle the rest. */
async function startBackgroundDiscovery(): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STARTUP_DISCOVERY_TIMEOUT_MS);
    timer.unref?.();

    const baseUrl = effectiveBaseUrl();
    const raw = await fetchModels(baseUrl, ENV_API_KEY, controller.signal);
    clearTimeout(timer);

    writeModelCache(raw);
    // Catalog refresh (via refreshModels) is the canonical path; this fetch
    // just keeps the cache warm. No re-registration needed here.
  } catch {
    // Discovery failed — keep whatever is cached. User runs /login to refresh.
  }
}

// ── Extension factory ────────────────────────────────────────────────────────
// IMPORTANT: Do NOT await a network call in the factory. Pi awaits the factory
// before continuing startup, so a blocking fetch would hang or freeze the UI.
// Register the provider (instant), then fire background discovery.

export default function (pi: ExtensionAPI) {
  registerProvider(pi);

  // Warm the cache in the background (non-blocking).
  void startBackgroundDiscovery();
}
