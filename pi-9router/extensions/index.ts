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

/** Re-select the active 9router model so Pi picks up refreshed capability
 *  flags (e.g. reasoning after a toggle). Safe: setModel updates the active
 *  model object; because id+provider are unchanged, Pi's modelsAreEqual guard
 *  suppresses the model_select event, so this never corrupts other extensions'
 *  per-mode model preferences. */
export async function refreshActiveModel(
  pi: ExtensionAPI, ctx: ExtensionContext,
): Promise<void> {
  const active = ctx.model;
  if (active?.provider !== "9router" || !active.id) return;
  const refreshed = ctx.modelRegistry.find("9router", active.id);
  if (refreshed) {
    try { await pi.setModel(refreshed); } catch { /* missing auth — ignore */ }
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
      // Fetch failed — fall back to cached models re-mapped with the current
      // reasoning flag so toggles still take effect when the endpoint is down.
      const cached = readModelCache();
      const models = cached ? cached.map((m) => mapModel(m, cfg.enableReasoning)) : [];
      modelIds = models.map((m) => m.id);
      registerProvider(pi, cfg, models);
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
      // ponytail: announce so other extensions (e.g. pi-plan's per-mode apply)
      // can retry deferred model switches now that 9router models are ready.
      pi.events.emit("9router:models-loaded", { provider: "9router", count: models.length });
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
    // Announce refreshed model list so other extensions (pi-plan per-mode apply)
    // can retry any deferred model switches.
    pi.events.emit("9router:models-loaded", { provider: "9router", count: modelIds.length });
  }

  // ── Registration ───────────────────────────────────────────────────────────

  registerLoginCommand(pi, () => config, () => modelIds, onConfigChange);

  // ── Session lifecycle ───────────────────────────────────────────────────────

  // On session start, refresh the active model pointer if it's a 9router model.
  // Re-selecting the same id+provider updates the model object's capability
  // flags (e.g. reasoning:true from enableReasoning) without emitting a
  // model_select event (Pi's modelsAreEqual guard), so it never corrupts
  // other extensions' per-mode model preferences.
  pi.on("session_start", async (_event, ctx) => {
    if (!config.baseUrl) {
      ctx.ui.notify("9router not configured — run /login-9router to connect.", "warning");
      return;
    }
    await refreshActiveModel(pi, ctx);
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
      // Models are ready synchronously from cache — announce immediately.
      pi.events.emit("9router:models-loaded", { provider: "9router", count: models.length });
      // Refresh in background to keep cache current.
      void startBackgroundDiscovery(config);
    } else {
      // No cache — register empty, discover in background.
      registerProvider(pi, config, []);
      void startBackgroundDiscovery(config);
    }
  }
}
