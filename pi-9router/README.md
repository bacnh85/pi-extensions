# pi-9router

Pi extension for [9router](https://github.com/decolua/9router) — connect to your 9router AI routing proxy instance.

## Install

```bash
pi install npm:@bacnh85/pi-9router
```

## Usage

### Configure connection

```
/login-9router
```

Prompts for:
- **Endpoint URL** (default: `http://localhost:20128/v1`)
- **API key** (required if your 9router has `REQUIRE_API_KEY=true`)

Once configured, models from 9router appear in Pi's `/model` picker under the `9router/` provider prefix.

### Toggle reasoning/thinking levels

```
/9router-reasoning
```

Toggles Pi thinking-level support for 9router models ON/OFF.

When ON, use `Shift+Tab`, `--thinking high`, or model suffixes like
`9router/...:high` to control `reasoning_effort` sent to 9router.

### Check status

```
/9router-status
```

Shows connection status, model count, and current configuration.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NINE_ROUTER_BASE_URL` | — | Overrides saved endpoint URL |
| `NINE_ROUTER_API_KEY` | — | Overrides saved API key |
| `NINE_ROUTER_ENABLE_REASONING` | — | Overrides saved reasoning toggle (`true`/`false`) |

## How it works

1. On startup, loads config from `~/.pi/agent/9router-config.json` and registers the `9router` provider
2. Models are fetched dynamically from `GET /v1/models` on first use
3. Pi's built-in OpenAI completions API handles all streaming and tool calling
4. No built-in providers are overridden — `9router/` models are a separate namespace

## License

MIT
