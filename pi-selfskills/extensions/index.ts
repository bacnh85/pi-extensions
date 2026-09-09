import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { readSelfSkillsSettings, agentDir, type SelfSkillsSettings } from "./lib/config";
import {
  backupRoot,
  countBackups,
  isValidRelpath,
  latestDeletedSnapshot,
  listBackups,
  listDeletedSnapshots,
  snapshot,
  snapshotDir,
} from "./lib/backup";
import {
  checkPatchable,
  discoverSkills,
  isContained,
  isContainedOrSelf,
  resolveSkillsDir,
  writableRoots,
} from "./lib/paths";
import {
  applyPatch,
  atomicWrite,
  buildSkillContent,
  contentHash,
  isValidSkillName,
  validateSkillContent,
} from "./lib/skillfile";

const READ_LIMIT = 30000;

/** Latest backup file for a skill file (relpath), or null. */
function latestBackupFile(skillName: string, relpath: string): string | null {
  const all = listBackups(skillName, relpath);
  return all.length > 0 ? all[all.length - 1] : null;
}

// npm/node_modules package skills and skills from settings skill-arrays /
// --skill flags aren't observable by an extension (Pi's loader passes them as
// explicit skillPaths); they're read-only regardless. LOCAL package skills
// (monorepo source) ARE listed and patchable unless patchPackages=false.
const LIST_NOTE =
  "Note: npm-installed package skills and skills from settings skill arrays or --skill flags may be absent from this list (read-only regardless). Patchable: ~/.pi/agent/skills, <trusted>/.pi/skills, the skillsDir override, and local (repo-checkout) package skills.";

const DISCIPLINE_BLOCK = `## pi-selfskills: skill self-improvement discipline

You have the skill_manage tool (list/read/patch/create/write/delete/restore,
plus operations[] for all-or-nothing multi-file batches) to improve the skills
loaded into this session. Default is patch-by-exception: most tasks end with
NO skill write. Write only when the skill itself was part of the task and left
a reusable gap.

PATCH (same turn the gap surfaces):
- Only if the skill was part of the task, the fix is a reusable procedure (not a
  one-off task detail), and it corrects the skill's root cause — the wrong or
  missing rule — not a symptom you happened to hit.
- Read the skill first (skill_manage read, or the read tool) — patches are
  refused otherwise; if the file changed on disk since the read, the patch is
  refused (hash mismatch) — re-read instead of forcing.
- Smallest unique old_string → new_string. Never rewrite a whole skill file.
- If the patch changes the skill's meaning, patch the frontmatter description in
  the same pass — the description is the load gate.
- DON'T patch one-off task details, environment quirks, or always-on facts —
  those belong in memory (evolve/munin), not skills.

EXTEND, DON'T FORK: content that doesn't fit the body goes into bundled files
(skill_manage write to references/<topic>.md, then patch SKILL.md to point at
it — one operations[] batch when both must land together). Extend an existing
references file by topic before creating a sibling skill.

DELETE for dedup: remove dead bundled files (delete with file=) or whole dead
skills (delete, no file=) — deletions are backed up and restorable.

CREATE (judgment, not counting):
- Only procedural + non-trivial-to-rederive + plausibly recurring knowledge.
  Over-eager creation is a rot vector: redundant skills dilute routing.
- The description is the load gate — its first ~57 chars must stand alone as a
  trigger: "Use when X. One-line behavior."
- Body: imperative, one rule per lesson; no incident narration; never secrets.
- New skills auto-load next session; read the returned path to use it now.`;

/** Skill files read this session: realpath → sha256 of content at read time.
 *  Patches re-hash current content and refuse on mismatch, so a file edited
 *  externally (other session, user, tool) between read and write is caught. */
const readThisSession = new Map<string, string>();

/** Test helper: clear per-session read state. Exported for tests only. */
export function _resetForTest(): void {
  readThisSession.clear();
}

interface ToolErr {
  content: [{ type: "text"; text: string }];
  details: { error: true };
}

function err(text: string): ToolErr {
  return { content: [{ type: "text", text }], details: { error: true } };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function selfskillsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "skill_manage",
    label: "Skill Manage",
    description:
      "Self-improve pi skills. Actions: list (discovered skills + patchable flag), read (SKILL.md + bundled files), patch (targeted old_string→new_string edit with backup), create (new skill from name/description/body), write (create/overwrite a bundled file like references/*.md), delete (remove a bundled file or a whole skill — backed up), restore (revert file or skill from backup). Package/node_modules skills are read-only. Batch: pass operations[] for all-or-nothing multi-file changes.",
    promptSnippet: "Self-improve skills: patch gaps in loaded skills, create skills for recurring procedures",
    promptGuidelines: [
      "Patch a skill in the same turn a gap surfaces — and only then; most tasks should end with no skill write at all.",
      "Read the skill before patching; use the smallest unique old_string — never rewrite a whole skill file. On hash-mismatch refusal, re-read instead of forcing.",
      "Extend existing references/ files via write (batch with the SKILL.md patch via operations[]) before forking a sibling skill; delete dead files/skills for dedup.",
      "Create only for procedural, non-trivial-to-rederive, plausibly recurring knowledge; never store secrets in skills.",
      "One-off task details, environment quirks, and always-on facts belong in memory (evolve/munin), not skills.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(
          [
            Type.Literal("list"),
            Type.Literal("read"),
            Type.Literal("patch"),
            Type.Literal("create"),
            Type.Literal("write"),
            Type.Literal("delete"),
            Type.Literal("restore"),
          ],
          { description: "list | read | patch | create | write | delete | restore. Omit when using operations[]." },
        ),
      ),
      operations: Type.Optional(
        Type.Array(
          Type.Object({
            action: Type.Union([Type.Literal("patch"), Type.Literal("write"), Type.Literal("delete")], { description: "Batch supports patch | write | delete." }),
            skill: Type.Optional(Type.String({ description: "Skill name for this op." })),
            path: Type.Optional(Type.String({ description: "Absolute SKILL.md path for this op." })),
            file: Type.Optional(Type.String({ description: "write/delete: relative path inside the skill dir (e.g. references/api.md)." })),
            old_string: Type.Optional(Type.String({ description: "patch: exact text to replace; must occur exactly once." })),
            new_string: Type.Optional(Type.String({ description: "patch: replacement text; empty string deletes." })),
            content: Type.Optional(Type.String({ description: "write: full file content." })),
          }),
          { description: "Batch planning is all-or-nothing: ops are validated together first — a validation failure writes NOTHING. A commit-time filesystem failure may partially apply and is reported with what landed." },
        ),
      ),
      skill: Type.Optional(Type.String({ description: "Skill name (from list). Alternative to path." })),
      path: Type.Optional(Type.String({ description: "Absolute SKILL.md path. Alternative to skill." })),
      old_string: Type.Optional(Type.String({ description: "patch: exact text to replace; must occur exactly once." })),
      new_string: Type.Optional(Type.String({ description: "patch: replacement text; empty string deletes." })),
      name: Type.Optional(Type.String({ description: "create: skill name, lowercase-hyphen (1-64 chars)." })),
      description: Type.Optional(Type.String({ description: "create: 'Use when X. One-line behavior.' ≤1024 chars, no newlines." })),
      body: Type.Optional(Type.String({ description: "create: markdown body, imperative rules." })),
      file: Type.Optional(Type.String({ description: "write/delete/restore: relative path inside the skill dir (e.g. references/api.md; omit for SKILL.md)." })),
      content: Type.Optional(Type.String({ description: "write: full file content." })),
      backup: Type.Optional(Type.String({ description: "restore: specific backup filename; default latest." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const trusted = ctx?.isProjectTrusted?.() === true;
      const settings = readSelfSkillsSettings(ctx.cwd, trusted);
      if (!settings.enabled) {
        return { content: [{ type: "text" as const, text: "pi-selfskills is disabled (selfskills.enabled=false)." }] };
      }
      if (Array.isArray(params.operations)) {
        if (params.action) return err("Provide either `operations` (batch) or a single `action`, not both.");
        return await executeBatch(params.operations, ctx.cwd, settings, trusted);
      }
      if (!params.action) {
        return err("Provide `action` (list/read/patch/create/write/delete/restore) or `operations` (batch).");
      }
      switch (params.action) {
        case "list":
          return listAction(ctx.cwd, settings, trusted, params.skill);
        case "read":
          return readAction(params, ctx.cwd, settings, trusted);
        case "patch":
          return await patchAction(params, ctx.cwd, settings, trusted);
        case "create":
          return await createAction(params, ctx.cwd, settings, trusted);
        case "write":
          return await writeAction(params, ctx.cwd, settings, trusted);
        case "delete":
          return await deleteAction(params, ctx.cwd, settings, trusted);
        case "restore":
          return await restoreAction(params, ctx.cwd, settings, trusted);
      }
    },
  });

  pi.registerCommand("selfskills", {
    description: "Show pi-selfskills status: inject, skills dir, discovered skills, backups.",
    handler: async (_args: string, ctx: any) => {
      const trusted = ctx?.isProjectTrusted?.() === true;
      const settings = readSelfSkillsSettings(ctx.cwd, trusted);
      const count = discoverSkills(ctx.cwd, agentDir(), trusted).skills.length;
      const roots = writableRoots(ctx.cwd, settings, trusted)
        .map((r) => `    - ${r.label}: ${r.root}`)
        .join("\n");
      ctx.ui.notify(
        `pi-selfskills ${settings.enabled ? "enabled" : "disabled"}:\n  Inject: ${settings.inject ? "on" : "off"}\n  Skills dir (create): ${resolveSkillsDir(settings, ctx.cwd)}\n  Discovered skills: ${count}\n  Backups: ${countBackups()} under ${backupRoot()}\n  Writable roots:\n${roots}`,
        "info",
      );
    },
  });

  // New/resume/fork session: read-tracking state must not leak across sessions.
  pi.on("session_start", (_event: any, _ctx: any) => {
    readThisSession.clear();
  });

  // Track COMPLETED built-in read results so a patch right after a read is
  // allowed. tool_result (not tool_call) records actual reads — a read that
  // failed or was blocked by another extension never unlocks a patch.
  pi.on("tool_result", (event: any, ctx: any) => {
    if (event?.toolName !== "read" || event?.isError) return;
    const p = event?.input?.path;
    if (typeof p !== "string" || p === "") return;
    try {
      const abs = path.resolve(ctx?.cwd ?? process.cwd(), p);
      if (!existsSync(abs)) return;
      const real = realpathSync(abs);
      readThisSession.set(real, contentHash(readFileSync(real, "utf8")));
    } catch {
      // best-effort: an unreadable path just won't be patch-eligible
    }
  });

  pi.on("before_agent_start", (event: any, ctx: any) => {
    const settings = readSelfSkillsSettings(ctx?.cwd, ctx?.isProjectTrusted?.() === true);
    if (!settings.enabled || !settings.inject) return;
    return { systemPrompt: `${DISCIPLINE_BLOCK}\n\n---\n\n${event.systemPrompt}` };
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function listAction(cwd: string, settings: ReturnType<typeof readSelfSkillsSettings>, trusted: boolean, filter?: string) {
  const skills = discoverSkills(cwd, agentDir(), trusted).skills;
  const f = (filter ?? "").toLowerCase();
  const rows = skills
    .filter((s) => !f || s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f))
    .map((s) => {
      const patchable = checkPatchable(s.filePath, cwd, settings, trusted).ok;
      const desc = s.description.length > 100 ? `${s.description.slice(0, 100)}…` : s.description;
      return `- ${s.name} — ${desc} — ${s.filePath} — patchable: ${patchable ? "yes" : "no"}`;
    });
  const text = rows.length
    ? `Discovered ${rows.length} skill(s):\n${rows.join("\n")}\n\n${LIST_NOTE}`
    : `No skills discovered.\n\n${LIST_NOTE}`;
  return { content: [{ type: "text" as const, text }] };
}

type Resolved = { absPath: string; name?: string };

function resolveTarget(params: any, cwd: string, trusted: boolean): Resolved | string {
  if (params.path && params.skill) return "Provide either `skill` or `path`, not both.";
  if (params.path) return { absPath: path.resolve(cwd, params.path) };
  if (params.skill) {
    const { skills } = discoverSkills(cwd, agentDir(), trusted);
    const hit =
      skills.find((s) => s.name === params.skill) ??
      skills.find((s) => s.name.toLowerCase() === params.skill.toLowerCase());
    if (!hit) return `Skill not found: ${params.skill}. Use action=list to see discovered skills.`;
    return { absPath: hit.filePath, name: hit.name };
  }
  return "Provide `skill` (name from list) or `path` (absolute SKILL.md path).";
}

function readAction(params: any, cwd: string, _settings: ReturnType<typeof readSelfSkillsSettings>, trusted: boolean) {
  const relpath = typeof params.file === "string" && params.file !== "" ? params.file : "SKILL.md";
  if (!isValidRelpath(relpath)) {
    return err("Invalid `file`: use a relative path inside the skill directory (e.g. references/api.md).");
  }
  const t = resolveTarget(params, cwd, trusted);
  if (typeof t === "string") return err(t);
  let abs: string;
  let content: string;
  try {
    abs = realpathSync(t.absPath);
    // file= re-anchors INSIDE the resolved skill's directory (SKILL.md default).
    if (relpath !== "SKILL.md") {
      const baseDir = path.dirname(abs);
      const anchored = path.join(baseDir, relpath);
      if (!isContained(baseDir, anchored)) {
        return err("Refusing: file escapes the skill directory.");
      }
      abs = realpathSync(anchored);
    }
    if (!statSync(abs).isFile()) {
      return err(`Refusing: ${abs} is not a regular file.`);
    }
    content = readFileSync(abs, "utf8");
  } catch (e: any) {
    return err(`File not found or unreadable: ${relpath !== "SKILL.md" ? path.join(path.dirname(t.absPath), relpath) : t.absPath} (${e?.message ?? e})`);
  }
  // Scope: only files inside a discovered skill's directory (SKILL.md,
  // references/, scripts/) — keeps the tool from reading arbitrary files
  // outside the permission rules other extensions apply to built-in read.
  const { skills } = discoverSkills(cwd, agentDir(), trusted);
  const known = skills.some((s) => {
    let base = s.baseDir;
    try {
      base = realpathSync(s.baseDir); // canonicalize — abs is a realpath, and
      // macOS /var→/private/var aliasing would otherwise false-negative
    } catch {
      // unreadable baseDir — compare raw
    }
    return isContainedOrSelf(base, abs);
  });
  if (!known) {
    return err(`Refusing: ${abs} is not inside a discovered skill directory. Use action=list to see skills.`);
  }
  readThisSession.set(abs, contentHash(content));
  const text =
    content.length > READ_LIMIT
      ? `${content.slice(0, READ_LIMIT)}\n\n[… truncated at ${READ_LIMIT} of ${content.length} chars — use the read tool for the rest]`
      : content;
  return { content: [{ type: "text" as const, text }] };
}

async function patchAction(params: any, cwd: string, settings: ReturnType<typeof readSelfSkillsSettings>, trusted: boolean) {
  // (1) per-action param validation
  if (typeof params.old_string !== "string" || params.old_string === "") {
    return err("patch requires a non-empty old_string.");
  }
  if (typeof params.new_string !== "string") {
    return err("patch requires new_string (a string; empty string deletes the old_string).");
  }
  if (params.old_string === params.new_string) {
    return err("old_string and new_string are identical — nothing to patch.");
  }
  const t = resolveTarget(params, cwd, trusted);
  if (typeof t === "string") return err(t);
  let real: string;
  try {
    real = realpathSync(t.absPath);
  } catch {
    return err(`File not found: ${t.absPath}`);
  }
  // (2) must have been read this session
  if (!readThisSession.has(real)) {
    return err("Refusing to patch: read the skill first (skill_manage read, or the read tool), then patch.");
  }
  // (3) patchable location
  const gate = checkPatchable(real, cwd, settings, trusted);
  if (!gate.ok) return err(gate.reason ?? "Target is not patchable.");
  // Frontmatter names are unvalidated by the SDK loader (invalid name = warning
  // only) — never let one become a backup path component. Same for the on-disk
  // directory name fallback: if neither is valid, refuse cleanly instead of
  // letting backupDirFor throw mid-mutation.
  const skillName = t.name && isValidSkillName(t.name) ? t.name : path.basename(path.dirname(gate.realpath));
  if (!isValidSkillName(skillName)) {
    return err(
      `Refusing: neither the skill's frontmatter name nor its directory name ("${skillName}") is a valid skill name (lowercase-hyphen), so a safe backup path cannot be formed. Rename the directory or fix the frontmatter name first.`,
    );
  }
  // Read-hash precondition: the file must not have changed since it was read
  // (other session, user editor, another tool). Pre-queue check for a fast,
  // precise error; the authoritative re-check runs inside the queue below.
  const readHash = readThisSession.get(real);
  if (readHash !== undefined) {
    let currentHash: string;
    try {
      currentHash = contentHash(readFileSync(gate.realpath, "utf8"));
    } catch {
      return err(`File not readable: ${gate.realpath}`);
    }
    if (currentHash !== readHash) {
      return err("Refusing: the file changed on disk since it was read (hash mismatch). Re-read the skill, then re-apply the patch against the current content.");
    }
  }
  // (4)-(6) read → apply → validate → backup → write INSIDE the per-file
  // mutation queue: two patches in one parallel tool batch would otherwise
  // both compute from the same pre-write content (lost update).
  let result: any;
  await withFileMutationQueue(gate.realpath, async () => {
    let current: string;
    try {
      current = readFileSync(gate.realpath, "utf8");
    } catch {
      result = err(`File not readable: ${gate.realpath}`);
      return;
    }
    // Authoritative hash check on the queued bytes — an external write landing
    // between the pre-queue check and here is caught, not patched over.
    if (readHash !== undefined && contentHash(current) !== readHash) {
      result = err("Refusing: the file changed on disk since it was read (hash mismatch). Re-read the skill, then re-apply the patch against the current content.");
      return;
    }
    const applied = applyPatch(current, params.old_string, params.new_string);
    if (!applied.ok) {
      result = err(`${applied.reason} (${applied.occurrences} occurrence(s) of old_string). Nothing was written.`);
      return;
    }
    const validated = validateSkillContent(applied.content, t.name);
    if (!validated.ok) {
      result = err(`${validated.reason} — nothing was written. Adjust the patch so the result keeps valid frontmatter.`);
      return;
    }
    const backup = snapshot(skillName, current, settings.backupCap);
    atomicWrite(gate.realpath, applied.content);
    // The tool's own write becomes the new read-state: the gate only exists to
    // catch EXTERNAL changes, not our own committed ones.
    readThisSession.set(gate.realpath, contentHash(applied.content));
    result = {
      content: [
        {
          type: "text" as const,
          text: `Patched ${gate.realpath} (backup ${backup.file}). If the skill's meaning changed, also patch the frontmatter description in this same turn.`,
        },
      ],
      details: { backup: backup.file },
    };
  });
  return result;
}

async function createAction(params: any, cwd: string, settings: ReturnType<typeof readSelfSkillsSettings>, trusted: boolean) {
  const name = typeof params.name === "string" ? params.name : "";
  if (!isValidSkillName(name)) {
    return err("create requires name matching ^[a-z0-9]+(-[a-z0-9]+)*$ (1-64 chars).");
  }
  const desc = typeof params.description === "string" ? params.description : "";
  if (!desc.trim() || desc.length > 1024 || /[\r\n]/.test(desc)) {
    return err("create requires description: non-empty, ≤1024 chars, no newlines ('Use when X. One-line behavior.').");
  }
  const body = typeof params.body === "string" ? params.body : "";
  if (!body.trim()) return err("create requires a non-empty body.");
  const target = path.join(resolveSkillsDir(settings, cwd), name, "SKILL.md");
  if (existsSync(target)) return err(`Refusing: ${target} already exists.`);
  const { skills } = discoverSkills(cwd, agentDir(), trusted);
  const clash = skills.find((s) => s.name === name);
  if (clash) return err(`Refusing: a skill named "${name}" is already discovered (${clash.filePath}).`);
  const content = buildSkillContent(name, desc, body);
  const validated = validateSkillContent(content, name);
  if (!validated.ok) return err(validated.reason ?? "Skill content failed validation.");
  // Duplicate check INSIDE the queue: two parallel creates of one name must
  // not silently overwrite each other — the second refuses instead.
  let result: any;
  await withFileMutationQueue(target, async () => {
    if (existsSync(target)) {
      result = err(`Refusing: ${target} already exists.`);
      return;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    atomicWrite(target, content);
    result = {
      content: [
        {
          type: "text" as const,
          text: `Created skill \`${name}\` at \`${target}\`. It auto-loads next session; read that path now to apply it in this session.`,
        },
      ],
      details: { path: target },
    };
  });
  return result;
}

async function restoreAction(params: any, cwd: string, settings: ReturnType<typeof readSelfSkillsSettings>, trusted: boolean) {
  const relpath = typeof params.file === "string" && params.file !== "" ? params.file : "SKILL.md";
  if (!isValidRelpath(relpath)) return err("Invalid `file`: use a relative path inside the skill directory (e.g. references/api.md).");

  // Deleted-skill restore: the skill is no longer discovered, but a deletion
  // snapshot exists — recreate it in the create target dir (skillsDir).
  const t = resolveTarget(params, cwd, trusted);
  if (typeof t === "string") {
    const name = typeof params.skill === "string" ? params.skill : "";
    if (!name || params.path || !isValidSkillName(name)) return err(t);
    const snap = latestDeletedSnapshot(name);
    if (!snap) return err(t);
    const targetDir = path.join(resolveSkillsDir(settings, cwd), name);
    if (existsSync(targetDir)) {
      return err(`Refusing: ${targetDir} already exists — deleted-skill restore only recreates a missing skill.`);
    }
    const files = collectFiles(snap.dir, snap.dir);
    const skillMd = files.find((f) => f.relpath === "SKILL.md");
    if (!skillMd) return err(`Refusing restore: deletion snapshot ${snap.dir} has no SKILL.md.`);
    // Snapshot provenance is tool-generated; the backup KEY can legitimately
    // differ from an (invalid) frontmatter name — validate structurally only.
    // SKILL.md is text by nature; bundled assets stay Buffers.
    const validated = validateSkillContent(skillMd.content.toString("utf8"));
    if (!validated.ok) {
      return err(`Refusing restore: snapshot content failed validation (${validated.reason}).`);
    }
    try {
      for (const f of files) {
        const target = path.join(targetDir, f.relpath);
        await withFileMutationQueue(target, async () => {
          mkdirSync(path.dirname(target), { recursive: true });
          atomicWrite(target, f.content);
        });
      }
    } catch (e: any) {
      // Best-effort cleanup of the partial dir — the snapshot is retained, so a
      // retry starts clean instead of dead-ending on "already exists".
      try {
        rmSync(targetDir, { recursive: true, force: true });
      } catch {
        // leave partial state; the error message reports it
      }
      return err(`Restore failed mid-write: ${e?.message ?? e}. Partial output at ${targetDir} was removed; the snapshot is intact — retry.`);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Recreated deleted skill \`${name}\` at \`${targetDir}\` from snapshot ${snap.dir} (${files.length} file(s)). It auto-loads next session; read that path now to apply it in this session.`,
        },
      ],
      details: { path: targetDir, snapshot: snap.dir },
    };
  }

  const gate = checkPatchable(t.absPath, cwd, settings, trusted);
  if (!gate.ok) return err(`Refusing restore: ${gate.reason}`);
  // Same frontmatter-name guard as patchAction — backup paths only.
  const skillName = t.name && isValidSkillName(t.name) ? t.name : path.basename(path.dirname(gate.realpath));
  if (!isValidSkillName(skillName)) {
    return err(`Refusing restore: directory name "${skillName}" is not a valid skill name, so a safe backup path cannot be formed.`);
  }
  const all = listBackups(skillName, relpath);
  const wanted = typeof params.backup === "string" && params.backup !== "" ? (params.backup.endsWith(".md") ? params.backup : `${params.backup}.md`) : null;
  const backupFile = wanted ? (all.find((f) => path.basename(f) === wanted) ?? null) : latestBackupFile(skillName, relpath);
  if (!backupFile) {
    return err(
      `No backup${params.backup ? ` named ${params.backup}` : ""} found for ${relpath} of skill "${skillName}" under ${backupRoot()}.`,
    );
  }
  let backupContent: string;
  try {
    backupContent = readFileSync(backupFile, "utf8");
  } catch {
    return err(`Backup unreadable: ${backupFile}`);
  }
  // SKILL.md restores get the same SDK validation as a patch; bundled files
  // are restored as-is.
  const target = relpath === "SKILL.md" ? gate.realpath : path.join(path.dirname(gate.realpath), relpath);
  if (relpath === "SKILL.md") {
    const validated = validateSkillContent(backupContent, t.name);
    if (!validated.ok) {
      return err(`Refusing restore: backup content failed validation (${validated.reason}).`);
    }
  }
  // Read → snapshot current → write INSIDE the queue (same lost-update
  // reasoning as patch); restore is itself reversible via the re-backup.
  let result: any;
  await withFileMutationQueue(target, async () => {
    let current: string | null = null;
    if (existsSync(target)) {
      try {
        current = readFileSync(target, "utf8");
      } catch {
        result = err(`File not readable: ${target}`);
        return;
      }
    }
    const currentBackup = current !== null ? snapshot(skillName, current, settings.backupCap, agentDir(), relpath) : null;
    mkdirSync(path.dirname(target), { recursive: true });
    atomicWrite(target, backupContent);
    if (relpath === "SKILL.md") readThisSession.set(target, contentHash(backupContent));
    result = {
      content: [
        {
          type: "text" as const,
          text: `Restored ${target} from backup ${backupFile}.${currentBackup ? ` Current content was backed up to ${currentBackup.file}.` : ""}`,
        },
      ],
      details: { restoredFrom: backupFile, backup: currentBackup?.file },
    };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Bundled-file write + delete
// ---------------------------------------------------------------------------

/** Resolve the skill dir + SKILL.md path for file-level ops (write/delete-file).
 *  `skill` name preferred; `path` accepted only when it IS the skill's SKILL.md. */
function resolveSkillDir(params: any, cwd: string, trusted: boolean): { baseDir: string; skillFilePath: string; skillName: string } | string {
  const t = resolveTarget(params, cwd, trusted);
  if (typeof t === "string") return t;
  let real: string;
  try {
    real = realpathSync(t.absPath);
  } catch {
    return `File not found: ${t.absPath}`;
  }
  if (path.basename(real) !== "SKILL.md") {
    return "Provide the skill's SKILL.md (or use `skill` name) — file ops anchor on the skill directory.";
  }
  const baseDir = path.dirname(real);
  const skillName = t.name && isValidSkillName(t.name) ? t.name : path.basename(baseDir);
  if (!isValidSkillName(skillName)) {
    return `Refusing: directory name "${skillName}" is not a valid skill name, so safe backup paths cannot be formed.`;
  }
  return { baseDir, skillFilePath: real, skillName };
}

/** Remove now-empty parent dirs between dir (inclusive) and stop (exclusive). */
function pruneEmptyDirs(dir: string, stop: string): void {
  let cur = dir;
  for (;;) {
    if (!isContainedOrSelf(stop, cur)) return;
    try {
      if (readdirSync(cur).length > 0) return;
      rmSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

/** Walk a directory collecting every file's content keyed by relpath.
 *  Buffers, not utf8 strings — skills may ship non-UTF8 assets (images,
 *  binaries) and whole-skill delete/restore must round-trip byte-for-byte. */
function collectFiles(dir: string, baseDir: string, out: { relpath: string; content: Buffer }[] = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, baseDir, out);
    else out.push({ relpath: path.relative(baseDir, p), content: readFileSync(p) });
  }
  return out;
}

async function writeAction(params: any, cwd: string, settings: ReturnType<typeof readSelfSkillsSettings>, trusted: boolean) {
  const file = typeof params.file === "string" ? params.file : "";
  if (!isValidRelpath(file)) {
    return err("write requires `file`: a relative path inside the skill directory (e.g. references/api.md).");
  }
  if (path.basename(file) === "SKILL.md") {
    return err("Refusing: SKILL.md is only writable via patch (targeted edits) or create.");
  }
  const content = typeof params.content === "string" ? params.content : "";
  if (!content) return err("write requires non-empty `content`.");
  const r = resolveSkillDir(params, cwd, trusted);
  if (typeof r === "string") return err(r);
  const gate = checkPatchable(r.skillFilePath, cwd, settings, trusted);
  if (!gate.ok) return err(gate.reason ?? "Target is not patchable.");
  if (!readThisSession.has(r.skillFilePath)) {
    return err("Refusing to write: read the skill (its SKILL.md) first, then write bundled files.");
  }
  const target = path.join(r.baseDir, file);
  if (path.relative(r.baseDir, target).startsWith("..") || path.isAbsolute(path.relative(r.baseDir, target))) {
    return err("Refusing: file escapes the skill directory.");
  }
  if (existsSync(target) && !statSync(target).isFile()) {
    return err(`Refusing: ${target} exists and is not a regular file.`);
  }
  // Backup-of-current happens inside the queue (same bytes that get written).
  let result: any;
  await withFileMutationQueue(target, async () => {
    const existed = existsSync(target);
    let backupFile: string | null = null;
    try {
      backupFile = existed ? snapshot(r.skillName, readFileSync(target, "utf8"), settings.backupCap, agentDir(), file).file : null;
    } catch (e: any) {
      result = err(`Existing file unreadable, nothing written: ${target} (${e?.message ?? e})`);
      return;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    atomicWrite(target, content);
    result = {
      content: [
        {
          type: "text" as const,
          text: existed
            ? `Wrote ${target} (previous content backed up to ${backupFile}).`
            : `Created ${target}. If the skill's SKILL.md should point to it, patch it in this same turn.`,
        },
      ],
      details: { path: target, backup: backupFile },
    };
  });
  return result;
}

async function deleteAction(params: any, cwd: string, settings: ReturnType<typeof readSelfSkillsSettings>, trusted: boolean) {
  const r = resolveSkillDir(params, cwd, trusted);
  if (typeof r === "string") return err(r);
  const gate = checkPatchable(r.skillFilePath, cwd, settings, trusted);
  if (!gate.ok) return err(`Refusing delete: ${gate.reason}`);
  if (!readThisSession.has(r.skillFilePath)) {
    return err("Refusing to delete: read the skill (its SKILL.md) first — deletion is destructive.");
  }
  const file = typeof params.file === "string" ? params.file : "";

  // Bundled-file delete: backup, remove, prune empty parents.
  if (file) {
    if (!isValidRelpath(file)) {
      return err("delete requires `file` as a relative path inside the skill directory, or omit it to delete the whole skill.");
    }
    if (path.basename(file) === "SKILL.md") {
      return err("Refusing: to remove the whole skill omit `file`; SKILL.md alone is not deletable.");
    }
    const target = path.join(r.baseDir, file);
    if (!isContained(r.baseDir, target)) {
      return err("Refusing: file escapes the skill directory.");
    }
    if (!existsSync(target)) return err(`File not found: ${target}`);
    if (!statSync(target).isFile()) return err(`Refusing: ${target} is not a regular file.`);
    let result: any;
    await withFileMutationQueue(target, async () => {
      let backup;
      try {
        backup = snapshot(r.skillName, readFileSync(target, "utf8"), settings.backupCap, agentDir(), file);
      } catch (e: any) {
        result = err(`Existing file unreadable, nothing deleted: ${target} (${e?.message ?? e})`);
        return;
      }
      rmSync(target);
      result = {
        content: [
          {
            type: "text" as const,
            text: `Deleted ${target} (backup ${backup.file}). Restore with skill_manage restore skill="${r.skillName}" file="${file}".`,
          },
        ],
        details: { deleted: target, backup: backup.file },
      };
    });
    pruneEmptyDirs(path.dirname(target), r.baseDir);
    return result;
  }

  // Whole-skill delete: snapshot every file, then remove the dir. Destructive —
  // the SKILL.md must be unchanged since it was read (hash precondition).
  const readHash = readThisSession.get(r.skillFilePath);
  let current: string;
  try {
    current = readFileSync(r.skillFilePath, "utf8");
  } catch {
    return err(`File not readable: ${r.skillFilePath}`);
  }
  if (readHash !== undefined && contentHash(current) !== readHash) {
    return err("Refusing: SKILL.md changed on disk since it was read (hash mismatch). Re-read the skill, then delete.");
  }
  // Snapshot + rm inside the queue, as close together as serialization allows:
  // a file created between walk and rm would otherwise be destroyed unbacked.
  let result: any;
  await withFileMutationQueue(r.skillFilePath, async () => {
    // Authoritative hash re-check on the queued bytes (mirrors patchAction):
    // an external write landing between the pre-queue check and here is
    // caught instead of deleted.
    if (readHash !== undefined) {
      let now: string;
      try {
        now = readFileSync(r.skillFilePath, "utf8");
      } catch (e: any) {
        result = err(`File not readable: ${r.skillFilePath} (${e?.message ?? e})`);
        return;
      }
      if (contentHash(now) !== readHash) {
        result = err("Refusing: SKILL.md changed on disk since it was read (hash mismatch). Re-read the skill, then delete.");
        return;
      }
    }
    const files = collectFiles(r.baseDir, r.baseDir);
    const snap = snapshotDir(r.skillName, files, settings.backupCap);
    try {
      rmSync(r.baseDir, { recursive: true, force: true });
    } catch (e: any) {
      result = err(`Delete failed after snapshot at ${snap.dir}: ${e?.message ?? e} — the snapshot is intact; restore or remove it manually.`);
      return;
    }
    result = {
      content: [
        {
          type: "text" as const,
          text: `Deleted skill directory ${r.baseDir} (${files.length} file(s)); snapshot at ${snap.dir}. Restore with skill_manage restore skill="${r.skillName}".`,
        },
      ],
      details: { deleted: r.baseDir, snapshot: snap.dir },
    };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Batch (operations[]): plan against an in-memory overlay, validate everything,
// then commit — any failure writes NOTHING.
// ---------------------------------------------------------------------------

async function executeBatch(ops: any[], cwd: string, settings: ReturnType<typeof readSelfSkillsSettings>, trusted: boolean) {
  if (ops.length === 0) return err("operations array is empty.");
  const overlay = new Map<string, string | null>();
  const meta = new Map<string, { skillName: string; baseDir: string; relpath: string }>();
  const errors: string[] = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const action = op?.action;
    const prefix = `operations[${i}] (${action ?? "missing action"}): `;
    if (action !== "patch" && action !== "write" && action !== "delete") {
      errors.push(`${prefix}action must be patch, write, or delete.`);
      continue;
    }
    const r = resolveSkillDir(op, cwd, trusted);
    if (typeof r === "string") {
      errors.push(`${prefix}${r}`);
      continue;
    }
    const gate = checkPatchable(r.skillFilePath, cwd, settings, trusted);
    if (!gate.ok) {
      errors.push(`${prefix}${gate.reason}`);
      continue;
    }
    // Identical gating for identical operations: batch write/delete require the
    // same read-first discipline the standalone actions enforce.
    if (!readThisSession.has(r.skillFilePath)) {
      errors.push(`${prefix}read the skill first (skill_manage read), then batch-modify it.`);
      continue;
    }
    if (action === "patch") {
      const real = r.skillFilePath;
      const readHash = readThisSession.get(real)!;
      if (typeof op.old_string !== "string" || op.old_string === "" || typeof op.new_string !== "string" || op.old_string === op.new_string) {
        errors.push(`${prefix}patch requires old_string and new_string (non-empty, different).`);
        continue;
      }
      // Hash gate applies to the ON-DISK state only, and only for the first op
      // touching this path — later ops patch the overlay of earlier ones.
      if (!overlay.has(real)) {
        let disk: string;
        try {
          disk = readFileSync(real, "utf8");
        } catch (e: any) {
          errors.push(`${prefix}File not readable: ${real} (${e?.message ?? e}).`);
          continue;
        }
        if (contentHash(disk) !== readHash) {
          errors.push(`${prefix}file changed on disk since it was read (hash mismatch) — re-read and retry.`);
          continue;
        }
        overlay.set(real, disk);
      }
      const applied = applyPatch(overlay.get(real)!, op.old_string, op.new_string);
      if (!applied.ok) {
        errors.push(`${prefix}${applied.reason} (${applied.occurrences} occurrence(s) of old_string).`);
        continue;
      }
      overlay.set(real, applied.content);
      meta.set(real, { skillName: r.skillName, baseDir: r.baseDir, relpath: "SKILL.md" });
    } else if (action === "write") {
      const file = typeof op.file === "string" ? op.file : "";
      if (!isValidRelpath(file) || path.basename(file) === "SKILL.md") {
        errors.push(`${prefix}write requires \`file\` (relative path; SKILL.md is patch-only).`);
        continue;
      }
      if (typeof op.content !== "string" || op.content === "") {
        errors.push(`${prefix}write requires non-empty \`content\`.`);
        continue;
      }
      const target = path.join(r.baseDir, file);
      if (!isContained(r.baseDir, target)) {
        errors.push(`${prefix}file escapes the skill directory.`);
        continue;
      }
      if (existsSync(target) && !statSync(target).isFile()) {
        errors.push(`${prefix}${target} exists and is not a regular file.`);
        continue;
      }
      overlay.set(target, op.content);
      meta.set(target, { skillName: r.skillName, baseDir: r.baseDir, relpath: file });
    } else {
      const file = typeof op.file === "string" ? op.file : "";
      if (!isValidRelpath(file) || path.basename(file) === "SKILL.md") {
        errors.push(`${prefix}batch delete requires \`file\` (bundled files only; SKILL.md is patch-only; whole-skill delete is a single call).`);
        continue;
      }
      const target = path.join(r.baseDir, file);
      if (!isContained(r.baseDir, target)) {
        errors.push(`${prefix}file escapes the skill directory.`);
        continue;
      }
      if (!existsSync(target) && !overlay.has(target)) {
        errors.push(`${prefix}file not found: ${target}`);
        continue;
      }
      if (existsSync(target) && !statSync(target).isFile()) {
        errors.push(`${prefix}${target} exists and is not a regular file.`);
        continue;
      }
      overlay.set(target, null);
      meta.set(target, { skillName: r.skillName, baseDir: r.baseDir, relpath: file });
    }
  }

  if (errors.length > 0) {
    return err(`Batch failed — nothing was written:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  }
  if (meta.size === 0) return err("Batch had no valid operations.");

  // Validate every modified SKILL.md in the overlay before touching disk.
  for (const [p, content] of overlay) {
    if (content === null || path.basename(p) !== "SKILL.md") continue;
    const v = validateSkillContent(content, meta.get(p)?.skillName);
    if (!v.ok) {
      return err(`Batch failed — nothing was written: SKILL.md result invalid (${v.reason}).`);
    }
  }

  // Commit: per-path backup-original → write/delete, sequential and queued.
  // Backup reads happen inside the queue (same bytes that get overwritten).
  const lines: string[] = [];
  for (const [p, content] of overlay) {
    const m = meta.get(p)!;
    try {
      await withFileMutationQueue(p, async () => {
        const existed = existsSync(p);
        let backup: string | null = null;
        try {
          backup = existed ? snapshot(m.skillName, readFileSync(p, "utf8"), settings.backupCap, agentDir(), m.relpath).file : null;
        } catch (e: any) {
          throw new Error(`existing file unreadable: ${p} (${e?.message ?? e})`);
        }
        if (content === null) {
          rmSync(p, { force: true });
          pruneEmptyDirs(path.dirname(p), m.baseDir);
        } else {
          mkdirSync(path.dirname(p), { recursive: true });
          atomicWrite(p, content);
          if (path.basename(p) === "SKILL.md") readThisSession.set(p, contentHash(content));
        }
        if (content === null) readThisSession.delete(p);
        lines.push(content === null ? `deleted ${p} (backup ${backup})` : `${existed ? "wrote" : "created"} ${p}${backup ? ` (backup ${backup})` : ""}`);
      });
    } catch (e: any) {
      return err(
        `Batch partially applied before failure at ${p}: ${e?.message ?? e}. Applied so far:\n${lines.map((l) => `- ${l}`).join("\n")}`,
      );
    }
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `Batch applied (${lines.length} file change(s)):\n${lines.map((l) => `- ${l}`).join("\n")}`,
      },
    ],
    details: { changes: lines.length },
  };
}
