import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NineRouterConfig } from "./lib/config.js";
import { getEffectiveConfig } from "./lib/config.js";
import { fetchModels, mapModel, type NineRouterModelRaw } from "./lib/client.js";
import { registerProvider, unregisterProvider } from "./lib/provider.js";
import { registerLoginCommand } from "./commands/login.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Short timeout for background discovery — Pi never blocks startup on a
 *  slow or unreachable 9router endpoint. */
const STARTUP_DISCOVERY_TIMEOUT_MS = 5_000;

/** Disk cache for raw model list so session restore finds models instantly
 *  without waiting for the background HTTP fetch to complete. */
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi");
const MODEL_CACHE_PATH = join(CACHE_DIR, "9router-models.json");

/** Model IDs that allow the switch-away-and-back workaround for Pi's
 *  modelsAreEqual guard (see forceModelRefresh below). */
const FALLBACK_SWITCH_MODELS: [string, string][] = [
  ["opencode-go", "deepseek-v4-flash"],
  ["zai-coding-cn", "glm-5.1"],
  ["zai-coding-cn", "glm-5-turbo"],
  ["openrouter", "nvidia/nemotron-3-super-120b-a12b:free"],
];

// ── Model cache ──────────────────────────────────────────────────────────────

function readModelCache(): NineRouterModelRaw[] | null {
  try {
    if (!existsSync(MODEL_CACHE_PATH)) return null;
    const raw = JSON.parse(readFileSync(MODEL_CACHE_PATH, "utf8")) as unknown;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    // ponytail: validate just the first entry's shape — if it has an id, trust the rest
    if (!raw[0] || typeof (raw[0] as Record<string, unknown>).id !== "string") return null;
    return raw as NineRouterModelRaw[];
  } catch {
    return null;
  }
}

function writeModelCache(models: NineRouterModelRaw[]): void {
  if (models.length === 0) return;
  try {
    mkdirSync(dirname(MODEL_CACHE_PATH), { recursive: true });
    writeFileSync(MODEL_CACHE_PATH, JSON.stringify(models) + "\n", { mode: 0o600 });
  } catch {
    // cache write failure is non-fatal — next startup just falls back to fetch
  }
}

// ── Fallback model helpers ───────────────────────────────────────────────────

function findFallbackModel(ctx: ExtensionContext): ReturnType<ExtensionContext["modelRegistry"]["find"]> {
  for (const [provider, id] of FALLBACK_SWITCH_MODELS) {
    const model = ctx.modelRegistry.find(provider, id);
    if (model) return model;
  }
  return undefined;
}

/** Force Pi to pick up updated model capabilities by switching away from the
 *  current 9router model and then back to the refreshed registry copy. */
export async function forceModelRefresh(
  pi: ExtensionAPI, ctx: ExtensionContext, modelId: string,
): Promise<void> {
  const fallback = findFallbackModel(ctx);
  if (fallback) {
    try { await pi.setModel(fallback); } catch { /* auth missing or fallback gone */ }
  }
  const refreshed = ctx.modelRegistry.find("9router", modelId);
  if (refreshed) {
    try { await pi.setModel(refreshed); } catch { /* auth missing — skip */ }
  }
}

// ── Extension factory ────────────────────────────────────────────────────────
// IMPORTANT: Do NOT await a network call in the factory.  Pi awaits the factory
// before continuing startup, so a blocking fetch would hang or freeze the UI.
// Instead, load models from disk cache (instant) or register with empty models,
// and fire a background discovery that re-registers when complete.

export default async function (pi: ExtensionAPI) {
  // ── Module state ───────────────────────────────────────────────────────────
  let config: NineRouterConfig = getEffectiveConfig();
  let modelIds: string[] = [];
  let discoveryGen = 0;

  // ── Provider lifecycle ─────────────────────────────────────────────────────

  /** Apply a config by fetching models and registering the provider.
   *  This IS awaited in command handlers (user expects the change now)
   *  but NOT during startup (that blocks Pi). */
  async function applyProvider(cfg: NineRouterConfig) {
    unregisterProvider(pi);
    if (!cfg.baseUrl) return;
    try {
      const raw = await fetchModels(cfg);
      writeModelCache(raw);
      const models = raw.map((m) => mapModel(m, cfg.enableReasoning));
      modelIds = models.map((m) => m.id);
      registerProvider(pi, cfg, models);
    } catch {
      modelIds = [];
      registerProvider(pi, cfg, []);
    }
  }

  /** Background model fetch with a short timeout.  Re-registers the provider
   *  with real models on success; discards stale results via generation guard. */
  async function startBackgroundDiscovery(cfg: NineRouterConfig): Promise<void> {
    const gen = ++discoveryGen;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), STARTUP_DISCOVERY_TIMEOUT_MS);
      timer.unref?.();

      const raw = await fetchModels(cfg, controller.signal);
      clearTimeout(timer);

      if (gen !== discoveryGen) return; // stale — a newer discovery started

      writeModelCache(raw);
      const models = raw.map((m) => mapModel(m, cfg.enableReasoning));
      modelIds = models.map((m) => m.id);

      unregisterProvider(pi);
      registerProvider(pi, cfg, models);
    } catch {
      if (gen !== discoveryGen) return;
      // Discovery failed — keep whatever models are currently registered
      // (cached fallback or empty).  User can retry via /login-9router.
    }
  }

  /** Called when the user changes config via a command.  Awaits the fetch
   *  because the user expects the change to take effect now. */
  async function onConfigChange(newConfig: NineRouterConfig) {
    config = newConfig;
    await applyProvider(newConfig);
  }

  // ── Registration ───────────────────────────────────────────────────────────

  registerLoginCommand(pi, () => config, () => modelIds, onConfigChange);

  // ── Session lifecycle ───────────────────────────────────────────────────────

  // On session start, refresh the active model pointer if it's a 9router model.
  // Pi restores the last selected model after the extension factory completes,
  // but the restored model object may not reflect freshly registered capabilities
  // (e.g. reasoning:true from enableReasoning).
  pi.on("session_start", async (_event, ctx) => {
    const active = ctx.model;
    if (active?.provider === "9router" && active.id) {
      const refreshed = ctx.modelRegistry.find("9router", active.id);
      if (refreshed) {
        try { await pi.setModel(refreshed); } catch { /* missing auth — ignore */ }
      }
    }
  });

  // When a 9router model is selected via /model (or restored), ensure its
  // reasoning capabilities match the current config.  This catches stale
  // model objects that predate a reasoning-toggle.
  // ponytail: bail fast — only do the slow switch-away dance when actually needed.
  pi.on("model_select", async (event, ctx) => {
    if (event.model.provider !== "9router" || !event.model.id) return;
    if (config.enableReasoning && !event.model.reasoning) {
      await forceModelRefresh(pi, ctx, event.model.id);
    }
  });

  // ── Startup ────────────────────────────────────────────────────────────────
  // Try disk cache first (instant — no network wait).  If no cache, register
  // with empty models so Pi sees the provider exists, then fire background
  // discovery.

  if (config.baseUrl) {
    const cached = readModelCache();
    if (cached) {
      const models = cached.map((m) => mapModel(m, config.enableReasoning));
      modelIds = models.map((m) => m.id);
      registerProvider(pi, config, models);
      // Refresh in background to keep cache current.
      void startBackgroundDiscovery(config);
    } else {
      // No cache — register empty, discover in background.
      registerProvider(pi, config, []);
      void startBackgroundDiscovery(config);
    }
  }
}
