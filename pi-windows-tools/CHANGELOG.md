# Changelog

## 0.5.1 (2026-08-04)

### Improvements

- **`windows_shell_exec` guidance softened.** The tool is no longer pitched as "use instead of generic bash" — its prompt guidelines now direct the model to use it for PowerShell/cmd/WSL-native commands, and to prefer plain `bash` for read-only inspection (which runs automatically in plan mode without a confirmation prompt). Reduces unnecessary confirm prompts in plan mode.

All notable changes to `pi-windows-tools` will be documented in this file.

## 0.5.0 (2026-08-02)

### Features & Fixes

- Stream command output via `onUpdate` (throttled live output, like Claude Code/Codex) — `windows_shell_exec` no longer buffers silently until exit.
- PowerShell `-EncodedCommand` fallback for multi-line / long commands (robust parsing where `-Command` mis-tokenizes).
- WSL UNC path support (`\\wsl.localhost\<distro>\<path>`, `\\wsl$\<distro>\<path>`) via `parseWslUncPath` — closes the Codex #27553 class of bug.
- Richer shell guidance: `&&`/`||` portability note, `nul` vs `/dev/null`, path quoting, pipe-after-cd caveat.
- Doctor now detects Windows Terminal (`wt`).
- Fixed phantom CHANGELOG entry: `windows_file_edit` (added 0.4.0, removed before 0.4.3) is no longer claimed as a current feature.

## 0.4.3 (2026-07-30)

### Improvements

- Bump shell-detect test timeout for GitHub CI.

## 0.4.2 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.4.1 (2026-07-24)

### Fixes

- Fixed YAML frontmatter parsing in skill definition.

## 0.4.0 (2026-07-16)

### Features & Security

- Hardened Windows path resolution, environment overrides, safety checks, and shell priority selection.
- Added `windows_file_edit` tool as a reliable Windows-native replacement for built-in edit. *(Note: removed before 0.4.3; no longer shipped.)*

## 0.2.0 (2026-07-10)

### Features

- Initial release of `pi-windows-tools` extension for Windows-native developer tooling, WSL support, and shell configuration.
