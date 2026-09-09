import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { agentDir, expandTilde, packageSkillDirs, readSelfSkillsSettings } from "../lib/config";

const ENV_KEYS = ["PI_CODING_AGENT_DIR"] as const;

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSettings(dir: string, selfskills: Record<string, unknown>): void {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ selfskills }), "utf8");
}

describe("config", () => {
  let savedEnv: Record<string, string | undefined>;
  let dirs: string[];

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    // Hermetic agent dir for every test (settings fallback + default skillsDir).
    const agent = tmpDir("pi-selfskills-cfg-agent-");
    process.env.PI_CODING_AGENT_DIR = agent;
    dirs = [agent];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("returns defaults when no settings files exist (skillsDir tracks agentDir)", () => {
    const cwd = tmpDir("pi-selfskills-cfg-cwd-");
    dirs.push(cwd);
    expect(readSelfSkillsSettings(cwd)).to.deep.equal({
      enabled: true,
      inject: true,
      skillsDir: join(agentDir(), "skills"),
      backupCap: 10,
      patchPackages: true,
      patchProjectAgents: true,
    });
  });

  it("reads overrides from <cwd>/.pi/settings.json when trusted, tilde-expands skillsDir", () => {
    const cwd = tmpDir("pi-selfskills-cwd2-");
    dirs.push(cwd);
    writeSettings(cwd, { enabled: false, inject: false, skillsDir: "~/skills-ovr", backupCap: 3 });
    expect(readSelfSkillsSettings(cwd, true)).to.deep.equal({
      enabled: false,
      inject: false,
      skillsDir: join(process.env.HOME ?? "", "skills-ovr"),
      backupCap: 3,
      patchPackages: true,
      patchProjectAgents: true,
    });
  });

  it("ignores <cwd>/.pi/settings.json when untrusted (allowlist punch-through guard)", () => {
    const cwd2 = tmpDir("pi-selfskills-cwd-untrusted-");
    dirs.push(cwd2);
    writeSettings(cwd2, { enabled: false, inject: false, backupCap: 1 });
    // trusted=false: cwd settings must not apply — user-level defaults win.
    expect(readSelfSkillsSettings(cwd2, false)).to.deep.equal({
      enabled: true,
      inject: true,
      skillsDir: join(agentDir(), "skills"),
      backupCap: 10,
      patchPackages: true,
      patchProjectAgents: true,
    });
  });

  it("falls back to $PI_CODING_AGENT_DIR/settings.json when cwd has none", () => {
    const cwd = tmpDir("pi-selfskills-cwd3-");
    dirs.push(cwd);
    const agent = tmpDir("pi-selfskills-agent2-");
    dirs.push(agent);
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ selfskills: { backupCap: 42 } }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agent;
    expect(readSelfSkillsSettings(cwd).backupCap).to.equal(42);
  });

  it("cwd settings win over agent-dir settings (resolution order)", () => {
    const cwd = tmpDir("pi-selfskills-cwd4-");
    dirs.push(cwd);
    writeSettings(cwd, { backupCap: 1 });
    const agent = tmpDir("pi-selfskills-agent3-");
    dirs.push(agent);
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ selfskills: { backupCap: 2 } }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agent;
    expect(readSelfSkillsSettings(cwd, true).backupCap).to.equal(1);
  });

  it("malformed JSON → defaults", () => {
    const cwd = tmpDir("pi-selfskills-cwd5-");
    dirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), "{not json", "utf8");
    expect(readSelfSkillsSettings(cwd, true)).to.deep.equal({
      enabled: true,
      inject: true,
      skillsDir: join(agentDir(), "skills"),
      backupCap: 10,
      patchPackages: true,
      patchProjectAgents: true,
    });
  });

  it("packageSkillDirs refuses pi.skills entries that escape the package dir", () => {
    const cwd = tmpDir("pi-selfskills-pkg-esc-cwd-");
    dirs.push(cwd);
    const pkg = tmpDir("pi-selfskills-pkg-esc-");
    dirs.push(pkg);
    mkdirSync(join(pkg, "skills"), { recursive: true });
    mkdirSync(join(pkg, "node_modules", "z"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "p", pi: { skills: ["skills", "../../..", "/etc", "./node_modules/z"] } }),
      "utf8",
    );
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [pkg] }), "utf8");
    expect(packageSkillDirs(cwd, true)).to.deep.equal([join(pkg, "skills")]);
  });

  it("expandTilde handles ~, ~/ and untouched absolute paths", () => {
    const home = process.env.HOME ?? "";
    expect(expandTilde("~")).to.equal(home);
    expect(expandTilde("~/x/y")).to.equal(join(home, "x/y"));
    expect(expandTilde("/abs/path")).to.equal("/abs/path");
    expect(expandTilde("other~")).to.equal("other~");
  });

  it("packageSkillDirs resolves local packages (pi.skills entries), skips npm:/node_modules", () => {
    const cwd = tmpDir("pi-selfskills-pkg-cwd-");
    dirs.push(cwd);
    const pkg = tmpDir("pi-selfskills-pkg-dir-");
    dirs.push(pkg);
    mkdirSync(join(pkg, "custom-skills"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "p", pi: { skills: ["custom-skills"] } }),
      "utf8",
    );
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ packages: [pkg, "npm:@x/y", join(pkg, "node_modules", "z")] }),
      "utf8",
    );
    expect(packageSkillDirs(cwd, true)).to.deep.equal([join(pkg, "custom-skills")]);
  });
});
