# Changelog

## 0.1.5 (2026-08-14)

### Fixes

- **GLM-5.3 support.** Widened the context override and thinking-format
  detection from `/glm-5\.2/` to `/glm-5\.[23](?!\d)/` (1M context, 131,072 max
  tokens) so GLM-5.3 gets the zai single-tier map instead of the full OpenAI set.
  Without the format fix, GLM-5.3 would send `reasoning_effort:
  "low"/"medium"/"xhigh"` — values the GLM API rejects with HTTP 400 (the bug
  class fixed in 0.1.3/0.1.4). Added an explicit `zai-org/glm-5.3` capabilities
  entry (text-only, reasoning). The negative lookahead keeps future GLM-5.4+
  (unverified profile) on the generic 200K floor and openai format.

## 0.1.4 (2026-08-11)

### Fixes

- **Hide `off`/`minimal` thinking levels: they sent invalid `reasoning_effort`
  values and caused HTTP 400.** Command Code's `reasoning_effort` only accepts
  `low|medium|high|xhigh|max` — there is no disable value. Unlike pi-core's
  deepseek format (which sends `thinking:{type:"disabled"}` to turn reasoning
  off), the generic OpenAI `reasoning_effort` path used by this extension maps
  `off` verbatim, so the previous `off:"none"` (and `minimal:"minimal"`) were
  forwarded and rejected with `Invalid option: expected one of
  "low"|"medium"|"high"|"xhigh"|"max"`. Every map now sets `off:null` and
  `minimal:null` (hidden in the Pi UI); selecting "off" omits `reasoning_effort`
  entirely (the upstream default) instead of sending an invalid string.

## 0.1.3 (2026-08-11)

### Fixes

- **Accurate per-model reasoning levels via `thinkingLevelMap`.** Every
  reasoning-capable model previously advertised Pi's default thinking levels
  (off/minimal/low/medium/high) and Pi forwarded unsupported `reasoning_effort`
  values (e.g. `low`/`medium`) to Command Code, where DeepSeek V4 only accepts
  `high`/`max` (low/medium normalize to high, xhigh maps to max). `mapModel`
  now attaches a per-family `thinkingLevelMap` derived from the upstream effort
  set (mirrors pi-9router's `FORMAT_TO_LEVEL_MAP` and pi-core's built-in
  catalogs): DeepSeek V4 → high/max, GLM-5.2 → single tier (low/medium/high all
  map to `high`), Kimi K2.7/K3 → low/high/max (thinking cannot be disabled),
  GPT-5.6-sol → full set with native `max`, Qwen/Step/Hy3 → low/medium/high,
  everything else (GPT, Gemini, Grok, Claude, unknown) → full OpenAI-style set.
  Non-reasoning models stay map-less (Pi shows only `off`). The map constant is
  typed with literal level keys so typos fail at compile time.

## 0.1.2 (2026-08-11)

### Fixes

- **Accurate per-model vision + reasoning capabilities.** The Provider API
  (`GET /provider/v1/models`) returns no capability data (only id/name/context),
  so `mapModel` previously hardcoded `reasoning: true` for every model and never
  advertised vision — all 52 models showed as text-only with reasoning on.
  `mapModel` now resolves both vision and reasoning from a documented override
  table sourced 1:1 from the Command Code docs caps registry
  (`https://commandcode.ai/docs/reference/cli/models`): ~37 models now correctly
  advertise image input (Claude family, Gemini, GPT-5.x, Kimi K2.7/K3, Grok,
  Qwen 3.6-Plus/3.7-Flash/3.7-Plus/3.8, …) and ~11 correctly report reasoning off
  (Claude Haiku 4.5 & Sonnet 4.6, Kimi K2.5/K2.6, MiMo, GLM-5/5.1, MiniMax M2.x).
  An explicit API `capabilities.vision`/`capabilities.reasoning` (if ever added)
  still wins over the table (forward-compat).
- **Display name.** `mapModel` now uses the API's human-readable `name` field
  (e.g. "GLM-5.2") when present, falling back to the raw id.

## 0.1.1 (2026-08-09)

### Fixes

- **Provider baseUrl now includes `/v1`**, fixing a 404 on chat completions.
  The provider was registered with `https://api.commandcode.ai/provider`, so
  Pi's OpenAI-completions client POSTed to `…/provider/chat/completions`
  (non-existent) instead of `…/provider/v1/chat/completions`. Model discovery
  was already correct because it added `/v1` itself; the fix moves `/v1` into
  the shared `DEFAULT_BASE_URL` and makes `fetchModels` append only `/models`.
  Added a request-URL assertion to lock this in.

## 0.1.0 (2026-08-09)

### Features

- Added Command Code extension connecting Pi to Command Code's OpenAI-compatible
  Provider API (`https://api.commandcode.ai/provider`).
- Registered the `commandcode` provider with dynamic model discovery via
  `GET /provider/v1/models` and a disk cache for instant session restore.
- Relies on Pi's built-in `/login` flow for API-key setup (no dedicated slash
  command). `COMMAND_CODE_API_KEY` env var also supported for CI/headless.
