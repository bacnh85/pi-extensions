import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { readEvolveSettings, resolveSettingsPath } from "../lib/config";

const DEFAULTS = {
  enabled: true,
  autoInject: true,
  injectMode: "both",
  maxInject: 3,
  store: "auto",
  bufferCap: 200,
  localCap: 500,
  autoReflect: true,
  errorTriage: true,
  recallStoredFixes: true,
};

const ENV_KEYS = ["PI_CODING_AGENT_DIR"] as const;

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSettings(dir: string, evolve: Record<string, unknown>, scope: "cwd" | "agent" = "cwd"): void {
  const base = scope === "cwd" ? join(dir, ".pi") : dir;
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "settings.json"), JSON.stringify({ evolve }), "utf8");
}

describe("config", () => {
  let savedEnv: Record<string, string | undefined>;
  let dirs: string[];

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    // Hermetic agent dir for every test (settings fallback).
    const agent = tmpDir("pi-evolve-cfg-agent-");
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

  it("returns defaults when no settings files exist (missing file)", () => {
    const cwd = tmpDir("pi-evolve-cfg-empty-");
    dirs.push(cwd);
    expect(readEvolveSettings(cwd)).to.deep.equal(DEFAULTS);
    expect(resolveSettingsPath(cwd)).to.equal(null);
  });

  it("malformed JSON → defaults", () => {
    const cwd = tmpDir("pi-evolve-cfg-malformed-");
    dirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), "{not json", "utf8");
    expect(readEvolveSettings(cwd, true)).to.deep.equal(DEFAULTS);
  });

  it("reads overrides from <cwd>/.pi/settings.json when trusted", () => {
    const cwd = tmpDir("pi-evolve-cfg-trusted-");
    dirs.push(cwd);
    writeSettings(cwd, { enabled: false, store: "local", bufferCap: 7 });
    expect(readEvolveSettings(cwd, true)).to.deep.equal({ ...DEFAULTS, enabled: false, store: "local", bufferCap: 7 });
    expect(resolveSettingsPath(cwd, true)).to.equal(join(cwd, ".pi", "settings.json"));
  });

  it("ignores <cwd>/.pi/settings.json when untrusted (an untrusted repo cannot re-enable evolve or steer store:local)", () => {
    const cwd = tmpDir("pi-evolve-cfg-untrusted-");
    dirs.push(cwd);
    writeSettings(cwd, { enabled: false, store: "local", bufferCap: 7 });
    // trusted=false: cwd settings must not apply — defaults win.
    expect(readEvolveSettings(cwd, false)).to.deep.equal(DEFAULTS);
    // Untrusted: no cwd candidate → nothing exists → null.
    expect(resolveSettingsPath(cwd, false)).to.equal(null);
  });

  it("falls back to $PI_CODING_AGENT_DIR/settings.json when cwd has none", () => {
    const cwd = tmpDir("pi-evolve-cfg-fallback-");
    dirs.push(cwd);
    const agent = tmpDir("pi-evolve-cfg-agent2-");
    dirs.push(agent);
    writeSettings(agent, { maxInject: 9 }, "agent");
    process.env.PI_CODING_AGENT_DIR = agent;
    expect(readEvolveSettings(cwd).maxInject).to.equal(9);
    expect(resolveSettingsPath(cwd)).to.equal(join(agent, "settings.json"));
  });

  it("trusted cwd settings win over agent-dir settings (resolution order)", () => {
    const cwd = tmpDir("pi-evolve-cfg-precedence-");
    dirs.push(cwd);
    const agent = tmpDir("pi-evolve-cfg-agent3-");
    dirs.push(agent);
    writeSettings(cwd, { bufferCap: 1 });
    writeSettings(agent, { bufferCap: 2 }, "agent");
    process.env.PI_CODING_AGENT_DIR = agent;
    expect(readEvolveSettings(cwd, true).bufferCap).to.equal(1);
  });

  it("untrusted cwd falls through to agent-dir settings (cwd ignored, agent honored)", () => {
    const cwd = tmpDir("pi-evolve-cfg-untrusted-fallback-");
    dirs.push(cwd);
    const agent = tmpDir("pi-evolve-cfg-agent4-");
    dirs.push(agent);
    writeSettings(cwd, { enabled: false });
    writeSettings(agent, { enabled: false, autoInject: false }, "agent");
    process.env.PI_CODING_AGENT_DIR = agent;
    // The untrusted repo's enabled:false is ignored, but the user's own
    // agent-dir opt-out still applies.
    expect(readEvolveSettings(cwd, false)).to.deep.equal({ ...DEFAULTS, enabled: false, autoInject: false });
  });

  it("invalid value types fall back per-field (num/bool/enum guards)", () => {
    const cwd = tmpDir("pi-evolve-cfg-guards-");
    dirs.push(cwd);
    writeSettings(cwd, {
      enabled: "yes",
      injectMode: "nope",
      maxInject: -1,
      store: "dropbox",
    });
    expect(readEvolveSettings(cwd, true)).to.deep.equal(DEFAULTS);
  });
});
