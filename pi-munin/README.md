# pi-munin

Pi extension that exposes Munin long-term memory as native Pi tools.

## Install

Install the published package from npm:

```bash
pi install npm:@bacnh85/pi-munin
```

From this repository checkout, install only this extension package:

```bash
cd pi-munin
npm install
cd ..

pi install ./pi-munin
# or test directly
pi -e ./pi-munin
```

The package manifest points Pi directly at `./extensions/index.ts`, so published npm installs and local installs load the same extension entrypoint.

## Configuration

- `MUNIN_API_KEY` (required)
- `MUNIN_PROJECT` (required)
- `MUNIN_BASE_URL` (optional, defaults to `https://munin.kalera.ai`)

Configuration precedence is explicit tool parameters, process environment, trusted project `.env.local`/`.env`, then Pi-global `.env.local`/`.env`. Project env files are read only when `ctx.isProjectTrusted()` is true. Env files are parsed without mutating `process.env`; `.env.local` wins over `.env` at each location.

The Pi global config directory honors `$PI_CODING_AGENT_DIR` when set; otherwise the extension checks `~/.pi/agent` and legacy `~/.pi/agents`. Base URLs must be HTTP(S), cannot contain credentials, and a tool-level `base_url` override requires a tool-level `api_key` so ambient credentials are never sent to a model-selected endpoint.

## Tools

- `munin_search` — search memories.
- `munin_get` — retrieve one memory by key.
- `munin_store` — store verified durable knowledge.
- `munin_list` — list stored memories.
- `munin_recent` — list recently updated memories.
- `munin_delete` — delete a memory after interactive confirmation.
- `munin_capabilities` — inspect server capabilities.
- `munin_share` — share memories with other projects after interactive confirmation.

Delete and share safely cancel in non-interactive modes, where Pi cannot obtain confirmation.

## Notes

- Treat retrieved memories as leads, not authority. Verify against current repository evidence before relying on them.
- Never store secrets, credentials, tokens, private keys, or sensitive connection strings.
- `@kalera/munin-sdk@1.5.0` exposes no client-side encryption-key or crypto-helper API. This extension does not implement or claim client-side E2EE; use a future official SDK integration when one is available.

## Troubleshooting

- Missing SDK dependency (`Cannot find module '@kalera/munin-sdk'`): when using this repository as a local Pi extension, install runtime dependencies with `npm install --prefix pi-munin`, then restart Pi or run `/reload`.
- Missing credentials: run `/munin-status` or set `MUNIN_API_KEY` and `MUNIN_PROJECT`.
- Auth, validation, feature, rate-limit, network, timeout, and stale-protocol errors are surfaced as typed tool errors.
- Transient network, timeout, and rate-limit failures are retried automatically with exponential backoff (3 retries).
