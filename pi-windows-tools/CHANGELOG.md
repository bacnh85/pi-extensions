# Changelog

## 0.5.9 (2026-09-26)

### Fixed

- **Shell detection is now memoized at module level.** Every
  `windows_shell_exec`/`windows_path_quote` call previously re-ran
  `where.exe` + version probes (2-10 sync spawns, seconds worst case).
  `resetShellDetectionCache()` forces re-detection — wired into the
  `/shell <kind>` command so freshly-installed shells are discoverable;
  regression test added.

