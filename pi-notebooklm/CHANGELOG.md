# Changelog

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
