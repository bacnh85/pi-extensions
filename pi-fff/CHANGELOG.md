# Changelog

All notable changes to `pi-fff` will be documented in this file.

## 0.8.3 (2026-09-22)

### Fixed

- Override-mode `find` now returns a friendly "Invalid path constraint"
  message for absolute out-of-workspace paths instead of a raw tool error
  (matches the non-override path's error handling).

### Changed

- README documents explicit hidden-file/hidden-directory scoping
  (`.env`, `.agents/**`) and the `0.8.2` boilerplate line moved to the top
  of this file.

## 0.8.2 (2026-09-21)

### Fixed

- Autocomplete provider is now registered once per extension instance —
  repeated `session_start` events no longer stack wrapper chains that
  ran N lookups per keystroke.

### Changed

- README now cites FFF 0.10.6, matching the `@ff-labs/fff-node`
  dependency version.

## 0.8.1 (2026-09-20)

### Changed

- Removed dead override-mode branches from the find tool's execute —
  unreachable since the early `searchOverrideFind` return; non-override
  values are used directly.

### Tests

- Added direct coverage for the manual hidden-file scanner's NUL-byte
  rejection (`grepExplicitHiddenFile` via ffgrep execute); >10MB rejection
  was already covered.

## 0.8.0 (2026-08-31)

### Changed

- Upgraded `@ff-labs/fff-node` `^0.9.6` → `^0.10.6` (additive API: `followSymlinks`, `watch()`; dot-directory glob matching fix; ffgrep per-file cap decoupled from page size).
- Tool discoverability: `ffgrep`/`fffind` prompt snippets now state the FFF advantage (paginated, frecency-ranked, prefer over bash grep/find).

### Added

- `before_agent_start` system-prompt note (all modes except `override`): ffgrep/fffind are the preferred search tools; plain grep/find reserved for pipelines and outside-workspace paths.

## 0.7.10 (2026-08-29)

### Added

- `/fff-mode` argument completion offers `tools-and-ui|tools-only|override`.

## 0.7.9 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.7.8 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.7.7 (2026-07-24)

### Fixes

- Hardened search contracts and tool error handling for `fffind` and `ffgrep`.

## 0.7.6 (2026-07-20)

### Features

- Added `resolve_file`, `fff_multi_grep`, and `related_files` tools.
- Added output mode selection (`content`, `files_with_matches`, `count`) and cursor pagination.

## 0.7.0 (2026-07-10)

### Features

- Initial release of `@bacnh85/pi-fff`, integrating FFF Rust-native SIMD-accelerated fuzzy file and content search into Pi.
