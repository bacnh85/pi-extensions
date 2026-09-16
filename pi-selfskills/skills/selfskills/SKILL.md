---
name: selfskills
description: "Use when improving pi skills with skill_manage (list/read/patch/create/restore). Patch gaps same-turn with minimal diffs; create only recurring procedures."
---

# Skill self-improvement discipline

You can improve the skills loaded into this session with the `skill_manage`
tool. This skill is the long-form version of the injected standing rules; the
short block in your system prompt wins on conflicts.

## Default: patch by exception

Most tasks end with **no** skill write. A write is warranted only when all of
these hold:

1. The skill itself was part of the task (you read or followed it).
2. The gap is a **reusable procedure**, not a one-off task detail.
3. The fix addresses the skill's **root cause** — a wrong or missing rule —
   not a symptom you happened to hit.

If any answer is no, note the gap to the user and move on. One-off task
details, environment quirks, and always-on facts belong in memory
(evolve/munin), never in skills.

## Patching (`skill_manage patch`)

- **Same turn.** Patch the moment the gap surfaces, while the exact wording is
  still in context. Do not defer to "later".
- **Read first.** Patches are refused unless the file was read this session
  (`skill_manage read` or the `read` tool). If the file changed on disk since
  that read, the patch is refused (hash mismatch) — re-read and re-apply
  against the current content instead of forcing.
- **Smallest unique edit.** `old_string` must occur exactly once — include
  just enough surrounding text to disambiguate. Never rewrite a whole skill
  file; if you're tempted to, the change is probably not a patch.
- **Keep the frontmatter honest.** The `description` is the load gate: if the
  patch changes what the skill does or when it applies, patch the description
  in the same pass. First ~57 chars must stand alone as a trigger:
  "Use when X. One-line behavior."
- **Nothing is lost.** Every patch snapshots the original to the backup dir;
  `restore` reverts if a patch turned out wrong.

## Extend, don't fork (`skill_manage write`)

Content that doesn't fit the SKILL.md body goes into bundled files: `write`
with `file: "references/<topic>.md"` (also `scripts/`, `assets/`), then patch
the body to point at it. Wrap dependent changes in one `operations[]` batch —
it validates everything first and commits together, so a half-applied state is
impossible. Extend an existing references file by topic before creating a
sibling skill.

## Deleting (`skill_manage delete`)

Dedup needs lifecycle closure. Delete dead bundled files (with `file:`) or
whole dead skills (omit `file:`) — every deletion is fully snapshotted and
restorable. Read the skill first; deletion refuses on a stale read.

## Creating (`skill_manage create`)

Judgment, not counting. Create only when the knowledge is:

- **Procedural** — steps/rules someone would follow again.
- **Non-trivial to rederive** — it cost real debugging or a correction loop.
- **Plausibly recurring** — a different future task would plausibly hit it.

Over-eager creation is a rot vector: redundant skills dilute routing for the
real ones. Names are `lowercase-hyphen`, 1–64 chars. Body is imperative — one
rule per lesson, no incident narration, never secrets.

## Lifecycle

- New skills auto-load **next session**; `skill_manage create` returns the
  path — read it immediately to apply the new skill in the current session.
- `list` marks each skill patchable or read-only. Package and node_modules
  skills are read-only, as are project skills in untrusted projects.
- Writable roots: `<agentDir>/skills`, `<cwd>/.pi/skills` (trusted projects),
  plus the `selfskills.skillsDir` override. Everything else is refused.
