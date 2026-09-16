// Skill discovery (SDK loadSkills) + writable-root allowlist.
// Writable roots: <agentDir>/skills always; <cwd>/.pi/skills only for trusted
// projects; settings selfskills.skillsDir override. Everything else is read-only.
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSkills, loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { agentDir, packageSkillDirs, type SelfSkillsSettings } from "./config";

export interface WritableRoot {
  root: string;
  label: string;
}

export function defaultSkillsDir(): string {
  return path.join(agentDir(), "skills");
}

/** Create-target skills dir: settings override (tilde-expanded), relative resolved against cwd. */
export function resolveSkillsDir(settings: SelfSkillsSettings, cwd: string): string {
  return path.isAbsolute(settings.skillsDir) ? settings.skillsDir : path.resolve(cwd, settings.skillsDir);
}

export function writableRoots(cwd: string, settings: SelfSkillsSettings, trusted: boolean): WritableRoot[] {
  const roots: WritableRoot[] = [{ root: defaultSkillsDir(), label: "user" }];
  if (trusted) {
    roots.push({ root: path.resolve(cwd, ".pi", "skills"), label: "project" });
    // Project .agents/skills in trusted projects: git-backed source + backups,
    // same rationale as local package skills. Writability never crosses the
    // project boundary — git root when tracked, the project dir itself when
    // not — so a non-git cwd under $HOME can never make the USER-level
    // ~/.agents/skills writable (invariant: user .agents is always read-only).
    if (settings.patchProjectAgents) {
      const boundary = gitRoot(cwd) ?? path.resolve(cwd);
      // Include the cwd-level .agents/skills even when absent so create can
      // bootstrap a fresh project's root (create mkdir -p's the target).
      const wouldBe = path.resolve(cwd, ".agents", "skills");
      const candidates = projectAgentsSkillRoots(cwd);
      if (!candidates.some((c) => c === wouldBe)) candidates.unshift(wouldBe);
      // Invariant: the USER-level ~/.agents/skills is always read-only (shared
      // across projects/harnesses). When cwd === $HOME the boundary is $HOME
      // itself and would swallow it — exclude it explicitly.
      const userAgents = path.join(os.homedir(), ".agents", "skills");
      for (const root of candidates) {
        if (realIfExists(root) === realIfExists(userAgents)) continue;
        if (!isContained(boundary, root)) continue;
        if (!roots.some((r) => r.root === root)) roots.push({ root, label: "project-agents" });
      }
    }
  }
  const override = resolveSkillsDir(settings, cwd);
  if (!roots.some((r) => r.root === override)) roots.push({ root: override, label: "skillsDir" });
  // Local package skills (monorepo source) are patchable unless disabled —
  // node_modules packages never get this far (packageSkillDirs skips them and
  // checkPatchable refuses node_modules segments as belt-and-braces).
  if (settings.patchPackages) {
    for (const dir of packageSkillDirs(cwd, trusted)) {
      if (!roots.some((r) => r.root === dir)) roots.push({ root: dir, label: "package" });
    }
  }
  return roots;
}

/** Canonicalize for comparisons: realpath when present; else realpath the
 *  nearest existing ancestor and rejoin (macOS /var↔/private/var aliasing —
 *  a not-yet-created path must still compare equal to its created form). */
export function realIfExists(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    /* not yet created — fall through to the parent */
  }
  try {
    return path.join(realpathSync(path.dirname(p)), path.basename(p));
  } catch {
    return p;
  }
}

export function hasNodeModuleSegment(p: string): boolean {
  return p.split(path.sep).includes("node_modules");
}

/** Containment: target strictly under root (not the root itself), path-relative.
 *  Segment-safe: only a real parent traversal (".." or "../…") escapes — a
 *  sibling named "..drafts" is contained. */
export function isContained(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/** Containment allowing the root itself (rel === "" counts as contained). */
export function isContainedOrSelf(root: string, target: string): boolean {
  return path.relative(root, target) === "" || isContained(root, target);
}

export interface PatchCheck {
  ok: boolean;
  reason?: string;
  root?: string;
  realpath: string;
}

/**
 * Gate a target path against the writable-root allowlist. Target must exist.
 * Refuses node_modules segments, ..-escapes (via realpath containment), and
 * untrusted project skills.
 */
export function checkPatchable(absPath: string, cwd: string, settings: SelfSkillsSettings, trusted: boolean): PatchCheck {
  const real = realIfExists(absPath);
  if (!existsSync(real)) return { ok: false, reason: `File not found: ${absPath}`, realpath: real };
  if (hasNodeModuleSegment(real)) {
    return { ok: false, reason: `Refusing: ${real} is inside a node_modules directory — package skills are read-only.`, realpath: real };
  }
  for (const { root, label } of writableRoots(cwd, settings, trusted)) {
    const realRoot = realIfExists(root);
    if (isContained(realRoot, real)) return { ok: true, root: realRoot, realpath: real };
  }
  // Specific hint for the common untrusted-project case.
  const projectSkills = realIfExists(path.resolve(cwd, ".pi", "skills"));
  if (isContained(projectSkills, real)) {
    return {
      ok: false,
      reason: `Refusing: ${real} is a project skill but this project is not trusted, so project skills are read-only.`,
      realpath: real,
    };
  }
  const list = writableRoots(cwd, settings, trusted)
    .map((r) => `  - ${r.label}: ${r.root}`)
    .join("\n");
  return { ok: false, reason: `Refusing: ${real} is outside the writable skill roots:\n${list}`, realpath: real };
}

/** Discover the skills the session sees, as far as the SDK allows.
 *
 *  loadSkills(includeDefaults) covers only <agentDir>/skills + <cwd>/.pi/skills;
 *  Pi's own loader collects the remaining roots (package skills dirs, settings
 *  skills array, --skill flags) into explicit skillPaths an extension cannot
 *  observe. We add the two always-scanned .agents roots ourselves (user
 *  ~/.agents/skills and project .agents/skills up the tree to the git root);
 *  package skills follow the project-trust rule (an untrusted repo's own
 *  packages are NOT scanned — attacker descriptions must not render into list),
 *  and settings-array/--skill/package entries outside those remain a documented
 *  ceiling. First discovery of a name or realpath wins (Pi keep-first rule). */
export function discoverSkills(cwd: string, agentDirPath = agentDir(), trusted = false) {
  const primary = loadSkills({ cwd, agentDir: agentDirPath, skillPaths: [], includeDefaults: true });
  const byName = new Map<string, Skill>();
  const seenReal = new Set<string>();
  const remember = (s: Skill) => {
    let real = s.filePath;
    try {
      real = realpathSync(s.filePath);
    } catch {
      // unreadable path — key on the raw path
    }
    if (seenReal.has(real) || byName.has(s.name)) return;
    seenReal.add(real);
    byName.set(s.name, s);
  };
  // Trust alignment with Pi itself: an untrusted project contributes NOTHING
  // project-located (no .pi/skills, no project .agents entries — attacker
  // descriptions must not render into list); only user-global skills load.
  const projectRoots = trusted
    ? []
    : [realIfExists(path.resolve(cwd, ".pi", "skills")), ...projectAgentsSkillRoots(cwd).map(realIfExists)];
  const isProjectLocated = (s: Skill) => {
    let real = s.filePath;
    try {
      real = realpathSync(real); // canonicalize — macOS /var→/private/var
    } catch {
      // keep raw
    }
    return projectRoots.some((r) => {
      // BOTH sides canonical: roots from resolve() keep the /var symlink form
      // while skill realpaths don't — uncanonical containment false-negatives.
      const rel = path.relative(realIfExists(r), real);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
  };
  for (const s of primary.skills) if (trusted || !isProjectLocated(s)) remember(s);
  for (const root of [...agentsSkillRoots(cwd, trusted), ...packageSkillDirs(cwd, trusted)]) {
    let result;
    try {
      result = loadSkillsFromDir({ dir: root, source: "pi-selfskills-list" });
    } catch {
      continue; // unreadable root — skip
    }
    for (const s of result.skills) remember(s);
  }
  return { skills: [...byName.values()], diagnostics: primary.diagnostics };
}

/** ~/.agents/skills (always) + project .agents/skills (trusted projects only —
 *  an untrusted repo contributes nothing project-located), nearest-first,
 *  walking up to the git repo root inclusive. */
function agentsSkillRoots(cwd: string, trusted: boolean): string[] {
  const roots: string[] = [];
  const userAgents = path.join(os.homedir(), ".agents", "skills");
  if (existsSync(userAgents)) roots.push(userAgents);
  if (trusted) roots.push(...projectAgentsSkillRoots(cwd));
  return roots;
}

/** .agents/skills in cwd and ancestors (nearest-first), walking up to the git
 *  repo root inclusive, else the filesystem root. */
export function projectAgentsSkillRoots(cwd: string): string[] {
  const roots: string[] = [];
  let dir = path.resolve(cwd);
  const stop = gitRoot(dir) ?? path.parse(dir).root;
  for (;;) {
    const candidate = path.join(dir, ".agents", "skills");
    if (existsSync(candidate)) roots.push(candidate);
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

function gitRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir; // repo dir or worktree link file
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
