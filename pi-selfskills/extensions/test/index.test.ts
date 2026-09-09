import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import selfskillsExtension, { _resetForTest } from "../index";
import { agentDir } from "../lib/config";
import { defaultSkillsDir } from "../lib/paths";

const ENV_KEYS = ["PI_CODING_AGENT_DIR"] as const;

function writeSkill(root: string, name: string, body = "Rule one.\n", description = "Use when testing. One-line behavior."): string {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  const file = join(skillDir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}`, "utf8");
  return file;
}

// Harness mirrors pi-evolve: writable cwd, settings written to <cwd>/.pi/settings.json.
function harness(cwd: string, selfskills?: Record<string, unknown>, trusted = true, extraSettings?: Record<string, unknown>) {
  const tools: Record<string, any> = {};
  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, any> = {};
  const notifications: string[] = [];
  const pi: any = {
    registerTool(tool: any) { tools[tool.name] = tool; },
    registerCommand(name: string, command: any) { commands[name] = command; },
    on(name: string, handler: Function) { (handlers[name] ??= []).push(handler); },
  };
  selfskillsExtension(pi);
  if (selfskills || extraSettings) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ selfskills, ...extraSettings }), "utf8");
  }
  const ctx: any = { cwd, isProjectTrusted: () => trusted, ui: { notify: (m: string) => notifications.push(m) } };
  return { tools, handlers, commands, notifications, ctx };
}

describe("pi-selfskills extension", () => {
  let savedEnv: Record<string, string | undefined>;
  let agent: string;
  let cwd: string;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    agent = mkdtempSync(join(tmpdir(), "pi-selfskills-ext-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "pi-selfskills-ext-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agent;
    _resetForTest();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(agent, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("registers skill_manage + /selfskills command", () => {
    const { tools, commands } = harness(cwd);
    expect(Object.keys(tools)).to.deep.equal(["skill_manage"]);
    expect(commands.selfskills).to.exist;
  });

  it("list finds temp-dir skills with patchable flags", async () => {
    writeSkill(defaultSkillsDir(), "alpha");
    const project = writeSkill(join(cwd, ".pi", "skills"), "beta");
    const { tools, ctx } = harness(cwd);
    const res = await tools.skill_manage.execute("id", { action: "list" }, undefined, undefined, ctx);
    // Presence-based, not exact-count: discoverSkills also merges real
    // ~/.agents/skills when it exists, so totals vary by machine.
    expect(res.content[0].text).to.match(/Discovered \d+ skill/);
    expect(res.content[0].text).to.include("alpha — Use when testing");
    expect(res.content[0].text).to.include(`${project} — patchable: yes`);
    expect(res.content[0].text).to.include("may be absent");
    // untrusted project: project-located skills are excluded entirely (trust
    // alignment — attacker descriptions must not render into list)
    const { tools: t2, ctx: c2 } = harness(cwd, undefined, false);
    const res2 = await t2.skill_manage.execute("id", { action: "list" }, undefined, undefined, c2);
    expect(res2.content[0].text).to.not.include("beta —");
    expect(res2.content[0].text).to.include("alpha —"); // user-global still loads
  });

  it("list finds .agents skills (user + project) with patchable flags", async () => {
    // Hermetic HOME: os.homedir() reads $HOME on POSIX, so redirecting it keeps
    // the user-.agents root inside a temp dir — no writes under the real HOME.
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-selfskills-home-"));
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    const userAgents = join(fakeHome, ".agents", "skills");
    const userFile = writeSkill(userAgents, "agents-user-skill");
    // project .agents/skills at cwd (ancestor rule: cwd itself is scanned)
    const projAgents = join(cwd, ".agents", "skills");
    writeSkill(projAgents, "agents-project-skill");
    try {
      const { tools, ctx } = harness(cwd);
      const res = await tools.skill_manage.execute("id", { action: "list" }, undefined, undefined, ctx);
      const lines = res.content[0].text.split("\n");
      const userRow = lines.find((l: string) => l.includes("agents-user-skill"));
      const projRow = lines.find((l: string) => l.includes("agents-project-skill"));
      expect(userRow, "user .agents skill discovered").to.exist;
      expect(projRow, "project .agents skill discovered").to.exist;
      // USER-level .agents is always read-only (shared across projects);
      // project-level .agents is patchable in trusted projects (patchProjectAgents).
      expect(userRow).to.include("patchable: no");
      expect(projRow).to.include("patchable: yes");
    } finally {
      process.env.HOME = savedHome;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(projAgents, { recursive: true, force: true });
    }
  });

  it("local package skills are discovered + patchable; patchPackages:false disables; patch flows end-to-end", async () => {
    const pkg = mkdtempSync(join(tmpdir(), "pi-selfskills-fakepkg-"));
    try {
      const skillFile = writeSkill(join(pkg, "skills"), "pkg-probe-skill");
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fake-pkg" }), "utf8");
      // npm: entries are skipped entirely
      const { tools, ctx } = harness(cwd, {}, true, { packages: [pkg, "npm:@x/y"] });
      const list = await tools.skill_manage.execute("id", { action: "list" }, undefined, undefined, ctx);
      expect(list.content[0].text).to.include("pkg-probe-skill");
      const row = list.content[0].text.split("\n").find((l: string) => l.includes("pkg-probe-skill"));
      expect(row).to.include("patchable: yes");
      // full patch flow on a package skill (repo-source scenario)
      await tools.skill_manage.execute("id", { action: "read", skill: "pkg-probe-skill" }, undefined, undefined, ctx);
      const patch = await tools.skill_manage.execute(
        "id",
        { action: "patch", skill: "pkg-probe-skill", old_string: "Rule one.", new_string: "Rule pkg-patched." },
        undefined,
        undefined,
        ctx,
      );
      expect(patch.content[0].text).to.include("Patched ");
      expect(readFileSync(skillFile, "utf8")).to.include("Rule pkg-patched.");
      // patchPackages:false flips the same skill to read-only
      const h2 = harness(cwd, { patchPackages: false }, true, { packages: [pkg] });
      await h2.tools.skill_manage.execute("id", { action: "read", skill: "pkg-probe-skill" }, undefined, undefined, h2.ctx);
      const refused = await h2.tools.skill_manage.execute(
        "id",
        { action: "patch", skill: "pkg-probe-skill", old_string: "Rule pkg-patched.", new_string: "x" },
        undefined,
        undefined,
        h2.ctx,
      );
      expect(refused.details.error).to.equal(true);
      expect(refused.content[0].text).to.include("outside the writable skill roots");
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  });

  it("hash mismatch refuses patch after external modification; re-read clears it", async () => {
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    // external edit between read and patch
    writeFileSync(file, "---\nname: alpha\ndescription: \"Use when testing. One-line behavior.\"\n---\n\nExternally changed.\n", "utf8");
    const res = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "alpha", old_string: "Externally changed.", new_string: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("hash mismatch");
    // re-read clears it
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    const ok = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "alpha", old_string: "Externally changed.", new_string: "Amended." },
      undefined,
      undefined,
      ctx,
    );
    expect(ok.content[0].text).to.include("Patched ");
  });

  it("write creates/overwrites bundled files with backups; SKILL.md and escapes refused", async () => {
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\nSee references/api.md.\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    // create new bundled file
    const w1 = await tools.skill_manage.execute(
      "id",
      { action: "write", skill: "alpha", file: "references/api.md", content: "API reference body." },
      undefined,
      undefined,
      ctx,
    );
    expect(w1.content[0].text).to.include("Created");
    expect(readFileSync(join(defaultSkillsDir(), "alpha", "references", "api.md"), "utf8")).to.equal("API reference body.");
    // overwrite → backup of previous content
    const w2 = await tools.skill_manage.execute(
      "id",
      { action: "write", skill: "alpha", file: "references/api.md", content: "API reference v2." },
      undefined,
      undefined,
      ctx,
    );
    expect(w2.content[0].text).to.include("backed up to");
    expect(readFileSync(w2.details.backup, "utf8")).to.equal("API reference body.");
    // SKILL.md is patch-only
    const w3 = await tools.skill_manage.execute(
      "id",
      { action: "write", skill: "alpha", file: "SKILL.md", content: "clobber" },
      undefined,
      undefined,
      ctx,
    );
    expect(w3.details.error).to.equal(true);
    // escape refused
    const w4 = await tools.skill_manage.execute(
      "id",
      { action: "write", skill: "alpha", file: "../escape.md", content: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(w4.details.error).to.equal(true);
    // restore the bundled file's previous version
    const r1 = await tools.skill_manage.execute(
      "id",
      { action: "restore", skill: "alpha", file: "references/api.md" },
      undefined,
      undefined,
      ctx,
    );
    expect(r1.content[0].text).to.include("Restored");
    expect(readFileSync(join(defaultSkillsDir(), "alpha", "references", "api.md"), "utf8")).to.equal("API reference body.");
  });

  it("write requires the skill read first", async () => {
    writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, ctx } = harness(cwd);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "write", skill: "alpha", file: "references/x.md", content: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("read the skill");
  });

  it("delete removes a bundled file (backup + restore) and refuses SKILL.md; whole-skill delete snapshots", async () => {
    const skillDir = join(defaultSkillsDir(), "alpha");
    const file = writeSkill(defaultSkillsDir(), "alpha");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "references", "old.md"), "stale doc", "utf8");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    // SKILL.md alone not deletable
    const d0 = await tools.skill_manage.execute(
      "id",
      { action: "delete", skill: "alpha", file: "SKILL.md" },
      undefined,
      undefined,
      ctx,
    );
    expect(d0.details.error).to.equal(true);
    // bundled file delete → backup → restore
    const d1 = await tools.skill_manage.execute(
      "id",
      { action: "delete", skill: "alpha", file: "references/old.md" },
      undefined,
      undefined,
      ctx,
    );
    expect(d1.content[0].text).to.include("Deleted");
    expect(existsSync(join(skillDir, "references", "old.md"))).to.equal(false);
    expect(existsSync(skillDir)).to.equal(true); // skill survived
    const r1 = await tools.skill_manage.execute(
      "id",
      { action: "restore", skill: "alpha", file: "references/old.md" },
      undefined,
      undefined,
      ctx,
    );
    expect(readFileSync(join(skillDir, "references", "old.md"), "utf8")).to.equal("stale doc");
    // whole-skill delete → snapshot → dir gone
    const d2 = await tools.skill_manage.execute("id", { action: "delete", skill: "alpha" }, undefined, undefined, ctx);
    expect(d2.content[0].text).to.include("Deleted skill directory");
    expect(existsSync(skillDir)).to.equal(false);
    const list = await tools.skill_manage.execute("id", { action: "list" }, undefined, undefined, ctx);
    // presence-based: totals vary by machine (real ~/.agents roots merge in)
    expect(list.content[0].text).to.not.include("alpha —");
    // restore recreates the deleted skill at skillsDir (same root here)
    const r2 = await tools.skill_manage.execute("id", { action: "restore", skill: "alpha" }, undefined, undefined, ctx);
    expect(r2.content[0].text).to.include("Recreated deleted skill");
    expect(readFileSync(file, "utf8")).to.include("Rule one.");
  });

  it("operations[] batch applies atomically; any failure writes nothing", async () => {
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    // happy batch: patch SKILL.md + write a reference in one call
    const ok = await tools.skill_manage.execute(
      "id",
      {
        operations: [
          { action: "patch", skill: "alpha", old_string: "Rule one.", new_string: "Rule one (v2). See references/api.md." },
          { action: "write", skill: "alpha", file: "references/api.md", content: "API: do things." },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(ok.content[0].text).to.include("Batch applied (2 file change(s))");
    expect(readFileSync(file, "utf8")).to.include("references/api.md");
    expect(readFileSync(join(defaultSkillsDir(), "alpha", "references", "api.md"), "utf8")).to.equal("API: do things.");
    // failing batch: valid patch + invalid second op → NOTHING written
    const before = readFileSync(file, "utf8");
    const bad = await tools.skill_manage.execute(
      "id",
      {
        operations: [
          { action: "patch", skill: "alpha", old_string: "Rule one (v2).", new_string: "Rule one (v3)." },
          { action: "write", skill: "alpha", file: "SKILL.md", content: "forbidden" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(bad.details.error).to.equal(true);
    expect(bad.content[0].text).to.include("nothing was written");
    expect(readFileSync(file, "utf8")).to.equal(before);
    // empty batch
    const empty = await tools.skill_manage.execute("id", { operations: [] }, undefined, undefined, ctx);
    expect(empty.details.error).to.equal(true);
  });

  it("read → patch → patch works without re-read (tool writes refresh read-hash)", async () => {
    writeSkill(defaultSkillsDir(), "alpha", "Rule one.\nRule two.\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    const p1 = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "alpha", old_string: "Rule one.", new_string: "Rule uno." },
      undefined,
      undefined,
      ctx,
    );
    expect(p1.content[0].text).to.include("Patched ");
    // second patch without re-read: the tool's own write refreshed the hash
    const p2 = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "alpha", old_string: "Rule two.", new_string: "Rule dos." },
      undefined,
      undefined,
      ctx,
    );
    expect(p2.content[0].text).to.include("Patched ");
    expect(readFileSync(join(defaultSkillsDir(), "alpha", "SKILL.md"), "utf8")).to.include("Rule dos.");
  });

  it("write/delete with file= naming a directory refuse cleanly (no raw EISDIR)", async () => {
    const skillDir = join(defaultSkillsDir(), "alpha");
    writeSkill(defaultSkillsDir(), "alpha");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    for (const action of ["write", "delete"] as const) {
      const res = await tools.skill_manage.execute(
        "id",
        { action, skill: "alpha", file: "references", content: "x" },
        undefined,
        undefined,
        ctx,
      );
      expect(res.details.error, `${action} on a directory`).to.equal(true);
      expect(res.content[0].text).to.include("not a regular file");
    }
    expect(existsSync(join(skillDir, "references"))).to.equal(true);
  });

  it("batch: unread-skill write is refused like the standalone action", async () => {
    writeSkill(defaultSkillsDir(), "alpha");
    const { tools, ctx } = harness(cwd);
    const res = await tools.skill_manage.execute(
      "id",
      { operations: [{ action: "write", skill: "alpha", file: "references/x.md", content: "x" }] },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("read the skill first");
  });

  it("batch: two patches on one SKILL.md apply cumulatively (no false hash mismatch)", async () => {
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\nRule two.\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      {
        operations: [
          { action: "patch", skill: "alpha", old_string: "Rule one.", new_string: "Rule one (v2)." },
          { action: "patch", skill: "alpha", old_string: "Rule two.", new_string: "Rule two (v2)." },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(res.content[0].text).to.include("Batch applied (1 file change(s))");
    const after = readFileSync(file, "utf8");
    expect(after).to.include("Rule one (v2).");
    expect(after).to.include("Rule two (v2).");
  });

  it("batch: write→delete of an overlay-only file resolves cleanly (no ENOENT throw)", async () => {
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      {
        operations: [
          { action: "patch", skill: "alpha", old_string: "Rule one.", new_string: "Rule kept." },
          { action: "write", skill: "alpha", file: "references/tmp.md", content: "temp" },
          { action: "delete", skill: "alpha", file: "references/tmp.md" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(undefined);
    expect(res.content[0].text).to.include("Batch applied");
    expect(readFileSync(file, "utf8")).to.include("Rule kept.");
    expect(existsSync(join(defaultSkillsDir(), "alpha", "references", "tmp.md"))).to.equal(false);
  });

  it("restore of a deleted skill tolerates a backup key that differs from frontmatter name", async () => {
    const skillDir = join(defaultSkillsDir(), "on-disk-key");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillDir + "/SKILL.md", '---\nname: Bad_Name\ndescription: "Use when testing. One-line behavior."\n---\n\nRule one.\n', "utf8");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "Bad_Name" }, undefined, undefined, ctx);
    const del = await tools.skill_manage.execute("id", { action: "delete", skill: "Bad_Name" }, undefined, undefined, ctx);
    expect(del.content[0].text).to.include("Deleted skill directory");
    const res = await tools.skill_manage.execute("id", { action: "restore", skill: "on-disk-key" }, undefined, undefined, ctx);
    expect(res.content[0].text).to.include("Recreated deleted skill");
    expect(readFileSync(skillDir + "/SKILL.md", "utf8")).to.include("Rule one.");
  });

  it("whole-skill delete refuses after external modification (in-queue hash re-check)", async () => {
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    // external edit between read and delete
    writeFileSync(file, "---\nname: alpha\ndescription: \"Use when testing. One-line behavior.\"\n---\n\nExternally changed.\n", "utf8");
    const res = await tools.skill_manage.execute("id", { action: "delete", skill: "alpha" }, undefined, undefined, ctx);
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("hash mismatch");
    expect(existsSync(file)).to.equal(true); // dir untouched
  });

  it("backup and deletion-snapshot trees never surface in discovery", async () => {
    // Backups live at <agentDir>/selfskills/backups — a sibling of the scanned
    // skills root, never inside it. A snapshot SKILL.md under the backup root
    // must not resurface as a discoverable skill (Hermes' ship condition).
    const bdir = join(agentDir(), "selfskills", "backups", "ghost", "__deleted__", "20260101-000000.000-abc123def0");
    writeSkill(bdir, "ghost-skill");
    writeSkill(defaultSkillsDir(), "real-skill");
    try {
      const { tools, ctx } = harness(cwd);
      const res = await tools.skill_manage.execute("id", { action: "list" }, undefined, undefined, ctx);
      expect(res.content[0].text).to.include("real-skill");
      expect(res.content[0].text).to.not.include("ghost-skill");
    } finally {
      rmSync(join(agentDir(), "selfskills"), { recursive: true, force: true });
    }
  });

  it("batch validates the FINAL overlay only: op1-invalid → op2-fixes succeeds", async () => {
    // If each op's intermediate result were validated, op1 (temporarily
    // breaking frontmatter) would false-fail the batch. Final-overlay
    // semantics: only the end state is checked.
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      {
        operations: [
          { action: "patch", skill: "alpha", old_string: 'description: "Use when testing. One-line behavior."', new_string: 'description: ""' },
          { action: "patch", skill: "alpha", old_string: 'description: ""', new_string: 'description: "Use when testing. Amended behavior."' },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(undefined);
    expect(res.content[0].text).to.include("Batch applied (1 file change(s))");
    expect(readFileSync(file, "utf8")).to.include("Amended behavior.");
  });

  it("untrusted project: its own packages are never scanned into list (trust-bypass guard)", async () => {
    const pkg = mkdtempSync(join(tmpdir(), "pi-selfskills-untrusted-pkg-"));
    try {
      writeSkill(join(pkg, "skills"), "untrusted-pkg-skill");
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "sketchy" }), "utf8");
      // the untrusted repo declares the package in its own .pi/settings.json
      const { tools, ctx } = harness(cwd, undefined, /* trusted */ false, { packages: [pkg] });
      const res = await tools.skill_manage.execute("id", { action: "list" }, undefined, undefined, ctx);
      expect(res.content[0].text).to.not.include("untrusted-pkg-skill");
      // trusted: the same declaration is scanned (and would be patchable per patchPackages)
      const h2 = harness(cwd, undefined, true, { packages: [pkg] });
      const res2 = await h2.tools.skill_manage.execute("id", { action: "list" }, undefined, undefined, h2.ctx);
      expect(res2.content[0].text).to.include("untrusted-pkg-skill");
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  });

  it("read file= returns bundled files; directory reads refused cleanly", async () => {
    const skillDir = join(defaultSkillsDir(), "alpha");
    writeSkill(defaultSkillsDir(), "alpha", "Rule one.\nSee references/api.md.\n");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "references", "api.md"), "API reference body.", "utf8");
    const { tools, ctx } = harness(cwd);
    // bundled file via file= param
    const ok = await tools.skill_manage.execute(
      "id",
      { action: "read", skill: "alpha", file: "references/api.md" },
      undefined,
      undefined,
      ctx,
    );
    expect(ok.content[0].text).to.include("API reference body.");
    // directory read → clean refusal, no raw EISDIR
    const dir = await tools.skill_manage.execute(
      "id",
      { action: "read", path: join(skillDir, "references") },
      undefined,
      undefined,
      ctx,
    );
    expect(dir.details.error).to.equal(true);
    expect(dir.content[0].text).to.include("not a regular file");
  });

  it("binary bundled assets survive whole-skill delete → restore byte-for-byte", async () => {
    const skillDir = join(defaultSkillsDir(), "alpha");
    writeSkill(defaultSkillsDir(), "alpha", "Rule one.\nSee references/logo.\n");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    const bin = Buffer.from([0x89, 0x00, 0xff, 0xfe, 0x50, 0x4e, 0x47]);
    writeFileSync(join(skillDir, "references", "img.png"), bin);
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    const del = await tools.skill_manage.execute("id", { action: "delete", skill: "alpha" }, undefined, undefined, ctx);
    expect(del.content[0].text).to.include("Deleted skill directory");
    expect(existsSync(skillDir)).to.equal(false);
    await tools.skill_manage.execute("id", { action: "restore", skill: "alpha" }, undefined, undefined, ctx);
    const restored = readFileSync(join(skillDir, "references", "img.png"));
    expect(restored.equals(bin), "binary bytes identical").to.equal(true);
    expect(restored.includes(Buffer.from([0xef, 0xbf, 0xbd]))).to.equal(false); // no utf8 replacement char
  });

  it("batch patch on an unreadable SKILL.md → structured error, no raw throw", function () {
    if (typeof process.getuid === "function" && process.getuid() === 0) this.skip(); // chmod ignored as root
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, ctx } = harness(cwd);
    return (async () => {
      await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
      chmodSync(file, 0o000);
      try {
        const res = await tools.skill_manage.execute(
          "id",
          { operations: [{ action: "patch", skill: "alpha", old_string: "Rule one.", new_string: "x" }] },
          undefined,
          undefined,
          ctx,
        );
        expect(res.details.error).to.equal(true);
        expect(res.content[0].text).to.include("Batch failed");
      } finally {
        chmodSync(file, 0o644);
      }
    })();
  });

  it("read returns content and records read state", async () => {
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, ctx } = harness(cwd);
    const res = await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    expect(res.content[0].text).to.include("Rule one.");
    // patch now allowed without any further read
    const patch = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "alpha", old_string: "Rule one.", new_string: "Rule uno." },
      undefined,
      undefined,
      ctx,
    );
    expect(patch.content[0].text).to.include(`Patched ${realpathSync(file)}`);
  });

  it("read truncates over-large content", async () => {
    writeSkill(defaultSkillsDir(), "big", "x".repeat(40000));
    const { tools, ctx } = harness(cwd);
    const res = await tools.skill_manage.execute("id", { action: "read", skill: "big" }, undefined, undefined, ctx);
    expect(res.content[0].text).to.match(/truncated at 30000 of \d+ chars/);
  });

  it("read is scoped to discovered skill directories (no arbitrary-file reads)", async () => {
    writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, ctx } = harness(cwd);
    const outside = join(cwd, "secret.txt");
    writeFileSync(outside, "secret");
    const res = await tools.skill_manage.execute("id", { action: "read", path: outside }, undefined, undefined, ctx);
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("not inside a discovered skill directory");
    // bundled files inside a skill baseDir are legitimate progressive disclosure
    const refsDir = join(defaultSkillsDir(), "alpha", "references");
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(join(refsDir, "deep.md"), "deep docs");
    const ok = await tools.skill_manage.execute("id", { action: "read", path: join(refsDir, "deep.md") }, undefined, undefined, ctx);
    expect(ok.content[0].text).to.include("deep docs");
  });

  it("invalid dir name + invalid frontmatter name → clean refusal, no raw throw", async () => {
    const skillDir = join(defaultSkillsDir(), "Mixed_Case");
    mkdirSync(skillDir, { recursive: true });
    const file = join(skillDir, "SKILL.md");
    writeFileSync(file, '---\nname: Bad_Name\ndescription: "Use when testing. One-line behavior."\n---\n\nRule one.\n', "utf8");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "Bad_Name" }, undefined, undefined, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "Bad_Name", old_string: "Rule one.", new_string: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("valid skill name");
    expect(readFileSync(file, "utf8")).to.include("Rule one."); // untouched
  });

  it("patch refused without prior read", async () => {
    writeSkill(defaultSkillsDir(), "alpha");
    const { tools, ctx } = harness(cwd);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "alpha", old_string: "Rule one.", new_string: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("read the skill first");
  });

  it("patch accepted after simulating a built-in read via the tool_result hook", async () => {
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, handlers, ctx } = harness(cwd);
    handlers.tool_result[0]({ toolName: "read", input: { path: file }, isError: false }, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "alpha", old_string: "Rule one.", new_string: "Rule uno." },
      undefined,
      undefined,
      ctx,
    );
    expect(res.content[0].text).to.include("Patched ");
    expect(res.content[0].text).to.include("(backup ");
    expect(readFileSync(file, "utf8")).to.include("Rule uno.");
    // backup of the ORIGINAL content was created under the backup root
    expect(readFileSync(res.details.backup, "utf8")).to.include("Rule one.");
  });

  it("patch refused on node_modules path", async () => {
    const file = writeSkill(join(defaultSkillsDir(), "node_modules", "pkg"), "alpha");
    const { tools, handlers, ctx } = harness(cwd);
    handlers.tool_result[0]({ toolName: "read", input: { path: file }, isError: false }, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "patch", path: file, old_string: "Rule one.", new_string: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("node_modules");
  });

  it("non-unique old_string refused", async () => {
    writeSkill(defaultSkillsDir(), "alpha", "same line\nsame line\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "alpha", old_string: "same line", new_string: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("2 locations");
  });

  it("frontmatter-breaking patch refused before write", async () => {
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "alpha", old_string: 'description: "Use when testing. One-line behavior."\n', new_string: "" },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("nothing was written");
    expect(readFileSync(file, "utf8")).to.include("Use when testing"); // untouched
  });

  it("create happy path — valid per SDK re-list — and refuses existing/invalid names", async () => {
    const { tools, ctx } = harness(cwd);
    const res = await tools.skill_manage.execute(
      "id",
      {
        action: "create",
        name: "fresh-skill",
        description: "Use when shipping. Creates the thing.",
        body: "Do it imperatively.",
      },
      undefined,
      undefined,
      ctx,
    );
    expect(res.content[0].text).to.include("Created skill `fresh-skill`");
    const created = join(agentDir(), "skills", "fresh-skill", "SKILL.md");
    expect(readFileSync(created, "utf8")).to.include("Do it imperatively.");
    // SDK re-list sees it as a valid skill
    const list = await tools.skill_manage.execute("id", { action: "list", skill: "fresh" }, undefined, undefined, ctx);
    expect(list.content[0].text).to.include("fresh-skill");
    // refuse existing file
    const dup = await tools.skill_manage.execute(
      "id",
      { action: "create", name: "fresh-skill", description: "d", body: "b" },
      undefined,
      undefined,
      ctx,
    );
    expect(dup.content[0].text).to.include("already exists");
    // refuse discovered-name clash (clash lives in the project dir, not the create target dir)
    writeSkill(join(cwd, ".pi", "skills"), "alpha");
    const clash = await tools.skill_manage.execute(
      "id",
      { action: "create", name: "alpha", description: "d", body: "b" },
      undefined,
      undefined,
      ctx,
    );
    expect(clash.content[0].text).to.include("already discovered");
    // invalid names / bad description / empty body
    for (const params of [
      { action: "create", name: "Bad_Name", description: "d", body: "b" },
      { action: "create", name: "ok-name", description: "", body: "b" },
      { action: "create", name: "ok-name", description: "two\nlines", body: "b" },
      { action: "create", name: "ok-name", description: "d", body: "" },
    ]) {
      const bad = await tools.skill_manage.execute("id", params as any, undefined, undefined, ctx);
      expect(bad.details.error).to.equal(true);
    }
  });

  it("restore happy path — byte-identical revert, current content backed up first", async () => {
    const file = writeSkill(defaultSkillsDir(), "alpha", "Original rule.\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "alpha", old_string: "Original rule.", new_string: "Patched rule." },
      undefined,
      undefined,
      ctx,
    );
    expect(readFileSync(file, "utf8")).to.include("Patched rule.");
    const res = await tools.skill_manage.execute("id", { action: "restore", skill: "alpha" }, undefined, undefined, ctx);
    expect(res.content[0].text).to.include(`Restored ${realpathSync(file)}`);
    expect(readFileSync(file, "utf8")).to.equal(
      "---\nname: alpha\ndescription: \"Use when testing. One-line behavior.\"\n---\n\nOriginal rule.\n",
    );
    expect(res.content[0].text).to.include("backed up to");
    // unknown backup name → error
    const missing = await tools.skill_manage.execute(
      "id",
      { action: "restore", skill: "alpha", backup: "20990101-000000-deadbeef00" },
      undefined,
      undefined,
      ctx,
    );
    expect(missing.details.error).to.equal(true);
    expect(missing.content[0].text).to.include("No backup");
  });

  it("before_agent_start prepends the discipline block; inject:false leaves the prompt untouched", () => {
    const { handlers, ctx } = harness(cwd);
    const out = handlers.before_agent_start[0]({ systemPrompt: "BASE" }, ctx);
    expect(out.systemPrompt.startsWith("## pi-selfskills: skill self-improvement discipline")).to.equal(true);
    expect(out.systemPrompt.endsWith("---\n\nBASE")).to.equal(true);

    const { handlers: h2, ctx: c2 } = harness(cwd, { inject: false });
    expect(h2.before_agent_start[0]({ systemPrompt: "BASE" }, c2)).to.equal(undefined);
  });

  it("enabled:false disables the tool with a message and skips injection", async () => {
    const { tools, handlers, ctx } = harness(cwd, { enabled: false });
    const res = await tools.skill_manage.execute("id", { action: "list" }, undefined, undefined, ctx);
    expect(res.content[0].text).to.include("disabled");
    expect(handlers.before_agent_start[0]({ systemPrompt: "BASE" }, ctx)).to.equal(undefined);
  });

  it("/selfskills command reports status", () => {
    writeSkill(defaultSkillsDir(), "alpha");
    const { commands, notifications, ctx } = harness(cwd);
    commands.selfskills.handler("", ctx);
    expect(notifications[0]).to.include("pi-selfskills enabled");
    const count = Number((notifications[0].match(/Discovered skills: (\d+)/) ?? [])[1]);
    expect(count, "at least the alpha skill is counted").to.be.at.least(1);
    expect(notifications[0]).to.include("Backups: 0");
  });

  it("session_start clears read state", async () => {
    writeSkill(defaultSkillsDir(), "alpha");
    const { tools, handlers, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    handlers.session_start[0]({ reason: "new" }, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "alpha", old_string: "Rule one.", new_string: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("read the skill first");
  });

  it("a failed read (isError) does not unlock patching", async () => {
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, handlers, ctx } = harness(cwd);
    handlers.tool_result[0]({ toolName: "read", input: { path: file }, isError: true }, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "alpha", old_string: "Rule one.", new_string: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("read the skill first");
  });

  it("untrusted project: cwd settings cannot punch through the writable-root allowlist", async () => {
    const overrideDir = join(cwd, "punch-target");
    const file = writeSkill(overrideDir, "victim", "Rule one.\n");
    const { tools, handlers, ctx } = harness(cwd, { skillsDir: overrideDir }, /* trusted */ false);
    handlers.tool_result[0]({ toolName: "read", input: { path: file }, isError: false }, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "patch", path: file, old_string: "Rule one.", new_string: "x" },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("outside the writable skill roots");
    // trusted=true: the same override from the SAME cwd settings applies.
    const h2 = harness(cwd, { skillsDir: overrideDir }, true);
    h2.handlers.tool_result[0]({ toolName: "read", input: { path: file }, isError: false }, h2.ctx);
    const ok = await h2.tools.skill_manage.execute(
      "id",
      { action: "patch", path: file, old_string: "Rule one.", new_string: "Rule patched." },
      undefined,
      undefined,
      h2.ctx,
    );
    expect(ok.content[0].text).to.include("Patched ");
  });

  it("restore refuses a traversal backup param and leaves the file untouched", async () => {
    const file = writeSkill(defaultSkillsDir(), "alpha", "Rule one.\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "restore", skill: "alpha", backup: "../../../../etc/hostname.md" },
      undefined,
      undefined,
      ctx,
    );
    expect(res.details.error).to.equal(true);
    expect(res.content[0].text).to.include("No backup");
    expect(readFileSync(file, "utf8")).to.include("Rule one."); // untouched
  });

  it("parallel patches on the same skill both land (no lost update)", async () => {
    writeSkill(defaultSkillsDir(), "alpha", "alpha rule\nbeta rule\n");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "alpha" }, undefined, undefined, ctx);
    const [r1, r2] = await Promise.all([
      tools.skill_manage.execute(
        "id",
        { action: "patch", skill: "alpha", old_string: "alpha rule", new_string: "alpha PATCHED" },
        undefined,
        undefined,
        ctx,
      ),
      tools.skill_manage.execute(
        "id",
        { action: "patch", skill: "alpha", old_string: "beta rule", new_string: "beta PATCHED" },
        undefined,
        undefined,
        ctx,
      ),
    ]);
    const errors = [r1, r2].filter((r: any) => r?.details?.error);
    // Either both applied or one failed loudly — never a silent clobber.
    if (errors.length === 0) {
      const content = readFileSync(join(defaultSkillsDir(), "alpha", "SKILL.md"), "utf8");
      expect(content).to.include("alpha PATCHED");
      expect(content).to.include("beta PATCHED");
    } else {
      expect(errors.length).to.equal(1);
    }
  });

  it("list filter with no match reports none", async () => {
    writeSkill(defaultSkillsDir(), "alpha");
    const { tools, ctx } = harness(cwd);
    const res = await tools.skill_manage.execute("id", { action: "list", skill: "zzz-nope" }, undefined, undefined, ctx);
    expect(res.content[0].text).to.include("No skills discovered");
  });

  it("create honors the skillsDir override end-to-end", async () => {
    const overrideDir = join(cwd, "custom-skills");
    const { tools, ctx } = harness(cwd, { skillsDir: overrideDir }, true);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "create", name: "ovr-skill", description: "Use when overriding. Lands in skillsDir.", body: "Imperative." },
      undefined,
      undefined,
      ctx,
    );
    expect(res.content[0].text).to.include("Created skill `ovr-skill`");
    expect(readFileSync(join(overrideDir, "ovr-skill", "SKILL.md"), "utf8")).to.include("Imperative.");
  });

  it("invalid frontmatter name never becomes a backup path component", async () => {
    // SDK loader still loads skills with invalid names (warning only) — the
    // backup dir must fall back to the on-disk directory basename.
    const skillDir = join(defaultSkillsDir(), "on-disk-name");
    mkdirSync(skillDir, { recursive: true });
    const file = join(skillDir, "SKILL.md");
    writeFileSync(file, '---\nname: ../../escaped\ndescription: "Use when testing. One-line behavior."\n---\n\nRule one.\n', "utf8");
    const { tools, ctx } = harness(cwd);
    await tools.skill_manage.execute("id", { action: "read", skill: "../../escaped" }, undefined, undefined, ctx);
    const res = await tools.skill_manage.execute(
      "id",
      { action: "patch", skill: "../../escaped", old_string: "Rule one.", new_string: "Rule patched." },
      undefined,
      undefined,
      ctx,
    );
    expect(res.content[0].text).to.include("Patched ");
    expect(res.details.backup).to.include(join("selfskills", "backups", "on-disk-name"));
    // nothing escaped the backup root
    expect(existsSync(join(agentDir(), "selfskills", "backups", "escaped"))).to.equal(false);
  });

  it("parallel creates of one name: exactly one succeeds", async () => {
    const { tools, ctx } = harness(cwd);
    const [r1, r2] = await Promise.all([
      tools.skill_manage.execute(
        "id",
        { action: "create", name: "race-skill", description: "Use when racing. One winner.", body: "Body A." },
        undefined,
        undefined,
        ctx,
      ),
      tools.skill_manage.execute(
        "id",
        { action: "create", name: "race-skill", description: "Use when racing. One winner.", body: "Body B." },
        undefined,
        undefined,
        ctx,
      ),
    ]);
    const successes = [r1, r2].filter((r: any) => !r?.details?.error);
    expect(successes.length, "exactly one create succeeds").to.equal(1);
    const onDisk = readFileSync(join(agentDir(), "skills", "race-skill", "SKILL.md"), "utf8");
    expect(onDisk).to.include(r1?.details?.error ? "Body B." : "Body A.");
  });
});
