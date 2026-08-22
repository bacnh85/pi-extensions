# @bacnh85/pi-sub

Pi extension that shows subscription usage for the currently selected supported model provider.

 Supports OpenAI Codex (`openai-codex`) with live usage windows from ChatGPT's usage endpoint, OpenCode Go (`opencode-go`) with session cost tracking, and Z.ai GLM Coding Plan — both the international (`zai`) and China (`zai-coding-cn`, `open.bigmodel.cn`) endpoints — with quota monitoring. Also tracks Command Code (`commandcode`) 5-hour/weekly windows and monthly credit balance. Displays a subscription footer status after Pi's built-in status/token usage line.

## Install

```bash
pi install npm:@bacnh85/pi-sub
```

## What it shows

### OpenAI Codex

The footer status appears after Pi's built-in status/token usage line and includes:

- active account email/account label;
- subscription plan, such as `Plus` in `/sub` details;
- 5-hour remaining quota and reset countdown;
- weekly remaining quota and reset countdown.

Example subscription line:

```text
(user@example.com) R:15%/2H W:20%/3D 42 tok/s
```

### OpenCode Go

OpenCode Go does not expose a public usage-window API, so the footer shows the active account/key label, accumulated session cost, and last response speed:

```text
OpenCode Go (OpenCode Go key#1a2b3c4d) $0.23 42 tok/s
```

### Z.ai

Z.ai (GLM Coding Plan) shows the active account/key label, 5-hour rolling and weekly remaining quota with reset countdowns, and last response speed:

```text
(Z.ai key#1a2b3c4d) R:55%/2H W:80%/3D 42 tok/s
```

### Z.ai Coding Plan (China)

The built-in `zai-coding-cn` provider targets the domestic BigModel endpoint (`open.bigmodel.cn`) and returns the same GLM Coding Plan quota format as the international `zai` provider, so the footer and `/sub` detail behave identically, distinguished only by the `Z.ai (CN)` label:

```text
(Z.ai (CN) key#1a2b3c4d) R:55%/2H W:80%/3D 42 tok/s
```

### Router (pi-router — formerly 9router)

For **OmniRoute** instances the footer shows real usage: `GET <origin>/api/usage/om-usage`
with the router API key (auth.json `router` credential from `/login router`, or
`ROUTER_API_KEY` env) returns the per-key report — Personal quota (daily/weekly
USD budgets) and Provider quota (session/weekly connection windows) — rendered
as `R:`/`W:` remaining-percent windows:

```text
Router usage R:80% W:28% 145 tok/s
```

Requirements:
- The router instance must be OmniRoute (other routers 404 → endpoint-only fallback).
- The API key must have the **usage command enabled** in the OmniRoute dashboard
  (API Keys → the key → enable "usage command"); the footer shows a hint when it's off.

The endpoint URL is read from `~/.pi/agent/settings.json` (`router.baseUrl`), env `ROUTER_BASE_URL` overrides:

```text
Router (172.30.55.22:20128) 145 tok/s
```

### Command Code

Command Code exposes live usage windows via its `/alpha/billing/credits` endpoint (same Provider API key used for `/provider/v1` models — no cookies). The footer shows the active account/key label, 5-hour and weekly remaining windows with reset countdowns, and last response speed:

```text
(Command Code key#1a2b3c4d) R:99%/4H W:99%/6D M:$69.99 42 tok/s
```

The `M:$X.XX` segment is the monthly credit balance (the plan's remaining
monthly allowance in USD). The `/sub` detail view also shows a
`Monthly: $X remaining` line.

### Tokens per second

`pi-sub` tracks each response's tokens-per-second (tok/s) speed by measuring the time from provider request to message completion against the response's output token count. The last response's speed is shown in the footer next to usage data. The `/sub` detail view shows both the last response speed and the session-wide average.

The tok/s speed line is shown for **all** providers — including ones without a
subscription adapter, such as `ollama` and other OpenAI-compatible local
providers. For those, the footer shows only the speed:

```text
145 tok/s
```

and `/sub` reports the provider/model and speed instead of usage windows.
`pi-sub` still does not refresh subscription data for unsupported providers
(there is nothing to fetch).

## Commands

| Command | Description |
| --- | --- |
| `/sub` | Show detailed subscription usage for the current supported provider. |
| `/sub status` | Same as `/sub`. |
| `/sub refresh` | Force a usage refresh, then show details. |

When Pi OpenAI Codex auth is available, `/sub` shows the active account usage and speed:

```text
Provider: Codex · Model: o4-mini · Fetched: 14:23
Session cost: $0.12
Last response: 42 tok/s · Session avg: 39 tok/s

ACCOUNT                 PLAN  ROLLING  WEEKLY  LAST ACTIVITY
* user@example.com     Plus  15%/2H   20%/3D  Now
```

For OpenCode Go, `/sub` shows the provider/model, active account/key label, session cost, and speed:

```text
Provider: OpenCode Go · Model: kimi-k2.6 · Fetched: 14:23
Session cost: $0.23
Last response: 42 tok/s · Session avg: 39 tok/s

  ACCOUNT                         PLAN  LAST ACTIVITY
------------------------------------------------------
* OpenCode Go key#1a2b3c4d        Go    Now

OpenCode Go does not expose usage windows.
```

For Command Code, `/sub` shows the provider/model, active account/key label, rolling windows, and speed:

```text
Provider: Command Code · Model: deepseek/deepseek-v4-flash · Fetched: 14:23
Session cost: $0.05
Last response: 42 tok/s · Session avg: 39 tok/s

  ACCOUNT                        ROLLING  WEEKLY   LAST ACTIVITY
-----------------------------------------------------------------
* Command Code key#1a2b3c4d      99%/4H   99%/6D   Now

Monthly: $69.99 remaining
```

For Z.ai, `/sub` shows the rolling and weekly quota windows and speed:

```text
Provider: Z.ai · Model: glm-5.2 · Fetched: 14:23
Session cost: $0.05
Last response: 42 tok/s · Session avg: 39 tok/s

  ACCOUNT             PLAN  ROLLING        WEEKLY             LAST ACTIVITY
  ------------------------------------------------------------------------
* Z.ai key#1a2b3c4d  Pro   55%/2H        80%/3D            Now
```

For Z.ai Coding Plan (China), the `/sub` detail is the same with a `Z.ai (CN)` provider/account label:

## Refresh behavior

`pi-sub` refreshes usage data:

- when a session starts on a supported provider;
- when switching into a supported provider;
- after provider responses, debounced;
- periodically while a supported provider remains active;
- when `/sub refresh` is run.

`pi-sub` reads the `openai-codex` OAuth entry from Pi's auth file and refreshes live usage directly against ChatGPT's usage endpoint. It does not execute the `codex-auth` CLI and does not assume a separate Codex CLI installation exists.

Refreshes are cached briefly to avoid excessive usage endpoint calls.

## Requirements and troubleshooting

- **OpenAI Codex**: Pi auth must contain an `openai-codex` OAuth entry in `~/.pi/agent/auth.json` or `$PI_CODING_AGENT_DIR/auth.json`. The entry must include `access` and `accountId` fields.
- **OpenCode Go**: Pi auth must contain an `opencode-go` API key entry (via `/login` or env var). The entry must have a `key` field or an `accountId` field. OpenCode Go/Zen usage windows and Zen balance are not shown because no public API is currently documented for those values.
- **Command Code**: Pi auth must contain a `commandcode` API key entry (via `/login commandcode` or the `COMMAND_CODE_API_KEY` env var). The entry must have a `key` field or an `accountId` field. Usage is read from `https://api.commandcode.ai/alpha/billing/credits` with the same key; 5-hour and weekly windows plus the monthly credit balance are displayed.
- **Z.ai**: Pi auth must contain a `zai` entry in `auth.json` with a `key` field (the same API key used for Z.ai model access via `@czottmann/pi-zai-api`). The Z.ai provider must be registered (e.g., `pi install npm:@czottmann/pi-zai-api`).
- **Z.ai Coding Plan (China)**: The built-in `zai-coding-cn` provider targets `https://open.bigmodel.cn/api/coding/paas/v4`. Pi auth must contain a `zai-coding-cn` entry with a `key` field (set via `/login` or the `ZAI_CODING_CN_API_KEY` env var). Quota is read from the BigModel endpoint `https://open.bigmodel.cn/api/monitor/usage/quota/limit`.
- For API-key-only providers, account labels come from stored auth metadata (`email`, `label`, `name`, or `accountId`) when available; otherwise `pi-sub` displays a non-secret SHA-256 key fingerprint such as `Z.ai key#1a2b3c4d`.
- `pi-sub` redacts auth/token-related errors and never prints credentials.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Design notes

The extension is named `pi-sub` rather than `pi-codex-usage` so future subscription providers can be added as separate adapters. Supports OpenAI Codex (live usage API), OpenCode Go (session cost only), the Z.ai GLM Coding Plan (international `zai` and China `zai-coding-cn`, which share a quota response format and are served by one parameterized adapter), and Command Code (live 5-hour/weekly windows + monthly balance via `/alpha/billing/credits`).
