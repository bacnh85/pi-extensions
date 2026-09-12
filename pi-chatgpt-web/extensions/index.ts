import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChatGptWebConfig } from "./lib/config.js";
import { getEffectiveConfig, getEffectiveCodexConfig } from "./lib/config.js";
import { fetchModels, mapModel, mapCodexModel, type ChatGptWebModelRaw } from "./lib/client.js";
import {
  registerProvider, unregisterProvider,
  registerCodexProvider, unregisterCodexProvider,
  PROVIDER_ID, CODEX_PROVIDER_ID,
} from "./lib/provider.js";
import { registerCommands } from "./commands/login.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Short timeout for background discovery — Pi never blocks startup on a
 *  slow or unreachable bridge. */
const STARTUP_DISCOVERY_TIMEOUT_MS = 5_000;

const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi");
const MODEL_CACHE_PATH = join(CACHE_DIR, "chatgpt-web-models.json");
const CODEX_MODEL_CACHE_PATH = join(CACHE_DIR, "codex-web-models.json");

/** Bridge 502/403 signature when the account pool is empty — normalize so the
 *  user sees an actionable hint instead of a cryptic upstream error. Does not
 *  touch overflow patterns (context_length_exceeded stays untouched). */
function isUpstreamPoolFailure(errorMessage: string): boolean {
  return errorMessage.includes("upstream_error")
    || errorMessage.includes("backend-anon")
    || errorMessage.includes("backend-api/conversation failed");
}

// ── Model cache ──────────────────────────────────────────────────────────────

function readModelCache(path: string): ChatGptWebModelRaw[] | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    // ponytail: validate just the first entry's shape — if it has an id, trust the rest
    if (!raw[0] || typeof (raw[0] as Record<string, unknown>).id !== "string") return null;
    return raw as ChatGptWebModelRaw[];
  } catch {
    return null;
  }
}

function writeModelCache(path: string, models: ChatGptWebModelRaw[]): void {
  if (models.length === 0) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(models) + "\n", { mode: 0o600 });
  } catch {
    // cache write failure is non-fatal — next startup just falls back to fetch
  }
}

export async function refreshActiveModel(
  pi: ExtensionAPI, ctx: ExtensionContext,
): Promise<void> {
  const active = ctx.model;
  if ((active?.provider !== PROVIDER_ID && active?.provider !== CODEX_PROVIDER_ID) || !active.id) return;
  const refreshed = ctx.modelRegistry.find(active.provider, active.id);
  if (refreshed) {
    try { await pi.setModel(refreshed); } catch { /* missing auth — ignore */ }
  }
}

// ── Shared provider lifecycle ────────────────────────────────────────────────

interface ProviderWiring {
  providerId: string;
  cachePath: string;
  register: (pi: ExtensionAPI, cfg: ChatGptWebConfig, models: ReturnType<typeof mapModel>[]) => void;
  unregister: (pi: ExtensionAPI) => void;
  mapModel: (raw: ChatGptWebModelRaw) => ReturnType<typeof mapModel>;
}

function wireProvider(pi: ExtensionAPI, wiring: ProviderWiring) {
  let modelIds: string[] = [];
  let discoveryGen = 0;

  async function applyProvider(cfg: ChatGptWebConfig) {
    wiring.unregister(pi);
    if (!cfg.baseUrl) return;
    try {
      const raw = await fetchModels(cfg);
      writeModelCache(wiring.cachePath, raw);
      const models = raw.map(wiring.mapModel);
      modelIds = models.map((m) => m.id);
      wiring.register(pi, cfg, models);
    } catch {
      // Fetch failed — fall back to cached models so the provider stays usable
      // while the bridge is temporarily down.
      const cached = readModelCache(wiring.cachePath);
      const models = cached ? cached.map(wiring.mapModel) : [];
      modelIds = models.map((m) => m.id);
      wiring.register(pi, cfg, models);
    }
  }

  async function startBackgroundDiscovery(cfg: ChatGptWebConfig): Promise<void> {
    const gen = ++discoveryGen;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), STARTUP_DISCOVERY_TIMEOUT_MS);
      timer.unref?.();

      const raw = await fetchModels(cfg, controller.signal);
      clearTimeout(timer);

      if (gen !== discoveryGen) return; // stale — a newer discovery started

      writeModelCache(wiring.cachePath, raw);
      const models = raw.map(wiring.mapModel);
      modelIds = models.map((m) => m.id);

      wiring.unregister(pi);
      wiring.register(pi, cfg, models);
      pi.events.emit(`${wiring.providerId}:models-loaded`, { provider: wiring.providerId, count: models.length });
    } catch {
      if (gen !== discoveryGen) return;
      // Discovery failed — keep cached or empty model list; retry via /login-*.
    }
  }

  async function onConfigChange(newConfig: ChatGptWebConfig) {
    await applyProvider(newConfig);
    pi.events.emit(`${wiring.providerId}:models-loaded`, { provider: wiring.providerId, count: modelIds.length });
  }

  function startup(cfg: ChatGptWebConfig) {
    if (!cfg.baseUrl) return;
    const cached = readModelCache(wiring.cachePath);
    if (cached) {
      const models = cached.map(wiring.mapModel);
      modelIds = models.map((m) => m.id);
      wiring.register(pi, cfg, models);
      pi.events.emit(`${wiring.providerId}:models-loaded`, { provider: wiring.providerId, count: models.length });
      void startBackgroundDiscovery(cfg);
    } else {
      wiring.register(pi, cfg, []);
      void startBackgroundDiscovery(cfg);
    }
  }

  return { getModelIds: () => modelIds, onConfigChange, startup };
}

// ── Extension factory ────────────────────────────────────────────────────────
// IMPORTANT: Do NOT await a network call in the factory. Pi awaits the factory
// before continuing startup, so a blocking fetch would hang the UI. Load from
// disk cache (instant) or register with empty models, then discover in the
// background and re-register when complete.

export default async function (pi: ExtensionAPI) {
  const chatWiring = wireProvider(pi, {
    providerId: PROVIDER_ID,
    cachePath: MODEL_CACHE_PATH,
    register: registerProvider,
    unregister: unregisterProvider,
    mapModel,
  });
  const codexWiring = wireProvider(pi, {
    providerId: CODEX_PROVIDER_ID,
    cachePath: CODEX_MODEL_CACHE_PATH,
    register: registerCodexProvider,
    unregister: unregisterCodexProvider,
    mapModel: mapCodexModel,
  });

  registerCommands(
    pi,
    () => getEffectiveConfig(), () => chatWiring.getModelIds(), (c) => chatWiring.onConfigChange(c),
    () => getEffectiveCodexConfig(), () => codexWiring.getModelIds(), (c) => codexWiring.onConfigChange(c),
  );

  // Surface empty-account-pool failures (502 upstream_error) as an actionable
  // hint instead of a raw gateway error. Scoped to our providers only.
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    const isOurs = message.provider === PROVIDER_ID
      || message.provider === CODEX_PROVIDER_ID
      || ctx.model?.provider === PROVIDER_ID
      || ctx.model?.provider === CODEX_PROVIDER_ID;
    if (!isOurs) return;
    const errorMessage = message.errorMessage ?? "";
    if (!isUpstreamPoolFailure(errorMessage)) return;

    return {
      message: {
        ...message,
        errorMessage: `${message.provider} bridge upstream failed (likely no logged-in account / empty account pool — check the bridge admin panel): ${errorMessage}`,
      },
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const chatConfig = getEffectiveConfig();
    const codexConfig = getEffectiveCodexConfig();
    if (!chatConfig.baseUrl) {
      ctx.ui.notify("chatgpt-web not configured — run /login-chatgpt-web to connect.", "warning");
    } else {
      await refreshActiveModel(pi, ctx);
    }
    if (!codexConfig.baseUrl) {
      ctx.ui.notify("codex-web not configured — run /login-codex-web to connect.", "warning");
    } else {
      await refreshActiveModel(pi, ctx);
    }
  });

  chatWiring.startup(getEffectiveConfig());
  codexWiring.startup(getEffectiveCodexConfig());
}
