/**
 * Role-based model routing tests: defaults preservation, settings layering,
 * @role expansion (nesting/cycles/unknown), :thinking suffix parsing, and
 * per-agent overrides.
 */

import * as assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_ROLES,
  expandModelCandidates,
  readSubagentRoles,
  readSubagentRolesGlobal,
  resolveAgentModelChain,
  splitThinkingSuffix,
  type RolesConfig,
} from "../roles.ts";
import { buildRows, buildRolesPanelCfg, cfgToPatch, defaultChainLabel, makeAddRoleAction, makeRemoveRoleAction, preserveUnknownAgentModels, removeRoleFromCfg, validateNewRoleName } from "../roles-panel.ts";
import { discoverAgents, getModelCandidates } from "../agents.ts";
import type { AgentConfig } from "../agents.ts";

const BUNDLED_DIR = path.resolve(import.meta.dirname, "..", "..", "agents");

function emptyRoles(): RolesConfig {
  return { roles: {}, agentModels: {}, agentThinking: {} };
}

describe("splitThinkingSuffix", () => {
  it("splits a known trailing level", () => {
    assert.deepEqual(splitThinkingSuffix("opencode-go/deepseek-v4-pro:high"), {
      name: "opencode-go/deepseek-v4-pro",
      thinking: "high",
    });
  });

  it("keeps openrouter :free ids intact", () => {
    assert.deepEqual(splitThinkingSuffix("openrouter/nvidia/nemotron-3-super-120b-a12b:free"), {
      name: "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    });
  });

  it("returns name only when no colon", () => {
    assert.deepEqual(splitThinkingSuffix("zai-coding-cn/glm-5-turbo"), { name: "zai-coding-cn/glm-5-turbo" });
  });

  it("ignores unknown trailing segments", () => {
    assert.deepEqual(splitThinkingSuffix("provider/model:whatever"), { name: "provider/model:whatever" });
  });
});

describe("expandModelCandidates", () => {
  it("passes concrete candidates through, deduped", () => {
    const { candidates, unresolved } = expandModelCandidates(["a/b", "a/b", "c/d"], emptyRoles().roles);
    assert.deepEqual(candidates, ["a/b", "c/d"]);
    assert.deepEqual(unresolved, []);
  });

  it("expands @role to its chain in place", () => {
    const roles = { fast: ["a/one", "a/two"] };
    const { candidates } = expandModelCandidates(["@fast", "a/backup"], roles);
    assert.deepEqual(candidates, ["a/one", "a/two", "a/backup"]);
  });

  it("accepts comma-string role values", () => {
    const { candidates } = expandModelCandidates(["@fast"], { fast: "a/one, a/two" });
    assert.deepEqual(candidates, ["a/one", "a/two"]);
  });

  it("supports one-level nested roles", () => {
    const { candidates } = expandModelCandidates(["@outer"], { outer: "@fast", fast: ["a/one"] });
    assert.deepEqual(candidates, ["a/one"]);
  });

  it("cycle-safe: recursive roles do not loop", () => {
    const { candidates } = expandModelCandidates(["@a"], { a: "@b", b: "@a" });
    assert.deepEqual(candidates, []);
  });

  it("unknown role → recorded in unresolved and skipped", () => {
    const { candidates, unresolved } = expandModelCandidates(["@missing", "a/fallback"], emptyRoles().roles);
    assert.deepEqual(candidates, ["a/fallback"]);
    assert.deepEqual(unresolved, ["@missing"]);
  });

  it("* and @default mean parent fallback (empty candidates)", () => {
    assert.deepEqual(expandModelCandidates(["*"], emptyRoles().roles).candidates, []);
    assert.deepEqual(expandModelCandidates(["@default"], emptyRoles().roles).candidates, []);
  });

  it("captures :thinking suffix per candidate", () => {
    const { candidates, thinkingByCandidate } = expandModelCandidates(
      ["a/deep:high", "a/cheap"],
      emptyRoles().roles,
    );
    assert.deepEqual(candidates, ["a/deep", "a/cheap"]);
    assert.equal(thinkingByCandidate.get("a/deep"), "high");
    assert.equal(thinkingByCandidate.get("a/cheap"), undefined);
  });

  it("role chains carry :thinking per entry", () => {
    const { thinkingByCandidate } = expandModelCandidates(["@smart"], { smart: ["a/x:high", "a/y"] });
    assert.equal(thinkingByCandidate.get("a/x"), "high");
  });
});

describe("resolveAgentModelChain", () => {
  it("behavior preservation: bundled agents + DEFAULT_ROLES equal today's chains", () => {
    const rolesCfg: RolesConfig = { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} };
    const discovery = discoverAgents(os.tmpdir(), "user", BUNDLED_DIR);
    const byName = new Map(discovery.agents.map((a) => [a.name, a]));

    const scout = byName.get("scout")!;
    assert.deepEqual(getModelCandidates(scout), ["@fast"]);
    assert.deepEqual(resolveAgentModelChain(scout, rolesCfg).candidates, [
      "zai-coding-cn/glm-5-turbo",
      "nvidia/openai/gpt-oss-20b",
      "opencode-go/deepseek-v4-flash",
    ]);

    const planner = byName.get("planner")!;
    assert.deepEqual(resolveAgentModelChain(planner, rolesCfg).candidates, [
      "zai-coding-cn/glm-5.3",
      "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
      "opencode-go/deepseek-v4-pro",
    ]);

    const worker = byName.get("worker")!;
    assert.deepEqual(resolveAgentModelChain(worker, rolesCfg).candidates, [
      "zai-coding-cn/glm-5.1",
      "nvidia/mistralai/mistral-small-4-119b-2603",
      "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
      "opencode-go/deepseek-v4-flash",
    ]);
  });

  it("agentModels override replaces the whole candidate list", () => {
    const rolesCfg: RolesConfig = { roles: structuredClone(DEFAULT_ROLES), agentModels: { scout: "a/custom" }, agentThinking: {} };
    const agent: Pick<AgentConfig, "name" | "model" | "models"> = { name: "scout", model: "@fast", models: [] };
    const chain = resolveAgentModelChain(agent, rolesCfg);
    assert.deepEqual(chain.candidates, ["a/custom"]);
    assert.equal(chain.overridden, true);
  });

  it("agentModels override may reference a role with :thinking", () => {
    const rolesCfg: RolesConfig = { roles: structuredClone(DEFAULT_ROLES), agentModels: { reviewer: "@smart:high" }, agentThinking: {} };
    const agent: Pick<AgentConfig, "name" | "model" | "models"> = { name: "reviewer", model: "@smart", models: [] };
    const chain = resolveAgentModelChain(agent, rolesCfg);
    assert.deepEqual(chain.candidates, ["zai-coding-cn/glm-5.3", "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", "opencode-go/deepseek-v4-pro"]);
    assert.equal(chain.thinkingByCandidate.get("zai-coding-cn/glm-5.3"), "high");
  });

  it("no candidates → parent fallback (empty list)", () => {
    const rolesCfg: RolesConfig = { roles: structuredClone(DEFAULT_ROLES), agentModels: { scout: "*" }, agentThinking: {} };
    const agent: Pick<AgentConfig, "name" | "model" | "models"> = { name: "scout", model: "@fast", models: [] };
    assert.deepEqual(resolveAgentModelChain(agent, rolesCfg).candidates, []);
  });
});

describe("readSubagentRoles settings layering", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-roles-"));
    process.env.PI_CODING_AGENT_DIR = tmpHome;
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("no settings → DEFAULT_ROLES", () => {
    const cfg = readSubagentRoles();
    assert.deepEqual(cfg.roles, DEFAULT_ROLES);
    assert.deepEqual(cfg.agentModels, {});
  });

  it("global settings.json overrides role chains", () => {
    writeFileSync(path.join(tmpHome, "settings.json"), JSON.stringify({
      subagent: { roles: { fast: ["nvidia/openai/gpt-oss-20b"] }, agentModels: { tester: "a/t" } },
    }));
    const cfg = readSubagentRoles();
    assert.deepEqual(cfg.roles.fast, ["nvidia/openai/gpt-oss-20b"]);
    assert.deepEqual(cfg.roles.coder, DEFAULT_ROLES.coder); // untouched
    assert.equal(cfg.agentModels.tester, "a/t");
  });

  it("accepts comma-string role values in settings", () => {
    writeFileSync(path.join(tmpHome, "settings.json"), JSON.stringify({
      subagent: { roles: { fast: "a/one, a/two" } },
    }));
    const cfg = readSubagentRoles();
    assert.deepEqual(cfg.roles.fast, ["a/one", "a/two"]);
  });

  it("ignores garbage settings sections", () => {
    writeFileSync(path.join(tmpHome, "settings.json"), JSON.stringify({
      subagent: { roles: "not-an-object", agentModels: [1, 2] },
    }));
    const cfg = readSubagentRoles();
    assert.deepEqual(cfg.roles, DEFAULT_ROLES);
    assert.deepEqual(cfg.agentModels, {});
  });

  it("reads valid agentThinking entries and drops invalid ones", () => {
    writeFileSync(path.join(tmpHome, "settings.json"), JSON.stringify({
      subagent: { agentThinking: { reviewer: "high", junk: "nope" } },
    }));
    const cfg = readSubagentRoles();
    assert.equal(cfg.agentThinking.reviewer, "high");
    assert.equal(cfg.agentThinking.junk, undefined);
  });

  it("effectiveAgentThinking: settings override beats frontmatter", async () => {
    const { effectiveAgentThinking } = await import("../roles.ts");
    const agent = { name: "planner", thinking: "high" as const };
    assert.equal(effectiveAgentThinking(agent, { agentThinking: {} }), "high");
    assert.equal(effectiveAgentThinking(agent, { agentThinking: { planner: "low" } }), "low");
    assert.equal(effectiveAgentThinking({ name: "x", thinking: undefined }, { agentThinking: { x: "medium" } }), "medium");
    assert.equal(effectiveAgentThinking({ name: "x", thinking: undefined }, { agentThinking: {} }), undefined);
  });

  it("untrusted repo .pi/settings.json is ignored", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-repo-"));
    mkdirSync(path.join(repo, ".pi"));
    writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({
      subagent: { roles: { fast: ["evil/repo"] } },
    }));
    const cfg = readSubagentRoles({ cwd: repo, isProjectTrusted: () => false } as any);
    assert.deepEqual(cfg.roles.fast, DEFAULT_ROLES.fast);
    rmSync(repo, { recursive: true, force: true });
  });

  it("trusted repo .pi/settings.json overlays global per key", () => {
    writeFileSync(path.join(tmpHome, "settings.json"), JSON.stringify({
      subagent: { roles: { fast: ["global/fast"] }, agentModels: { scout: "global/s" } },
    }));
    const repo = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-repo-"));
    mkdirSync(path.join(repo, ".pi"));
    writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({
      subagent: { roles: { fast: ["repo/fast"], coder: ["repo/coder"] } },
    }));
    const cfg = readSubagentRoles({ cwd: repo, isProjectTrusted: () => true } as any);
    assert.deepEqual(cfg.roles.fast, ["repo/fast"]);
    assert.deepEqual(cfg.roles.coder, ["repo/coder"]);
    assert.deepEqual(cfg.roles.smart, DEFAULT_ROLES.smart); // untouched
    assert.equal(cfg.agentModels.scout, "global/s"); // agentModels NOT overlaid by repo
    rmSync(repo, { recursive: true, force: true });
  });

  it("readSubagentRolesGlobal never sees repo overlay", () => {
    writeFileSync(path.join(tmpHome, "settings.json"), JSON.stringify({
      subagent: { roles: { fast: ["global/fast"] } },
    }));
    const repo = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-repo-"));
    mkdirSync(path.join(repo, ".pi"));
    writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({
      subagent: { roles: { fast: ["repo/fast"] } },
    }));
    const cfg = readSubagentRolesGlobal();
    assert.deepEqual(cfg.roles.fast, ["global/fast"]);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("roles panel", () => {
  const agents: AgentConfig[] = [
    { name: "scout", description: "d", model: "@fast", models: [], systemPrompt: "", source: "bundled", filePath: "/x" },
    { name: "worker", description: "d", model: "@coder", models: [], systemPrompt: "", source: "bundled", filePath: "/x" },
  ];

  it("buildRolesPanelCfg defaults render blank (= default chain)", () => {
    const cfg = buildRolesPanelCfg(agents, { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} });
    assert.equal(cfg.roles.fast, "");
    assert.equal(cfg.roles.coder, "");
    assert.equal(cfg.agentModels.scout, "");
  });

  it("explicit overrides render as comma chains", () => {
    const current: RolesConfig = {
      roles: { ...structuredClone(DEFAULT_ROLES), fast: ["a/one", "a/two"] },
      agentModels: { scout: "a/custom" }, agentThinking: {},
    };
    const cfg = buildRolesPanelCfg(agents, current);
    assert.equal(cfg.roles.fast, "a/one, a/two");
    assert.equal(cfg.agentModels.scout, "a/custom");
  });

  it("cfgToPatch drops blanks and parses comma chains", () => {
    const cfg = buildRolesPanelCfg(agents, { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} });
    cfg.roles.fast = "a/one, a/two";
    cfg.roles.coder = "";
    cfg.agentModels.scout = "a/custom";
    cfg.agentModels.worker = "";
    const patch = cfgToPatch(cfg);
    assert.deepEqual(patch.roles, { fast: ["a/one", "a/two"] });
    assert.deepEqual(patch.agentModels, { scout: "a/custom" });
  });

  it("single model without comma stays a string", () => {
    const cfg = buildRolesPanelCfg(agents, { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} });
    cfg.roles.fast = "nvidia/openai/gpt-oss-20b";
    assert.deepEqual(cfgToPatch(cfg).roles, { fast: "nvidia/openai/gpt-oss-20b" });
  });

  it("preserveUnknownAgentModels keeps undiscovered agents' overrides", async () => {
    const { preserveUnknownAgentModels } = await import("../roles-panel.ts");
    const preserved = preserveUnknownAgentModels(
      { scout: "a/custom" },
      ["scout"],
      { scout: "old", worker: "kept", ghost: "also-kept" },
    );
    assert.deepEqual(preserved, { scout: "a/custom", worker: "kept", ghost: "also-kept" });
  });

  it("buildRows produces role + agent + thinking groups", () => {
    const cfg = buildRolesPanelCfg(agents, { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} });
    const groups = buildRows(cfg, agents);
    assert.equal(groups.length, 3);
    assert.ok(groups[0].rows.some((r) => r.key === "role.fast"));
    assert.ok(groups[1].rows.some((r) => r.key === "agent.scout"));
    assert.ok(groups[2].rows.some((r) => r.key === "agentThinking.scout"));
    // setter mutates cfg
    const fastRow = groups[0].rows.find((r) => r.key === "role.fast")!;
    fastRow.set("a/x, a/y");
    assert.equal(cfg.roles.fast, "a/x, a/y");
  });

  it("thinking rows round-trip through cfgToPatch; blanks and invalid drop", async () => {
    const { invalidAgentThinking } = await import("../roles-panel.ts");
    const cfg = buildRolesPanelCfg(agents, { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} });
    const groups = buildRows(cfg, agents);
    const scoutRow = groups[2].rows.find((r) => r.key === "agentThinking.scout")!;
    scoutRow.set("high");
    const workerRow = groups[2].rows.find((r) => r.key === "agentThinking.worker")!;
    workerRow.set("hgh"); // typo — dropped by cfgToPatch, reported by invalidAgentThinking
    const patch = cfgToPatch(cfg);
    assert.equal(patch.agentThinking.scout, "high");
    assert.equal(patch.agentThinking.worker, undefined);
    assert.deepEqual(invalidAgentThinking(cfg), ["worker"]);
    workerRow.set("");
    assert.deepEqual(invalidAgentThinking(cfg), []);
    assert.deepEqual(cfgToPatch(cfg).agentThinking, { scout: "high" });
  });

  it("preserveUnknownAgentModels also preserves agentThinking for undiscovered agents", () => {
    const preserved = preserveUnknownAgentModels(
      { scout: "high" },
      ["scout"],
      { scout: "low", ghost: "medium" },
    );
    assert.deepEqual(preserved, { scout: "high", ghost: "medium" });
  });

  it("agent row labels show the default chain when effectiveRoles provided", () => {
    const cfg = buildRolesPanelCfg(agents, { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} });
    const groups = buildRows(cfg, agents, { models: () => [], roles: () => [], effectiveRoles: DEFAULT_ROLES });
    const scout = groups[1].rows.find((r) => r.key === "agent.scout")!;
    assert.ok(scout.label.includes("@fast"), `expected @fast alias in label, got: ${scout.label}`);
    assert.ok(scout.label.includes(DEFAULT_ROLES.fast[0]), `expected resolved chain in label, got: ${scout.label}`);
    // without effectiveRoles, defaults still apply
    const groupsBare = buildRows(cfg, agents);
    const scoutBare = groupsBare[1].rows.find((r) => r.key === "agent.scout")!;
    assert.ok(scoutBare.label.includes("@fast"));
  });

  it("buildRows appends add/remove action rows when actions provided", () => {
    const cfg = buildRolesPanelCfg(agents, { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} });
    const actions = {
      addRole: { label: "Add role", run: () => {} },
      removeRole: { label: "Remove role", run: () => {} },
    };
    const groups = buildRows(cfg, agents, undefined, actions);
    const keys = groups[0].rows.map((r) => r.key);
    assert.ok(keys.includes("action.addRole"));
    assert.ok(keys.includes("action.removeRole"));
    // action rows are action kind and route run() through set
    const addRow = groups[0].rows.find((r) => r.key === "action.addRole")!;
    assert.equal(addRow.kind, "action");
    // without actions, no action rows (backward compat)
    const bare = buildRows(cfg, agents);
    assert.ok(!bare[0].rows.some((r) => r.key.startsWith("action.")));
  });

  it("defaultChainLabel: alias → chain, plain models, parent fallback", () => {
    const roles = structuredClone(DEFAULT_ROLES);
    // role alias
    const label = defaultChainLabel({ name: "s", model: "@fast" }, roles);
    assert.ok(label.startsWith("default: @fast → "), label);
    // plain model (no alias prefix)
    assert.equal(defaultChainLabel({ name: "s", model: "a/one", models: [] }, roles), "default: a/one");
    // no models at all
    assert.equal(defaultChainLabel({ name: "s" }, roles), "default: parent fallback");
  });

  it("validateNewRoleName rejects invalid/colliding names", () => {
    const known = ["fast", "coder", "smart"];
    assert.equal(validateNewRoleName("writer", known), null);
    assert.equal(validateNewRoleName("code-review.v2_x", known), null);
    assert.ok(validateNewRoleName("", known));
    assert.ok(validateNewRoleName("has space", known));
    assert.ok(validateNewRoleName("@at", known));
    assert.ok(validateNewRoleName("a".repeat(65), known));
    assert.ok(validateNewRoleName("FAST", known), "case-insensitive collision");
  });

  it("removeRoleFromCfg resets built-ins and deletes customs", () => {
    const cfg = buildRolesPanelCfg([], { roles: { ...structuredClone(DEFAULT_ROLES), writer: ["a/one"] }, agentModels: {}, agentThinking: {} });
    assert.equal(removeRoleFromCfg(cfg, "fast"), "reset");
    assert.equal(cfg.roles.fast, "");
    assert.equal(removeRoleFromCfg(cfg, "WRITER"), "deleted");
    assert.equal(cfg.roles.writer, undefined);
    assert.equal(removeRoleFromCfg(cfg, "ghost"), null);
  });

  it("addRole action validates and mutates the working config", async () => {
    // full flow: name prompt then chain prompt
    const cfg = buildRolesPanelCfg([], { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} });
    const add = makeAddRoleAction(cfg, {});
    let step = 0;
    await add.run((_label, onDone) => { step += 1; onDone(step === 1 ? "writer" : "a/one, a/two"); });
    assert.equal(cfg.roles.writer, "a/one, a/two");

    // case-insensitive duplicate name aborts with a notify
    const notes: string[] = [];
    const cfg2 = buildRolesPanelCfg([], { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} });
    const add2 = makeAddRoleAction(cfg2, { notify: (m) => notes.push(m) });
    await add2.run((_label, onDone) => onDone("FAST"));
    assert.ok(!("FAST" in cfg2.roles) && cfg2.roles.fast === "");
    assert.ok(notes.some((n) => n.includes("already exists")));

    // invalid name aborts
    const cfg3 = buildRolesPanelCfg([], { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} });
    const add3 = makeAddRoleAction(cfg3, {});
    await add3.run((_label, onDone) => onDone("has space"));
    assert.ok(!("has space" in cfg3.roles));

    // blank chain aborts
    const cfg4 = buildRolesPanelCfg([], { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} });
    const add4 = makeAddRoleAction(cfg4, {});
    let step4 = 0;
    await add4.run((_label, onDone) => { step4 += 1; onDone(step4 === 1 ? "writer" : ""); });
    assert.ok(!("writer" in cfg4.roles));
  });

  it("removeRole action resets built-ins via removeRoleFromCfg", async () => {
    const cfg = buildRolesPanelCfg([], { roles: structuredClone(DEFAULT_ROLES), agentModels: {}, agentThinking: {} });
    const notes: string[] = [];
    const remove = makeRemoveRoleAction(cfg, { notify: (m) => notes.push(m) });
    await remove.run((label, onDone) => onDone("fast"));
    assert.equal(cfg.roles.fast, "");
    assert.ok(notes.some((n) => n.includes("reset to bundled default")));
    // empty pick is a no-op; unknown pick warns
    await remove.run((label, onDone) => onDone(undefined));
    await remove.run((label, onDone) => onDone("ghost"));
    assert.ok(notes.some((n) => n.includes('No role named')));
  });
});

describe("writeSubagentSection persistence", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-write-"));
    process.env.PI_CODING_AGENT_DIR = tmpHome;
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("refuses to overwrite corrupt settings.json and leaves it byte-identical", async () => {
    const { writeSubagentSection } = await import("../roles-panel.ts");
    writeFileSync(path.join(tmpHome, "settings.json"), '{"theme":"dark",');
    let threw: unknown = null;
    try {
      writeSubagentSection({ roles: { fast: ["a/x"] } });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw instanceof Error, "expected a throw, got none");
    assert.ok(String((threw as Error).message).includes("not valid JSON"));
    assert.equal(readFileSync(path.join(tmpHome, "settings.json"), "utf8"), '{"theme":"dark",');
  });

  it("preserves unrelated keys and returns false for no-ops", async () => {
    const { writeSubagentSection } = await import("../roles-panel.ts");
    writeFileSync(path.join(tmpHome, "settings.json"), JSON.stringify({
      theme: "dark",
      subagent: { roles: { fast: ["a/x"] } },
    }));
    assert.equal(writeSubagentSection({ roles: { fast: ["a/x"] } }), false);
    writeSubagentSection({ roles: { fast: ["a/y"] } });
    const raw = readFileSync(path.join(tmpHome, "settings.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.theme, "dark");
    assert.deepEqual(parsed.subagent.roles.fast, ["a/y"]);
  });

  it("creates the file when missing and drops an emptied subagent", async () => {
    const { writeSubagentSection } = await import("../roles-panel.ts");
    assert.equal(writeSubagentSection({ roles: { fast: ["a/x"] }, agentModels: {}, agentThinking: {} }), true);
    const created = JSON.parse(readFileSync(path.join(tmpHome, "settings.json"), "utf8"));
    assert.deepEqual(created.subagent.roles.fast, ["a/x"]);
    writeSubagentSection({ roles: {}, agentModels: {}, agentThinking: {} });
    const after = JSON.parse(readFileSync(path.join(tmpHome, "settings.json"), "utf8"));
    assert.equal(after.subagent, undefined);
  });

  it("refuses to overwrite a non-object settings.json root", async () => {
    const { writeSubagentSection } = await import("../roles-panel.ts");
    writeFileSync(path.join(tmpHome, "settings.json"), "[1,2,3]");
    let threw: unknown = null;
    try {
      writeSubagentSection({ roles: { fast: ["a/x"] } });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw instanceof Error, "expected a throw, got none");
    assert.ok(String((threw as Error).message).includes("not a JSON object"));
    assert.equal(readFileSync(path.join(tmpHome, "settings.json"), "utf8"), "[1,2,3]");
  });

  it("preserves unrelated subagent.* keys when clearing roles/agentModels", async () => {
    const { writeSubagentSection } = await import("../roles-panel.ts");
    writeFileSync(path.join(tmpHome, "settings.json"), JSON.stringify({
      theme: "dark",
      subagent: { roles: { fast: ["a/x"] }, agentModels: {}, agentThinking: {}, maxTurns: 20 },
    }));
    writeSubagentSection({ roles: {}, agentModels: {}, agentThinking: {} });
    const after = JSON.parse(readFileSync(path.join(tmpHome, "settings.json"), "utf8"));
    assert.equal(after.theme, "dark");
    assert.equal(after.subagent.maxTurns, 20);
    assert.equal(after.subagent.roles, undefined);
    assert.equal(after.subagent.agentModels, undefined);
  });
});

describe("bundled agent files use role aliases", () => {
  it("all six bundled agents parse with @role model refs and no prefix diagnostics", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const bundledDir = path.join(root, "bundled");
    mkdirSync(bundledDir, { recursive: true });
    rmSync(root, { recursive: true, force: true });

    const discovery = discoverAgents(os.tmpdir(), "user", BUNDLED_DIR);
    assert.equal(discovery.agents.length, 6);
    const prefixDiags = discovery.diagnostics.filter((d) => d.issue.includes("provider prefix"));
    assert.deepEqual(prefixDiags, []);
    for (const agent of discovery.agents) {
      const cands = getModelCandidates(agent);
      assert.equal(cands.length, 1, `${agent.name} should have exactly one alias`);
      assert.ok(cands[0].startsWith("@"), `${agent.name} model should be @role, got ${cands[0]}`);
    }
  });
});
