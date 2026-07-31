# Changelog

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
