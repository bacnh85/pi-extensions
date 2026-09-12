# Changelog

## 0.1.4 (2026-09-12)

### Fixed

- **README daemon claim was false.** It said a healthy daemon already on the
  port is reused; in fact `daemon.ts` never reuses a stranger daemon (it may
  carry a stale environment). README now states the truth: a fresh daemon is
  always spawned on a free port and killed on Pi exit.
- **APPDATA leaked across platforms.** `kiCadUserDirCandidates` checked
  `env.APPDATA` before the platform, so a non-Windows host that happened to
  export APPDATA resolved the KiCad user dir from it. The candidate is now
  gated on `win32` (with the default `AppData/Roaming` fallback).
- README tools table now lists `kicad_batch` (registered since the batch tool
  was added but missing from the docs).
- Dropped the dead `binary` parameter from `buildSpawnArgs` (always ignored).

## 0.1.3 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

All notable changes to `pi-kicad` will be documented in this file.

## 0.1.2 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.1.1 (2026-07-24)

### Fixes

- Fixed process lifecycle cleanup and port handling for the managed Konnect daemon.

## 0.1.0 (2026-07-16)

### Features

- Initial release of `pi-kicad`, driving KiCad schematics and PCB layout via Konnect daemon.
