# Changelog

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
