# Changelog

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
