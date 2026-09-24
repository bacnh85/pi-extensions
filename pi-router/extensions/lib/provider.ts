import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RouterSettings } from "./config.js";
import { fetchModels, mapModel, applyReasoning, resolveVision, type PiModel } from "./client.js";

export const PROVIDER_ID = "router";

/** Freshness window for the persisted catalog: within it, maybeRefreshCatalog
 *  treats the stored models as fresh and skips the network fetch. */
export const ROUTER_MODELS_TTL_MS = 15 * 60_000;

/** Unix ms of the last completed network fetch (persisted as `checkedAt`,
 *  mirroring Pi's own remote-catalog convention). Undefined = never fetched
 *  or legacy store without the field → treated as stale so the next
 *  maybeRefreshCatalog backfills it. */
let lastFetchedAt: number | undefined;

/** Shared in-flight refresh — concurrent callers await the same operation
 *  instead of stacking generations that supersede each other (pi-ai drops
 *  publications from superseded generations). */
let inflight: Promise<void> | undefined;

/** Test hook: reset freshness + in-flight state between tests. */
export function resetCatalogState(): void {
  lastFetchedAt = undefined;
  inflight = undefined;
}

/** Age of the persisted catalog, or undefined when unknown (legacy/absent). */
export function catalogAgeMs(): number | undefined {
  return lastFetchedAt === undefined ? undefined : Date.now() - lastFetchedAt;
}

/** TTL-gated, in-flight-guarded provider-scoped refresh. The only call site
 *  that reaches the network for router models in RPC/print/headless modes
 *  (Pi itself only network-refreshes from the TUI /model picker). Skips when
 *  PI_OFFLINE is set or the catalog is fresh (unless force).
 *
 *  Force semantics: force with a refresh in flight does NOT join it — a join
 *  would silently return the OLD endpoint's fetch right after a baseUrl flip
 *  and leave the new catalog unpulled for a full TTL. Instead the in-flight
 *  job is superseded and the forced fetch proceeds. Non-force joins. */
export function maybeRefreshCatalog(
  ctx: { modelRegistry: { refresh(options?: { providers?: string[]; force?: boolean }): Promise<unknown> } },
  opts?: { force?: boolean },
): Promise<void> {
  if (opts?.force === true) {
    // Supersede the in-flight job (if any): its finally sees
    // inflight !== job.p and skips the clear; the registry's per-provider
    // generation guard aborts the stale fetch (refreshControllers).
    inflight = undefined;
  } else if (inflight) {
    return inflight;
  }
  if (process.env.PI_OFFLINE) return Promise.resolve();
  if (!opts?.force && lastFetchedAt !== undefined && Date.now() - lastFetchedAt < ROUTER_MODELS_TTL_MS) {
    return Promise.resolve();
  }
  // Holder object: the finally clause must reference the promise while TS's
  // definite-assignment analysis can't see the IIFE-to-let assignment order.
  const job = { p: undefined as unknown as Promise<void> };
  job.p = (async () => {
    try {
      await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: opts?.force === true ? true : undefined });
    } finally {
      if (inflight === job.p) inflight = undefined;
    }
  })();
  inflight = job.p;
  return job.p;
}

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
      // Freshness for maybeRefreshCatalog; backfilled on restore for legacy
      // stores that predate the checkedAt field.
      const checkedAt = (context.stored as { checkedAt?: number } | undefined)?.checkedAt;

      if (!context.allowNetwork || context.signal.aborted) {
        if (checkedAt !== undefined) lastFetchedAt = checkedAt;
        // Offline: restore persisted catalog, re-mapped with current reasoning
        // flag. Vision is re-resolved so stale persisted flags self-heal —
        // /v1/models vision metadata lies in both directions (see client.ts
        // VISION_OVERRIDES/VISION_DOWNGRADES) and old caches froze it verbatim.
        return stored?.length
          ? (stored
              // Array.isArray guards legacy/malformed store entries (treated as text-only).
              .map((m) => ({ ...m, input: resolveVision(m.id, Array.isArray(m.input) && m.input.includes("image")) ? ["text", "image"] : ["text"] }) as PiModel)
              .map((m) => applyReasoning(m, settings.enableReasoning)) as unknown as ProviderModelConfig[])
          : undefined;
      }

      const cred = context.credential as { type?: string; key?: string } | undefined;
      const raw = await fetchModels(settings, context.signal, cred?.key);
      if (context.signal.aborted) return undefined;
      const models = raw.map((m) => mapModel(m, settings.enableReasoning)) as unknown as ProviderModelConfig[];
      if (!models.length) return undefined; // keep restored models on empty fetch
      lastFetchedAt = Date.now();
      // persist entry is Model<Api>[] at runtime; our mapped shape is compatible
      // (composer clones and stores it verbatim — verified in models-store.json).
      // checkedAt survives restarts so freshness is known across sessions.
      await context.publish({ persist: { models: models as never, checkedAt: lastFetchedAt } });
      // Late-loading signal for other extensions (pi-plan per-mode model retry).
      // Runs after all extensions registered their listeners, so this is safe.
      pi.events.emit("router:models-loaded", { provider: PROVIDER_ID, count: models.length });
      return models;
    }) as ProviderConfig["refreshModels"],
  });
}

