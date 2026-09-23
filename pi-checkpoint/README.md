# pi-checkpoint

Git-backed undo/redo for [Pi](https://pi.dev).

Snapshots file state into a dedicated ref namespace at the start of each turn, so `/undo` rolls back the last message **and** its file changes together. Fills Pi's gap vs OpenCode's git-backed `/undo`/`/redo` — Pi has conversation-level `/tree`/`/fork`/`/clone` but no file-state snapshots tied to turns.

## Install

```bash
pi install npm:@bacnh85/pi-checkpoint
```

## Commands

| Command | Description |
|---------|-------------|
| `/undo [n]` | Restore file state to `n` turns ago (default 1) |
| `/redo [n]` | Re-apply file changes after `/undo` |
| `/checkpoint` | Show the checkpoint stack for this session |

## How it works

- On every `turn_start`, captures the working/index tree via `git stash create` (which does **not** touch your stash list) and stores it under `refs/pi-checkpoints/<sessionId>/<n>`.
- `/undo` pops snapshots into a redo buffer and restores the prior checkpoint with `git checkout <ref> -- .` (tracked files only; untracked files are left alone).
- `/redo` re-applies from the redo buffer.
- Uses a dedicated ref namespace so it **never** touches your working refs, branches, or stash.

## Requirements

- The project must be a **git repository**. Outside a git repo, the commands no-op gracefully with a notification.

## Why

Pi's `/tree` lets you navigate conversation history, but if the agent made 20 edits across 8 files and you want to roll back one message, you'd manually `git stash` or `git checkout` — disconnected from the conversation. `pi-checkpoint` ties file state to turns so `/undo` is a single command.

## Caveats

- Snapshots are per-session and in-memory; they are not persisted across Pi restarts (the git refs are, but the stack index resets). A resumed session reuses the same sessionId and **continues numbering from the highest existing ref** (`<sid>/<max+1>`), so old restore points are never overwritten.
- Restore is tracked-files-only. Untracked files created during the undone turn remain until you remove them — and tracked files that were **added** during the undone turn also remain after restore (`git checkout <ref> -- .` only updates paths tracked at the snapshot; files newly added to the index stay behind). Remove them manually if unwanted.
- Checkpoint refs are pruned on `session_start` when older than **30 days** (`refs/pi-checkpoints/<sid>/<n>`, by commit date); older restore points are deleted permanently.

## License

MIT
