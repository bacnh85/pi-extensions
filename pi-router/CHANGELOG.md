# Changelog

## 1.0.1 — 2026-08-22

Review fixes:
- Model discovery no longer doubles the `/v1` path segment when `router.baseUrl`
  already ends in `/v1` (GET `…/v1/models`, not `…/v1/v1/models`).
- Discovery now sends the `/login router` credential (auth.json) as the
  Bearer token via `RefreshModelsContext.credential`; `ROUTER_API_KEY` /
  `NINE_ROUTER_API_KEY` env remain the fallback when no credential is stored.
- Claude thinking-format detection: version parsed from the leading
  major[.-]minor token — `claude-3-5`/`claude-3-7` are budget (not adaptive),
  `claude-4-6`/`claude-opus-4.6`/`claude-sonnet-5` are adaptive.
- Migration never overwrites an unparseable settings.json/auth.json (bails and
  retries next load instead of wiping with a `{}` seed); rename is race-safe
  across concurrent Pi sessions; the whole migration is guarded in the
  extension factory so an fs error can't kill provider registration.
- `/router-reasoning` reports the effective flag (env/repo override detected).
- LICENSE file included in the published tarball.

## 1.0.0 — 2026-08-21

Renamed from `@bacnh85/pi-9router` and generalized to any OpenAI-compatible
router (9router, omniroute, …). Provider id: `router` (models appear as
`router/…`).

### Breaking changes

- Provider id changed `9router` → `router`; update any `9router/…` model ids.
- `/login-9router`, `/9router-status|model|reasoning` removed — use
  `/login router` (built-in), `/router-status`, `/router-model`,
  `/router-reasoning`.
- Config file `~/.pi/agent/9router-config.json` no longer read — migrated
  automatically on first load (file renamed `.migrated`), then settings live in:
  - settings.json → `router.baseUrl`, `router.enableReasoning`
  - auth.json → `router` credential (via `/login router`)
- Event `9router:models-loaded` renamed `router:models-loaded` (pi-plan
  updated accordingly).

### Added

- Pi-native model discovery: `refreshModels` fetches `GET /v1/models` and
  persists the catalog to `~/.pi/agent/models-store.json` — cached across
  sessions, restores offline, no custom cache files.
- Built-in `/login router` support (API key in auth.json, standard api-key flow).
- One-shot migration from pi-9router config (see README).

### Removed

- Manual background discovery + `~/.cache/pi/9router-models.json` cache
  (~80 lines) — replaced by Pi's models-store.

Earlier history under the `pi-9router` name: see the old package (v0.1.x).
