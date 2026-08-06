# Changelog

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
