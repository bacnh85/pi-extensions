# Changelog

## [0.1.6] - 2026-09-20

### Fixed

- The `mkdtemp` daemon config dir (`pi-kicad-daemon-*`) is now removed in
  `killChild` instead of leaking in the tmpdir until reboot — including when
  the spawned Konnect dies before becoming healthy (that path now reaps the
  child instead of leaving a `running: true` zombie and an orphaned dir for
  the next `ensure()` to strand).
- SIGINT/SIGTERM now run the same cleanup as `exit` and then terminate the
  process (130/143) — **but only when no other listener owns the signal**:
  pi's interactive host prepends its own SIGTERM shutdown handler (and guards
  SIGINT while suspended); in that case cleanup runs and the host's handler
  finishes its graceful shutdown (which fires `exit` → our cleanup again)
  instead of being cut short by an exit race. A `once()` signal handler
  suppresses the default terminator, so without an explicit exit the first
  Ctrl+C in print/RPC modes left the host alive with a dead daemon and the
  handler disarmed. The plain `exit` hook still covers host-managed shutdown
  paths. Handlers remain idempotent against double-run, and `stop()` unbinds
  them — handler lifetime tracks the daemon, so discard/respawn cycles don't
  accumulate process signal listeners.
- `callKonnect` removes its abort listener on completion — no more listener
  leak per call on the caller's `AbortSignal` (`{once:true}` kept).
- `probeHealth` clears its timeout in a `finally` (timer leaked on abort).

### Removed

- Unused `probeHealth` re-export from the extension entrypoint.

## 0.1.5 (2026-09-14)

### Maintenance

- Dead-code removal: the `reused` flag/branch in `KonnectDaemon` could never be
  true (stranger daemons are never reused), so `DaemonStatus.reused`, the
  `running: child || reused` disjunct, and the status tool's "reused (external)"
  label are gone. Header comment in `daemon.ts` now describes current behavior
  (reuse only our own healthy daemon; strangers are never reused).

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
