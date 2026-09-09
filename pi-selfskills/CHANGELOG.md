# Changelog

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
