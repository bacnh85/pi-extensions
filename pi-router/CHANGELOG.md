# Changelog

## 1.1.5 (2026-09-06)

### Fixed

- **Router models reported `images: no` even when image content actually
  passes through, and `images: yes` on a route that silently strips it.**
  OmniRoute's `/v1/models` omits `capabilities.vision` on most non-openrouter
  connections and stamps it on openrouter entries regardless of upstream
  behavior — and `mapModel` trusted that flag verbatim. Live probes
  (`extensions/scripts/probe-vision.mjs`, sends a real image and checks the
  prompt-token delta + image-only answer) showed the metadata lies in both
  directions: `cmd/google/gemini-3.7-flash` and
  `cmd|command-code/deepseek/deepseek-v4-flash-vision-exp` pass images
  (Δ1071 / Δ215 prompt tokens) with no vision flag, while
  `openrouter/z-ai/glm-5.3-flash` (all effort/batch variants) claims
  `vision: true` but strips image parts (Δ16, model replied NOIMAGE).
  New `VISION_OVERRIDES` / `VISION_DOWNGRADES` tables + `resolveVision()` in
  `client.ts`: verified-passing routes gain `["text","image"]`, verified
  stripping routes are forced back to `["text"]`, everything else keeps
  router metadata. The offline restore path (`provider.ts`) re-resolves
  vision for persisted `models-store.json` entries, so stale caches self-heal
  without a network refresh.

### Added

- `extensions/scripts/probe-vision.mjs` — transport-verifies image passing
  per router model (PASS/STRIP/ERROR verdict from usage deltas). VISION
  table entries must be probe-backed; re-run when the router image updates.
  Probe findings 2026-09-06: glm-5.3-flash via glm-cn/glmcn/cmd/command-code/
  opencode/opencode-go/opencode-zen all STRIP (the old `images: no` listing
  was accidentally correct for them); `combo/glm-5.3-flash` PASSED (Δ1060)
  but is excluded from overrides — combo failover can land on a stripping
  member. `oc/*` returned 402 (missing opencode key in router config).

## 1.1.4 (2026-08-29)

### Added

- `/router-model` argument completion offers cached router model ids
  (populated by the first `/router-model` invocation).

## 1.1.3 — 2026-08-26

### Fixed

- **`/tree` branch summary and `/handoff` returned HTTP 400** when running
  router models served via the command-code upstream (e.g.
  `command-code/MiniMaxAI/MiniMax-M3`):
  `Invalid option: expected one of "low"|"medium"|"high"|"xhigh"|"max" at "params.reasoning_effort"`.
  The router's command-code executor forwards `reasoning_effort:"none"`
  untranslated and Command Code's API rejects anything outside
  `low|medium|high|xhigh|max`. Background summarization calls
  (`/tree` → `generateBranchSummary`, `/handoff` → `runIsolated` without
  `reasoning`) hit the SDK's no-level fallback which sends
  `thinkingLevelMap.off` verbatim; pi-router advertised `off:"none"` for
  the minimax format. New `NO_DISABLE_PREFIX` override in
  `getThinkingLevelMap`: model ids matching `/^(command-?code|cmd)[-/]/i`
  now have `off` and `minimal` mapped to `null` — Pi hides both levels in
  the UI and the SDK omits `reasoning_effort` entirely for no-level calls
  (upstream default, no 400). Identical bug class to pi-commandcode 0.1.4;
  same upstream, same error text. Scoped to command-code prefixes only —
  other upstreams (glm-cn, openai, etc.) keep `off:"none"`, which is
  OmniRoute's canonical disable vocabulary that other executors translate.

## 1.1.2 — 2026-08-26

### Fixed

- **`glm-cn/glm-5.3` showed 200K instead of 1M** (the user's exact case).
  Omniroute (a 9router fork) intermittently emits top-level
  `context_length: 200000, max_output_tokens: 128000` for unprofiled models
  — its `DEFAULT_CAPABILITIES` floor. `mapModel` previously trusted this
  pair as router truth (1.1.1 single-tier provenance) and bypassed
  `CONTEXT_OVERRIDES`. New pair-floor-poison gate: when both top-level
  fields are parseable AND at/below the 9router DEFAULT_CAPABILITIES floor
  (200K context, 128K output) AND a verified override exists at/above the
  floor for each, the override fires for both fields. Above-floor router
  values stay authoritative (preserves `openrouter/z-ai/glm-5.2:free = 256K`
  and `opencode-go/kimi-k3 = 1048576/1048576` from the inflation regression
  1.1.1 fixed). 1.1.1 single-tier back-compat (`Direction A`/`Direction B`
  tests) preserved by keeping "any present truthful field → override fully
  bypassed" as the default behavior.

### Added

- **`CONTEXT_OVERRIDES` extended** with verified models.dev entries for
  under-reported families on the user's omniroute (glm-cn / glmcn /
  opencode-go / nvidia / aug routes that lack top-level metadata):
  - `glm-5` / `glm-5.1` / `glm-5-turbo` / `glm-5v-turbo` → 200K / 128K
  - `glm-4.6` / `glm-4.7` → 200K / 128K
  - `kimi-k3` → 1M / 128K (specific pattern — `kimi-k2.7-code` real = 262K
    so a blanket override would inflate it; pi-commandcode 0.1.6 bug class
    avoided).
- **Live validation script** (`extensions/test/live-validation.ts`):
  `cd pi-router && PI_CODING_AGENT_DIR=/tmp/x npx tsx
  extensions/test/live-validation.ts` runs against the live `/v1/models`
  endpoint and asserts 14 representative models against models.dev truth
  (current pass rate: 14/14). One-shot verification, not part of
  `npm test` (network-dependent).

### Changed

- **`REQUEST_TIMEOUT_MS` 15s → 30s** (one line in `client.ts`): the live
  full-catalog fetch measures ~10s, leaving the previous 15s budget
  insufficient under load — aborted refreshes silently kept stale
  `models-store.json` entries (which is how the user's
  `glm-cn/glm-5.3 = 200K` persisted through several Pi restarts).

### Verified

- 41/41 unit tests (added 11 new tests covering the floor-aware gate, the
  pair-poison exception, and the 1.1.1 back-compat guards; all pre-existing
  tests pass unchanged).
- `npm run typecheck` clean.
- 14/14 live validation cases pass against the user's omniroute (172.30.55.22).

## 1.1.1 — 2026-08-25

### Fixed

- **Context window under-reported via router aggregation**: routers that
  forward OpenAI-compat upstream catalogs (e.g. omniroute) report context
  as top-level `context_length` / `max_output_tokens`, not
  `capabilities.contextWindow`. `mapModel` now reads `context_length` /
  `max_output_tokens` first (1508/1550 live models carry it), so
  `meta/muse-spark-1.2-contributor` and every other routed model no longer
  collapses to the 128K fallback. The on-disk `CONTEXT_OVERRIDES` table
  (fixes 9router's 200K floor for `glm-5.2`/`deepseek-v4`) now applies only
  to responses with NO top-level fields (a `null` or `undefined`
  `context_length`/`max_output_tokens` counts as absent) — it cannot inflate a
  router that truthfully reports a smaller `context_length`, and a partial
  presence of one top-level field never mixes a stale override into the other
  (provenance stays single-tier). It still intentionally overrides
  `capabilities.*` for 9router-shape routers until that table is refreshed.
  Same ordering as `pi-commandcode` 0.1.6.

## 1.1.0 — 2026-08-22

### Added

- **`/router-config`** — interactive settings panel (TUI) built on the shared
  `@bacnh85/pi-config-panel` kernel. Edit `router.baseUrl` and
  `router.enableReasoning` with arrow keys; Esc saves to `~/.pi/agent/settings.json`
  (merge, never clobber), re-registers the provider, forces a catalog refresh, and
  keeps the active model valid (`refreshActiveModel`). Warns when env vars or repo
  `.pi/settings.json` shadow the saved values. Non-TUI mode / `show` arg prints a
  config summary (endpoint, reasoning flag, masked key source).

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
