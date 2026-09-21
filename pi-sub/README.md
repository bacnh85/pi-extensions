# @bacnh85/pi-sub

Pi extension that shows subscription usage for the currently selected supported model provider.

 Supports OpenAI Codex (`openai-codex`) with live usage windows from ChatGPT's usage endpoint, OpenCode Go (`opencode-go`) with rolling/weekly/monthly usage windows from Zen's `GET /zen/go/v1/usage` endpoint plus session cost tracking, and Z.ai GLM Coding Plan — both the international (`zai`) and China (`zai-coding-cn`, `open.bigmodel.cn`) endpoints — with quota monitoring. Also tracks Router (pi-router, `router` provider) with response-speed tracking and usage windows via yardmaster's general `GET /v1/usage` API (with OmniRoute's om-usage as fallback), and Command Code (`commandcode`) 5-hour/weekly windows and monthly credit balance. Displays a subscription footer status after Pi's built-in status/token usage line.

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

OpenCode Go reads the rolling (5-hour), weekly, and monthly usage windows from Zen's `GET /zen/go/v1/usage` endpoint using the stored API key. The footer shows the active account/key label, remaining quota per window, accumulated session cost, and last response speed:

```text
(OpenCode Go key#1a2b3c4d) R:97%/3H W:61%/2D M:20%/5D $0.23 42 tok/s
```

If the auth entry has an `accountId` but no API `key`, the footer falls back to the account label, session cost, and speed (no usage API is called).

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

### Z.ai via Anthropic endpoint

The `zai-anthropic` provider (registered by pi-model-tools, GLM through `api.z.ai/api/anthropic`) is tracked the same way — same api.z.ai quota monitor as the international `zai` provider, keyed by the auth.json `zai-anthropic` credential, labeled `Z.ai (Anthropic)`:

```text
(Z.ai (Anthropic) key#1a2b3c4d) R:55%/2H W:80%/3D 42 tok/s
```

### Router (pi-router — formerly 9router)

For **yardmaster** instances the footer shows real usage via the general JSON
usage API: `GET <baseUrl>/usage?provider=<prefix>` with the router API key
(auth.json `router` credential from `/login router`, or `ROUTER_API_KEY` env).
`<prefix>` is the upstream routing prefix of the selected model
(`zai/glm-5.3-flash` → `zai`, `cmd/...` → command code, `ds/...` → deepseek);
unknown prefixes fall back to the aggregate report. Unknown/older routers 404
and `pi-sub` automatically falls back to the OmniRoute text flow below.
Requirements: the API key must hold the usage permission (yardmaster dashboard
→ Endpoints & keys → usage api → "allowed"; keys allow it by default).

```text
Router · zai R:96%/2H W:80%/1D 145 tok/s
```

Credit-based upstreams (DeepSeek) surface their raw balance the same way
(shown as `M:$X.XX`) — no manage scope needed.

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

#### Raw USD balance (credit-based upstreams)

Credit-based upstreams (e.g. DeepSeek) only appear on the om-usage report as
meaningless normalized percentages. When the report has no usable windows,
`pi-sub` additionally queries OmniRoute's management usage API for the raw USD
balance (shown as `M:$X.XX`): it discovers the connection id via the
key-authable `GET /api/v1/me/status`, then reads `GET /api/usage/<connectionId>`
(`quotas.credits_usd.remaining`).

The management call needs a manage-scope credential: the router API key itself
works when it holds the **manage** scope (OmniRoute dashboard → API Keys), or
set one of these env vars to override it:

- `ROUTER_MGMT_TOKEN` — manage-scope API key or `oma_` CLI token
- `OMNIROUTE_MGMT_TOKEN` — legacy alias, checked second

Without either, the router API key from auth.json is used as-is; if it lacks
the manage scope the balance fetch simply returns nothing.

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

For OpenCode Go, `/sub` shows the provider/model, active account/key label, rolling/weekly/monthly windows, session cost, and speed:

```text
Provider: OpenCode Go · Model: kimi-k2.6 · Fetched: 14:23
Session cost: $0.23
Last response: 42 tok/s · Session avg: 39 tok/s

  ACCOUNT                         PLAN  ROLLING   WEEKLY    MONTHLY   LAST ACTIVITY
------------------------------------------------------------------------------
* OpenCode Go key#1a2b3c4d        Go    97%/3H   61%/2D    20%/5D    Now
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

For Z.ai Coding Plan (China), the `/sub` detail is the same, with the account rows showing the `Z.ai (CN)` provider label (e.g. `Z.ai (CN) key#1a2b3c4d` in the ACCOUNT column).

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
- **OpenCode Go**: Pi auth must contain an `opencode-go` API key entry (via `/login` or env var). The entry must have a `key` field or an `accountId` field. Usage windows come from `https://opencode.ai/zen/go/v1/usage` with the stored key; with only an `accountId` (no key), the footer falls back to session cost. The Zen credit wallet balance is not exposed by the API.
- **Command Code**: Pi auth must contain a `commandcode` API key entry in `~/.pi/agent/auth.json` (add it with `pi /login` → commandcode; there is no env-var fallback). The entry must have a `key` field or an `accountId` field. Usage is read from `https://api.commandcode.ai/alpha/billing/credits` with the same key; 5-hour and weekly windows plus the monthly credit balance are displayed.
- **Z.ai**: Pi auth must contain a `zai` entry in `auth.json` with a `key` field (the same API key used for Z.ai model access via `@czottmann/pi-zai-api`). The Z.ai provider must be registered (e.g., `pi install npm:@czottmann/pi-zai-api`).
- **Z.ai Coding Plan (China)**: The built-in `zai-coding-cn` provider targets `https://open.bigmodel.cn/api/coding/paas/v4`. Pi auth must contain a `zai-coding-cn` entry with a `key` field in `~/.pi/agent/auth.json` (add it with `pi /login`; there is no env-var fallback). Quota is read from the BigModel endpoint `https://open.bigmodel.cn/api/monitor/usage/quota/limit`.
- For API-key-only providers, account labels come from stored auth metadata (`email`, `label`, `name`, or `accountId`) when available; otherwise `pi-sub` displays a non-secret SHA-256 key fingerprint such as `Z.ai key#1a2b3c4d`.
- `pi-sub` redacts auth/token-related errors and never prints credentials.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Design notes

The extension is named `pi-sub` rather than `pi-codex-usage` so future subscription providers can be added as separate adapters. Supports OpenAI Codex (live usage API), OpenCode Go (live rolling/weekly/monthly windows via `/zen/go/v1/usage`), the Z.ai GLM Coding Plan (international `zai` and China `zai-coding-cn`, which share a quota response format and are served by one parameterized adapter), and Command Code (live 5-hour/weekly windows + monthly balance via `/alpha/billing/credits`).
