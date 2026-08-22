import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettings } from "./lib/config.js";
import { migrateLegacyConfig } from "./lib/migrate.js";
import { registerProvider, unregisterProvider, PROVIDER_ID } from "./lib/provider.js";
import { registerCommands } from "./commands/commands.js";

/** Re-select the active router model so Pi picks up refreshed capability
 *  flags (e.g. reasoning after a toggle). Safe: id+provider are unchanged, so
 *  Pi's modelsAreEqual guard suppresses the model_select event and per-mode
 *  model preferences of other extensions are untouched. */
export async function refreshActiveModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const active = ctx.model;
  if (active?.provider !== PROVIDER_ID || !active.id) return;
  const refreshed = ctx.modelRegistry.find(PROVIDER_ID, active.id);
  if (refreshed) {
    try { await pi.setModel(refreshed); } catch { /* missing auth — ignore */ }
  }
}

export default function (pi: ExtensionAPI) {
  // One-shot migration from pi-9router's config file → settings.json + auth.json.
  // Guarded: any fs failure (EACCES, lost race) must never kill provider registration.
  try {
    migrateLegacyConfig();
  } catch { /* non-fatal — retried on next load */ }

  const settings = getSettings();
  if (settings.baseUrl) {
    registerProvider(pi, settings);
  }

  registerCommands(pi, () => getSettings());

  pi.on("session_start", async (_event, ctx) => {
    const s = getSettings();
    if (!s.baseUrl) {
      ctx.ui.notify(
        "router provider not configured — set `router.baseUrl` in ~/.pi/agent/settings.json (or ROUTER_BASE_URL), then /login router.",
        "warning",
      );
      return;
    }
    await refreshActiveModel(pi, ctx);
  });
}

export { unregisterProvider };
