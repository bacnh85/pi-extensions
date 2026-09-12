# Changelog

## 0.2.1 (2026-09-12)

### Fixed

- **The bundled skill now ships.** `skills/` was missing from `files[]` and the
  pi manifest, so the published package never carried
  `skills/chatgpt-web/SKILL.md`.
- **Stale config closure.** The extension factory snapshotted
  `getEffectiveConfig()` / `getEffectiveCodexConfig()` once at startup;
  `/login-chatgpt-web` saves were invisible to status output and session_start
  warnings until restart. Commands now read live getters.
- **`/chatgpt-web-status` account pool health.** The README/SKILL claimed the
  status command reports account pool health but it never called
  `fetchAccountPool`. Now wired in (best-effort: shows "unavailable" when the
  pool endpoint doesn't respond, warns on an empty pool). codex-web status is
  unaffected (codex-proxy has no pool monitor).
- Removed unused `typebox` peer dependency.

## 0.2.0 — 2026-08-20

**New provider: `codex-web` — tool-capable ChatGPT models via codex-proxy.**
Homelab-deployed [icebear0828/codex-proxy](https://github.com/icebear0828/codex-proxy)
(`http://172.30.55.22:8086/v1`, Quadlet, vault key `vault_codex_proxy_api_key`)
provides native function calling through the Codex Responses backend —
file access, shell, edits all work, unlike the chat-only `chatgpt-web` provider.

- Config: `CODEX_WEB_BASE_URL` / `CODEX_WEB_AUTH_KEY` (full env-file chain),
  saved to `~/.pi/agent/codex-web-config.json`, default homelab proxy URL.
- Models (gpt-5.5/5.4/5.4-mini/5.3-codex/5.2/5-codex/oss): reasoning +
  thinkingLevelMap (off→low — Codex always reasons), real context windows
  (272k/400k per catalog), no chat-only suffix.
- Commands: `/login-codex-web`, `/codex-web-model`, `/codex-web-status`.
- Shared lifecycle generalized: both providers use non-blocking startup,
  disk cache, 5s background discovery, upstream-failure normalization.
- Prerequisite: one-time OAuth PKCE login with a ChatGPT account in the
  codex-proxy web panel (free account works).

## 0.1.2 — 2026-08-20

**Document + label: web-tier text models are chat-only.** Verified live against
the bridge: `tools` and even forced `tool_choice` on both `/v1/chat/completions`
and `/v1/responses` are silently ignored — the upstream web conversation API has
no function calling. Model names now carry a `(chat only)` suffix so users
aren't surprised when a chatgpt-web session can't touch the workspace. Tool-
capable ChatGPT access requires the Codex backend (different account type +
different proxy project; see README "Agentic (tool) access").

## 0.1.1 — 2026-08-20

**Fix: auth key in `~/.pi/agent/.env.local` was never read** — Pi does not inject
env files into `process.env`; the package must implement the repo env chain
itself (`process.env` → cwd `.env.local` → cwd `.env` → global `.env.local` →
global `.env`). Without it, `/v1/models` returned 401 and the provider
registered with zero models (nothing selectable in `/model`). Tests now
isolate and restore the developer's real env files.

## 0.1.0 — 2026-08-20

Initial release.

- Provider `chatgpt-web` (`openai-completions`) pointing at a self-hosted
  ChatGPT web bridge (default: homelab chatgpt2api at `http://172.30.55.22:3001/v1`).
- Live model discovery from `GET {baseUrl}/models` with disk cache and
  non-blocking background refresh (5s timeout).
- `gpt-5*` family and `auto` mapped to reasoning models; image models filtered;
  zero cost (web tier).
- Commands: `/login-chatgpt-web` (URL + auth key, connection test),
  `/chatgpt-web-model` (search/select), `/chatgpt-web-status` (bridge health +
  account pool check).
- `message_end` normalization: upstream pool failures (502 `upstream_error` /
  `backend-anon`) surfaced as an actionable "add a web account" hint.
- Config: `CHATGPT_WEB_BASE_URL` / `CHATGPT_WEB_AUTH_KEY` env vars → saved
  config → default; baseUrl must include `/v1`.
