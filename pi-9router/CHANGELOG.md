# Changelog

All notable changes to `pi-9router` will be documented in this file.

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
