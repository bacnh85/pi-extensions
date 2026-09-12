# Changelog

## 0.2.1 (2026-09-12)

### Changed

- `isAtLeastVersion` is now imported from `version-gate.js` instead of a
  verbatim duplicate in `index.ts`.
- `/rtk status` reuses the version fetched by `checkRtkAvailable` instead of
  spawning `rtk --version` a second time.

### Fixed

- README no longer claims `RTK_DISABLED` is read from cwd/Pi-global `.env`
  files — it is read from the process environment only.
- Clarified the availability-gate comment: rtk >= 0.23 is required for
  availability; >= 0.46 only re-enables find passthrough.

## 0.2.0 (2026-08-31)

### Changed

- find-predicate blocklist is now version-gated: rtk ≥ 0.46 dispatches on find's
  grammar and passes unmodeled predicates through to real find (never-worse
  guard), so `-not/!/-or/-o/-and/-a/-newer/-perm/-size/-mtime/-mmin/-atime/
  -amin/-ctime/-cmin/-empty/-link` and `(` `)` groups rewrite again (round-trip
  verified against native find). rtk < 0.46 keeps the old strict blocklist.
- Always rejected regardless of version: `-exec/-execdir/-delete/-print0/
  -fprint0/-fprintf/-fprint/-regex/-iregex/-regextype` (mutating or consumer-
  contract tokens where rtk's compact display is lossy).

### Added

- `npm test` script (`node --test`) — findFallback tests were present but never
  run by CI's `npm pack --dry-run`.

### Fixed

- Version-gate helpers live in a new `version-gate.js` module instead of new
  exports in `findFallback.js`: pi's jiti loader can pair a reloaded `index.ts`
  with a stale cached copy of an existing module, which crashed at import
  (`parseSemver is not a function`). New imports must target new files.

## 0.1.13 (2026-08-29)

### Added

- `/rtk` argument completion offers `enable|disable|status`.

## 0.1.12 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

All notable changes to `pi-rtk` will be documented in this file.

## 0.1.11 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.1.10 (2026-07-24)

### Improvements

- Fixed handling for `!cmd` user shell command rewrites and context-visible commands.

## 0.1.8 (2026-07-10)

### Features

- Initial release of `pi-rtk` bash tool token rewriting extension.
