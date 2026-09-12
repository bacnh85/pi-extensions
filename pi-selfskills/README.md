# @bacnh85/pi-selfskills

Pi extension for **skill self-improvement**: one `skill_manage` tool that lets
the agent patch gaps in its own loaded skills and create new skills for
recurring procedures — with a writable-root allowlist, real SDK validation,
atomic writes, and content-addressed backups. Ships a `selfskills` doc-skill
(long-form patch/create discipline) and injects a compact standing-rules block
each turn (patch-by-exception default: most tasks end with no skill write).

## Why

Skills rot the first time reality disagrees with them. Without tooling the
agent either silently works around a stale skill or rewrites the whole file by
hand. `pi-selfskills` makes the fix a first-class, guarded action: targeted
patch in the same turn the gap surfaces, validated against the same loader pi
uses at startup, with an automatic backup and a one-step restore.

## Tool: `skill_manage`

| Action | Params | What it does |
|---|---|---|
| `list` | `skill?` (filter) | Discovered skills: name — description (first 100 chars) — path — patchable yes/no |
| `read` | `skill` \| `path`, `file?` | SKILL.md (default) or a bundled file; truncated at 30k chars; records the SKILL.md as read. Scoped to discovered skill dirs — no arbitrary-file reads |
| `patch` | `skill`\|`path`, `old_string`, `new_string` | Targeted replacement; backup first; refuses non-unique matches and invalid results |
| `create` | `name`, `description`, `body` | New skill `<skillsDir>/<name>/SKILL.md`, SDK-validated |
| `write` | `skill`\|`path`, `file`, `content` | Create/overwrite a bundled file (`references/*.md`, `scripts/…`); SKILL.md is patch-only; overwrites backed up |
| `delete` | `skill`\|`path`, `file?` | Delete a bundled file — or the whole skill (omit `file`): full snapshot first, always restorable |
| `restore` | `skill`\|`path`, `file?`, `backup?` | Revert SKILL.md or a bundled file to latest/named backup; recreate a deleted skill from its deletion snapshot; current content backed up first |
| `operations` | `[{action: patch\|write\|delete, …}]` | All-or-nothing batch: planned on an in-memory overlay, fully validated, committed together — any failure writes NOTHING |

```text
skill_manage { "action": "list" }
skill_manage { "action": "read",  "skill": "my-skill" }
skill_manage { "action": "patch", "skill": "my-skill",
               "old_string": "Run npm build.", "new_string": "Run npm run build." }
skill_manage { "action": "create", "name": "deploy-checks",
               "description": "Use when deploying. Verifies health after rollout.",
               "body": "1. ...\n2. ..." }
skill_manage { "action": "restore", "skill": "my-skill" }
```

Patch gates, in order: non-empty `old_string` ≠ `new_string` → file was read
this session → **file unchanged since read** (hash precondition — re-read and
retry on mismatch) → path inside a writable root → `old_string` occurs exactly
once → patched result passes real SDK skill validation → backup → atomic write
under the shared file-mutation queue.

**Writable roots** (everything else is refused):

- `<agentDir>/skills` (i.e. `$PI_CODING_AGENT_DIR/skills` or `~/.pi/agent/skills`)
- `<cwd>/.pi/skills` — only when the project is trusted (`isProjectTrusted()`)
- project `.agents/skills` (cwd + ancestors up to the git root) — trusted projects,
  unless `patchProjectAgents: false`
- local package skill dirs from settings `packages` — unless `patchPackages: false`
- the `selfskills.skillsDir` override

**Read-only by policy:** user-level `~/.agents/skills`, `npm:`/`node_modules`
package skills, skills from settings skill arrays / `--skill` flags, anything in
**untrusted** projects (including their declared packages — never scanned), and
anything outside the roots above.

## Command

`/selfskills` — status: enabled, inject, skills dir, discovered skills, backup count.

## Configuration (`settings.json`, key `selfskills`)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` disables the tool and injection |
| `inject` | `true` | Prepend the standing-rules block to the system prompt each turn |
| `skillsDir` | `~/.pi/agent/skills` | Create target dir (tilde-expanded); also a writable root |
| `backupCap` | `10` | Backups kept per skill (oldest pruned) |
| `patchPackages` | `true` | Patch skills in LOCAL packages from settings `packages` (monorepo source; git + backups make it safe). `npm:`/`node_modules` package skills are always read-only. |
| `patchProjectAgents` | `true` | Patch project `.agents/skills` in trusted projects, within the git boundary (the project dir itself when not git-tracked). User-level `~/.agents/skills` stays read-only. |

Settings resolve `<cwd>/.pi/settings.json` (trusted projects only — mirrors
Pi's own trust gating, so an untrusted repo cannot steer this extension)
`→` `<agentDir>/settings.json` where `<agentDir>` is `$PI_CODING_AGENT_DIR`
or `~/.pi/agent`; first found wins.

npm-installed package skills and skills from settings skill arrays / `--skill`
flags may be absent from `list` (read-only regardless). LOCAL package skills
(monorepo checkouts) are listed and patchable unless `patchPackages: false`.

## Backups

Content-addressed snapshots live under
`~/.pi/agent/selfskills/backups/<skill>/<relpath>/<yyyyMMdd-HHmmss.mmm>-<sha256[:10]>.md`
where `<relpath>` mirrors the file inside the skill dir (`SKILL.md` for the
skill file; v0.1 flat SKILL.md backups remain restorable). Whole-skill
deletions snapshot to `<skill>/__deleted__/<stamp>/…`. Manual restore is just
a copy:

```bash
cp ~/.pi/agent/selfskills/backups/my-skill/SKILL.md/<yyyyMMdd-HHmmss.mmm>-<hash>.md \
   ~/.pi/agent/skills/my-skill/SKILL.md
```

## Install

```bash
pi install @bacnh85/pi-selfskills
```

## Test

```bash
npm ci && npm test   # mocha + tsx, tmpdir-isolated
```
