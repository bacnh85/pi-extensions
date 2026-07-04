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

The extension lazily discovers credentials on first tool use:

- `MUNIN_API_KEY` (required)
- `MUNIN_PROJECT` (required)
- `MUNIN_BASE_URL` (optional, defaults to `https://munin.kalera.ai`)

It also loads environment files without overriding existing environment values, in this order: current working directory `.env.local`, current working directory `.env`, and Pi global config `.env.local`/`.env`. The Pi global config directory honors `$PI_CODING_AGENT_DIR` when set; otherwise it checks `~/.pi/agent` and legacy `~/.pi/agents`.

## Tools

Individual tools:

- `munin_search`
- `munin_get`
- `munin_store`
- `munin_list`
- `munin_recent`
- `munin_delete`
- `munin_capabilities`

## Notes

- Treat retrieved memories as leads, not authority. Verify against current repository evidence before relying on them.
- Never store secrets, credentials, tokens, private keys, or sensitive connection strings.
- For E2EE projects, use the official Munin setup and environment variables; this extension relies on the official SDK/server protocol.

## Troubleshooting

- Missing SDK dependency (`Cannot find module '@kalera/munin-sdk'`): when using this repository as a local Pi extension, install runtime dependencies in the extension directory with `npm install --prefix pi-munin`, then restart Pi or run `/reload`.
- Missing credentials: run `/munin-status` or set `MUNIN_API_KEY` and `MUNIN_PROJECT`.
- Auth/network/E2EE/stale-protocol errors are surfaced as actionable tool errors.
- Transient network errors are retried automatically with exponential backoff (3 retries).
