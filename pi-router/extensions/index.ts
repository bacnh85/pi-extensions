import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettings } from "./lib/config.js";
import { migrateLegacyConfig } from "./lib/migrate.js";
import { registerProvider, maybeRefreshCatalog, PROVIDER_ID } from "./lib/provider.js";
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
  // Base URL the currently-registered provider was built with — session_start
  // compares against it to detect a trust-gated repo override (see below).
  let registeredBaseUrl = "";

  // One-shot migration from pi-9router's config file → settings.json + auth.json.
  // Guarded: any fs failure (EACCES, lost race) must never kill provider registration.
  try {
    migrateLegacyConfig();
  } catch { /* non-fatal — retried on next load */ }

  // Load-time settings: env + global ONLY (no repo scope — no ctx/trust yet,
  // and an untrusted checkout must not own the endpoint the auth key goes to).
  const settings = getSettings();
  registeredBaseUrl = settings.baseUrl;
  if (settings.baseUrl) {
    registerProvider(pi, settings);
  }

  registerCommands(pi);

  // Periodic catalog pull: TTL gate makes this a no-op while the catalog is
  // fresh, a fetch when it ages out. Catches mid-session endpoint additions.
  // Uses the latest session ctx (ExtensionAPI carries no modelRegistry).
  // ponytail: 5-min tick + 15-min TTL constants, no env knob until asked.
  let lastCtx: ExtensionContext | undefined;
  const periodicRefresh = setInterval(() => {
    if (!lastCtx) return;
    void maybeRefreshCatalog(lastCtx).catch(() => { /* transient — next tick retries */ });
  }, 5 * 60_000);
  periodicRefresh.unref?.();

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    // Now ctx exists: trust-gate the repo scope. A trusted repo may add/override
    // the endpoint; an untrusted one is ignored (attacker-redirect guard).
    const s = getSettings({ trustProject: ctx.isProjectTrusted?.() === true });
    if (!s.baseUrl) {
      ctx.ui.notify(
        "router provider not configured — set `router.baseUrl` in ~/.pi/agent/settings.json (or ROUTER_BASE_URL), then /login router.",
        "warning",
      );
      return;
    }
    // Repo scope flipped the endpoint: re-register + refresh exactly like the
    // /router-config panel save path so discovery/chat hit the new URL.
    if (s.baseUrl !== registeredBaseUrl) {
      registeredBaseUrl = s.baseUrl;
      registerProvider(pi, s);
      // New endpoint — bypass TTL so the first pull is immediate.
      try { await maybeRefreshCatalog(ctx, { force: true }); } catch { /* surfaced by Pi elsewhere */ }
    }
    await refreshActiveModel(pi, ctx);
    // Automatic network pull in EVERY mode — Pi only network-refreshes from
    // the TUI /model picker (agent-session-services.js forces allowNetwork:
    // false), so RPC/print/headless sessions would otherwise keep serving the
    // stale models-store.json for the whole session. Fire-and-forget: never
    // blocks session start; TTL + in-flight guard make repeats cheap.
    void maybeRefreshCatalog(ctx)
      .then(() => refreshActiveModel(pi, ctx))
      .catch(() => { /* transient — timer/session end retries */ });
  });

  // Stop the interval from refreshing with a dead session's registry after
  // quit/reload/session replacement (review finding 4).
  pi.on("session_shutdown", () => { lastCtx = undefined; });
}

