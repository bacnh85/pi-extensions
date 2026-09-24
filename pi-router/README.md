# pi-router

Pi extension that connects to **any OpenAI-compatible AI router** — [9router],
omniroute, or any proxy exposing `GET /v1/models` + `/v1/chat/completions` —
and registers its models as a single generic `router` provider.

Formerly `@bacnh85/pi-9router` (settings are migrated automatically, see below).

## Install

```bash
pi install @bacnh85/pi-router
```

## Configure

Two pieces, matching Pi conventions:

| What | Where |
|------|-------|
| **Endpoint URL** | `~/.pi/agent/settings.json` → `router.baseUrl` (or `ROUTER_BASE_URL` env; repo `.pi/settings.json` also read for trusted projects, `router.apiKey` there is ignored) |
| **API key** | Pi's built-in `/login router` → stored in `~/.pi/agent/auth.json` (or `ROUTER_API_KEY` env) |

```jsonc
// ~/.pi/agent/settings.json
{
  "router": {
    "baseUrl": "http://localhost:20128/v1",
    "enableReasoning": true   // optional, default true
  }
}
```

Then:

```
/login router        # store API key in auth.json (same as other providers)
```

Precedence: env vars > repo `.pi/settings.json` > global settings.json.
The auth.json credential wins over `ROUTER_API_KEY` when both exist.
Legacy `NINE_ROUTER_BASE_URL` still works for the URL. For the key, prefer
`ROUTER_API_KEY` (or `/login router` — recommended); discovery requests also
fall back to `NINE_ROUTER_API_KEY` if that's all you have set.

**Repo-scope trust gate.** Repo `.pi/settings.json` `router` values are only
read when the project is trusted (Pi's `trustProject`); untrusted checkouts
ignore them entirely, and `router.apiKey` from a repo file is never read —
credentials must come from auth.json or the env. An untrusted checkout thus
cannot redirect `router.baseUrl` to an attacker endpoint.

**`ROUTER_ENABLE_REASONING` env var** (legacy alias
`NINE_ROUTER_ENABLE_REASONING`): set to `true`/`false` to override the
persisted `router.enableReasoning` flag — it wins over both settings files
and shadows what `/router-reasoning` saves (the command reports this).

## Model discovery (cached, auto-refreshed)

Models are fetched automatically via Pi's native `refreshModels`:

- Every session start pulls `GET /v1/models` in the background — TUI, RPC,
  and print modes alike (Pi core only network-refreshes from the TUI `/model`
  picker; this covers the rest).
- A 5-minute timer re-pulls while pi runs; a 15-minute TTL keeps a fresh
  catalog from fetching at all. `PI_OFFLINE` disables all network pulls.
- The result is cached in `~/.pi/agent/models-store.json` under the `router`
  key with a `checkedAt` timestamp — next session restores instantly, offline,
  and freshness survives restarts.
- Reasoning levels (Shift+Tab, `:high` suffixes) map per model family
  (OpenAI, Claude, Gemini, DeepSeek, Kimi, Qwen, GLM, …).

## Commands

| Command | Description |
|---------|-------------|
| `/login router` | Built-in Pi login — stores the API key in auth.json |
| `/router-status` | Endpoint, masked key, model count |
| `/router-config` | Interactive settings panel (baseUrl, reasoning) |
| `/router-reasoning` | Toggle thinking levels on router models |
| `/router-model [search]` | Search/select a router model |

## Migration from pi-9router

On load, if `~/.pi/agent/9router-config.json` exists:

- `baseUrl` + `enableReasoning` → settings.json `router` section
- `apiKey` → auth.json `router` credential
- The legacy file is renamed `9router-config.json.migrated` (never deleted)

Also update `~/.pi/agent/settings.json` `packages` path `pi-9router` → `pi-router`.

## License

MIT

[9router]: https://github.com/nicepkg/9router
