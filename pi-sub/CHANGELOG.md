## 0.1.32 (2026-08-22)

- **DeepSeek via OmniRoute now shows the real USD balance** (e.g. `M:$18.25`)
  instead of the misleading aggregate windows (R:100%/5H W:0%/2D). Credit-based
  upstreams report "Unavailable" session/weekly in the usage text; pi-sub now
  recognizes that shape and fetches `credits_usd` from the management usage
  API. Needs `ROUTER_MGMT_TOKEN` (an `oma_` CLI token or manage-scope key) in
  env / `~/.pi/agent/.env.local`; without it, the footer degrades to the clean
  endpoint display (no aggregate leak).
- The plain-retry fallback (drop `?provider=`) now fires only on "No cached
  usage data" (wrong/unknown slug), not on "Unavailable" windows.
- pi-sub now reads `.env.local`/`.env` (cwd then `~/.pi/agent`) for its own
  env vars — same discovery chain as pi-munin, stdlib parser, no deps.

## 0.1.31 (2026-08-22)

- **Fixed glm-cn quota via OmniRoute**: OmniRoute's connection slug for the
  Z.ai (CN) upstream is `glm-cn`, not `zai-coding-cn` (a Pi provider id).
  Wrong slug returned "No cached usage data", so the plain-retry fallback
  showed the aggregate snapshot (e.g. R:100% W:0%) instead of the Z.ai windows.
  Alias `glmcn` now maps to the correct slug; footer shows `R:99%/3H`-style
  windows matching the direct Z.ai display.
- OmniRoute "reset in 2h 55m" countdowns are now converted into compact
  footer labels (`/3H`), and "Unavailable" windows are skipped (previously
  `0%`-style aggregates leaked in via the fallback).

## 0.1.30 (2026-08-22)

- Router usage is now **provider-scoped**: the active router model's upstream
  prefix (e.g. `command-code` from `router/command-code/deepseek/deepseek-v4-flash`)
  is passed as `?provider=` to the OmniRoute usage API, so the footer shows that
  upstream's quota (e.g. opencode-go session/weekly windows).
- Aliases normalized before the API call: `cmd`→`command-code`, `oc`→`opencode-go`,
  `ds`→`deepseek`, `glmcn`/`glm-cn`→`zai-coding-cn`; generic router aliases
  (auto/aug/no-think/tllm/combo/openrouter/nvidia/…) are filtered out.
- When the selected upstream has no cached quota ("No cached usage data"),
  the adapter retries without `?provider=` so the footer still shows the best
  snapshot instead of empty windows.
- Switching between router models with different upstreams now refreshes
  immediately (adapter id includes the prefix, so stale in-flight results are
  discarded via the generation guard).
- `/sub` breakdown shows only the Provider quota section — personal USD budget
  lines are no longer surfaced.
- Self-check extended (17 assertions) and now exercises the real
  `routerUpstreamPrefix` (aliases + generic filter).

## 0.1.27 (2026-08-22)

- Router adapter now fetches real usage from OmniRoute instances: GET
  `<origin>/api/usage/om-usage` (Bearer = router API key from auth.json or
  ROUTER_API_KEY env). The plain-text report (Personal quota Daily/Weekly +
  Provider quota Session/Weekly) is parsed into the footer R:/W: windows.
  Non-OmniRoute routers 404 → fall back to the endpoint-only display.
  When the per-key usage command is disabled, the footer shows a hint to
  enable it in the OmniRoute dashboard (API Keys → the key).
- New pure parser `parseOmniUsageText` with an env-gated self-check
  (PI_SUB_SELF_CHECK=1) — pi-sub stays pack-only for CI.

## 0.1.26 (2026-08-21)

- Router adapter: reads `router.baseUrl` from `~/.pi/agent/settings.json`
  (env `ROUTER_BASE_URL`/`NINE_ROUTER_BASE_URL`) now that pi-router moved the
  endpoint URL out of the old `9router-config.json` (which is migrated away on
  pi-router load). Footer shows for both new `router/` and legacy `9router/`
  provider models.

# Changelog

## 0.1.29 (2026-08-15)

### Features

- **tok/s speed now shown for all providers.** Previously the footer was cleared
  for providers without a subscription adapter (e.g. `ollama`); now the last
  response speed renders as a standalone `145 tok/s` line, and `/sub` reports
  provider/model plus last and session-average speed instead of only
  "tracking inactive".

## 0.1.28 (2026-08-09)

### Improvements

- **Command Code monthly balance now shown in the footer.** The footer adds a
  compact `M:$X.XX` segment (monthly credit balance from
  `/alpha/billing/credits`) next to the 5-hour/weekly windows, e.g.
  `(Command Code key#…) R:100%/5H W:100%/7D M:$69.99`. The `/sub` detail view
  keeps the `Monthly: $X remaining` breakdown line.

## 0.1.27 (2026-08-09)

### Features

- **Command Code now shows live usage windows.** The adapter fetches
  `https://api.commandcode.ai/alpha/billing/credits` with the same Provider
  API key used for `/provider/v1` models and renders the 5-hour and weekly
  rolling windows (USD used/cap, remaining% + reset countdown) plus a
  `Monthly: $X remaining` balance line — matching what the `cmd /usage` CLI
  shows. Previously the footer showed session cost only.

## 0.1.26 (2026-08-09)

### Features

- Added Command Code (`commandcode`) provider support. When a `commandcode`
  model is active, the footer shows the account label plus session cost and
  tok/s, and `/sub` reports the provider. Command Code's Provider API does not
  expose usage windows via its API key (the rolling-window data is
  web-session-cookie only), so live 5h/weekly meters are not shown — behavior
  matches `opencode-go` and `9router`.

## 0.1.25 (2026-08-07)

### Improvements

- Widen peer dependency range to support Pi 0.84.0 (`>=0.80.8 <0.85.0`).
  No code changes — verified compatible against the 0.84.0 SDK types.

## 0.1.24 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

All notable changes to `pi-sub` will be documented in this file.

## 0.1.23 (2026-07-30)

### Improvements

- Widen Pi peer dependency range to <0.84.0 for Pi 0.83.0 compatibility.

## 0.1.22 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.1.21 (2026-07-24)

### Features

- Added 9router adapter for tokens per second (tok/s) and endpoint display.
- Cleared stale context on session shutdown to prevent crashes on `/new`.

## 0.1.15 (2026-07-16)

### Features

- Added `zai-coding-cn` (Z.ai China / open.bigmodel.cn) usage monitoring.
- Surfaced Z.ai MCP/month + per-model usage in `/sub` detail view.

## 0.1.10 (2026-07-10)

### Features

- Added tok/s (tokens per second) display for response speed tracking.

## 0.1.0 (2026-07-05)

### Features

- Initial release of `pi-sub` subscription usage footer extension.
