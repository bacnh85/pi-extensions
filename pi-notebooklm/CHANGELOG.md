# Changelog

## 0.1.14 (2026-09-24)

### Changed

- Peer dependency swapped from `@sinclair/typebox` to `typebox` (unscoped),
  matching the host SDK — `@earendil-works/pi-coding-agent` bundles
  `typebox` and its dist imports `from "typebox"`, so the scoped package
  never matched the real host. Also aligns with the sibling extension
  convention. Dev dependency `@sinclair/typebox` dropped; `Type` resolves
  via the peer (peer auto-install / SDK).

## 0.1.13 (2026-09-22)

### Fixed

- `truncateOutput` no longer fails the whole tool result when temp-dir
  persistence breaks (mkdtemp/write errors, e.g. ENOSPC). Persistence is
  now best-effort: on failure the output falls back to plain in-memory
  truncation without the "Full output saved to" suffix, honoring the
  invariant that cleanup must never break the tool result.
- The truncation-dir sweeper now removes registry entries whose dirs are
  unreadable/missing instead of keeping stale paths until cap eviction.

### Changed

- README: `share public`, `share add`, `share update`, and `share
  view-level` are documented as confirm-only destructive commands (no
  `-y`/`--yes` support), matching `DESTRUCTIVE_PATHS`.

## 0.1.12 (2026-09-21)

### Fixed

- Removed the unreachable `NO_YES_SUPPORT` set from the destructive-command
  gate. None of its members (auth.logout, skill.uninstall, history --clear,
  clear) appear in `REQUIRES_YES`, so the check could never match; behavior
  is unchanged — those commands keep using the explicit-confirm path.

## 0.1.11 (2026-09-20)

### Fixed

- When the truncation-dir registry hits its cap (20), the evicted dir is now
  removed from disk (best-effort) instead of being silently dropped from the
  registry — the age-gated sweeper could never see it again, so the temp dir
  (with full output content) leaked permanently. Eviction applies the same
  10-minute age gate as the sweeper: an old evicted dir is deleted
  immediately; a young one (its path possibly already handed to the model) is
  deleted via an unref'd timer after the remaining age, so a later read never
  ENOENTs.

## 0.1.10 (2026-09-18)

### Fixed

- Truncation temp dirs are now age-gated (removed only when older than 10
  minutes) instead of being deleted on the next truncation. Parallel
  notebooklm tool calls in one turn no longer delete each other's saved full
  output (which previously caused an ENOENT when the model read the temp
  path). Cleanup remains best-effort and never breaks the tool result.

## 0.1.9 (2026-09-12)

### Fixed

- `truncateOutput` temp dirs under `os.tmpdir()` were never cleaned. The
  previous truncation directory is now removed (best-effort, `rmSync`
  recursive+force in try/catch) when the next truncation happens — the newest
  one stays alive for the model to read.
- Reworded the `--yes` guidance for destructive commands: the old example
  showed the command path, not applicable args. Now actionable — "Append
  `--yes` as the last element of the args array to skip confirmation for
  destructive paths like delete/remove."

## 0.1.8 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

All notable changes to `pi-notebooklm` will be documented in this file.

## 0.1.7 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.1.6 (2026-07-24)

### Documentation

- Documented navigation quirks, undocumented commands, and CLI v0.7.3 compatibility.

## 0.1.4 (2026-07-16)

### Features

- Added argument validation, byte-aware output truncation, and confirmation gating for destructive operations.

## 0.1.0 (2026-07-10)

### Features

- Initial release of `pi-notebooklm` CLI bridge extension for Google NotebookLM.
