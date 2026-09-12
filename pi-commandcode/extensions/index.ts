import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { openConfigPanel, row } from "@bacnh85/pi-config-panel";
import { DEFAULT_BASE_URL, fetchModels, mapModel, type CommandCodeModelRaw } from "./lib/client.js";
import { getSettings, isCustomEndpoint, writeBaseUrl, type CommandCodeSettings } from "./lib/config.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Short timeout for background discovery — Pi never blocks startup on a slow
 *  or unreachable Command Code endpoint. */
const STARTUP_DISCOVERY_TIMEOUT_MS = 5_000;

/** Disk cache for raw model list so session restore finds models instantly
 *  without waiting for the background HTTP fetch. */
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi");
const MODEL_CACHE_PATH = join(CACHE_DIR, "commandcode-models.json");

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

function cachedModelCount(): number {
  return readModelCache()?.length ?? 0;
}

// ── Provider lifecycle ───────────────────────────────────────────────────────

/** Register the provider with the given settings. Re-registerable — the
 *  config panel calls this after saving a new baseUrl so the provider points
 *  at the fresh endpoint without a restart (same pattern as pi-router's
 *  /router-reasoning). Models are registered via refreshModels so Pi's
 *  catalog refresh populates them. `apiKey` env-interpolation makes /login
 *  auto-available AND resolvable from COMMAND_CODE_API_KEY without login. */
function registerProvider(pi: ExtensionAPI, settings: CommandCodeSettings) {
  pi.registerProvider(PROVIDER_ID, {
    name: "Command Code",
    baseUrl: settings.baseUrl,
    apiKey: "$COMMAND_CODE_API_KEY",
    api: "openai-completions",
    refreshModels: async (context) => {
      // Restore from disk cache instantly if the network is unavailable.
      // No cache → undefined ("keep current") so the catalog is never wiped.
      // Cast: the composer runtime guards with `if (refreshed)` so undefined
      // keeps the current catalog, but its .d.ts return type omits undefined.
      if (!context.allowNetwork || context.signal.aborted) {
        const cached = readModelCache();
        return cached ? cached.map(mapModel) : (undefined as unknown as ProviderModelConfig[]);
      }

      // apiKey is only safe to read from context.credential (resolved by Pi
      // after /login) or env. Never assume a global.
      const apiKey = context.credential?.type === "api_key" ? context.credential.key : ENV_API_KEY;

      const raw = await fetchModels(settings.baseUrl, apiKey, context.signal);
      writeModelCache(raw);
      return raw.map(mapModel);
    },
  });
}

/** Background model discovery with a short timeout. Used only at startup so
 *  the disk cache stays current; /login and catalog refresh handle the rest. */
async function startBackgroundDiscovery(settings: CommandCodeSettings): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STARTUP_DISCOVERY_TIMEOUT_MS);
    timer.unref?.();

    const raw = await fetchModels(settings.baseUrl, ENV_API_KEY, controller.signal);
    clearTimeout(timer);

    writeModelCache(raw);
    // Catalog refresh (via refreshModels) is the canonical path; this fetch
    // just keeps the cache warm. No re-registration needed here.
  } catch {
    // Discovery failed — keep whatever is cached. User runs /login to refresh.
  }
}

// ── /commandcode-config ──────────────────────────────────────────────────────

/** Summary for non-TUI mode / `show` (mirrors pi-router's configSummary). */
function configSummary(s: CommandCodeSettings): string {
  const key = ENV_API_KEY
    ? "set (env COMMAND_CODE_API_KEY)"
    : "run /login commandcode (auth.json) or set COMMAND_CODE_API_KEY";
  return [
    "Command Code config:",
    `  baseUrl: ${s.baseUrl}${isCustomEndpoint(s) ? "" : " (default)"}`,
    `  apiKey: ${key}`,
    `  cached models: ${cachedModelCount()}`,
    "",
    "Interactive editor: run /commandcode-config in TUI mode.",
    "Select models with /model (commandcode provider).",
  ].join("\n");
}

function registerConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("commandcode-config", {
    description: "Configure Command Code endpoint interactively (TUI) or show config",
    handler: async (args, ctx) => {
      const sub = String(args ?? "").trim().toLowerCase();

      // Non-interactive mode or explicit "show": print the summary.
      if (sub === "show" || ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify(configSummary(getSettings(ctx.cwd)), "info");
        return;
      }

      const before = getSettings(ctx.cwd);
      const working = structuredClone(before);
      await openConfigPanel({
        ctx,
        cfg: working,
        title: "Command Code Configuration",
        build: (cfg) => [
          {
            key: "endpoint",
            label: "Endpoint",
            rows: [
              row("baseUrl", "Base URL", "string", cfg.baseUrl, (v) => {
                cfg.baseUrl = String(v ?? "").trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
              }),
            ],
          },
        ],
        onSave: async (saved) => {
          if (!saved) return;
          if (working.baseUrl === before.baseUrl) {
            ctx.ui.notify("No changes.", "info");
            return;
          }
          let written: string;
          try {
            written = writeBaseUrl(working.baseUrl);
          } catch (err) {
            // Corrupt global settings.json — surface instead of overwriting it.
            ctx.ui.notify(`Not saved: ${err instanceof Error ? err.message : String(err)}`, "error");
            return;
          }
          // Re-register so the provider points at the new endpoint, then
          // force a catalog refresh (same pattern as pi-router).
          registerProvider(pi, working);
          try {
            await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] });
          } catch {
            /* refresh errors are surfaced by Pi elsewhere */
          }
          ctx.ui.notify(`Command Code baseUrl saved → ${written}\nModels refreshed — select with /model.`, "info");
        },
      });
    },
  });
}

// ── Extension factory ────────────────────────────────────────────────────────
// IMPORTANT: Do NOT await a network call in the factory. Pi awaits the factory
// before continuing startup, so a blocking fetch would hang or freeze the UI.
// Register the provider (instant), then fire background discovery.

export default function (pi: ExtensionAPI) {
  const settings = getSettings();
  registerProvider(pi, settings);

  registerConfigCommand(pi);

  // Warm the cache in the background (non-blocking).
  void startBackgroundDiscovery(settings);
}
