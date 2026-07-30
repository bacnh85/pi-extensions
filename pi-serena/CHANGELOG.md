# Changelog

All notable changes to `pi-serena` will be documented in this file.

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
