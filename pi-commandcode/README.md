# @bacnh85/pi-commandcode

Pi extension that connects to [Command Code](https://commandcode.ai)'s OpenAI-compatible Provider API.

## Install

```bash
pi install npm:@bacnh85/pi-commandcode
```

## What it does

Registers the `commandcode` provider in Pi. Models are fetched dynamically from
`GET /provider/v1/models` and appear in Pi's `/model` picker under the
`commandcode/` prefix. Pi's built-in OpenAI completions client handles all
streaming and tool calling — no custom API code.

## Usage

### Log in

```
/login commandcode
```

This uses Pi's built-in `/login` flow — no dedicated slash command needed.
Paste your Command Code API key (generate one in
[Studio → API Keys](https://commandcode.ai/studio)).

Alternatively, set the API key via environment variable (for CI/headless):

```bash
export COMMAND_CODE_API_KEY=cmd_...
```

Once logged in, models populate via catalog refresh and `/model` shows them:

```
/model commandcode/deepseek/deepseek-v4-flash
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMMAND_CODE_API_KEY` | — | API key (overrides `/login`; read by catalog refresh) |
| `COMMAND_CODE_BASE_URL` | `https://api.commandcode.ai/provider/v1` | Override the base URL (must include `/v1`; chat completions POST to `<baseUrl>/chat/completions`) |

## How it works

1. On startup, registers the `commandcode` provider with `api: "openai-completions"`.
2. Models are loaded from a disk cache (instant session restore) and warmed in
   the background from `/provider/v1/models`.
3. After `/login`, Pi's catalog refresh calls `refreshModels`, which fetches the
   live model list authenticated with your stored key.
4. Pi's built-in OpenAI completions API handles all streaming and tool calling.

The Provider API bills at model cost with no markup. See Command Code's
[Provider API docs](https://commandcode.ai/docs/provider) and
[Pricing & Limits](https://commandcode.ai/docs/resources/pricing-limits) for
plans, credits, and per-token rates.

## Notes

- **API key vs. CLI subscription:** This extension uses the Provider API
  surface (OpenAI-compatible, pay-as-you-go or plan credits). The Command Code
  CLI subscription (GOAT/Pro/Max) and its `/usage` rolling windows are tracked
  on the web Studio and are **not** exposed via the Provider API key.
- **Usage display:** Install [`@bacnh85/pi-sub`](../pi-sub) for a session-cost
  footer when a `commandcode` model is active. Because the Provider API key
  does not expose live usage windows, pi-sub shows session cost and tok/s
  (same as `opencode-go` and `9router`), not 5h/weekly meters.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
