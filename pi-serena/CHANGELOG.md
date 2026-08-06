# Changelog

## 0.9.12 (2026-08-06)

### Fixes

- Third review round on the JetBrains work, all findings addressed:
  - `_jb_find_declaration` stage 1 now wraps the plugin-client call in
    `contextlib.redirect_stdout(sys.stderr)`, matching every other serena-agent
    interaction in the bridge. Prevents a stray `print()` in the plugin-client
    path from corrupting the stdout JSON-line protocol.
  - `serena_get_diagnostics_for_file` under the JetBrains backend now reports
    `errorType: serena_error` instead of `language_server_error`, so the error
    no longer suggests restarting the language server (which is not applicable
    to the JetBrains backend).
  - New tests assert that each `_jb_declaration_regexes` pattern contains
    exactly one capturing group (a second group would make
    `find_text_coordinates` raise ValueError and silently disable the
    find_declaration stage-2 fallback), and that the patterns match their
    intended declaration shapes (keyword-anchored, method definition vs call
    site, bare fallback).

## 0.9.11 (2026-08-06)

### Fixes

- Reviewer findings on the 0.9.9/0.9.10 JetBrains work, all addressed:
  - `serena_find_declaration` stage-1 no longer picks an arbitrary symbol when
    the name-path *pattern* matches multiple symbols. It now requires a single
    match or exactly one exact name-path match (`_jb_pick_unique_symbol`);
    otherwise it falls through to the regex stage, which enforces uniqueness,
    so an ambiguous name returns an `Error:`-prefixed failure instead of a
    wrong declaration position as a success.
  - Stage-1 plugin/client errors are now logged to stderr before falling back
    to the regex stage, so a real plugin failure is observable instead of
    silently swallowed.
  - The "resolvable reference" detection (regex landed on the declaration
    itself) now matches the plugin's error text tolerantly
    (`_jb_is_declaration_position_error`, case-insensitive regex covering
    "not ... resolvable", "may not be on", "is a declaration", "declaration
    itself") instead of a fragile exact substring, since the wording is
    plugin-server-side and may vary across plugin versions.
  - Synthesized declaration results now include the `type` field (from the
    plugin response, or `"unknown"` in the regex fallback), matching the
    shape of `jet_brains_find_declaration`'s normal output.
  - New unit tests cover the decision helpers (`_jb_pick_unique_symbol`
    ambiguity handling and `_jb_is_declaration_position_error` phrasing
    variants) as TS mirrors of the Python logic.

## 0.9.10 (2026-08-06)

### Fixes

- Non-ASCII tool output is no longer garbled on hosts whose default locale is
  not UTF-8. The bridge's `respond()` now serializes responses with
  `ensure_ascii=True`, keeping the stdout wire format pure ASCII regardless of
  the host locale. Node reads the worker stdout as UTF-8, and `JSON.parse`
  decodes the `\uXXXX` escapes back to the original characters. Previously
  `ensure_ascii=False` wrote raw non-ASCII bytes that Python's `sys.stdout`
  encoded with the locale codec, garbling code-context snippets (e.g. from
  `find_referencing_symbols`) on `C`/`cp1252` locales. macOS is unaffected
  (UTF-8 by default).
- `serena_find_declaration` under the JetBrains backend now resolves the
  symbol's exact location via the plugin client (`find_symbol` with
  `include_location=True`), which handles class fields/properties and other
  ambiguous names that the regex fallback missed (e.g. a field appearing
  multiple times in a file). Previously such names returned a bare
  `ValueError: ...` string misclassified as a success result. All failure paths
  now return `Error:`-prefixed strings so the caller classifies them as
  failures.

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
