# Changelog

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
