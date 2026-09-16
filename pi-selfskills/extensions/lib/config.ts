// Settings reader — reads the `selfskills` key from settings.json directly.
// ponytail: the SDK ExtensionAPI has NO getSetting/config for structured values.
// Resolution (trusted mirrors Pi's own project-trust gating of cwd config, so
// an untrusted repo cannot steer the writable-roots allowlist):
//   trusted:   <cwd>/.pi/settings.json → <agentDir>/settings.json
//   untrusted: <agentDir>/settings.json
// agentDir = $PI_CODING_AGENT_DIR or ~/.pi/agent; malformed JSON → defaults.
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SelfSkillsSettings {
  enabled: boolean;
  inject: boolean;
  /** Tilde-expanded. May be relative — resolve against cwd at use site. */
  skillsDir: string;
  backupCap: number;
  /** Patch skills that live in LOCAL packages from settings `packages`
   *  (monorepo source — git-backed, plus backups). npm:/node_modules package
   *  skills stay read-only regardless. */
  patchPackages: boolean;
  /** Patch project `.agents/skills` (git-root-walked) in trusted projects —
   *  same git+backups rationale as patchPackages. The USER-level
   *  `~/.agents/skills` stays read-only: it is shared across all projects. */
  patchProjectAgents: boolean;
}

function defaults(): SelfSkillsSettings {
  // Computed, never a "~" literal — resolveSkillsDir treats non-absolute
  // values as cwd-relative, so an unexpanded tilde would misplace creates.
  return {
    enabled: true,
    inject: true,
    skillsDir: path.join(agentDir(), "skills"),
    backupCap: 10,
    patchPackages: true,
    patchProjectAgents: true,
  };
}

/** Expand a leading ~ to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Agent config dir: $PI_CODING_AGENT_DIR or ~/.pi/agent. */
export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function settingsCandidates(cwd: string, trusted: boolean): string[] {
  return [
    ...(trusted ? [path.join(cwd, ".pi", "settings.json")] : []),
    path.join(agentDir(), "settings.json"),
  ];
}

/** Read the `selfskills` block from the first settings.json found. Defaults when absent/unreadable. */
export function readSelfSkillsSettings(cwd = process.cwd(), trusted = false): SelfSkillsSettings {
  for (const file of settingsCandidates(cwd, trusted)) {
    if (!existsSync(file)) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return defaults(); // malformed → defaults
    }
    const raw = (parsed?.selfskills ?? {}) as Record<string, unknown>;
    const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
    const num = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v : d);
    const dir =
      typeof raw.skillsDir === "string" && raw.skillsDir.trim() !== ""
        ? expandTilde(raw.skillsDir)
        : path.join(agentDir(), "skills"); // default tracks PI_CODING_AGENT_DIR
    return {
      enabled: bool(raw.enabled, true),
      inject: bool(raw.inject, true),
      skillsDir: dir,
      backupCap: num(raw.backupCap, 10),
      patchPackages: bool(raw.patchPackages, true),
      patchProjectAgents: bool(raw.patchProjectAgents, true),
    };
  }
  return defaults();
}

/**
 * Skill directories contributed by LOCAL packages in settings `packages`
 * (monorepo checkouts). Resolves entries relative to their settings.json,
 * reads each package's `pi.skills` array (defaulting to `skills/`), and skips
 * npm: entries and anything inside node_modules. Project packages are only
 * included when the project is trusted.
 */
export function packageSkillDirs(cwd = process.cwd(), trusted = false): string[] {
  const dirs = new Set<string>();
  for (const file of settingsCandidates(cwd, trusted)) {
    if (!existsSync(file)) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const base = path.dirname(file);
    for (const raw of (parsed?.packages ?? []) as string[]) {
      if (typeof raw !== "string" || raw.startsWith("npm:") || raw.includes("node_modules")) continue;
      const pkgDir = path.isAbsolute(raw) ? raw : path.resolve(base, raw);
      let manifest: any;
      try {
        manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      } catch {
        continue;
      }
      const skillsEntries: string[] = manifest?.pi?.skills ?? ["skills"];
      for (const entry of skillsEntries) {
        const dir = path.isAbsolute(entry) ? entry : path.resolve(pkgDir, entry);
        // Containment: a package manifest must not widen the writable roots —
        // `pi.skills: ["../../.."]` or an absolute path would otherwise add
        // e.g. $HOME to the allowlist.
        const rel = path.relative(pkgDir, dir);
        if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) continue;
        if (existsSync(dir) && !dir.includes("node_modules")) dirs.add(dir);
      }
    }
  }
  return [...dirs];
}
