import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RouterSettings } from "./config.js";
import { fetchModels, mapModel, applyReasoning, type PiModel } from "./client.js";

export const PROVIDER_ID = "router";

/** Context Pi hands to refreshModels (RefreshModelsContext is not exported
 *  by the SDK's public surface — derive it from ProviderConfig's signature). */
export type RefreshCtx = NonNullable<Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0]>;

/** Register the router provider with dynamic model discovery via Pi's
 *  `refreshModels` contract:
 *  - Offline phase (startup, `allowNetwork: false`): return the persisted
 *    catalog from `~/.pi/agent/models-store.json` (`context.stored`), re-mapped
 *    with the current reasoning flag. The composer applies the return value
 *    in-memory — instant session restore, no network, and a reasoning toggle
 *    takes effect even when the endpoint is down.
 *  - Network phase: fetch `GET /v1/models`, map, return. We also persist via
 *    `context.publish({ persist })` so the next session restores from cache.
 *
 *  Auth: `apiKey: "$ROUTER_API_KEY"` — auth.json credential (from `/login router`)
 *  wins over the env var; provider is unconfigured only when both are absent.
 *
 *  Return-value contract (provider-composer.js): truthy return replaces the
 *  in-memory list; `undefined` keeps the current list untouched. */
export function registerProvider(pi: ExtensionAPI, settings: RouterSettings): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Router (OpenAI-compatible)",
    baseUrl: settings.baseUrl,
    apiKey: "$ROUTER_API_KEY",
    api: "openai-completions",
    models: [],
    // SDK type says Promise<ProviderModelConfig[]>, but the composer treats a
    // falsy return as "no change" (provider-composer.js `if (refreshed)`) —
    // returning undefined keeps the restored list. Runtime-verified.
    refreshModels: (async (context: RefreshCtx): Promise<ProviderModelConfig[] | undefined> => {
      const stored = context.stored?.models as PiModel[] | undefined;

      if (!context.allowNetwork || context.signal.aborted) {
        // Offline: restore persisted catalog, re-mapped with current reasoning flag.
        return stored?.length
          ? (stored.map((m) => applyReasoning(m, settings.enableReasoning)) as unknown as ProviderModelConfig[])
          : undefined;
      }

      const cred = context.credential as { type?: string; key?: string } | undefined;
      const raw = await fetchModels(settings, context.signal, cred?.key);
      if (context.signal.aborted) return undefined;
      const models = raw.map((m) => mapModel(m, settings.enableReasoning)) as unknown as ProviderModelConfig[];
      if (!models.length) return undefined; // keep restored models on empty fetch
      // persist entry is Model<Api>[] at runtime; our mapped shape is compatible
      // (composer clones and stores it verbatim — verified in models-store.json).
      await context.publish({ persist: { models: models as never } });
      // Late-loading signal for other extensions (pi-plan per-mode model retry).
      // Runs after all extensions registered their listeners, so this is safe.
      pi.events.emit("router:models-loaded", { provider: PROVIDER_ID, count: models.length });
      return models;
    }) as ProviderConfig["refreshModels"],
  });
}

export function unregisterProvider(pi: ExtensionAPI): void {
  pi.unregisterProvider(PROVIDER_ID);
}
