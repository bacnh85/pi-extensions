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
| **Endpoint URL** | `~/.pi/agent/settings.json` → `router.baseUrl` (or `ROUTER_BASE_URL` env; repo `.pi/settings.json` also read, `router.apiKey` there is ignored) |
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

## Model discovery (cached)

Models are fetched automatically via Pi's native `refreshModels`:

- First `/models` or `/login` in a session triggers `GET /v1/models`.
- The result is cached in `~/.pi/agent/models-store.json` under the `router`
  key — next session restores instantly, offline.
- Reasoning levels (Shift+Tab, `:high` suffixes) map per model family
  (OpenAI, Claude, Gemini, DeepSeek, Kimi, Qwen, GLM, …).

## Commands

| Command | Description |
|---------|-------------|
| `/login router` | Built-in Pi login — stores the API key in auth.json |
| `/router-status` | Endpoint, masked key, model count |
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
