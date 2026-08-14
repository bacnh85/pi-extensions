# Changelog

## 0.1.8 (2026-08-14)

### Fixes

- **GLM-5.3 context override.** Widened the `CONTEXT_OVERRIDES` pattern from `/glm-5\.2/` to `/glm-5\.[23](?!\d)/` so GLM-5.3 reports its 1M context window instead of falling to 9router's 200K default floor. GLM-5.3 is text-only, 1M context, 128K output — same profile as GLM-5.2. The negative lookahead keeps future GLM-5.4+ (unverified profile) off the override.

## 0.1.7 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

All notable changes to `pi-9router` will be documented in this file.

## 0.1.6 (2026-07-31)

### Fixes

- **No longer reverts to a localhost test URL when unconfigured.** Previously, a missing/corrupt config silently fell back to `http://localhost:20128/v1` (a dev port) with no API key, registering a provider against an unreachable endpoint. `getEffectiveConfig()` now returns an empty `baseUrl`, the provider is skipped, and `session_start` notifies "run /login-9router".
- **Migrated stale `enableReasoning: false` to `true`.** Legacy configs (saved before `configVersion` existed) held a `false` value from the old default, and `?? true` in `getEffectiveConfig()` did not rescue an explicit `false` (`false ?? true === false`) — so reasoning controls (Shift+Tab, `:high`) stayed permanently hidden. `loadConfig()` now resets reasoning to ON for legacy configs and stamps a `configVersion` on save. Current-version configs with an explicit `false` are still respected.
- **Toggle works even when the endpoint is unreachable.** `/9router-reasoning` re-fetches models; on fetch failure it previously re-registered with an empty model list, so `refreshActiveModel` found nothing and the toggle silently no-op'd. `applyProvider` now falls back to the cached model list re-mapped with the new reasoning flag.
- `/9router-status` now hints `/9router-reasoning` when reasoning is OFF.

## 0.1.5 (2026-07-30)

### Fixes

- **Removed `forceModelRefresh` and its `model_select` handler.** The switch-away-and-back dance emitted unguarded `model_select` events that corrupted other extensions' per-mode model preferences (notably pi-plan). The same-id re-select (`refreshActiveModel`) now updates capability flags without emitting any `model_select` event.
- **Emit `9router:models-loaded` event** on the shared `pi.events` bus whenever 9router models become available (disk cache, background discovery, and config change). This lets late-loading-aware extensions (pi-plan) retry deferred model switches immediately instead of polling.

## 0.1.4 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.1.3 (2026-07-24)

### Fixes

- Fixed context window overrides for under-reported model schemas returned by 9router proxies.

## 0.1.0 (2026-07-16)

### Features

- Added 9router extension connecting Pi to 9router AI routing proxy instance via OpenAI-compatible API.
- Registered `/login-9router`, `/9router-reasoning`, and `/9router-status` commands.
