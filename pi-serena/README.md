# pi-serena

Pi extension that registers Pi-native `serena_*` tools backed by a persistent TypeScript/Node worker. This avoids configuring Pi as an MCP client while still using Serena's semantic code APIs.

Note: Serena itself is a Python package. The TypeScript worker owns lifecycle, request/response handling, and Pi integration, and uses an embedded Python bridge subprocess only to call Serena internals because Serena does not provide a JavaScript SDK and its non-MCP project HTTP server is read-only.

## Symbol-key auto-repair

Models intermittently confuse Serena's two symbol keys. `serena_find_symbol` and `serena_safe_delete_symbol` take `name_path_pattern`; every other name-bearing Serena tool (`find_referencing_symbols`, `find_declaration`, `find_implementations`, `replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol`, `rename_symbol`) takes `name_path`. Each name-bearing tool now normalises the key in `prepareArguments` **before schema validation** — a wrong key is silently moved to the expected one; correct input is a no-op. This runs for all models (it is a generic argument-shape fix).

## Install

Install the published package from npm:

```bash
pi install npm:@bacnh85/pi-serena
```

From this repository checkout, install only this extension package:

```bash
pi install ./extensions/pi-serena
```

For local development from a checkout:

```bash
pi -e ./extensions/pi-serena
```

The package manifest points Pi directly at `./index.ts`, so published npm installs and local installs load the same extension entrypoint.

There is intentionally no repository-level Pi package. Install each extension from its own subdirectory, matching `extensions/pi-rtk` and future extensions.

After install or update, restart Pi or run `/reload` in an existing Pi session.

## Tools

- `serena_status`
- `serena_list_tools`
- `serena_get_symbols_overview`
- `serena_find_symbol`
- `serena_find_referencing_symbols`
- `serena_find_declaration`
- `serena_find_implementations`
- `serena_replace_symbol_body`
- `serena_insert_before_symbol`
- `serena_insert_after_symbol`
- `serena_rename_symbol`
- `serena_safe_delete_symbol`
- `serena_search_for_pattern`
- `serena_replace_content`
- `serena_restart_language_server`
- `serena_get_current_config`
- `serena_get_diagnostics_for_file`
- `serena_check_onboarding_performed`
- `serena_onboarding`

> Memory tools removed — use `munin_*` tools (`munin_search`, `munin_store`, `munin_get`) for all memory operations. 

All tool outputs are truncated to 50KB / 2000 lines to match Pi-friendly output limits. Most tools accept optional `timeout_ms`.

### Serena-first workflow

For source-code navigation, use Serena before raw file reads or shell searches:

- `serena_get_symbols_overview` for a source-file outline.
- `serena_find_symbol` for named functions, classes, methods, or variables.
- `serena_find_referencing_symbols` before behavior changes or renames.
- `serena_find_declaration` / `serena_find_implementations` for definitions, interfaces, and implementations.

Use `read`, `grep`, and `find` for docs, configs, non-code files, exact text checks, or narrow code ranges after Serena identifies the relevant region.

Optional prompt/tool-selection knobs:

- `PI_SERENA_REMIND_ON_FIRST_MISS=1` — send the Serena reminder after the first obvious code-read/search miss instead of the default threshold.
- `PI_SERENA_STRICT=1` or `PI_SERENA_STRICT_MISSES=1` — block obvious raw code reads or semantic code searches until Serena is used first. Docs/config/non-code reads are still allowed.
- `SERENA_EAGER_STARTUP=1` — pre-spawn the worker on session start.

When a worker request exceeds the configured timeout, the Python bridge process is automatically killed and a fresh worker is started for the next call. Requests are serialized to match the Python bridge's sequential protocol, so a timed-out request should not reject later queued requests. The Pi adapter retries transient worker timeout/restart failures once. If a request is expected to take longer, pass a larger `timeout_ms`; if worker state appears stale, run `/serena-restart`. Exiting Pi should not normally be needed.

### Pattern search

Use the Pi-facing `pattern` field with `serena_search_for_pattern`:

```json
{
  "pattern": "USB_HOST_DEVICE_OBJ|USB_HOST_DEVICE_STATE_ERROR_HOLDING",
  "relative_path": "AmazonFreeRTOS",
  "paths_include_glob": "**/*.h"
}
```

The extension maps `pattern` to Serena's backend `substring_pattern` parameter internally, so users do not need to call the Serena implementation detail directly.

### Content replacement

Use Serena's current `replace_content` API through Pi-facing fields:

```json
{
  "relative_path": "src/example.py",
  "needle": "old text",
  "repl": "new text",
  "mode": "literal"
}
```

For regex replacement, set `mode` to `regex` and provide a Python regular expression in `needle`:

```json
{
  "relative_path": "src/example.py",
  "needle": "beginning.*?end",
  "repl": "replacement",
  "mode": "regex"
}
```

The Pi bridge also implements `serena_get_current_config` and `serena_restart_language_server` directly, so they work even when Serena's same-named native tools are inactive in single-project or default contexts.

## Commands

- `/serena-dashboard [project]`
- `/serena-restart`

The persistent Pi worker keeps one Serena bridge process per Pi process/session. It keeps the dashboard server available by default but does not open a browser tab automatically; use `/serena-dashboard` when you want to open it. Set `SERENA_BRIDGE_WEB_DASHBOARD=0` to disable the dashboard server, or `SERENA_BRIDGE_OPEN_DASHBOARD=1` to restore automatic browser launch. These variables are read from the process environment, current working directory `.env.local`/`.env`, or Pi global config `.env.local`/`.env` under `$PI_CODING_AGENT_DIR` or `~/.pi/agent`.

## Worker protocol

`worker.ts` implements the persistent worker client in TypeScript. The extension starts one worker per Pi process, lazily on first use, and shuts it down on `session_shutdown`.
