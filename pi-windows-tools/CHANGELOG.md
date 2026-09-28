# Changelog

## 0.5.10 - 2026-09-28

### Changed

- **The last 3 sync-exec tools are now async (`execFile` promisified), ending
  the TUI-freeze class:** `windows_tool_discover` (was `execFileSync` 3s),
  `windows_wsl_list_distros` (was `execFileSync` 5s), and `windows_doctor` —
  whose 26 where.exe/version probes + 2 registry reads now run via
  `Promise.all` (sequential worst case was ~30s). Output shapes unchanged;
  wsl.exe UTF-16LE output still parsed via the raw buffer.
- Dropped the accepted-but-ignored `timeout_ms` parameter from the schemas of
  the 10 tools that never used it (audit log, 4 path tools, safety classify,
  shell detect, doctor, tool discover, wsl list). `windows_shell_exec` keeps
  its real timeout.

### Removed

- Dead `isSensitivePath` export from `lib/safety.ts` (only ever called by its
  own test) and that test.

## 0.5.9 (2026-09-26)

### Fixed

- **Shell detection is now memoized at module level.** Every
  `windows_shell_exec`/`windows_path_quote` call previously re-ran
  `where.exe` + version probes (2-10 sync spawns, seconds worst case).
  `resetShellDetectionCache()` forces re-detection — wired into the
  `/shell <kind>` command so freshly-installed shells are discoverable;
  regression test added.

