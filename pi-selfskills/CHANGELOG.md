# Changelog

## 0.3.1

- **Fix: deletion-snapshot ordering** — `snapshotDir` re-evaluated its millisecond stamp inside the collision loop, so a mid-loop tick could emit `T2-2` while bare `T2` stayed free; the next snapshot claimed `T2`, sorting **before** `T2-2`. Consequences: cap-pruning could delete the *newest* snapshot and `latestDeletedSnapshot`/restore could resolve a stale one (seen live as a CI test flake). The stamp is now evaluated once per call — names are strictly monotonic with creation order.

## 0.3.0

- **`create` root placement**: new optional `root` param places a new skill in any writable root (path shown by `list`) — e.g. a project's `.agents/skills` — instead of only `~/.pi/agent/skills`/skillsDir. Previously the only way to get a project-local new skill was raw `write`, bypassing validation + backups (observed live in session 01a08bcc). Relative roots anchor to the session cwd; root matching canonicalizes both sides (macOS /var↔/private/var aliasing can't cause a refusal); the cwd-level `.agents/skills` is listed and creatable even when it doesn't exist yet (bootstrap), and create mkdir -p's the target.
- `list` now shows the writable roots (`user`/`project`/`project-agents`/`skillsDir`/`package`) so `root=` values are discoverable.
- Docs truth: `LIST_NOTE` and the tool description now state that project `.agents/skills` roots are patchable (true since 0.2.0 `patchProjectAgents`) and where `create` lands; the discipline block tells the model to use `root=` instead of bypassing with raw write/sed.
- **Guard fix**: the user-level `~/.agents/skills` can never become a writable project root — even when the session cwd is `$HOME` (non-git), whose boundary would otherwise swallow it. Closes a 0.2.x hole where a trusted `$HOME` cwd made an existing `~/.agents/skills` patchable, and keeps the new bootstrap root from inheriting the same edge.

## 0.2.0

- **Bundled-file writes**: `write` action creates/overwrites `references/`, `scripts/`, etc. under an existing skill's directory — extend a reference by topic instead of forking a sibling skill. SKILL.md stays patch-only; overwrites are backed up.
- **Delete**: bundled files (backup + restorable, empty parent dirs pruned) and whole skills (full-file snapshot to `backups/<skill>/__deleted__/`, restorable — recreates the skill from its snapshot).
- **Batch atomicity**: `operations[]` runs multiple patch/write/delete ops against an in-memory overlay, validates every resulting SKILL.md with the real SDK loader, then commits together — any failure writes nothing.
- **Read-hash precondition**: patches refuse with "hash mismatch" if the file changed on disk since it was read (other session/user/tool) — re-read and retry instead of clobbering.
- Restore extended: per-bundled-file restore (`file=` param), deleted-skill recreation, v0.1 flat SKILL.md backups still restorable.
- Backup layout v2: `backups/<skill>/<relpath>/<stamp.ms>-<sha256[:10]>.md`.

## 0.1.0

- Initial release: `skill_manage` tool with `list`/`read`/`patch`/`create`/`restore` actions.
- Writable-root allowlist (`<agentDir>/skills`, trusted `<cwd>/.pi/skills`, `skillsDir` override, local package skills); package/node_modules skills read-only.
- Patch gates: read-before-patch, unique-match, real SDK validation, backup + atomic write via `withFileMutationQueue`.
- Content-addressed backups with per-skill cap pruning and restore.
- `selfskills` doc-skill + per-turn standing-rules injection (`selfskills.inject`).
- `/selfskills` status command.
