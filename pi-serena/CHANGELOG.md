# Changelog

## 0.9.9 (2026-08-06)

### Fixes

- JetBrains backend (`SERENA_LANGUAGE_BACKEND=JetBrains`): the `serena_*` tools
  are now transparently routed to Serena's active `jet_brains_*` variants
  instead of failing with "tool not active". Serena's internal `jetbrains` mode
  excludes the LSP-flavored tools (`find_symbol`, `get_symbols_overview`,
  `find_referencing_symbols`, `rename_symbol`, `safe_delete_symbol`), so the
  Python bridge remaps the pi-facing tool names and parameters when the backend
  is JetBrains:
  - `serena_get_symbols_overview` → `jet_brains_get_symbols_overview`
  - `serena_find_symbol` → `jet_brains_find_symbol` (LSP-only `include_kinds`/
    `exclude_kinds`/`substring_matching` dropped)
  - `serena_find_referencing_symbols` → `jet_brains_find_referencing_symbols`
    (LSP-only `include_kinds`/`exclude_kinds` dropped)
  - `serena_find_declaration` → `jet_brains_find_declaration` (the JetBrains
    variant requires a one-group regex; the bridge tries declaration-context
    regexes in order and, when the regex lands on the declaration itself,
    returns the matched position)
  - `serena_find_implementations` → `jet_brains_find_implementations`
  - `serena_rename_symbol` → `jet_brains_rename`
  - `serena_safe_delete_symbol` → `jet_brains_safe_delete` (`name_path_pattern`
    mapped to `name_path`)
  - `serena_get_diagnostics_for_file` and `serena_restart_language_server` have
    no JetBrains counterpart (no `jet_brains_run_inspections` in serena-agent
    1.2.0) and now return a clear "not applicable to the JetBrains backend"
    message.

  The LSP backend path is unchanged (remap tables are a no-op). The remap
  tables live in `worker.ts` as exported TS constants, are interpolated into the
  bridge as JSON, and are covered by 8 new unit tests.

## 0.9.8 (2026-08-06)

### Improvements

- `SERENA_*` configuration variables (`SERENA_LANGUAGE_BACKEND`,
  `SERENA_BRIDGE_WEB_DASHBOARD`, `SERENA_BRIDGE_OPEN_DASHBOARD`, ...) are now
  resolved from project/global dot files as well as the process environment:
  process env → `<cwd>/.env.local` → `<cwd>/.env` → Pi global config
  `.env.local`/`.env` (under `$PI_CODING_AGENT_DIR` or `~/.pi/agent`), matching
  the pi-web/pi-munin env-discovery chain. First dot file wins; process env is
  never overridden. Values are captured at worker spawn, so a worker restart
  (`/serena-restart`) is required after editing dot files.

## 0.9.7 (2026-08-06)

### Improvements

- Added `SERENA_LANGUAGE_BACKEND` env var (`LSP` default, `JetBrains`) to select
  Serena's code-intelligence backend at worker startup, via config. The `JetBrains`
  value requires the Serena JetBrains Plugin and the project open in the IDE; the
  backend is fixed for the session and needs a worker restart (`/serena-restart`)
  to change. Per-project `project.yml` overrides continue to be honored by Serena.

## 0.9.6 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

All notable changes to `pi-serena` will be documented in this file.

## 0.9.5 (2026-07-31)

### Shared Python worker across parent and in-process subagents

The `SerenaWorkerClient` Python process is now a **module-level singleton**
instead of a factory-closure variable. Previously, every in-process child
session that loaded pi-serena (e.g. via pi-subagent's new inherit-by-default
mode) spawned its own Python worker that leaked on child dispose — there was no
shutdown path for the closure-scoped instance. One worker now serves the parent
and all children.

The `session_shutdown` hook keeps its original stop-on-all-reasons behavior —
it fires only on parent lifecycle events (reload/quit/new/fork/resume), never on
child `dispose()` (verified: AgentSession.dispose() invalidates the extension
runner but does not emit session_shutdown). So children reuse the shared worker
without risk of killing it, and reload cleanly stops the old worker before the
reloaded module spawns a fresh one.

## 0.9.4 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.9.3 (2026-07-24)

### Fixes

- Fixed symbol key auto-repair for `name_path` vs `name_path_pattern` schema drift.
- Restored diagnostics handling and hardened worker shutdown lifecycle.

## 0.9.0 (2026-07-16)

### Features

- Added `serena_restart_worker` tool and enhanced status output.
- Surfaced exact error tracebacks from `get_diagnostics_for_file`.

## 0.8.3 (2026-07-10)

### Features

- Initial release of `pi-serena` semantic code tools extension via persistent TypeScript worker.
