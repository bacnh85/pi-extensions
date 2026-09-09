// Content-addressed backups: <agentDir>/selfskills/backups/<skill>/<relpath>/<stamp.ms>-<hash>.md
// where <relpath> mirrors the file's path inside the skill dir ("SKILL.md" for
// the skill file). Legacy v0.1 flat layout (<skill>/<stamp>-<hash>.md) stays
// restorable: flat SKILL.md files merge into every SKILL.md lookup.
// Whole-skill deletions snapshot to <skill>/__deleted__/<stamp>/<relpath>.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentDir } from "./config";
import { SKILL_NAME_RE, contentHash } from "./skillfile";

export function backupRoot(agentDirPath = agentDir()): string {
  return path.join(agentDirPath, "selfskills", "backups");
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  // Millisecond resolution: filename order stays monotonic even when two
  // snapshots land in the same second (mtime ties + hash-order tiebreaks
  // could otherwise prune/latest-pick the wrong one).
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function backupDirFor(skillName: string, agentDirPath = agentDir()): string {
  // Defense in depth: callers sanitize frontmatter names, but a backup path is
  // never built from a name that could traverse (SDK loader warns on, but still
  // loads, skills whose frontmatter name is e.g. "../../x").
  if (!SKILL_NAME_RE.test(skillName)) {
    throw new Error(`invalid skill name for backup path: ${skillName}`);
  }
  return path.join(backupRoot(agentDirPath), skillName);
}

/** Per-file backup dir: backups/<skill>/<relpath>/ ("SKILL.md" → .../SKILL.md/). */
export function backupFileDir(skillName: string, relpath: string, agentDirPath = agentDir()): string {
  if (!isValidRelpath(relpath)) throw new Error(`invalid backup relpath: ${relpath}`);
  return path.join(backupDirFor(skillName, agentDirPath), relpath);
}

/** Relative path inside a skill dir: no traversal, no empty/dot segments. */
export function isValidRelpath(relpath: string): boolean {
  if (typeof relpath !== "string" || relpath === "" || path.isAbsolute(relpath)) return false;
  return relpath.split(/[\\/]/).every((p) => p !== "" && p !== "." && p !== "..");
}

/** Backup filename format: stamp.ms-hash[, counter].md (v0.2, ms-stamped) or
 *  the v0.1 legacy stamp-hash.md. The format check is the traversal guard —
 *  `../..` or arbitrary paths never match, so a user-supplied `backup` param
 *  can only ever select real snapshots. */
const BACKUP_FILE_RE = /^\d{8}-\d{6}(\.\d{3})?-[0-9a-f]{10}(-\d+)?\.md$/;

function mtimeMs(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Backup files for one skill file (relpath), oldest first. mtime primary; the
 *  ms-stamped filename tiebreak is monotonic, so same-mtime files still order
 *  by creation time. For "SKILL.md" the v0.1 flat layout merges in. */
export function listBackups(skillName: string, relpath = "SKILL.md", agentDirPath = agentDir()): string[] {
  if (!isValidRelpath(relpath)) return [];
  const files: string[] = [];
  const nested = path.join(backupFileDir(skillName, relpath, agentDirPath));
  if (existsSync(nested)) {
    files.push(
      ...readdirSync(nested)
        .filter((f) => BACKUP_FILE_RE.test(f))
        .map((f) => path.join(nested, f)),
    );
  }
  if (relpath === "SKILL.md") {
    // v0.1 legacy: flat <stamp>-<hash>.md files directly under the skill dir.
    const root = backupDirFor(skillName, agentDirPath);
    if (existsSync(root)) {
      files.push(
        ...readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isFile() && BACKUP_FILE_RE.test(e.name))
          .map((e) => path.join(root, e.name)),
      );
    }
  }
  return files.sort((a, b) => {
    const d = mtimeMs(a) - mtimeMs(b);
    return d !== 0 ? d : a.localeCompare(b);
  });
}

/** Total backup files across all skills (for /selfskills status). */
export function countBackups(agentDirPath = agentDir()): number {
  const root = backupRoot(agentDirPath);
  if (!existsSync(root)) return 0;
  let n = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else n += 1;
    }
  };
  walk(root);
  return n;
}

export interface SnapshotResult {
  file: string;
  pruned: string[];
}

/** Snapshot one file's content (relpath defaults to the skill file), then prune
 *  oldest beyond cap for THAT relpath. Same-millisecond + identical-hash
 *  collisions (rare) get a -N counter so the second snapshot is never lost. */
export function snapshot(
  skillName: string,
  content: string,
  cap: number,
  agentDirPath = agentDir(),
  relpath = "SKILL.md",
): SnapshotResult {
  const dir = backupFileDir(skillName, relpath, agentDirPath);
  mkdirSync(dir, { recursive: true });
  const base = `${stamp()}-${contentHash(content).slice(0, 10)}`;
  let file = path.join(dir, `${base}.md`);
  for (let n = 2; existsSync(file); n++) file = path.join(dir, `${base}-${n}.md`);
  writeFileSync(file, content, "utf8");
  const all = listBackups(skillName, relpath, agentDirPath).filter((f) => path.dirname(f) === dir);
  const pruned: string[] = [];
  for (const old of all.slice(0, Math.max(0, all.length - cap))) {
    rmSync(old);
    pruned.push(old);
  }
  return { file, pruned };
}

/** Named backup by strict generated filename (with or without .md suffix). */
export function namedBackup(skillName: string, name: string, relpath = "SKILL.md", agentDirPath = agentDir()): string | null {
  const base = name.endsWith(".md") ? name : `${name}.md`;
  if (!BACKUP_FILE_RE.test(base)) return null;
  const file = path.join(backupFileDir(skillName, relpath, agentDirPath), base);
  if (existsSync(file)) return file;
  // legacy: flat SKILL.md backups
  if (relpath === "SKILL.md") {
    const flat = path.join(backupDirFor(skillName, agentDirPath), base);
    return existsSync(flat) ? flat : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Whole-skill deletion snapshots: backups/<skill>/__deleted__/<stamp>/<relpath>
// ---------------------------------------------------------------------------

function deletedRoot(skillName: string, agentDirPath: string): string {
  return path.join(backupDirFor(skillName, agentDirPath), "__deleted__");
}

export interface DirSnapshotResult {
  dir: string;
  fileCount: number;
}

/** Snapshot a full skill file set before deletion. Contents are Buffers —
 *  byte-for-byte preservation for non-UTF8 bundled assets. */
export function snapshotDir(
  skillName: string,
  files: { relpath: string; content: Buffer }[],
  cap: number,
  agentDirPath = agentDir(),
): DirSnapshotResult {
  const root = deletedRoot(skillName, agentDirPath);
  // Same-stamp collisions (back-to-back calls within one millisecond) get a
  // -N counter — distinct deletions must never overwrite each other.
  let dir = path.join(root, stamp());
  for (let n = 2; existsSync(dir); n++) dir = path.join(root, `${stamp()}-${n}`);
  for (const f of files) {
    if (!isValidRelpath(f.relpath)) throw new Error(`invalid backup relpath: ${f.relpath}`);
    const target = path.join(dir, f.relpath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.content, "utf8");
  }
  // Prune oldest snapshot DIRS beyond cap.
  const snaps = listDeletedSnapshots(skillName, agentDirPath);
  for (const old of snaps.slice(0, Math.max(0, snaps.length - cap))) rmSync(old.dir, { recursive: true, force: true });
  return { dir, fileCount: files.length };
}

/** Deletion snapshots for a skill, oldest first. */
export function listDeletedSnapshots(skillName: string, agentDirPath = agentDir()): { dir: string; stamp: string }[] {
  const root = deletedRoot(skillName, agentDirPath);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ dir: path.join(root, e.name), stamp: e.name }))
    .sort((a, b) => a.stamp.localeCompare(b.stamp));
}

export function latestDeletedSnapshot(skillName: string, agentDirPath = agentDir()): { dir: string; stamp: string } | null {
  const all = listDeletedSnapshots(skillName, agentDirPath);
  return all.length > 0 ? all[all.length - 1] : null;
}
