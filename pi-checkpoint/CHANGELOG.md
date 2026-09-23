# Changelog

## 0.1.5 (2026-09-22)

### Fixed

- **Data loss on resume**: `session_start` reset the checkpoint counter to 0, so a
  resumed session (same sessionId) overwrote the prior session's refs
  (`refs/pi-checkpoints/<sid>/0…`), silently destroying restore points. The
  counter is now seeded from existing refs (`max index + 1`) at `session_start`
  and whenever the sessionId changes, so resumed sessions append instead of
  overwrite.

### Documented

- 30-day ref pruning on `session_start`.
- `/undo` restore leaves tracked files **added** during the undone turn in place
  (tracked-new files survive, like untracked ones); remove them manually.

## [0.1.4] - 2026-09-21

### Fixed

- `git()` now also treats resolved non-zero exits (`pi.exec` resolves with
  `.code` instead of throwing) as failures. Previously a failed
  `git stash create` with empty stdout was recorded as a clean tree, so a
  later `/undo` ran `git checkout HEAD -- .` and silently discarded tracked
  changes. Regression tests cover the resolve path for both snapshot and
  restore.

## [0.1.3] - 2026-09-20

### Fixed

- Checkpoint refs (`refs/pi-checkpoints/<sid>/<n>`) are now pruned on
  `session_start` when older than 30 days (`git for-each-ref` +
  `git update-ref -d`), instead of accumulating forever. Best-effort:
  failures are swallowed.

## 0.1.2 (2026-09-12)

### Fixed

- `/undo` to a clean ("null") checkpoint now actually restores: runs `git checkout HEAD -- .` (discards tracked changes, leaves untracked files alone) instead of reporting success while doing nothing.
- `/redo N` replay order fixed: re-applies oldest-first, so depth ≥ 2 redo ends at the pre-undo state instead of scrambling the stack. A new turn also clears the redo buffer (standard undo/redo semantics).
- Git failures during snapshot are no longer mistaken for a clean tree: a failed `git stash create` or `git update-ref` skips the checkpoint and notifies instead of recording a bogus empty one.

## 0.1.1 (2026-08-29)

### Added

- `/redo` argument completion mirrors `/undo` (`1|2|3` depths).

## 0.1.0

- Initial release.
- Git-backed `/undo [n]` and `/redo [n]` tied to turns.
- `/checkpoint` shows the session checkpoint stack.
- Snapshots stored under `refs/pi-checkpoints/<sessionId>/<n>` via `git stash create` (never touches user stash list).
- Graceful no-op outside a git repository.
- Zero dependencies, plain JS.
