import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { agentDir, readSelfSkillsSettings, type SelfSkillsSettings } from "../lib/config";
import { checkPatchable, defaultSkillsDir, resolveSkillsDir, writableRoots } from "../lib/paths";

import { isContained, isContainedOrSelf } from "../lib/paths";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkill(dir: string, name: string, description = "d"): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const file = join(skillDir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: "${description}"\n---\n\nBody.\n`, "utf8");
  return file;
}

describe("paths", () => {
  it("isContained is segment-safe: '..'-prefixed siblings are contained, real escapes are not", () => {
    expect(isContained("/r", "/r/..drafts/SKILL.md")).to.equal(true);
    expect(isContained("/r", "/r/..notes.md")).to.equal(true);
    expect(isContained("/r", "/r-drafts/SKILL.md")).to.equal(false);
    expect(isContained("/r", "/r/../escape.md")).to.equal(false);
    expect(isContained("/r", "/escape.md")).to.equal(false);
    expect(isContained("/r", "/r")).to.equal(false); // root itself: strictly-under
  });

  it("isContainedOrSelf allows the root itself", () => {
    expect(isContainedOrSelf("/r", "/r")).to.equal(true);
    expect(isContainedOrSelf("/r", "/r/sub/x.md")).to.equal(true);
    expect(isContainedOrSelf("/r", "/r-drafts/x.md")).to.equal(false);
  });

  let agent: string;
  let cwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    agent = tmpDir("pi-selfskills-paths-agent-");
    cwd = tmpDir("pi-selfskills-paths-cwd-");
    cleanup.push(agent, cwd);
    process.env.PI_CODING_AGENT_DIR = agent;
  });
  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function settings(over: Partial<SelfSkillsSettings> = {}): SelfSkillsSettings {
    return { ...readSelfSkillsSettings(cwd), ...over };
  }

  it("global agentDir skills are patchable", () => {
    const file = writeSkill(defaultSkillsDir(), "alpha");
    const check = checkPatchable(file, cwd, settings(), true);
    expect(check.ok).to.equal(true);
    expect(check.realpath).to.equal(realpathSync(file)); // canonicalized (macOS /var → /private/var); identical on Linux
  });

  it("project .pi/skills are patchable iff trusted", () => {
    const file = writeSkill(join(cwd, ".pi", "skills"), "beta");
    expect(checkPatchable(file, cwd, settings(), true).ok).to.equal(true);
    const untrusted = checkPatchable(file, cwd, settings(), false);
    expect(untrusted.ok).to.equal(false);
    expect(untrusted.reason).to.include("not trusted");
  });

  it("..-escapes outside any writable root are refused", () => {
    const file = writeSkill(join(cwd, "elsewhere"), "gamma");
    // path spelled as an escape from inside the global skills dir
    const spelled = join(defaultSkillsDir(), "..", "..", "elsewhere", "gamma", "SKILL.md");
    expect(checkPatchable(spelled, cwd, settings(), true).ok).to.equal(false);
    expect(checkPatchable(file, cwd, settings(), true).ok).to.equal(false);
  });

  it("node_modules paths are refused even when contained", () => {
    const file = writeSkill(join(defaultSkillsDir(), "node_modules", "somepkg"), "delta");
    const check = checkPatchable(file, cwd, settings(), true);
    expect(check.ok).to.equal(false);
    expect(check.reason).to.include("node_modules");
  });

  it("~/.agents/skills is refused (not a writable root) — hermetic HOME", () => {
    const fakeHome = tmpDir("pi-selfskills-paths-home-");
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    const file = writeSkill(join(fakeHome, ".agents", "skills"), "eps");
    try {
      expect(checkPatchable(file, cwd, settings(), true).ok).to.equal(false);
    } finally {
      process.env.HOME = savedHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("non-git cwd under HOME: ancestor ~/.agents stays read-only, cwd .agents is patchable", () => {
    // The advisor scenario: without a project boundary, the ancestor walk in a
    // trusted non-git cwd under $HOME made ~/.agents/skills writable.
    const fakeHome = tmpDir("pi-selfskills-paths-home2-");
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    const project = join(fakeHome, "work", "project");
    mkdirSync(project, { recursive: true });
    const userFile = writeSkill(join(fakeHome, ".agents", "skills"), "user-x");
    const projFile = writeSkill(join(project, ".agents", "skills"), "proj-x");
    try {
      const roots = writableRoots(project, settings(), true);
      const agentsRoots = roots.filter((r) => r.label === "project-agents");
      expect(agentsRoots.length).to.equal(1);
      expect(agentsRoots[0].root).to.equal(join(project, ".agents", "skills"));
      expect(checkPatchable(projFile, project, settings(), true).ok).to.equal(true);
      expect(checkPatchable(userFile, project, settings(), true).ok).to.equal(false);
    } finally {
      process.env.HOME = savedHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("git-tracked project: repo-root .agents is patchable up to the git boundary", () => {
    const repo = tmpDir("pi-selfskills-paths-repo-");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "sub", "project"), { recursive: true });
    const repoFile = writeSkill(join(repo, ".agents", "skills"), "repo-x");
    const project = join(repo, "sub", "project");
    expect(checkPatchable(repoFile, project, settings(), true).ok).to.equal(true);
    // untrusted: same file refused
    expect(checkPatchable(repoFile, project, settings(), false).ok).to.equal(false);
  });

  it("skillsDir override joins the writable roots", () => {
    const ovr = join(cwd, "custom-skills");
    const file = writeSkill(ovr, "zeta");
    const cfg = settings({ skillsDir: ovr });
    expect(resolveSkillsDir(cfg, cwd)).to.equal(ovr);
    expect(writableRoots(cwd, cfg, true).map((r) => r.label)).to.deep.equal(["user", "project", "skillsDir"]);
    expect(checkPatchable(file, cwd, cfg, true).ok).to.equal(true);
    // without the override in settings, the same file is refused
    expect(checkPatchable(file, cwd, settings(), true).ok).to.equal(false);
  });
});
