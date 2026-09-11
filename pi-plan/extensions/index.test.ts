/**
 * Tests for pi-plan extension: prompt composition, tool gating, plan lifecycle,
 * path containment.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "mocha";
import os from "node:os";
import path from "node:path";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { initTheme } from "@earendil-works/pi-coding-agent";
import piPlanExtension, { isInsidePlansDir, snapshotUntrackedFiles } from "./index";
import { BLOCKED_TOOLS, READ_ONLY_TOOLS } from "./lib/plan-tools";
import { PLAN_MODE_SERENA_GUIDANCE } from "./lib/guidance";
import { captureRewindCheckpoint, restoreRewindCheckpoint, rewindToFlowBaseline, validateRewindCheckpoint, type RewindCheckpoint } from "./lib/lifecycle";
import { advanceGoal, registerGoal, DEFAULT_GOAL_MAX_TURNS, type GoalAccessors, type GoalState } from "./commands/goal";
import { buildFinalPrompt } from "./commands/handoff";
import { formatSpecsProgress, invalidExistingTargets, specExecutionPrompt, specSlug } from "./commands/specs";
import { workspaceContext } from "./lib/workspace-context";
import { parseModel, loadUtilityConfig } from "./lib/utility-config";

/** Real temp directory for tests that write files. */
const TMP = path.join(os.tmpdir(), "pi-plan-test-" + process.pid);
const REAL_HOMEDIR = os.homedir;
const REAL_AGENT_DIR_ENV = process.env.PI_CODING_AGENT_DIR;
before(() => {
  // getAgentDir() snapshots homedir at SDK load — the env override is the
  // reliable way to point pi-plan's settings.json at the temp home.
  process.env.PI_CODING_AGENT_DIR = path.join(TMP, ".pi", "agent");
  os.homedir = () => TMP; // still isolate other homedir-based code paths
  mkdirSync(TMP, { recursive: true });
});
after(() => {
  os.homedir = REAL_HOMEDIR;
  if (REAL_AGENT_DIR_ENV === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = REAL_AGENT_DIR_ENV;
});
afterEach(cleanPrefs); // keep the isolated settings file hermetic between tests

function prefsPath(): string {
  return path.join(TMP, ".pi", "agent", "settings.json");
}
function legacyPrefsPath(): string {
  return path.join(TMP, ".pi", "agent", "pi-plan", "preferences.json");
}
function cleanPrefs(): void {
  mkdirSync(path.dirname(prefsPath()), { recursive: true });
  writeFileSync(prefsPath(), "{}\n");
  try { rmSync(legacyPrefsPath()); } catch { /* absent */ }
  try { rmSync(`${legacyPrefsPath()}.migrated`); } catch { /* absent */ }
}
/** Write pi-plan prefs into settings.json under the "pi-plan" key. */
function writePrefs(json: string): void {
  mkdirSync(path.dirname(prefsPath()), { recursive: true });
  writeFileSync(prefsPath(), JSON.stringify({ "pi-plan": JSON.parse(json) }, null, 2) + "\n");
}

function createGitRepo(prefix: string): string {
  const cwd = mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet"], { cwd });
  execFileSync("git", ["config", "user.email", "test@test"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  // The dev machine's global config signs commits via an agent that is not
  // always reachable in tests — sign nothing here.
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "# test");
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-m", "initial"], { cwd });
  return cwd;
}

describe("workflow snapshots", () => {
  it("snapshots untracked paths losslessly and detects content changes", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-plan-hash-"));
    execFileSync("git", ["init", "--quiet"], { cwd });
    const names = ["café.txt", "line\nbreak.txt"];
    for (const name of names) writeFileSync(path.join(cwd, name), name);

    type Entry = { path: string; hash: string; content: string };
    const first = new Map<string, Entry>((JSON.parse(await snapshotUntrackedFiles(cwd)) as Entry[]).map((entry) => [entry.path, entry]));
    assert.deepEqual([...first.keys()].sort(), [...names].sort());
    assert.equal(Buffer.from(first.get(names[0])!.content, "base64").toString(), names[0]);
    writeFileSync(path.join(cwd, names[0]), "changed");
    const second = new Map<string, Entry>((JSON.parse(await snapshotUntrackedFiles(cwd)) as Entry[]).map((entry) => [entry.path, entry]));
    assert.notEqual(second.get(names[0])?.hash, first.get(names[0])?.hash);
    chmodSync(path.join(cwd, names[1]), 0o755);
    const third = new Map<string, Entry>((JSON.parse(await snapshotUntrackedFiles(cwd)) as Entry[]).map((entry) => [entry.path, entry]));
    assert.equal(third.get(names[1])?.hash, second.get(names[1])?.hash);
    assert.equal((third.get(names[1]) as Entry & { mode: number }).mode, 0o755);
    writeFileSync(path.join(cwd, "large.txt"), "x".repeat(14 * 1024));
    assert.ok(JSON.parse(await snapshotUntrackedFiles(cwd)).some((entry: Entry) => entry.path === "large.txt"));
    writeFileSync(path.join(cwd, "large.txt"), "x".repeat(1024 * 1024 + 1));
    await assert.rejects(snapshotUntrackedFiles(cwd), /untracked content exceeds 1024 KB; commit, stage, or ignore/);
    const symlinkRepo = createGitRepo("pi-plan-symlink-");
    symlinkSync("/etc/hosts", path.join(symlinkRepo, "outside"));
    await assert.rejects(snapshotUntrackedFiles(symlinkRepo), /not a regular file: outside/);
  });
});

describe("state lifecycle", () => {
  it("captures and restores a prompt checkpoint", async () => {
    const cwd = createGitRepo("pi-plan-checkpoint-");
    writeFileSync(path.join(cwd, "README.md"), "checkpoint\n");
    writeFileSync(path.join(cwd, "keep.ts"), "export const keep = true;\n");
    const checkpoint = await captureRewindCheckpoint(cwd, "prompt-1", "Try this implementation", "test-session", "2026-01-01T00:00:00.000Z");
    writeFileSync(path.join(cwd, "README.md"), "broken\n");
    writeFileSync(path.join(cwd, "bad.ts"), "broken\n");

    const result = await restoreRewindCheckpoint(cwd, checkpoint);
    assert.notEqual(result.stash, "none");
    assert.equal(readFileSync(path.join(cwd, "README.md"), "utf8"), "checkpoint\n");
    assert.equal(readFileSync(path.join(cwd, "keep.ts"), "utf8"), "export const keep = true;\n");
    assert.equal(existsSync(path.join(cwd, "bad.ts")), false);

    execFileSync("git", ["add", "README.md"], { cwd });
    execFileSync("git", ["commit", "-m", "diverged"], { cwd });
    await assert.rejects(restoreRewindCheckpoint(cwd, checkpoint), /HEAD to match the checkpoint baseline/);
  });

  it("keeps empty directories for legacy and current snapshots", async () => {
    const cwd = createGitRepo("pi-plan-legacy-snapshot-");
    mkdirSync(path.join(cwd, "legacy"));
    const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    await rewindToFlowBaseline(cwd, { baseline, phase: "implement", reviewPass: 0, initialUntrackedSnapshot: "[]" });
    assert.equal(existsSync(path.join(cwd, "legacy")), true);
    const checkpoint = await captureRewindCheckpoint(cwd, "prompt-1", "Prompt", "test-session");
    mkdirSync(path.join(cwd, "new-empty"));
    await restoreRewindCheckpoint(cwd, checkpoint);
    assert.equal(existsSync(path.join(cwd, "new-empty")), true);
  });

  it("restores the whole repository when started from a subdirectory", async () => {
    const cwd = createGitRepo("pi-plan-subdir-");
    const subdir = path.join(cwd, "sub");
    mkdirSync(subdir);
    writeFileSync(path.join(cwd, "sibling.ts"), "checkpoint\n");
    writeFileSync(path.join(subdir, "child.ts"), "checkpoint\n");
    const checkpoint = await captureRewindCheckpoint(subdir, "prompt-1", "Prompt", "test-session");
    writeFileSync(path.join(cwd, "sibling.ts"), "broken\n");
    writeFileSync(path.join(subdir, "child.ts"), "broken\n");
    await restoreRewindCheckpoint(subdir, checkpoint);
    assert.equal(readFileSync(path.join(cwd, "sibling.ts"), "utf8"), "checkpoint\n");
    assert.equal(readFileSync(path.join(subdir, "child.ts"), "utf8"), "checkpoint\n");
  });

  it("restores the workflow baseline and file modes", async () => {
    const cwd = createGitRepo("pi-plan-lifecycle-");
    const plan = path.join(cwd, ".agents", "plans", "plan.md");
    mkdirSync(path.dirname(plan), { recursive: true });
    mkdirSync(path.join(cwd, "scratch"));
    writeFileSync(plan, "# Plan\n\n- [x] inspect\n- [ ] implement\n");
    chmodSync(plan, 0o755);
    writeFileSync(path.join(cwd, "README.md"), "staged\n");
    execFileSync("git", ["add", "README.md"], { cwd });
    writeFileSync(path.join(cwd, "README.md"), "unstaged\n");
    const initialUntrackedSnapshot = await snapshotUntrackedFiles(cwd);
    const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const initialCachedPatch = execFileSync("git", ["diff", "--cached", "--binary", "HEAD"], { cwd, encoding: "utf8" });
    const initialUnstagedPatch = execFileSync("git", ["diff", "--binary"], { cwd, encoding: "utf8" });
    writeFileSync(path.join(cwd, "README.md"), "broken");
    writeFileSync(path.join(cwd, "bad.ts"), "broken");

    await rewindToFlowBaseline(cwd, { baseline, phase: "implement", reviewPass: 0, initialCachedPatch, initialUnstagedPatch, initialUntrackedSnapshot });
    assert.equal(readFileSync(path.join(cwd, "README.md"), "utf8"), "unstaged\n");
    assert.equal(execFileSync("git", ["show", ":README.md"], { cwd, encoding: "utf8" }), "staged\n");
    assert.equal(readFileSync(plan, "utf8"), "# Plan\n\n- [x] inspect\n- [ ] implement\n");
    assert.equal(statSync(plan).mode & 0o777, 0o755);
    assert.equal(existsSync(path.join(cwd, "bad.ts")), false);
    assert.equal(existsSync(path.join(cwd, "scratch")), true);
  });

  it("captures large patches that exceed the old 50 KB inline limit", async () => {
    const cwd = createGitRepo("pi-plan-large-patch-");
    writeFileSync(path.join(cwd, "big.ts"), "x".repeat(80 * 1024) + "\n");
    // Previously threw "workspace patch exceeds 50 KB" — now writes to an external file instead.
    const checkpoint = await captureRewindCheckpoint(cwd, "prompt-big", "Big change", "test-session");
    assert.ok(checkpoint.patchFile, "checkpoint should reference an external payload file");
    assert.ok(existsSync(checkpoint.patchFile!), "external payload file should exist on disk");
    // The session entry must NOT contain inline patches.
    assert.equal(checkpoint.cachedPatch, undefined);
    assert.equal(checkpoint.unstagedPatch, undefined);
    // Restore round-trips correctly.
    writeFileSync(path.join(cwd, "big.ts"), "broken\n");
    const result = await restoreRewindCheckpoint(cwd, checkpoint);
    assert.notEqual(result.stash, "none");
    assert.equal(readFileSync(path.join(cwd, "big.ts"), "utf8"), "x".repeat(80 * 1024) + "\n");
  });

  it("restores a legacy inline-format checkpoint without a patchFile", async () => {
    const cwd = createGitRepo("pi-plan-legacy-");
    writeFileSync(path.join(cwd, "README.md"), "legacy-checkpoint\n");
    // Simulate a checkpoint saved before external storage (inline payloads, no patchFile).
    const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const legacy: RewindCheckpoint = {
      promptEntryId: "prompt-legacy",
      prompt: "Legacy",
      timestamp: "2026-01-01T00:00:00.000Z",
      baseline,
      cachedPatch: "",
      unstagedPatch: execFileSync("git", ["diff", "--binary"], { cwd, encoding: "utf8" }),
      untrackedSnapshot: "[]",
      untrackedSnapshotVersion: 1,
    };
    writeFileSync(path.join(cwd, "README.md"), "broken\n");
    await restoreRewindCheckpoint(cwd, legacy);
    assert.equal(readFileSync(path.join(cwd, "README.md"), "utf8"), "legacy-checkpoint\n");
  });

  it("validateRewindCheckpoint rejects a missing external payload before conversation rewind", async () => {
    const cwd = createGitRepo("pi-plan-missing-payload-");
    const checkpoint = await captureRewindCheckpoint(cwd, "prompt-missing", "Missing payload", "test-session");
    // Simulate the payload file being deleted (manual cleanup, disk failure, etc.).
    const { rmSync } = await import("node:fs");
    rmSync(checkpoint.patchFile!, { force: true });
    // validateRewindCheckpoint must reject so the combined-restore path fails BEFORE
    // navigating the conversation, not after.
    await assert.rejects(validateRewindCheckpoint(cwd, checkpoint), /payload not found/);
  });
});

// ── Fake Pi harness ──────────────────────────────────────────────

type EventHandler = (event: any, ctx: any) => any;

interface FakePi {
  handlers: Record<string, EventHandler[]>;
  toolDefs: Record<string, any>;
  commands: Record<string, any>;
  flags: Record<string, any>;
  shortcuts: Record<string, any>;
  activeTools: string[];
  thinkingLevel: string | null;
  modelSets: any[];
  setModelReject?: boolean;
  setModelFalse?: boolean; // setModel returns false (no auth) instead of rejecting
  entries: any[];
  sentMessages: any[];
  customMessages: any[];
  entryRenderers: Record<string, any>;
  flagValues: Record<string, any>;
  eventEmits?: any[];
  onEmit?: (event: string, data: any) => void;
  eventHandlers?: Record<string, Array<(data: any) => void>>;
}

function createFakePi(
  initialTools: string[] = [],
  flagValues: Record<string, any> = {},
): { pi: any } & FakePi {
  const state: FakePi = {
    handlers: {},
    toolDefs: {},
    commands: {},
    flags: {},
    shortcuts: {},
    activeTools: [...initialTools],
    thinkingLevel: null,
    modelSets: [],
    entries: [],
    sentMessages: [],
    customMessages: [],
    entryRenderers: {},
    flagValues: { ...flagValues },
  };

  const pi = {
    on(event: string, handler: EventHandler) {
      (state.handlers[event] ??= []).push(handler);
    },
    registerTool(def: any) {
      state.toolDefs[def.name] = def;
    },
    registerCommand(name: string, def: any) {
      state.commands[name] = def;
    },
    registerFlag(name: string, def: any) {
      state.flags[name] = def;
    },
    registerShortcut(keys: string, def: any) {
      state.shortcuts[keys] = def;
    },
    registerEntryRenderer(type: string, renderer: any) {
      state.entryRenderers[type] = renderer;
    },
    getActiveTools() {
      return [...state.activeTools];
    },
    setActiveTools(tools: string[]) {
      state.activeTools.splice(0, state.activeTools.length, ...tools);
    },
    setThinkingLevel(level: string) {
      state.thinkingLevel = level;
    },
    getThinkingLevel() {
      return state.thinkingLevel ?? "medium";
    },
    setModel(model: any) {
      state.modelSets.push(model);
      // Real Pi setModel returns Promise<boolean> — false on missing auth,
      // true on success. Rejects only on unexpected failures.
      if (state.setModelReject) return Promise.reject(new Error("No API key for model"));
      return Promise.resolve(!state.setModelFalse);
    },
    appendEntry(customType: string, data?: any) {
      state.entries.push({ customType, data });
    },
    getFlag(name: string) {
      return state.flagValues[name] ?? false;
    },
    sendUserMessage(content: string, options?: any) {
      state.sentMessages.push({ content, options });
    },
    getSessionName() { return undefined; },
    sendMessage(message: any, options?: any) {
      state.customMessages.push({ message, options });
    },
    events: {
      emit(event: string, data: any) {
        state.eventEmits ??= [];
        state.eventEmits.push({ event, data });
        state.onEmit?.(event, data);
      },
      on(channel: string, handler: (data: any) => void) {
        state.eventHandlers ??= {};
        (state.eventHandlers[channel] ??= []).push(handler);
        return () => {}; // ponytail: no-op unsubscribe
      },
    },
    exec: async (_cmd: string, _args: string[], _options?: any) => ({
      code: 0,
      stdout: "abc123def",
      stderr: "",
    }),
  };

  piPlanExtension(pi as any);
  return Object.assign(state, { pi });
}

function fakeCtx(overrides: Record<string, any> = {}): any {
  const ctx: any = {
    cwd: overrides.cwd ?? TMP,
    hasUI: overrides.hasUI ?? true,
    model: overrides.model ?? { provider: "test", id: "model-1" },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    getContextUsage: () => ({ percent: 50 }),
    isIdle: () => true,
    isProjectTrusted: () => false,
    ui: {
      theme: { fg: (_style: string, text: string) => text },
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
      select: async (_question: string, _options: string[]) => null,
      confirm: async (_title: string, _body: string) => false,
      editor: async (_title: string, _default: string) => "",
      custom: async <T,>(_factory: any) => null as T,
      getEditorComponent: () => undefined,
      setEditorComponent: () => {},
      setEditorText: (_text: string) => {},
      getEditorText: () => "",
    },
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => "/test/session.jsonl",
      getSessionId: () => "test-session",
    },
    waitForIdle: async () => {},
    sendUserMessage: async (_content: string, _options?: any) => {},
    ...overrides,
  };
  if (overrides.ui) Object.assign(ctx.ui, overrides.ui);
  if (overrides.sessionManager) Object.assign(ctx.sessionManager, overrides.sessionManager);
  if (overrides.modelRegistry) Object.assign(ctx.modelRegistry, overrides.modelRegistry);
  return ctx;
}

// ── Tests ────────────────────────────────────────────────────────

describe("workspace utility commands", () => {
  it("registers isolated utility commands and creates safe spec slugs", () => {
    const { commands } = createFakePi(["read"]);
    for (const command of ["btw", "specs", "specs-approve", "doctor"]) assert.ok(commands[command], `/${command} registered`);
    assert.equal(specSlug("Refactor cache!"), "refactor-cache");
    assert.equal(specSlug("../../../etc/passwd"), "etc-passwd");
    assert.deepEqual(parseModel("openai-codex/gpt-5.6-sol"), { provider: "openai-codex", id: "gpt-5.6-sol" });
    assert.deepEqual(parseModel("openrouter/anthropic/claude-3-haiku"), { provider: "openrouter", id: "anthropic/claude-3-haiku" });
    assert.equal(parseModel("invalid"), undefined);
  });

  it("formats colored timestamped specs progress", () => {
    const now = new Date("2026-07-19T00:00:00.000Z");
    assert.equal(formatSpecsProgress("scanning workspace", "cyan", now), "\x1b[36m[2026-07-19T00:00:00.000Z] scanning workspace\x1b[0m");
    assert.match(formatSpecsProgress("specification written", "green", now), /^\x1b\[32m\[/);
    assert.match(formatSpecsProgress("specification failed", "red", now), /^\x1b\[31m\[/);
  });

  it("prefills a scoped implementation prompt after approving specs in TUI", async () => {
    const { commands, handlers } = createFakePi(["read", "edit"]);
    const specPath = path.join(TMP, ".agents", "specs", "spec.md");
    let editorText = "";
    const ctx = fakeCtx({
      mode: "tui",
      ui: { theme: { fg: (_style: string, text: string) => text }, setStatus: () => {}, setWidget: () => {}, notify: () => {}, getEditorComponent: () => undefined, setEditorComponent: () => {}, setEditorText: (text: string) => { editorText = text; } },
      sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-plan", data: { enabled: true, specGateActive: true, specGatePlanMode: false, specPath } }] },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await commands["specs-approve"].handler("", ctx);
    assert.equal(editorText, specExecutionPrompt(".agents/specs/spec.md"));
    const result = await handlers.tool_call?.[0]({ toolName: "edit", input: { path: "x" } }, ctx);
    assert.equal(result, undefined, "approval releases the write gate");
  });

  it("reports the implementation prompt outside TUI", async () => {
    const { commands, handlers } = createFakePi(["read"]);
    const specPath = path.join(TMP, ".agents", "specs", "spec.md");
    const notices: string[] = [];
    const ctx = fakeCtx({
      mode: "rpc",
      ui: { theme: { fg: (_style: string, text: string) => text }, setStatus: () => {}, setWidget: () => {}, notify: (message: string) => notices.push(message) },
      sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-plan", data: { enabled: true, specGateActive: true, specGatePlanMode: false, specPath } }] },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await commands["specs-approve"].handler("", ctx);
    assert.ok(notices.includes(specExecutionPrompt(".agents/specs/spec.md")));
  });

  it("grounds specs targets in the supplied workspace context", () => {
    const context = { files: new Set(["known.ts", "src/existing.ts"]), directories: new Set(["", "src", "lib"]) };
    const cases: Array<[string, string[]]> = [
      ["- `known.ts`", []],
      ["- `known.ts`, `missing.ts`", ["missing.ts"]],
      ["- `src/existing.ts`", []],
      ["- `missing.ts`", ["missing.ts"]],
      ["- `/tmp/missing.ts`", ["/tmp/missing.ts"]],
      ["- `../missing.ts`", ["../missing.ts"]],
      ["- `src\\missing.ts`", ["src\\missing.ts"]],
      ["- no existing target file: `proposed.ts` (new)", []],
      ["- no existing target file: `src/proposed.ts` (new)", []],
      ["- `lib/proposed.ts` (new)", ["lib/proposed.ts"]],
      ["- no existing target file: `apps/web/page.ts` (new)", ["apps/web/page.ts"]],
    ];
    for (const [line, invalid] of cases) assert.deepEqual(invalidExistingTargets(context, line), invalid, line);
  });

  it("returns captured workspace paths with the model prompt", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-plan-context-"));
    mkdirSync(path.join(cwd, "src")); writeFileSync(path.join(cwd, "src", "index.ts"), "export {};");
    const context = await workspaceContext(cwd);
    assert.ok(context.prompt.includes("src/index.ts"));
    assert.ok(context.files.has("src/index.ts"));
    assert.ok(context.directories.has("src"));
  });

  it("finds the latest plan inside a monthly subfolder", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-plan-context-"));
    mkdirSync(path.join(cwd, ".agents", "plans", "202607"), { recursive: true });
    mkdirSync(path.join(cwd, ".agents", "plans", "202608"), { recursive: true });
    writeFileSync(path.join(cwd, ".agents", "plans", "202607", "a-old.md"), "# Old plan\nolder");
    writeFileSync(path.join(cwd, ".agents", "plans", "202608", "b-new.md"), "# New plan\nnewest");
    // Make mtime ordering deterministic: newer file gets a later mtime.
    const old = new Date("2026-07-01T00:00:00Z");
    const newer = new Date("2026-08-01T00:00:00Z");
    const { utimesSync } = await import("node:fs");
    utimesSync(path.join(cwd, ".agents", "plans", "202607", "a-old.md"), old, old);
    utimesSync(path.join(cwd, ".agents", "plans", "202608", "b-new.md"), newer, newer);
    const context = await workspaceContext(cwd);
    assert.ok(context.prompt.includes("# New plan"), `latest monthly plan found: ${context.prompt.slice(context.prompt.indexOf("PLAN"))}`);
    assert.ok(!context.prompt.includes("# Old plan"), "older monthly plan not selected");
  });

  it("skips an unreadable monthly subdir instead of aborting the scan", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-plan-context-"));
    mkdirSync(path.join(cwd, ".agents", "plans", "good"), { recursive: true });
    mkdirSync(path.join(cwd, ".agents", "plans", "bad"), { recursive: true });
    writeFileSync(path.join(cwd, ".agents", "plans", "good", "a.md"), "# Good plan\nreadable");
    if (process.platform !== "win32") chmodSync(path.join(cwd, ".agents", "plans", "bad"), 0o000);
    try {
      const context = await workspaceContext(cwd);
      assert.ok(context.prompt.includes("# Good plan"), "readable plan surfaced despite unreadable subdir");
    } finally {
      if (process.platform !== "win32") chmodSync(path.join(cwd, ".agents", "plans", "bad"), 0o755);
    }
  });

  it("breaks equal-mtime ties deterministically by name", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-plan-context-"));
    mkdirSync(path.join(cwd, ".agents", "plans", "202608"), { recursive: true });
    writeFileSync(path.join(cwd, ".agents", "plans", "202608", "a.md"), "# A plan\naaa");
    writeFileSync(path.join(cwd, ".agents", "plans", "202608", "b.md"), "# B plan\nbbb");
    const same = new Date("2026-08-01T00:00:00Z");
    const { utimesSync } = await import("node:fs");
    utimesSync(path.join(cwd, ".agents", "plans", "202608", "a.md"), same, same);
    utimesSync(path.join(cwd, ".agents", "plans", "202608", "b.md"), same, same);
    const context = await workspaceContext(cwd);
    assert.ok(context.prompt.includes("# B plan"), "equal-mtime tie breaks to lexically largest name");
  });

  it("hard-blocks all non-read tools while a restored specs gate is active", async () => {
    const { handlers } = createFakePi(["read", "edit"], {});
    const ctx = fakeCtx({ sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-plan", data: { enabled: true, specGateActive: true, specGatePlanMode: false, specPath: path.join(TMP, ".agents", "specs", "spec.md") } }] } });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const result = await handlers.tool_call?.[0]({ toolName: "edit", input: { path: "x" } }, ctx);
    assert.ok(result?.block);
    assert.match(result?.reason ?? "", /specs gate/);
  });
});

describe("plan-mode guidance", () => {
  it("tells agents to use Serena before raw code reads/searches", () => {
    assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("use Serena before raw reads/searches"));
    assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("serena_get_symbols_overview"));
    assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("serena_find_symbol"));
    assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("Use read for docs/config/non-code files"));
    assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("Prefer the dedicated ls/ffgrep/fffind tools (FFF: frecency-ranked, paginated) over shell commands"));
    assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("test, build, and package scripts require confirmation"));
  });
});


describe("btw", () => {
  it("registers the command and durable entry renderer", () => {
    const { commands, entryRenderers } = createFakePi(["read"]);
    assert.ok(commands.btw, "/btw registered");
    assert.ok(entryRenderers["pi-plan-btw"], "BTW entry renderer registered");
  });

  it("reports no recall on empty query with no history", async () => {
    const { commands } = createFakePi(["read"]);
    const notifications: string[] = [];
    const ctx = fakeCtx({
      mode: "print",
      hasUI: true,
      ui: { notify: (msg: string) => { notifications.push(msg); } },
      sessionManager: { getBranch: () => [], getSessionFile: () => "/test/session.jsonl" },
    });
    await commands.btw.handler("", ctx);
    assert.match(notifications[0], /No previous BTW/);
  });

  it("injects transcript context and persists a non-LLM answer", async () => {
    const { commands, entries, customMessages } = createFakePi(["read"]);
    let capturedContext: any;
    const response: any = {
      async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "You discussed file.ts." }; },
      result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "You discussed file.ts." }] }),
    };
    const widgetCalls: unknown[] = [];
    const message = {
      type: "message", id: "1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Let's work on file.ts" }], timestamp: 1 },
    };
    const ctx = fakeCtx({
      mode: "print",
      hasUI: false,
      modelRegistry: {
        getAvailable: () => [], find: () => ({ provider: "test", id: "m", contextWindow: 16_384 }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {}, env: {} }),
        getRegisteredProviderConfig: () => ({ streamSimple: (_model: any, context: any) => { capturedContext = context; return response; } }),
      },
      sessionManager: { getBranch: () => [message], getEntries: () => [message], getLeafId: () => "1", getSessionFile: () => "/test/session.jsonl" },
      isProjectTrusted: () => false,
      ui: { setWidget: (...args: unknown[]) => { widgetCalls.push(args); } },
    });

    await commands.btw.handler("What file were we discussing?", ctx);

    assert.ok(capturedContext.systemPrompt.includes("<transcript>"), "transcript injected into system prompt");
    assert.ok(capturedContext.systemPrompt.includes("file.ts"), "transcript contains session content");
    assert.equal(capturedContext.messages[0].content[0].text, "What file were we discussing?");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].customType, "pi-plan-btw");
    assert.equal(entries[0].data.query, "What file were we discussing?");
    assert.equal(entries[0].data.answer, "You discussed file.ts.");
    assert.equal(typeof entries[0].data.timestamp, "number");
    assert.equal(customMessages.length, 0, "BTW answer does not enter LLM context");
    assert.equal(widgetCalls.length, 0, "BTW no longer renders a transient widget");
  });

  it("does not persist a cancelled TUI request", async () => {
    const { commands, entries } = createFakePi(["read"]);
    const notifications: string[] = [];
    const ctx = fakeCtx({
      mode: "tui",
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => [], getEntries: () => [], getLeafId: () => "1", getSessionFile: () => "/test/session.jsonl" },
      ui: {
        custom: async () => ({ cancelled: true }),
        notify: (message: string) => { notifications.push(message); },
      },
    });

    await commands.btw.handler("What changed?", ctx);
    assert.deepEqual(entries, []);
    assert.deepEqual(notifications, ["BTW cancelled."]);
  });

  it("recalls the latest answer from the current branch", async () => {
    const { commands } = createFakePi(["read"]);
    let editorTitle = "";
    let editorContent = "";
    const ctx = fakeCtx({
      mode: "tui",
      sessionManager: {
        getBranch: () => [{ type: "custom", customType: "pi-plan-btw", data: { query: "What file?", answer: "file.ts", timestamp: 1 } }],
        getSessionFile: () => "/test/session.jsonl",
      },
      ui: { editor: async (title: string, content: string) => { editorTitle = title; editorContent = content; } },
    });

    await commands.btw.handler("", ctx);
    assert.ok(editorTitle.startsWith("BTW recall:"));
    assert.equal(editorContent, "file.ts");
  });
});

describe("goal", () => {
  function evaluatorResponse(text: string): any {
    return {
      async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: text }; },
      result: async () => ({ stopReason: "stop", content: [{ type: "text", text }] }),
    };
  }

  function setupGoal(models: any[] = [{ provider: "test", id: "model-1", contextWindow: 8192 }]) {
    let evaluatorText = '{"met": false, "reason": "still working"}';
    let config = { maxTurns: DEFAULT_GOAL_MAX_TURNS };
    let goal: GoalState | undefined;
    let goalModel: string | undefined;
    let planMode = false;
    let flowActive = false;
    let captured: any;
    const sent: { content: string; options?: any }[] = [];
    const messages: any[] = [];
    const notices: string[] = [];
    const modelSets: (string | undefined)[] = [];
    const commands: Record<string, any> = {};
    const pi: any = {
      registerCommand(name: string, def: any) { commands[name] = def; },
      getActiveTools: () => [], setActiveTools: () => {},
    };
    const accessors: GoalAccessors = {
      getModel: () => goalModel,
      setModel: async (m) => { goalModel = m; modelSets.push(m); },
      getGoal: () => goal,
      commit: (_ctx, next) => { goal = next ?? undefined; },
      isPlanMode: () => planMode,
      isFlowActive: () => flowActive,
      loadConfig: async () => config,
      sendUserMessage: (content, options) => { sent.push({ content, options }); },
      sendMessage: (m) => { messages.push(m); },
    };
    registerGoal(pi, accessors);
    const ctx: any = {
      mode: "print", hasUI: false, cwd: TMP,
      model: { provider: models[0].provider, id: models[0].id },
      modelRegistry: {
        getAvailable: () => models,
        find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, env: {} }),
        getRegisteredProviderConfig: () => ({ streamSimple: (_m: any, context: any) => { captured = context; return evaluatorResponse(evaluatorText); } }),
        refresh: async () => {}, getError: () => undefined,
      },
      sessionManager: {
        getEntries: () => [{ type: "message", id: "1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "do the work" }], timestamp: 1 } }],
        getLeafId: () => "1",
      },
      ui: { notify: (m: string) => { notices.push(m); }, setStatus: () => {}, custom: async () => undefined },
    };
    return {
      commands, accessors, ctx, sent, messages, notices, modelSets,
      getGoal: () => goal,
      setEvaluator: (t: string) => { evaluatorText = t; },
      setConfig: (maxTurns: number) => { config = { maxTurns }; },
      setPlanMode: (v: boolean) => { planMode = v; },
      setFlowActive: (v: boolean) => { flowActive = v; },
      captured: () => captured,
    };
  }

  it("registers /goal and /goal-model", () => {
    const { commands } = setupGoal();
    assert.ok(commands.goal, "/goal registered");
    assert.ok(commands["goal-model"], "/goal-model registered");
  });

  it("sets an active goal and starts the first turn", async () => {
    const { commands, ctx, sent, getGoal } = setupGoal();
    await commands.goal.handler("All tests pass", ctx);
    const g = getGoal()!;
    assert.equal(g.condition, "All tests pass");
    assert.equal(g.active, true);
    assert.equal(g.turns, 0);
    assert.equal(g.maxTurns, DEFAULT_GOAL_MAX_TURNS);
    assert.deepEqual(sent[0].options, { deliverAs: "followUp" });
    assert.match(sent[0].content, /All tests pass/);
  });

  it("refuses to set in plan mode or during an active flow", async () => {
    const r = setupGoal();
    r.setPlanMode(true);
    await r.commands.goal.handler("x", r.ctx);
    assert.equal(r.getGoal(), undefined);
    assert.equal(r.sent.length, 0);
    assert.match(r.notices[r.notices.length - 1], /Exit plan mode/);
    r.setPlanMode(false);
    r.setFlowActive(true);
    await r.commands.goal.handler("y", r.ctx);
    assert.equal(r.getGoal(), undefined);
    assert.equal(r.sent.length, 0);
    assert.match(r.notices[r.notices.length - 1], /workflow is active/);
  });

  it("evaluator 'met' clears the goal and records an achievement", async () => {
    const r = setupGoal();
    await r.commands.goal.handler("Ship it", r.ctx);
    r.setEvaluator('{"met": true, "reason": "build is green"}');
    await advanceGoal(r.ctx, r.accessors);
    assert.equal(r.getGoal(), undefined, "goal cleared on met");
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].customType, "pi-plan-goal");
    assert.match(r.messages[0].content, /Goal achieved/);
    assert.match(r.notices[r.notices.length - 1], /achieved/);
  });

  it("evaluator 'not met' continues with a followUp and counts the turn", async () => {
    const r = setupGoal();
    await r.commands.goal.handler("Migrate the module", r.ctx);
    r.setEvaluator('{"met": false, "reason": "2 call sites remain"}');
    await advanceGoal(r.ctx, r.accessors);
    const g = r.getGoal()!;
    assert.equal(g.active, true);
    assert.equal(g.turns, 1);
    assert.equal(g.lastReason, "2 call sites remain");
    assert.match(r.sent[r.sent.length - 1].content, /Goal not yet met: 2 call sites remain/);
  });

  it("stops at the maxTurns cap without sending another turn", async () => {
    const r = setupGoal();
    r.setConfig(1);
    await r.commands.goal.handler("Work", r.ctx);
    r.setEvaluator('{"met": false, "reason": "nope"}');
    await advanceGoal(r.ctx, r.accessors);
    const g = r.getGoal()!;
    assert.equal(g.active, false, "goal deactivated at cap");
    assert.equal(g.turns, 1);
    assert.equal(r.sent.length, 1, "only the initial turn was sent");
    assert.match(r.notices[r.notices.length - 1], /stopped after/);
  });

  it("parses the evaluator conservatively when JSON is malformed", async () => {
    const r = setupGoal();
    await r.commands.goal.handler("Make build green", r.ctx);
    r.setEvaluator("the work is basically done maybe");
    await advanceGoal(r.ctx, r.accessors);
    const g = r.getGoal()!;
    assert.equal(g.active, true, "unparseable is treated as not-met, never a false success");
    assert.equal(g.turns, 1);
  });

  it("does not overlap evaluations (re-entrancy guard)", async () => {
    const r = setupGoal();
    await r.commands.goal.handler("Work", r.ctx);
    let release!: () => void;
    const hang = new Promise<void>((done) => { release = done; });
    let evalCalls = 0;
    r.ctx.modelRegistry.getRegisteredProviderConfig = () => ({
      streamSimple: () => ({
        async *[Symbol.asyncIterator]() { evalCalls += 1; await hang; yield { type: "text_delta", delta: '{"met": false, "reason": "x"}' }; },
        result: async () => { await hang; return { stopReason: "stop", content: [{ type: "text", text: '{"met": false, "reason": "x"}' }] }; },
      }),
    });
    const first = advanceGoal(r.ctx, r.accessors);
    await Promise.resolve();
    const sentBefore = r.sent.length;
    await advanceGoal(r.ctx, r.accessors);
    assert.equal(evalCalls, 0, "overlapping call did not start a second evaluation (iterator not entered)");
    assert.equal(r.sent.length, sentBefore, "no followUp while the first evaluation is in flight");
    release();
    await first;
    assert.ok(r.sent.length > sentBefore, "first evaluation sent a followUp after release");
  });

  it("ignores a stale evaluation when the goal is replaced mid-eval (same condition)", async () => {
    const r = setupGoal();
    await r.commands.goal.handler("Same condition", r.ctx);
    const original = r.getGoal()!;
    let release!: () => void;
    const hang = new Promise<void>((done) => { release = done; });
    r.ctx.modelRegistry.getRegisteredProviderConfig = () => ({
      streamSimple: () => ({
        async *[Symbol.asyncIterator]() { await hang; yield { type: "text_delta", delta: '{"met": true, "reason": "done"}' }; },
        result: async () => { await hang; return { stopReason: "stop", content: [{ type: "text", text: '{"met": true, "reason": "done"}' }] }; },
      }),
    });
    const first = advanceGoal(r.ctx, r.accessors);
    await Promise.resolve();
    // Clear + re-set the SAME condition while the evaluation is in flight
    await r.commands.goal.handler("clear", r.ctx);
    await r.commands.goal.handler("Same condition", r.ctx);
    const replacement = r.getGoal()!;
    assert.notEqual(replacement, original, "re-set created a new goal object");
    assert.equal(replacement.turns, 0, "replacement starts fresh");
    release();
    await first;
    const after = r.getGoal()!;
    assert.equal(after, replacement, "stale met-true did not clear the replacement");
    assert.equal(after.turns, 0, "stale result did not increment the replacement's turns");
    assert.equal(after.active, true, "replacement remains active");
  });

  it("pauses the goal when the evaluator fails (no clear, no followUp)", async () => {
    const r = setupGoal();
    await r.commands.goal.handler("Work", r.ctx);
    const sentBefore = r.sent.length;
    // runIsolated throws when stopReason !== "stop" (isolated-model.ts) — exercise that path
    r.ctx.modelRegistry.getRegisteredProviderConfig = () => ({
      streamSimple: () => ({
        async *[Symbol.asyncIterator]() { /* evaluator error: no deltas */ },
        result: async () => ({ stopReason: "length", errorMessage: "context limit hit" }),
      }),
    });
    await advanceGoal(r.ctx, r.accessors);
    const g = r.getGoal()!;
    assert.equal(g.active, true, "goal stays active (paused, not cleared)");
    assert.equal(g.paused, true, "goal paused on evaluator failure");
    assert.equal(r.sent.length, sentBefore, "no followUp sent on failure");
    assert.match(r.notices[r.notices.length - 1], /paused/);
  });

  it("injects the condition and a transcript into the evaluator prompt", async () => {
    const r = setupGoal();
    await r.commands.goal.handler("Make build green", r.ctx);
    await advanceGoal(r.ctx, r.accessors);
    const prompt = r.captured().messages[0].content[0].text;
    assert.match(prompt, /Make build green/);
    assert.match(prompt, /<conversation>/);
    assert.match(r.captured().systemPrompt, /STRICT JSON/);
  });

  it("pause stops the loop and resume restarts it", async () => {
    const r = setupGoal();
    await r.commands.goal.handler("Work", r.ctx);
    await r.commands.goal.handler("pause", r.ctx);
    assert.equal(r.getGoal()!.paused, true);
    const before = r.sent.length;
    r.setEvaluator('{"met": false, "reason": "x"}');
    await advanceGoal(r.ctx, r.accessors);
    assert.equal(r.sent.length, before, "paused goal does not continue");
    await r.commands.goal.handler("resume", r.ctx);
    assert.equal(r.getGoal()!.paused, false);
    assert.match(r.sent[r.sent.length - 1].content, /Resuming goal/);
  });

  it("clears via every alias", async () => {
    const r = setupGoal();
    for (const alias of ["clear", "stop", "off", "reset", "none", "cancel"]) {
      await r.commands.goal.handler("Work " + alias, r.ctx);
      assert.ok(r.getGoal()?.active, `${alias}: goal set`);
      await r.commands.goal.handler(alias, r.ctx);
      assert.equal(r.getGoal(), undefined, `${alias}: goal cleared`);
    }
  });

  it("reports status with condition, turns, and cap", async () => {
    const r = setupGoal();
    await r.commands.goal.handler("", r.ctx);
    assert.match(r.notices[r.notices.length - 1], /No goal set/);
    await r.commands.goal.handler("Ship it", r.ctx);
    await r.commands.goal.handler("", r.ctx);
    assert.match(r.notices[r.notices.length - 1], /Ship it[\s\S]*Turn 0\/50/);
  });

  it("/goal-model selects by ref and bare id, clears with off, rejects headless ambiguity", async () => {
    const models = [
      { provider: "test", id: "goal-eval", contextWindow: 256 },
      { provider: "test", id: "unique", contextWindow: 256 },
      { provider: "openai", id: "shared", contextWindow: 256 },
      { provider: "other", id: "shared", contextWindow: 256 },
    ];
    const r = setupGoal(models);
    await r.commands["goal-model"].handler("test/goal-eval", r.ctx);
    assert.equal(r.modelSets[r.modelSets.length - 1], "test/goal-eval");
    await r.commands["goal-model"].handler("unique", r.ctx);
    assert.equal(r.modelSets[r.modelSets.length - 1], "test/unique", "bare id selects");
    await assert.rejects(() => r.commands["goal-model"].handler("shared", r.ctx), /Usage: \/goal-model/);
    assert.equal(r.modelSets[r.modelSets.length - 1], "test/unique", "ambiguity leaves the model unchanged");
    await r.commands["goal-model"].handler("off", r.ctx);
    assert.equal(r.modelSets[r.modelSets.length - 1], undefined);
  });
});

describe("goal integration", () => {
  it("agent_settled drives the goal loop after /goal is set", async () => {
    const { handlers, commands, sentMessages, customMessages } = createFakePi(["read"]);
    let evaluatorText = '{"met": false, "reason": "not done"}';
    const response: any = {
      async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: evaluatorText }; },
      result: async () => ({ stopReason: "stop", content: [{ type: "text", text: evaluatorText }] }),
    };
    const ctx = fakeCtx({
      hasUI: true,
      model: { provider: "test", id: "m" },
      isProjectTrusted: () => false,
      modelRegistry: {
        getAvailable: () => [{ provider: "test", id: "m", contextWindow: 8192 }],
        find: (p: string, id: string) => ({ provider: p, id, contextWindow: 8192 }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, env: {} }),
        getRegisteredProviderConfig: () => ({ streamSimple: () => response }),
      },
      sessionManager: {
        getBranch: () => [],
        getEntries: () => [{ type: "message", id: "1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 } }],
        getLeafId: () => "1",
        getSessionFile: () => "/t/s.jsonl",
      },
      ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_s: string, t: string) => t } },
    });

    await commands.goal.handler("Finish the migration", ctx);
    assert.equal(sentMessages.length, 1, "first turn sent on set");

    await handlers.agent_settled?.[0]({}, ctx);
    assert.equal(sentMessages.length, 2, "followUp sent when not met");

    evaluatorText = '{"met": true, "reason": "migration complete"}';
    await handlers.agent_settled?.[0]({}, ctx);
    assert.equal(sentMessages.length, 2, "no further turn once met");
    assert.ok(customMessages.some((m: any) => m.message.customType === "pi-plan-goal"), "achievement recorded as a transcript entry");
  });

  it("session_start resets an active goal's turn counter and timer (per-segment cap)", async () => {
    const oldStart = 1_000;
    const { handlers, entries } = createFakePi(["read"]);
    const ctx = fakeCtx({
      hasUI: true,
      isProjectTrusted: () => false,
      sessionManager: {
        getBranch: () => [{ type: "custom", customType: "pi-plan", data: { enabled: false, planThinking: "high", normalThinking: "medium", goal: { condition: "Finish it", active: true, paused: false, startedAt: oldStart, turns: 40, maxTurns: 50 } } }],
      },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, theme: { fg: (_s: string, t: string) => t } },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const planEntries = entries.filter((e: any) => e.customType === "pi-plan");
    const last = planEntries[planEntries.length - 1];
    assert.ok(last, "session_start persisted state for the active goal");
    assert.equal(last.data.goal.active, true);
    assert.equal(last.data.goal.turns, 0, "turn counter reset on session_start");
    assert.ok(last.data.goal.startedAt > oldStart, "timer refreshed on session_start");
  });
});

describe("plan-mode tool lists", () => {
  it("includes all known read/research tools", () => {
    for (const tool of ["read", "grep", "find", "ls", "ffgrep", "fffind", "web_search", "web_extract",
      "serena_check_onboarding_performed", "serena_find_symbol", "serena_get_symbols_overview",
      "munin_search", "munin_get", "munin_list",
      "evolve_reflect",
      "windows_shell_detect", "windows_audit_log", "windows_path_to_windows", "windows_path_to_wsl",
      "windows_path_to_gitbash", "windows_path_quote", "windows_safety_classify", "windows_doctor",
      "windows_tool_discover", "windows_wsl_list_distros",
    ]) {
      assert.ok(READ_ONLY_TOOLS.has(tool), `${tool} in known-read set`);
    }
  });

  it("hard-blocks known source mutators", () => {
    for (const tool of ["edit", "write",
      "serena_replace_symbol_body", "serena_insert_before_symbol",
      "serena_rename_symbol", "serena_replace_content",
      "munin_store", "munin_delete",
      "evolve_save",
    ]) {
      assert.ok(BLOCKED_TOOLS.has(tool), `${tool} should be blocked`);
    }
  });

  it("does not gate ask_user_question as plan-only (now available in any mode)", () => {
    // ask_user_question is mode-agnostic; write_plan is also always available.
    // No PLAN_ONLY_TOOLS set remains after generalizing ask_user_question.
    assert.ok(!READ_ONLY_TOOLS.has("edit"), "sanity: edit is not read-only");
  });
});

describe("plan mode prompt composition", () => {
  it("chains systemPrompt with plan instructions via before_agent_start", async () => {
    const { handlers } = createFakePi(["read", "ffgrep"], { plan: true });

    const ssHandler = handlers.session_start?.[0];
    assert.ok(ssHandler);
    await ssHandler({ reason: "startup" }, fakeCtx({ model: { provider: "test", id: "m" } }));

    const basHandler = handlers.before_agent_start?.[0];
    assert.ok(basHandler);

    const result = await basHandler(
      { systemPrompt: "[Base prompt]\n\n[Ponytail mode active]", systemPromptOptions: {} },
      fakeCtx({ model: { provider: "test", id: "m" } }),
    );

    assert.ok(result);
    assert.ok(result.systemPrompt.includes("[Base prompt]\n\n[Ponytail mode active]"), "base prompt preserved");
    assert.ok(result.systemPrompt.includes("## Plan Mode"), "plan mode header added");
    assert.ok(result.systemPrompt.includes("smallest complete"), "smallest complete change rule");
    assert.ok(result.systemPrompt.includes("read-only planning mode"), "read-only mode stated");
    assert.ok(result.systemPrompt.includes("Read-only bash commands (ls, grep, find, git status) run automatically"), "safe bash auto-run stated");
    assert.ok(result.systemPrompt.includes("every segment is read-only"), "segment-level pipelines stated");
    assert.ok(!result.systemPrompt.includes("Strict single read-only bash commands"));
  });

  it("names the active spec while the write gate is locked", async () => {
    const { handlers } = createFakePi(["read"], {});
    const specPath = path.join(TMP, ".agents", "specs", "spec.md");
    const ctx = fakeCtx({
      sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-plan", data: { enabled: true, specGateActive: true, specGatePlanMode: false, specPath } }] },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const result = await handlers.before_agent_start?.[0]({ systemPrompt: "[Base]", systemPromptOptions: {} }, ctx);
    assert.ok(result?.systemPrompt.includes("An active draft specification is at .agents/specs/spec.md"));
    assert.ok(result?.systemPrompt.includes("workspace writes remain locked until /specs-approve"));
  });

  it("does not inject plan prompt when not in plan mode", async () => {
    const { handlers } = createFakePi(["read"], {});
    const basHandler = handlers.before_agent_start?.[0];
    assert.ok(basHandler);

    const result = await basHandler(
      { systemPrompt: "[Base]", systemPromptOptions: {} },
      fakeCtx(),
    );
    assert.equal(result, undefined);
  });
});

describe("tool gating in plan mode", () => {
  it("auto-allows known read/research tools in baseline", async () => {
    const tools = ["read", "grep", "find", "ls", "ffgrep", "web_search", "serena_check_onboarding_performed", "serena_find_symbol"];
    const { handlers } = createFakePi(tools, { plan: true });
    const ctx = fakeCtx({ hasUI: true });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const tc = handlers.tool_call?.[0];
    assert.ok(tc);

    for (const tool of tools) {
      const r = await tc({ toolName: tool, input: {} }, ctx);
      assert.equal(r, undefined, `${tool} auto-allowed`);
    }
  });

  it("requires confirmation for baseline custom tools not in known-read set", async () => {
    const { handlers } = createFakePi(["obsidian", "custom_research_tool", "read"], { plan: true });
    let confirmed: string[] = [];
    const ctx = fakeCtx({
      hasUI: true,
      ui: {
        confirm: async () => true,
        select: async (title: string) => { confirmed.push(title); return "Allow once"; }, editor: async () => "",
        setStatus: () => {}, setWidget: () => {}, notify: () => {},
        theme: { fg: (_s: string, t: string) => t },
      },
    });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const tc = handlers.tool_call?.[0];
    assert.ok(tc);

    // obsidian is baseline but not in READ_ONLY_TOOLS → needs confirm
    const r1 = await tc({ toolName: "obsidian", input: { run: "read" } }, ctx);
    assert.equal(r1, undefined, "obsidian allowed after confirm");
    assert.ok(confirmed.some(c => c.includes("obsidian")), "obsidian confirmed");

    // read is both baseline and in READ_ONLY_TOOLS → auto-allowed
    const r2 = await tc({ toolName: "read", input: { path: "f.ts" } }, ctx);
    assert.equal(r2, undefined, "read auto-allowed");
    assert.equal(confirmed.length, 1, "only obsidian triggered confirm");
  });

  it("'Allow for this session' suppresses subsequent prompts for the same tool", async () => {
    const choices: (string | undefined)[] = ["Allow for this session", "Deny"];
    const prompts: string[] = [];
    const { handlers } = createFakePi(["read", "obsidian", "bash"], { plan: true });
    const ctx = fakeCtx({
      hasUI: true,
      ui: {
        confirm: async () => false,
        select: async (title: string) => { prompts.push(title); return choices.shift() ?? "Deny"; }, editor: async () => "",
        setStatus: () => {}, setWidget: () => {}, notify: () => {},
        theme: { fg: (_s: string, t: string) => t },
      },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const tc = handlers.tool_call?.[0];
    assert.ok(tc);

    // First obsidian call: user picks "Allow for this session" → allowed.
    assert.equal(await tc({ toolName: "obsidian", input: {} }, ctx), undefined);
    // Second obsidian call: no prompt (next choice "Deny" would block if prompted).
    assert.equal(await tc({ toolName: "obsidian", input: {} }, ctx), undefined, "session allow suppresses re-prompt");
    assert.equal(prompts.length, 1, "only one prompt for obsidian");

    // Bash session-allow is keyed by first token: same executable re-allowed, different still prompts.
    const bashChoices: (string | undefined)[] = ["Allow for this session", "Deny"];
    ctx.ui.select = async (title: string) => { prompts.push(title); return bashChoices.shift() ?? "Deny"; };
    assert.equal(await tc({ toolName: "bash", input: { command: "npm test" } }, ctx), undefined);
    assert.equal(await tc({ toolName: "bash", input: { command: "npm test -- --grep foo" } }, ctx), undefined, "same executable session-allowed");
    const blocked = await tc({ toolName: "bash", input: { command: "node script.js" } }, ctx);
    assert.ok(blocked?.block, "different executable still prompts");
    assert.equal(prompts.length, 3);
  });

  it("session allows do not survive session_start and interpreters are keyed by full command (review fixes)", async () => {
    const prompts: string[] = [];
    const { handlers } = createFakePi(["read", "bash", "subagent"], { plan: true });
    const ctx = fakeCtx({
      hasUI: true,
      ui: {
        confirm: async () => false,
        select: async (title: string) => { prompts.push(title); return "Allow for this session"; }, editor: async () => "",
        setStatus: () => {}, setWidget: () => {}, notify: () => {},
        theme: { fg: (_s: string, t: string) => t },
      },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const tc = handlers.tool_call?.[0];
    assert.ok(tc);

    // Approve `node script.js` for the session.
    assert.equal(await tc({ toolName: "bash", input: { command: "node script.js" } }, ctx), undefined);
    // Same exact command: remembered (no new prompt).
    const promptsBefore = prompts.length;
    assert.equal(await tc({ toolName: "bash", input: { command: "node script.js" } }, ctx), undefined);
    assert.equal(prompts.length, promptsBefore, "exact interpreter command session-allowed");
    // A DIFFERENT node payload must still prompt (interpreter → full-command key).
    const blocked = await tc({ toolName: "bash", input: { command: "node -e 'rm x'" } }, ctx);
    assert.equal(blocked, undefined, "different node payload prompted then allowed");
    assert.equal(prompts.length, promptsBefore + 1, "different node payload re-prompted");

    // Session replacement clears the allows (startup re-arms plan mode from
    // the --plan flag, so only the allows are what changes).
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await tc({ toolName: "bash", input: { command: "node script.js" } }, ctx);
    assert.equal(prompts.length, promptsBefore + 2, "session_start cleared planSessionAllows");
  });

  it("subagent session allows are keyed per requested agent set (review fix)", async () => {
    const prompts: string[] = [];
    const { handlers } = createFakePi(["read", "subagent"], { plan: true });
    const ctx = fakeCtx({
      hasUI: true,
      ui: {
        confirm: async () => false,
        select: async (title: string) => { prompts.push(title); return "Allow for this session"; }, editor: async () => "",
        setStatus: () => {}, setWidget: () => {}, notify: () => {},
        theme: { fg: (_s: string, t: string) => t },
      },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const tc = handlers.tool_call?.[0];
    assert.ok(tc);

    // Approve worker once.
    assert.equal(await tc({ toolName: "subagent", input: { agent: "worker", task: "x" } }, ctx), undefined);
    const promptsBefore = prompts.length;
    // Same agent set: remembered.
    assert.equal(await tc({ toolName: "subagent", input: { agent: "worker", task: "y" } }, ctx), undefined);
    assert.equal(prompts.length, promptsBefore, "same agent set session-allowed");
    // A DIFFERENT mutating agent must still prompt.
    await tc({ toolName: "subagent", input: { agent: "general-purpose", task: "z" } }, ctx);
    assert.equal(prompts.length, promptsBefore + 1, "different mutating agent re-prompted");
  });

  it("blocks direct source mutators", async () => {
    const { handlers } = createFakePi(["read", "edit", "write"], { plan: true });
    const ctx = fakeCtx({ hasUI: true });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const tc = handlers.tool_call?.[0];
    assert.ok(tc);

    const r1 = await tc({ toolName: "edit", input: { path: "f.ts" } }, ctx);
    assert.ok(r1?.block, "edit blocked");
    assert.ok(r1?.reason?.includes("write_plan"));

    const r2 = await tc({ toolName: "write", input: { path: "f.ts" } }, ctx);
    assert.ok(r2?.block, "write blocked");
  });

  it("requires confirmation for unknown executables and honors approval or rejection", async () => {
    const decisions = [true, false];
    const confirmations: string[] = [];
    const { handlers } = createFakePi(["read", "bash"], { plan: true });
    const ctx = fakeCtx({
      hasUI: true,
      ui: {
        confirm: async () => true,
        select: async (title: string) => { confirmations.push(title); return decisions.shift()! ? "Allow once" : "Deny"; }, editor: async () => "",
        setStatus: () => {}, setWidget: () => {}, notify: () => {},
        theme: { fg: (_s: string, t: string) => t },
      },
    });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const tc = handlers.tool_call?.[0];
    assert.ok(tc);
    assert.equal(await tc({ toolName: "bash", input: { command: "npm test" } }, ctx), undefined, "approved command allowed");
    const rejected = await tc({ toolName: "bash", input: { command: "npm test" } }, ctx);
    assert.ok(rejected?.block, "declined command blocked");
    assert.equal(confirmations.length, 2);
    assert.ok(confirmations.every((body) => body.includes("may execute repository-controlled code or modify files")));
  });

  it("denies confirmation-required commands when UI is not available", async () => {
    const { handlers } = createFakePi(["read", "bash"], { plan: true });
    const ctx = fakeCtx({ hasUI: false });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const tc = handlers.tool_call?.[0];
    assert.ok(tc);
    const r = await tc({ toolName: "bash", input: { command: "npm test" } }, ctx);
    assert.ok(r?.block);
    assert.ok(r?.reason?.includes("requires confirmation"));
  });

  const WRITE_CASES = [
    ["heredoc", "cat > file << 'EOF'\ndata\nEOF"],
    ["redirect", "echo hello > output.txt"],
    ["redirect without spaces", "echo hello>output.txt"],
    ["sed -i", "sed -i 's/foo/bar/g' file.txt"],
    ["sed backup", "sed -i.bak 's/foo/bar/g' file.txt"],
    ["sed long option", "sed --in-place 's/foo/bar/g' file.txt"],
    ["sed write", "sed -n '1w output.txt' input.txt"],
    ["sed glued w write", "sed -n '1wout' input.txt"],
    ["tee", "echo data | tee output.txt"],
    ["find delete", "find . -delete"],
    ["find exec", "find . -exec touch marker +"],
    ["find output", "find . -fprint output.txt"],
    ["sort output", "sort -o output.txt input.txt"],
    ["git mutation", "git reset --hard"],
    ["git output", "git show --output=patch HEAD"],
    ["git clone", "git clone https://example.com/repo.git"],
    ["git fetch", "git fetch origin"],
    ["git pull", "git pull origin main"],
    ["git config add", "git config --add core.foo bar"],
    ["git config set", "git config user.email a@b.com"],
    ["git remote add", "git remote add origin https://example.com/repo.git"],
    ["git tag create", "git tag v1.0.0"],
    ["git reflog expire", "git reflog expire --expire=now --all"],
    ["git checkout", "git checkout -b new-branch"],
    ["git stash push", "git stash push"],
    ["known writer", "cp source target"],
    ["absolute writer", "/bin/rm output.txt"],
    ["wrapped writer", "sudo rm output.txt"],
    ["writer in pipeline", "cat file.txt | tee out.txt"],
    ["writer in chain", "ls -la; cp a b"],
    ["mixed chain with redirect", "grep foo src | head > out.txt"],
    ["fd-dup with extra redirect", "grep foo src 2>&1 > out.txt"],
    ["stderr to file", "grep foo src 2> err.log"],
    ["stdin redirect", "grep foo < input.txt"],
    ["command wrapper runs a writer", "command rm -rf src/"],
    ["command -p wrapper", "command -p bash -c 'touch x'"],
    ["redirect to /dev/null-prefixed file", "grep -n x src/*.ts >/dev/null2 && echo done"],
    ["append stderr to file", "sort data 2>>err.log"],
    ["quoted string with redirect-ish text plus real redirect", "echo 'use 2>&1 here' > real.txt"],
    ["git -C quoted path push", "git -C \"my repo\" push origin main"],
    ["command substitution", "echo $(touch marker)"],
    ["command substitution in pipeline", "grep foo src | echo $(touch marker)"],
    ["awk print redirect", "awk '{print $1 > \"out.txt\"}' file"],
    ["sort combined -no", "sort -no output.txt input.txt"],
    ["sort combined -on", "sort -on output.txt input.txt"],
    // 0.12.0: a raw newline is a separator, not a write — each line still classifies
    ["newline-separated writer", "echo hi\nrm -rf x"],
    ["assignment-prefixed writer", "VAR=x rm -rf x"],
    ["xargs writer payload", "grep -rl foo . | xargs rm -rf"],
    ["writer after flow keyword", "while read -r f; do rm -rf $f; done"],
  ];

  for (const [label, cmd] of WRITE_CASES) {
    it(`blocks write commands in plan mode (${label})`, async () => {
      const { handlers } = createFakePi(["read", "bash"], { plan: true });
      const ctx = fakeCtx({ hasUI: true });
      await handlers.session_start?.[0]({ reason: "startup" }, ctx);
      const tc = handlers.tool_call?.[0];
      assert.ok(tc);
      const r = await tc({ toolName: "bash", input: { command: cmd } }, ctx);
      assert.ok(r?.block, `${label} write must be blocked`);
      assert.ok(r?.reason?.includes("writing to the filesystem"));
    });
  }

  it("auto-allows strict read-only bash commands without prompting", async () => {
    let confirmations = 0;
    const { handlers } = createFakePi(["read", "bash"], { plan: true });
    const ctx = fakeCtx({
      hasUI: true,
      ui: {
        confirm: async () => { confirmations++; return false; },
        select: async () => null, editor: async () => "",
        setStatus: () => {}, setWidget: () => {}, notify: () => {},
        theme: { fg: (_s: string, t: string) => t },
      },
    });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const tc = handlers.tool_call?.[0];
    assert.ok(tc);

    for (const cmd of ["ls -la", "grep -R foo src/", "find . -name '*.ts'", "git status --short", "cat index.ts", "/bin/ls -la", "/usr/bin/grep foo src/", "sort -n input.txt", "git blame file.ts", "git log --oneline -5", "git ls-tree HEAD", "git cat-file -p HEAD:file.ts", "git remote -v", "git remote show origin", "git config --get user.email", "git config --list", "git describe --tags", "git tag -l", "git tag --list", "git for-each-ref", "git rev-list --count HEAD", "git shortlog -sne", "git branch -v", "git branch -vv", "git reflog", "git reflog show", "git ls-files", "git ls-remote", "git name-rev HEAD", "git show-ref", "git symbolic-ref HEAD",
      // regression: falsely blocked in live sessions (2026-08 analysis)
      "git -C /Volumes/Dev/agents/pi-extensions status --short", "git -C repo log --oneline -8", "git -C repo remote get-url origin", "git -c color.ui=always diff", "find . -name '*.ts' 2>/dev/null | head -20", "grep -rn foo src/ 2>&1 | head -10", "ls /tmp 2>/dev/null", "command -v pi", "command -V pi", "which pi", "type node",
      // regression: chained git + fd-dup across separators (segment split must use the stripped string)
      "git ls-remote origin 2>&1 | head -20; git remote -v", "git remote -v && git ls-remote origin 2>&1 | head -20", "ls .agents/plans/ 2>/dev/null; git log --oneline -3; grep -n 'X' src/a.rs | head -4",
      // regression: 0.12.0 session analysis — top confirm sources now read-classified
      "sed -n 140,200p src/index.ts", "sed -n 's/foo/bar/gp' file.txt", "cd /tmp && grep -n x file.txt",
      "sed -n '/twelve/p' notes.txt",
      "D=/tmp; ls $D", "S=/tmp/x.json; jq -r '.type' $S", "jq -r '.type' file.json",
      "grep -rl foo . | xargs grep -l bar", "find . -name '*.ts' -print0 | xargs -0 grep -l foo",
      "tar -tzf archive.tgz", "tar -xzOf archive.tgz package/dist/index.js | diff - dist/index.js",
      "ls -la\ngrep -n foo file.txt",
      "jq -r 'if .type==\"x\"\n  then .a\n  else empty\n  end' file.json",
      // regression: reviewer findings (0.11.3) — anchored null target, append-to-null, quoted -C, --no-pager, fd dups
      "grep foo src 2>>/dev/null", "git -C \"my repo\" status", "git --no-pager diff", "echo err 1>&2", "grep x f >&2", "cat f 2>&-"]) {
      assert.equal(await tc({ toolName: "bash", input: { command: cmd } }, ctx), undefined, `${cmd} auto-allowed`);
    }
    assert.equal(confirmations, 0);
  });

  it("requires confirmation for awk (Turing-complete interpreter)", async () => {
    let confirmations = 0;
    const { handlers } = createFakePi(["read", "bash"], { plan: true });
    const ctx = fakeCtx({
      hasUI: true,
      ui: {
        confirm: async () => { confirmations++; return true; },
        select: async () => { confirmations++; return "Allow once"; }, editor: async () => "",
        setStatus: () => {}, setWidget: () => {}, notify: () => {},
        theme: { fg: (_s: string, t: string) => t },
      },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const tc = handlers.tool_call?.[0];
    assert.ok(tc);
    // awk must NOT auto-run — it needs confirmation even for column extraction.
    for (const cmd of ["awk '{print $1}' file.txt", "awk 'BEGIN{system(\"touch marker\")}'", "/usr/bin/awk '{print $1}' file.txt"]) {
      assert.equal(await tc({ toolName: "bash", input: { command: cmd } }, ctx), undefined, `${cmd} confirmed then allowed`);
    }
    assert.equal(confirmations, 3, "every awk command required confirmation");
  });

  it("requires confirmation for ambiguous sed forms, xargs interpreters, and one-off scripts", async () => {
    let confirmations = 0;
    const { handlers } = createFakePi(["read", "bash"], { plan: true });
    const ctx = fakeCtx({
      hasUI: true,
      ui: {
        confirm: async () => { confirmations++; return true; },
        select: async () => { confirmations++; return "Allow once"; }, editor: async () => "",
        setStatus: () => {}, setWidget: () => {}, notify: () => {},
        theme: { fg: (_s: string, t: string) => t },
      },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const tc = handlers.tool_call?.[0];
    assert.ok(tc);
    // These must neither hard-block (write tier) nor auto-run — they confirm first.
    // Includes the session-analysis pipeline shape that transiently hard-blocked
    // before 0.12.0 (multi-line command with quoted jq + awk program).
    for (const cmd of [
      "sed -f gen.sed input.txt",
      "sed 's/x/y/e' input.txt",
      "sed 's/x/y/ge' input.txt",
      "sed 's/x/y/gw out.txt' input.txt",
      "sed 's|x|y|pew' input.txt",
      "sed 's/x/y/e;p' input.txt",
      "sed 's/a/b/ew out.txt' input.txt",
      "sed 'e;p' input.txt",
      "tar -xzOf a.tgz --to-command=sh",
      "tar -tf a.tar -I sh",
      "tar -tzf a.tgz --use-compress-program=sh",
      "xargs sh -c 'echo hi'",
      "find . -name '*.log' | xargs sh -c 'cat'",
      "python3 -c \"print(1)\"",
      "node -e \"console.log(1)\"",
      "for f in *; do echo $f; done",
      "curl https://example.com",
      "tar -xzf archive.tgz",
      "cd /tmp && find . -name '*.jsonl' -print0 | xargs -0 grep -l pattern | while IFS= read -r f; do jq -r '.id' \"$f\" | awk '/^id/{print}'; done | sort | uniq -c",
    ]) {
      assert.equal(await tc({ toolName: "bash", input: { command: cmd } }, ctx), undefined, `${cmd} confirmed then allowed`);
    }
    assert.equal(confirmations, 19, "every ambiguous command required confirmation");
  });

  it("auto-allows read-only pipelines and chains (segment-level classification)", async () => {
    let confirmations = 0;
    const { handlers } = createFakePi(["read", "bash"], { plan: true });
    const ctx = fakeCtx({
      hasUI: true,
      ui: {
        confirm: async () => { confirmations++; return false; },
        select: async () => null, editor: async () => "",
        setStatus: () => {}, setWidget: () => {}, notify: () => {},
        theme: { fg: (_s: string, t: string) => t },
      },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const tc = handlers.tool_call?.[0];
    assert.ok(tc);

    for (const cmd of [
      "cat file.txt | grep foo",
      "grep -rn 'sqi_manager_task' system_tasks.c | head",
      "ls -la; pwd",
      "grep foo src | head -n 5; echo done",
      "git status --short | grep modified",
      "find . -name '*.ts' | wc -l",
      // Quoted alternation (\| inside quotes) must NOT split into segments
      "grep -rn \"sqi_manager_task\\|SYS_Tasks\\|TASK_SQI\" system_tasks.c | head; echo ===",
      "grep -rn 'a\\|b' src/file.ts | head",
      "echo \"x;y\" | grep foo",
    ]) {
      assert.equal(await tc({ toolName: "bash", input: { command: cmd } }, ctx), undefined, `${cmd} auto-allowed`);
    }
    assert.equal(confirmations, 0);
  });

  it("requires confirmation for mixed read/unknown chains", async () => {
    const confirmations: string[] = [];
    const decisions = [true, true];
    const { handlers } = createFakePi(["read", "bash"], { plan: true });
    const ctx = fakeCtx({
      hasUI: true,
      ui: {
        confirm: async () => true,
        select: async (title: string) => { confirmations.push(title); return decisions.shift()! ? "Allow once" : "Deny"; }, editor: async () => "",
        setStatus: () => {}, setWidget: () => {}, notify: () => {},
        theme: { fg: (_s: string, t: string) => t },
      },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const tc = handlers.tool_call?.[0];
    assert.ok(tc);

    for (const cmd of ["grep foo src | npm test", "ls -la; node script.js"]) {
      assert.equal(await tc({ toolName: "bash", input: { command: cmd } }, ctx), undefined, `${cmd} confirmed then allowed`);
    }
    assert.equal(confirmations.length, 2, "mixed chains require confirmation");
  });

  it("denies non-read baseline tools without UI", async () => {
    const { handlers } = createFakePi(["obsidian", "read"], { plan: true });
    const ctx = fakeCtx({ hasUI: false });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const tc = handlers.tool_call?.[0];
    assert.ok(tc);
    const r = await tc({ toolName: "obsidian", input: {} }, ctx);
    assert.ok(r?.block);
    assert.ok(r?.reason?.includes("confirmation"));
  });

  describe("subagent delegation gating", () => {
    it("auto-allows read-only bundled agents (scout/planner/reviewer) without confirmation", async () => {
      let confirmations = 0;
      const { handlers } = createFakePi(["read", "subagent"], { plan: true });
      const ctx = fakeCtx({
        hasUI: true,
        ui: {
          confirm: async () => { confirmations++; return false; },
          select: async () => null, editor: async () => "",
          setStatus: () => {}, setWidget: () => {}, notify: () => {},
          theme: { fg: (_s: string, t: string) => t },
        },
      });
      await handlers.session_start?.[0]({ reason: "startup" }, ctx);
      const tc = handlers.tool_call?.[0];
      assert.ok(tc);
      for (const agent of ["scout", "planner", "reviewer"]) {
        const r = await tc({ toolName: "subagent", input: { agent, task: "recon" } }, ctx);
        assert.equal(r, undefined, `subagent:${agent} auto-allowed (no block, no confirm)`);
      }
      assert.equal(confirmations, 0, "no confirmations for read-only agents");
    });

    it("requires confirmation for mutating agents (worker/general-purpose)", async () => {
      const confirmations: string[] = [];
      const { handlers } = createFakePi(["read", "subagent"], { plan: true });
      const ctx = fakeCtx({
        hasUI: true,
        ui: {
          confirm: async () => true,
          select: async (title: string) => { confirmations.push(title); return "Allow once"; }, editor: async () => "",
          setStatus: () => {}, setWidget: () => {}, notify: () => {},
          theme: { fg: (_s: string, t: string) => t },
        },
      });
      await handlers.session_start?.[0]({ reason: "startup" }, ctx);
      const tc = handlers.tool_call?.[0];
      assert.ok(tc);
      for (const agent of ["worker", "general-purpose"]) {
        const r = await tc({ toolName: "subagent", input: { agent, task: "implement" } }, ctx);
        assert.equal(r, undefined, `subagent:${agent} allowed after confirm`);
      }
      assert.equal(confirmations.length, 2, "each mutating agent required confirmation");
      assert.ok(confirmations.every((c) => c.includes("subagent")), "confirm prompts mention subagent");
    });

    it("auto-allows parallel tasks when all agents are read-only", async () => {
      let confirmations = 0;
      const { handlers } = createFakePi(["read", "subagent"], { plan: true });
      const ctx = fakeCtx({
        hasUI: true,
        ui: {
          confirm: async () => { confirmations++; return false; },
          select: async () => null, editor: async () => "",
          setStatus: () => {}, setWidget: () => {}, notify: () => {},
          theme: { fg: (_s: string, t: string) => t },
        },
      });
      await handlers.session_start?.[0]({ reason: "startup" }, ctx);
      const tc = handlers.tool_call?.[0];
      assert.ok(tc);
      const r = await tc({ toolName: "subagent", input: { tasks: [{ agent: "scout", task: "a" }, { agent: "planner", task: "b" }] } }, ctx);
      assert.equal(r, undefined, "parallel all-read-only auto-allowed");
      assert.equal(confirmations, 0, "no confirmations");
    });

    it("requires confirmation for parallel tasks when any agent can mutate", async () => {
      let confirmations = 0;
      const { handlers } = createFakePi(["read", "subagent"], { plan: true });
      const ctx = fakeCtx({
        hasUI: true,
        ui: {
          confirm: async () => { confirmations++; return true; },
          select: async () => { confirmations++; return "Allow once"; }, editor: async () => "",
          setStatus: () => {}, setWidget: () => {}, notify: () => {},
          theme: { fg: (_s: string, t: string) => t },
        },
      });
      await handlers.session_start?.[0]({ reason: "startup" }, ctx);
      const tc = handlers.tool_call?.[0];
      assert.ok(tc);
      const r = await tc({ toolName: "subagent", input: { tasks: [{ agent: "scout", task: "a" }, { agent: "worker", task: "b" }] } }, ctx);
      assert.equal(r, undefined, "mixed parallel allowed after confirm");
      assert.equal(confirmations, 1, "one confirmation for the whole call");
    });

    it("requires confirmation for unknown agent names", async () => {
      let confirmations = 0;
      const { handlers } = createFakePi(["read", "subagent"], { plan: true });
      const ctx = fakeCtx({
        hasUI: true,
        ui: {
          confirm: async () => { confirmations++; return true; },
          select: async () => { confirmations++; return "Allow once"; }, editor: async () => "",
          setStatus: () => {}, setWidget: () => {}, notify: () => {},
          theme: { fg: (_s: string, t: string) => t },
        },
      });
      await handlers.session_start?.[0]({ reason: "startup" }, ctx);
      const tc = handlers.tool_call?.[0];
      assert.ok(tc);
      const r = await tc({ toolName: "subagent", input: { agent: "nonexistent-agent", task: "x" } }, ctx);
      assert.equal(r, undefined, "unknown agent allowed after confirm");
      assert.equal(confirmations, 1, "unknown agent required confirmation");
    });
  });

  it("allows plan-only tools without gating", async () => {
    const { handlers } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: true });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const tc = handlers.tool_call?.[0];
    assert.ok(tc);
    const r = await tc({ toolName: "write_plan", input: { title: "T", content: "# T" } }, ctx);
    assert.equal(r, undefined, "write_plan auto-allowed");
  });

  it("auto-allows ask_user_question (and deprecated alias) in plan mode without confirmation", async () => {
    // Regression guard: ask_user_question is NOT in READ_ONLY_TOOLS; before the fix it
    // fell through to the confirm branch and prompted the user on every clarifying question.
    const { handlers } = createFakePi(["read"], { plan: true });
    const confirmCalls: any[] = [];
    const ctx = fakeCtx({
      hasUI: true,
      ui: { ...fakeCtx().ui, confirm: async (_t: string, _b: string) => { confirmCalls.push(_t); return true; } },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const tc = handlers.tool_call?.[0];
    assert.ok(tc);
    const r1 = await tc({ toolName: "ask_user_question", input: { question: "Q?", options: [{ label: "A" }, { label: "B" }] } }, ctx);
    assert.equal(r1, undefined, "ask_user_question auto-allowed");
    const r2 = await tc({ toolName: "ask_plan_question", input: { question: "Q?", options: [{ label: "A" }, { label: "B" }] } }, ctx);
    assert.equal(r2, undefined, "ask_plan_question alias auto-allowed");
    assert.deepEqual(confirmCalls, [], "neither tool should prompt for confirmation");
  });

  it("auto-allows ask_user_question and alias under the /specs gate", async () => {
    // ponytail: specGate hard-blocks everything except known-read + the question tools.
    const specPath = path.join(TMP, ".agents", "specs", "spec.md");
    const { handlers } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({
      hasUI: true,
      sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-plan", data: { enabled: true, specGateActive: true, specGatePlanMode: false, specPath } }] },
    });
    await handlers.session_tree?.[0]({}, ctx);

    const tc = handlers.tool_call?.[0];
    assert.ok(tc);
    const r1 = await tc({ toolName: "ask_user_question", input: { question: "Q?", options: [{ label: "A" }, { label: "B" }] } }, ctx);
    assert.equal(r1, undefined, "ask_user_question allowed under spec gate");
    const r2 = await tc({ toolName: "ask_plan_question", input: { question: "Q?", options: [{ label: "A" }, { label: "B" }] } }, ctx);
    assert.equal(r2, undefined, "ask_plan_question alias allowed under spec gate");
  });
});

describe("plan path containment", () => {
  it("generates paths under .agents/plans/", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: true, cwd: TMP });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const wd = toolDefs.write_plan;
    assert.ok(wd);
    const result = await wd.execute("c1", { title: "My Plan", content: "# Plan\nDo work." }, undefined, undefined, ctx);
    assert.ok(result);
    assert.ok(result.details?.path?.includes(".agents/plans/"), `path under .agents/plans/: ${result.details?.path}`);
  });

  it("rejects path-traversal title", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: true, cwd: TMP });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const wd = toolDefs.write_plan;
    assert.ok(wd);
    const result = await wd.execute("c1", { title: "../../../etc/passwd", content: "# Plan\nMalicious." }, undefined, undefined, ctx);
    assert.ok(result);
    // ponytail: slugify strips non-alphanumeric chars, so the path must still be under .agents/plans/
    assert.ok(result.details?.path?.includes(".agents/plans/"), `path under .agents/plans/: ${result.details?.path}`);
    // ponytail: the slugified name "etc-passwd" is fine; what matters is no directory traversal
    assert.ok(!result.details?.path?.includes(".."), "path must not contain directory traversal sequences");
  });

  it("containment accepts any {yyyymm} position and both separator styles", () => {
    const cwd = "/repo";
    // Suffix placeholder
    assert.ok(isInsidePlansDir("/repo/.agents/plans/202607/a.md", ".agents/plans/{yyyymm}", cwd));
    // Non-suffix placeholder
    assert.ok(isInsidePlansDir("/repo/.agents/202607/plans/a.md", ".agents/{yyyymm}/plans", cwd));
    // Backslash separators in the config
    assert.ok(isInsidePlansDir("/repo/.agents/plans/202607/a.md", ".agents\\plans\\{yyyymm}", cwd));
    // Inside without placeholder
    assert.ok(isInsidePlansDir("/repo/.agents/plans/a.md", ".agents/plans", cwd));
    // Escapes rejected
    assert.ok(!isInsidePlansDir("/repo/.agents/plans/../escape.md", ".agents/plans/{yyyymm}", cwd));
    assert.ok(!isInsidePlansDir("/repo/escape.md", ".agents/plans/{yyyymm}", cwd));
    // Sibling dir rejected
    assert.ok(!isInsidePlansDir("/repo/.agents/other/a.md", ".agents/plans", cwd));
    // Exactly the dir itself (not a file inside) rejected
    assert.ok(!isInsidePlansDir("/repo/.agents/plans", ".agents/plans", cwd));
  });


});

describe("plansDir configuration", () => {
  const settingsPath = () => path.join(TMP, ".pi", "agent", "settings.json");
  const writeSettings = (settings: Record<string, unknown>) => {
    mkdirSync(path.dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(settings));
  };
  const clearSettings = () => {
    try { writeFileSync(settingsPath(), "{}"); } catch { /* absent */ }
  };

  afterEach(clearSettings);

  it("loads plansDir from global settings", async () => {
    writeSettings({ "pi-plan": { plansDir: "docs/plans" } });
    const ctx = fakeCtx({ isProjectTrusted: () => false });
    const cfg = await loadUtilityConfig(ctx);
    assert.equal(cfg.plansDir, "docs/plans");
  });

  it("project settings override global settings", async () => {
    writeSettings({ "pi-plan": { plansDir: "global/plans" } });
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-plan-proj-"));
    const projSettings = path.join(cwd, ".pi", "settings.json");
    mkdirSync(path.dirname(projSettings), { recursive: true });
    writeFileSync(projSettings, JSON.stringify({ "pi-plan": { plansDir: "proj/plans" } }));
    const ctx = fakeCtx({ cwd, isProjectTrusted: () => true });
    const cfg = await loadUtilityConfig(ctx);
    assert.equal(cfg.plansDir, "proj/plans");
  });

  it("returns undefined when plansDir is missing or empty", async () => {
    writeSettings({ "pi-plan": { btw: { model: "x/y" } } });
    const ctx = fakeCtx({ isProjectTrusted: () => false });
    const cfg = await loadUtilityConfig(ctx);
    assert.equal(cfg.plansDir, undefined);
    writeSettings({ "pi-plan": { plansDir: "   " } });
    assert.equal((await loadUtilityConfig(fakeCtx({ isProjectTrusted: () => false }))).plansDir, undefined);
  });

  it("write_plan uses the configured flat dir", async () => {
    writeSettings({ "pi-plan": { plansDir: "docs/plans" } });
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: true, cwd: TMP, isProjectTrusted: () => false });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const wd = toolDefs.write_plan;
    assert.ok(wd);
    const result = await wd.execute("c1", { title: "Custom Dir", content: "# Plan" }, undefined, undefined, ctx);
    assert.ok(result);
    assert.ok(result.details?.path?.includes(path.join("docs", "plans")), `path under docs/plans/: ${result.details?.path}`);
  });

  it("write_plan expands {yyyymm} into a monthly subfolder", async () => {
    writeSettings({ "pi-plan": { plansDir: ".agents/plans/{yyyymm}" } });
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: true, cwd: TMP, isProjectTrusted: () => false });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const wd = toolDefs.write_plan;
    assert.ok(wd);
    const result = await wd.execute("c1", { title: "Monthly", content: "# Plan" }, undefined, undefined, ctx);
    assert.ok(result);
    const yyyymm = new Date().toISOString().slice(0, 7).replace("-", "");
    assert.ok(result.details?.path?.includes(path.join(".agents", "plans", yyyymm)), `path under monthly subdir: ${result.details?.path}`);
  });

  it("draft refinement accepts a lastPlanPath inside a monthly subdir and rejects one outside the base", async () => {
    writeSettings({ "pi-plan": { plansDir: ".agents/plans/{yyyymm}" } });
    const yyyymm = new Date().toISOString().slice(0, 7).replace("-", "");

    // Write a first plan so lastPlanPath/status are set, then refine — must reuse the monthly path.
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: true, cwd: TMP, isProjectTrusted: () => false });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const wd = toolDefs.write_plan;
    assert.ok(wd);
    const first = await wd.execute("c1", { title: "Refine Me", content: "# Plan\nv1" }, undefined, undefined, ctx);
    assert.ok(first);
    const refined = await wd.execute("c2", { title: "Refine Me", content: "# Plan\nv2" }, undefined, undefined, ctx);
    assert.ok(refined);
    assert.equal(refined.details?.path, first.details?.path, "draft refinement reuses the same monthly path");
    assert.ok(first.details?.path?.includes(path.join(".agents", "plans", yyyymm)), first.details?.path);

    // A tampered lastPlanPath outside the base must be rejected by the guard.
    const { handlers: h2, toolDefs: t2 } = createFakePi(["read"], { plan: true });
    const ctx2 = fakeCtx({
      hasUI: true, cwd: TMP, isProjectTrusted: () => false,
      sessionManager: {
        getBranch: () => [{ type: "custom", customType: "pi-plan", data: { enabled: true, planThinking: "high", normalThinking: "medium", lastPlanPath: path.join(TMP, "escape.md"), lastPlanTitle: "Refine Me", lastPlanStatus: "draft" } }],
      },
    });
    await h2.session_start?.[0]({ reason: "startup" }, ctx2);
    const wd2 = t2.write_plan;
    assert.ok(wd2);
    await assert.rejects(
      wd2.execute("c3", { title: "Refine Me", content: "# Plan\nv3" }, undefined, undefined, ctx2),
      /outside the configured plans directory/,
    );
  });
});

describe("write_plan lifecycle", () => {
  it("sets planReadyForReview, agent_settled prefills /plan-approve once", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });

    let prefillText = "";
    let notifyCalled = false;
    const ctx = fakeCtx({
      hasUI: true, cwd: TMP,
      getContextUsage: () => ({ percent: 50 }),
      ui: {
        select: async () => "Stay in Plan mode",
        confirm: async () => false, editor: async () => "",
        setStatus: () => {}, setWidget: () => {}, notify: () => { notifyCalled = true; },
        setEditorText: (text: string) => { prefillText = text; },
        theme: { fg: (_s: string, t: string) => t },
      },
    });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const wd = toolDefs.write_plan;
    assert.ok(wd);

    // Write plan
    await wd.execute("c1", { title: "My Plan", content: "# Plan\nDo work." }, undefined, undefined, ctx);
    // Refinement
    await wd.execute("c2", { title: "My Plan", content: "# Plan\nDo more." }, undefined, undefined, ctx);

    const settled = handlers.agent_settled?.[0];
    assert.ok(settled);

    // First agent_settled: should prefill /plan-approve
    prefillText = "";
    notifyCalled = false;
    await settled({}, ctx);
    assert.ok(prefillText.includes("/plan-approve"), "first settled prefills /plan-approve");
    assert.ok(notifyCalled, "first settled sends notification");

    // Second: should NOT prefill (flag consumed)
    prefillText = "";
    notifyCalled = false;
    await settled({}, ctx);
    assert.equal(prefillText, "", "second settled does not prefill");
    assert.ok(!notifyCalled, "second settled does not notify");

    // Write new plan
    await wd.execute("c3", { title: "Another Plan", content: "# Another\nWork." }, undefined, undefined, ctx);

    // Again prefills
    prefillText = "";
    notifyCalled = false;
    await settled({}, ctx);
    assert.ok(prefillText.includes("/plan-approve"), "settled after new plan prefills again");
  });

  it("allows write_plan outside plan mode", async () => {
    const { toolDefs } = createFakePi(["read"], {});
    const wd = toolDefs.write_plan;
    assert.ok(wd);

    // ponytail: write_plan is available in any mode
    const result = await wd.execute("c1", { title: "Test", content: "# Test" }, undefined, undefined, fakeCtx());
    assert.ok(result);
  });

  it("derives title from first '# Heading' when title arg omitted (regression: validation failures in live sessions)", async () => {
    const { toolDefs } = createFakePi(["read"], {});
    const wd = toolDefs.write_plan;
    assert.ok(wd);
    const ctx = fakeCtx({ cwd: TMP });

    // No title arg — model sent only content (3 live failures: 2026-07-12, 2026-08-29)
    const result = await wd.execute("c1", { content: "# Pi 0.84.4 compat\n## Goal\nCheck all packages." }, undefined, undefined, ctx);
    assert.ok(result);
    assert.equal(result.details?.title, "Pi 0.84.4 compat");
    const written = readFileSync(result.details?.path, "utf8");
    assert.match(written, /^# Pi 0.84.4 compat/);

    // Neither title nor heading — falls back to "Plan"
    const r2 = await wd.execute("c2", { content: "Just some notes without a heading." }, undefined, undefined, ctx);
    assert.ok(r2);
    assert.equal(r2.details?.title, "Plan");
  });

  it("directs approval to /plan-approve, not to ask_user_question options", async () => {
    const { toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: true, cwd: TMP });
    const wd = toolDefs.write_plan;
    assert.ok(wd);
    const result = await wd.execute("c1", { title: "My Plan", content: "# Plan\nDo work." }, undefined, undefined, ctx);
    const text = result.content?.[0]?.text ?? "";
    assert.match(text, /\/plan-approve/, "result points approval at /plan-approve");
    assert.doesNotMatch(text, /ask the user to approve, refine, execute/, "result no longer instructs offering approve/execute via a question");
  });
});

describe("open question warning", () => {
  it("includes warning when plan has 'Open Questions' section with a question mark", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: true, cwd: TMP });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const wd = toolDefs.write_plan;
    assert.ok(wd);
    const result = await wd.execute("c1", {
      title: "My Plan",
      content: "## Open Questions\n- What is your preferred approach?\n## Next Steps\n...",
    }, undefined, undefined, ctx);
    assert.ok(result);
    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("blocking user-answerable open questions"), "should warn about open questions");
  });

  it("excludes warning when 'Open Questions' section has no question mark", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: true, cwd: TMP });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const wd = toolDefs.write_plan;
    assert.ok(wd);
    const result = await wd.execute("c1", {
      title: "My Plan",
      content: "## Open Questions\nNone at this time.\n## Next Steps\n...",
    }, undefined, undefined, ctx);
    assert.ok(result);
    const text = result.content?.[0]?.text ?? "";
    assert.ok(!text.includes("blocking user-answerable open questions"), "should not warn when no questions");
  });

  it("excludes warning when question mark is in a later section, not under 'Open Questions'", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: true, cwd: TMP });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const wd = toolDefs.write_plan;
    assert.ok(wd);
    const result = await wd.execute("c1", {
      title: "My Plan",
      content: "## Open Questions\nNone.\n\n## Implementation Details\nShould we use a library?",
    }, undefined, undefined, ctx);
    assert.ok(result);
    const text = result.content?.[0]?.text ?? "";
    // ponytail: the ? in "Should we use a library?" is under a different heading,
    // so hasOpenQuestionWarning must NOT fire.
    assert.ok(!text.includes("blocking user-answerable open questions"), "should not cross section boundaries");
  });

  it("detects question mark in sub-bullets under 'Open Questions'", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: true, cwd: TMP });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const wd = toolDefs.write_plan;
    assert.ok(wd);
    const result = await wd.execute("c1", {
      title: "My Plan",
      content: "## Open Questions\n- Main question?\n  - Sub-question?\n## Next Steps",
    }, undefined, undefined, ctx);
    assert.ok(result);
    const text = result.content?.[0]?.text ?? "";
    assert.ok(text.includes("ask_user_question"), "should detect questions in sub-items");
  });
});

describe("execution handoff", () => {
  it("current-session execution through /plan-approve command", async () => {
    const { commands, sentMessages, toolDefs, handlers } = createFakePi(["read"], { plan: true });

    const ctx = fakeCtx({ hasUI: true, cwd: TMP, getContextUsage: () => ({ percent: 50 }) });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await toolDefs.write_plan.execute("c1", { title: "Plan", content: "# Plan\nWork." }, undefined, undefined, ctx);

    const approve = commands["plan-approve"];
    assert.ok(approve, "/plan-approve registered");

    await approve.handler("current", ctx);

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].content?.includes("Execute the approved plan"));
    assert.equal(sentMessages[0].options?.deliverAs, "followUp");
  });

  it("fresh-session execution through /plan-approve new command", async () => {
    const { commands, sentMessages, toolDefs, handlers } = createFakePi(["read"], { plan: true });

    let newSessionCalled = false;
    const ctx = fakeCtx({
      hasUI: true, cwd: TMP,
      getContextUsage: () => ({ percent: 60 }),
      newSession: async (options: any) => {
        newSessionCalled = true;
        await options.setup({ appendCustomEntry: () => {} });
        await options.withSession({ sendUserMessage: async (text: string) => { sentMessages.push({ content: text }); } });
        return { cancelled: false };
      },
    });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await toolDefs.write_plan.execute("c1", { title: "Plan", content: "# Plan\nWork." }, undefined, undefined, ctx);

    const approve = commands["plan-approve"];
    assert.ok(approve, "/plan-approve registered");

    await approve.handler("new", ctx);

    assert.ok(newSessionCalled, "newSession was called");
    assert.ok(sentMessages.length >= 1, "sent at least one message");
  });

  it("fresh-session execution with flow through /plan-approve flow command", async () => {
    const { commands, sentMessages, toolDefs, handlers } = createFakePi(["read"], { plan: true });

    const flowCwd = createGitRepo("pi-plan-flow-");

    let newSessionCalled = false;
    const ctx = fakeCtx({
      hasUI: true, cwd: flowCwd,
      getContextUsage: () => ({ percent: 50 }),
      newSession: async (options: any) => {
        newSessionCalled = true;
        await options.setup({ appendCustomEntry: () => {} });
        await options.withSession({ sendUserMessage: async (text: string) => { sentMessages.push({ content: text }); } });
        return { cancelled: false };
      },
    });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await toolDefs.write_plan.execute("c1", { title: "Plan", content: "# Plan\nWork." }, undefined, undefined, ctx);

    const approve = commands["plan-approve"];
    assert.ok(approve, "/plan-approve registered");

    await approve.handler("flow", ctx);

    assert.ok(newSessionCalled, "newSession was called");
    assert.ok(sentMessages.length >= 1, "sent at least one message");
  });

  it("rolls back flow state when fresh-session handoff throws", async () => {
    const { commands, entries, toolDefs, handlers } = createFakePi(["read"], { plan: true });
    const flowCwd = createGitRepo("pi-plan-flow-error-");
    const ctx = fakeCtx({
      cwd: flowCwd,
      newSession: async (options: any) => {
        await options.setup({ appendCustomEntry: (customType: string, data?: any) => entries.push({ customType, data }) });
        throw new Error("handoff failed");
      },
    });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await toolDefs.write_plan.execute("c1", { title: "Plan", content: "# Plan\nWork." }, undefined, undefined, ctx);
    await assert.rejects(commands["plan-approve"].handler("flow", ctx), /handoff failed/);

    assert.ok(entries.some((entry) => entry.data?.flow?.phase === "implement"), "handoff captured new flow state");
    assert.equal(entries.at(-1)?.data?.flow, undefined, "failed handoff restores prior flow state");
  });

  it("calls appendEntry when plan mode is toggled", async () => {
    const { handlers, entries, commands } = createFakePi(["read"], {});

    const ctx = fakeCtx({ hasUI: true, cwd: TMP });

    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    // Enter plan mode via /plan command
    const planCmd = commands.plan;
    assert.ok(planCmd);
    await planCmd.handler("", ctx);

    const stateEntry = entries.find((e: any) => e.customType === "pi-plan");
    assert.ok(stateEntry, "should persist pi-plan state");
    assert.ok(stateEntry.data.hasOwnProperty("enabled"), "state includes enabled field");
  });

  it("switching to an empty branch clears workflow state", async () => {
    const { handlers, commands, entries, toolDefs } = createFakePi(["read"], { plan: true });

    const flowCwd = createGitRepo("pi-plan-branch-");

    const ctx = fakeCtx({
      hasUI: true, cwd: flowCwd,
      getContextUsage: () => ({ percent: 50 }),
      newSession: async (options: any) => {
        // Forward setup's appendCustomEntry to our entries tracker
        await options.setup({ appendCustomEntry: (type: string, data?: any) => entries.push({ customType: type, data }) });
        await options.withSession({ sendUserMessage: async () => {} });
        return { cancelled: false };
      },
    });

    // Start plan mode, write a plan, approve with flow to set workflow
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await toolDefs.write_plan.execute("c1", { title: "Plan", content: "# Plan\nWork." }, undefined, undefined, ctx);
    await commands["plan-approve"].handler("flow", ctx);

    // Confirm flow state was persisted (the last pi-plan entry should have flow)
    const allPlanEntries = entries.filter((e: any) => e.customType === "pi-plan");
    const lastPlanEntry = allPlanEntries[allPlanEntries.length - 1];
    const flowData = lastPlanEntry?.data?.flow;
    assert.ok(flowData, "flow state persisted after execution");

    // Simulate switching to a branch with no pi-plan entry
    const emptyBranchCtx = fakeCtx({
      cwd: flowCwd,
      sessionManager: {
        // No custom entries of type pi-plan
        getBranch: () => [
          { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
        ],
      },
    });

    const sessionTree = handlers.session_tree?.[0];
    assert.ok(sessionTree, "session_tree handler registered");
    await sessionTree({}, emptyBranchCtx);

    // Check that the latest entry has all state reset (cleared on empty branch)
    const allPlanEntriesAfter = entries.filter((e: any) => e.customType === "pi-plan");
    const lastEntryAfter = allPlanEntriesAfter[allPlanEntriesAfter.length - 1];
    assert.equal(lastEntryAfter.data?.flow, undefined, "flow cleared on empty branch");
    assert.equal(lastEntryAfter.data?.lastPlanPath, undefined, "lastPlanPath cleared on empty branch");
    assert.equal(lastEntryAfter.data?.lastPlanTitle, undefined, "lastPlanTitle cleared on empty branch");
    assert.equal(lastEntryAfter.data?.lastPlanStatus, undefined, "lastPlanStatus cleared on empty branch");
    assert.equal(lastEntryAfter.data?.enabled, false, "planModeEnabled reset on empty branch");
    assert.equal(lastEntryAfter.data?.toolsBeforePlan, undefined, "toolsBeforePlan cleared on empty branch");
  });

  it("restores tools and thinking when leaving a plan-mode branch", async () => {
    const state = createFakePi(["read", "edit"], { plan: false });
    const ctx = fakeCtx();
    await state.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const normalThinking = state.thinkingLevel;
    await state.commands.plan.handler("", ctx);
    assert.ok(!state.activeTools.includes("edit"), "plan branch hides mutators");

    await state.handlers.session_tree?.[0]({}, fakeCtx({ sessionManager: { getBranch: () => [] } }));
    assert.ok(state.activeTools.includes("edit"), "empty branch restores baseline tools");
    assert.equal(state.thinkingLevel, normalThinking, "empty branch restores normal thinking");
  });

  it("branch with partial saved entry reconstructs plan tools without inheriting optional state", async () => {
    const { handlers, entries, commands, activeTools } = createFakePi(["read", "ffgrep", "edit"], { plan: false });

    // Set up a module state with meaningful toolsBeforePlan (simulating prior branch)
    const ctx = fakeCtx({ hasUI: true, cwd: TMP });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    // Enter plan mode so toolsBeforePlan gets captured
    await commands.plan.handler("", ctx);

    // Now simulate a branch that has a saved plan entry but with a partial subset of fields
    const partialBranchCtx = fakeCtx({
      cwd: TMP,
      sessionManager: {
        getBranch: () => [
          // Has a custom pi-plan entry but only some fields (no toolsBeforePlan)
          { type: "custom", customType: "pi-plan", data: { enabled: true, lastPlanPath: "/some/path.md", lastPlanTitle: "Some Plan" } } as any,
        ],
      },
    });

    const sessionTree = handlers.session_tree?.[0];
    assert.ok(sessionTree, "session_tree handler registered");
    await sessionTree({}, partialBranchCtx);

    const lastEntry = entries[entries.length - 1];
    assert.equal(lastEntry.data?.enabled, true, "planModeEnabled from saved entry");
    assert.equal(lastEntry.data?.lastPlanPath, "/some/path.md", "lastPlanPath from saved entry");
    assert.deepEqual(lastEntry.data?.toolsBeforePlan, ["read", "ffgrep", "edit", "write_plan", "ask_user_question"], "baseline reconstructed for restoration");
    assert.ok(!activeTools.includes("edit"), "saved plan mode hides mutators");
    assert.equal(lastEntry.data?.lastPlanStatus, undefined, "lastPlanStatus not inherited — absent from saved entry");
    assert.equal(lastEntry.data?.flow, undefined, "flow not inherited — absent from saved entry");
  });
});

describe("handoff", () => {
  it("buildFinalPrompt prepends the parent-session reference", () => {
    assert.equal(buildFinalPrompt("body", undefined), "body");
    const prompt = buildFinalPrompt("body", "/test/session.jsonl");
    assert.match(prompt, /Parent session.*\/test\/session\.jsonl/);
    assert.ok(prompt.endsWith("body"));
  });

  it("requires a goal argument", async () => {
    const { commands } = createFakePi(["read"]);
    const notifies: Array<{ msg: string; level: string }> = [];
    const newSessionCalls: any[] = [];
    const ctx = fakeCtx({
      mode: "tui",
      ui: { notify: (msg: string, level: string) => notifies.push({ msg, level }) },
      newSession: async (options: any) => { newSessionCalls.push(options); return { cancelled: false }; },
    });
    await commands["handoff"].handler("", ctx);
    assert.ok(notifies.some((n) => /Usage: \/handoff/.test(n.msg)), "usage notify shown");
    assert.equal(newSessionCalls.length, 0, "newSession not called without a goal");
  });

  it("rejects non-TUI modes (RPC returns no custom UI)", async () => {
    const { commands } = createFakePi(["read"]);
    const notifies: Array<{ msg: string; level: string }> = [];
    const newSessionCalls: any[] = [];
    const ctx = fakeCtx({
      mode: "rpc",
      hasUI: true,
      ui: { custom: async () => undefined, notify: (msg: string, level: string) => notifies.push({ msg, level }) },
      newSession: async (options: any) => { newSessionCalls.push(options); return { cancelled: false }; },
    });
    await commands["handoff"].handler("do something", ctx);
    assert.ok(notifies.some((n) => /interactive mode/.test(n.msg)), "interactive-mode error shown");
    assert.equal(newSessionCalls.length, 0, "newSession not called in RPC mode");
  });

  it("spawns a parent-linked session with the edited prompt", async () => {
    const { commands } = createFakePi(["read"]);
    const newSessionCalls: any[] = [];
    const editorTexts: string[] = [];
    const ctx = fakeCtx({
      mode: "tui",
      ui: {
        custom: async () => ({ prompt: "## Task\nDo X" }),
        editor: async (_title: string, prefill: string) => prefill,
        notify: () => {},
        setEditorText: (text: string) => editorTexts.push(text),
      },
      sessionManager: {
        getBranch: () => [],
        getSessionFile: () => "/test/session.jsonl",
        getEntries: () => [
          { id: "1", type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
          { id: "2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } },
        ],
        getLeafId: () => "2",
      },
      newSession: async (options: any) => {
        newSessionCalls.push(options);
        await options.withSession?.({ ui: { setEditorText: (text: string) => editorTexts.push(text), notify: () => {} } });
        return { cancelled: false };
      },
    });

    await commands["handoff"].handler("finish phase two", ctx);

    assert.equal(newSessionCalls.length, 1, "newSession called once");
    assert.equal(newSessionCalls[0].parentSession, "/test/session.jsonl", "parent session linked");
    assert.ok(editorTexts.some((text) => /Parent session/.test(text) && /Do X/.test(text)), "editor prefilled with parent ref and task");
  });

  it("cancels when the editor prompt is dismissed", async () => {
    const { commands } = createFakePi(["read"]);
    const notifies: Array<{ msg: string; level: string }> = [];
    const newSessionCalls: any[] = [];
    const ctx = fakeCtx({
      mode: "tui",
      ui: {
        custom: async () => ({ prompt: "## Task\nDo X" }),
        editor: async () => undefined,
        notify: (msg: string, level: string) => notifies.push({ msg, level }),
      },
      sessionManager: {
        getBranch: () => [],
        getSessionFile: () => "/test/session.jsonl",
        getEntries: () => [
          { id: "1", type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
          { id: "2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } },
        ],
        getLeafId: () => "2",
      },
      newSession: async (options: any) => { newSessionCalls.push(options); return { cancelled: false }; },
    });

    await commands["handoff"].handler("finish phase two", ctx);
    assert.ok(notifies.some((n) => /Handoff cancelled/.test(n.msg)), "cancellation notify shown");
    assert.equal(newSessionCalls.length, 0, "newSession not called on cancel");
  });
});

describe("rewind checkpoints", () => {
  it("captures a normal user turn and restores its conversation prompt", async () => {
    const { commands, entries, handlers } = createFakePi(["read"]);
    const cwd = createGitRepo("pi-plan-command-rewind-");
    const checkpoint = await captureRewindCheckpoint(cwd, "prompt-1", "Restore me", "test-session", "2026-01-01T00:00:00.000Z");
    let editorText = "";
    let navigatedTo = "";
    let cancelled = false;
    const branch = [
      { id: "parent", type: "message", parentId: null, message: { role: "assistant", content: [] } },
      { id: "prompt-1", type: "message", parentId: "parent", message: { role: "user", content: "Restore me" } },
      { id: "checkpoint", type: "custom", customType: "pi-plan-rewind", data: checkpoint },
    ];
    const ctx = fakeCtx({
      cwd,
      ui: {
        select: async (_title: string, options: string[]) => options[0] === "Restore conversation" ? "Restore conversation" : options[0],
        setEditorText: (text: string) => { editorText = text; },
        notify: () => {},
      },
      sessionManager: {
        getBranch: () => branch,
        getLeafEntry: () => branch[1],
        getEntry: (id: string) => branch.find((entry) => entry.id === id),
      },
      navigateTree: async (id: string) => { navigatedTo = id; return { cancelled }; },
    });
    await commands.rewind.handler("", ctx);
    assert.equal(navigatedTo, "parent");
    assert.equal(editorText, "Restore me");
    cancelled = true;
    editorText = "unchanged";
    await commands.rewind.handler("", ctx);
    assert.equal(editorText, "unchanged");

    const assistantStart = { type: "message_start", message: { role: "assistant" } };
    // turn_start fires before the user message is persisted (leaf is still the prior
    // assistant), so it must not capture. No turn_start handler is registered now.
    await handlers.turn_start?.[0]({}, fakeCtx({
      cwd,
      sessionManager: { getBranch: () => [], getLeafEntry: () => branch[1], getSessionId: () => "test-session" },
    }));
    assert.equal(entries.some((entry) => entry.customType === "pi-plan-rewind"), false);
    // message_start(assistant) fires after the user leaf is in the tree, before any
    // edits: capture happens here.
    await handlers.message_start?.[0](assistantStart, fakeCtx({
      cwd,
      sessionManager: { getBranch: () => [], getLeafEntry: () => branch[1], getSessionId: () => "test-session" },
    }));
    assert.ok(entries.some((entry) => entry.customType === "pi-plan-rewind"));
    // A non-user leaf (e.g. toolResult on a continuation turn) must not capture.
    const before = entries.length;
    await handlers.message_start?.[0](assistantStart, fakeCtx({
      cwd,
      sessionManager: { getBranch: () => [], getLeafEntry: () => branch[0], getSessionId: () => "test-session" },
    }));
    assert.equal(entries.length, before);
  });

  it("preflights combined rewind before changing the conversation", async () => {
    const { commands } = createFakePi(["read"]);
    const cwd = createGitRepo("pi-plan-combined-rewind-");
    const checkpoint = await captureRewindCheckpoint(cwd, "prompt-1", "Restore me", "test-session");
    writeFileSync(path.join(cwd, "README.md"), "diverged\n");
    execFileSync("git", ["add", "README.md"], { cwd });
    execFileSync("git", ["commit", "-m", "diverged"], { cwd });
    let navigations = 0;
    let editorText = "unchanged";
    const branch = [
      { id: "parent", type: "message", parentId: null, message: { role: "assistant", content: [] } },
      { id: "prompt-1", type: "message", parentId: "parent", message: { role: "user", content: "Restore me" } },
      { id: "checkpoint", type: "custom", customType: "pi-plan-rewind", data: checkpoint },
    ];
    await commands.rewind.handler("", fakeCtx({
      cwd,
      ui: {
        select: async (_title: string, options: string[]) => options.includes("Restore code") ? "Restore code and conversation" : options[0],
        setEditorText: (text: string) => { editorText = text; },
        notify: () => {},
      },
      sessionManager: { getBranch: () => branch, getEntry: (id: string) => branch.find((entry) => entry.id === id) },
      navigateTree: async () => { navigations++; return { cancelled: false }; },
    }));
    assert.equal(navigations, 0);
    assert.equal(editorText, "unchanged");
  });
});

describe("plan model and thinking (global, plan-mode only)", () => {
  function modelCtx(model: any): any {
    const models = [
      { provider: "test", id: "model-1" },
      { provider: "zai-anthropic", id: "glm-5.3" },
      { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    ];
    return fakeCtx({
      model,
      modelRegistry: {
        getAvailable: () => models,
        refresh: async () => {},
        find: (p: string, i: string) => models.find((m) => m.provider === p && m.id === i),
      },
    });
  }

  function prefsOnDisk(): any {
    return JSON.parse(readFileSync(prefsPath(), "utf8"))["pi-plan"] ?? {};
  }

  it("/plan-model sets the plan model globally without touching the active model in normal mode", async () => {
    cleanPrefs();
    const notices: string[] = [];
    const ext = createFakePi(["read"], {});
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    ctx.ui.notify = (m: string) => notices.push(m);
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    ext.modelSets.length = 0;

    await ext.commands["plan-model"].handler("zai-anthropic/glm-5.3", ctx);
    assert.equal(prefsOnDisk().planModel, "zai-anthropic/glm-5.3", "plan model persisted");
    assert.equal(ext.modelSets.length, 0, "normal mode is untouched");
    assert.ok(notices.some((n) => /applies in plan mode/.test(n)), "explains it applies in plan mode");
  });

  it("entering plan mode switches to the plan model; leaving restores the previous model", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({ version: 3, planModel: "zai-anthropic/glm-5.3", planThinking: "high" }));
    const ext = createFakePi(["read"], {});
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);

    ext.modelSets.length = 0;
    await ext.commands["plan"].handler("", ctx); // enter plan mode
    const last = ext.modelSets[ext.modelSets.length - 1];
    assert.ok(last && last.provider === "zai-anthropic" && last.id === "glm-5.3", "plan model applied on enter");
    assert.equal(ext.thinkingLevel, "high", "plan thinking applied on enter");

    ext.modelSets.length = 0;
    ctx.model = { provider: "zai-anthropic", id: "glm-5.3" }; // core switched
    await ext.commands["plan"].handler("", ctx); // leave plan mode
    const restored = ext.modelSets[ext.modelSets.length - 1];
    assert.ok(restored && restored.provider === "opencode-go" && restored.id === "deepseek-v4.1-flash",
      "pre-plan model restored on leave");
  });

  it("a model picked while planning is session-temporary (plan config unchanged, restored on leave)", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({ version: 3, planModel: "zai-anthropic/glm-5.3" }));
    const ext = createFakePi(["read"], {});
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.commands["plan"].handler("", ctx); // enter plan mode -> glm-5.3
    ctx.model = { provider: "zai-anthropic", id: "glm-5.3" }; // core switched on enter
    ext.modelSets.length = 0;

    // User picks another model with the built-in /model while in plan mode.
    ctx.model = { provider: "test", id: "model-1" };
    await ext.handlers.model_select?.[0]({
      model: { provider: "test", id: "model-1" }, previousModel: { provider: "zai-anthropic", id: "glm-5.3" }, source: "set",
    }, ctx);
    assert.equal(prefsOnDisk().planModel, "zai-anthropic/glm-5.3", "plan config unchanged by an in-plan pick");

    // Leaving restores the pre-plan model, not the temporary pick.
    ext.modelSets.length = 0;
    await ext.commands["plan"].handler("", ctx);
    const restored = ext.modelSets[ext.modelSets.length - 1];
    assert.ok(restored && restored.provider === "opencode-go", "pre-plan model restored on leave");
  });

  it("a model picked in normal mode never changes the plan model", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({ version: 3, planModel: "zai-anthropic/glm-5.3" }));
    const ext = createFakePi(["read"], {});
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);

    await ext.handlers.model_select?.[0]({
      model: { provider: "test", id: "model-1" }, previousModel: { provider: "opencode-go", id: "deepseek-v4.1-flash" }, source: "set",
    }, ctx);
    assert.equal(prefsOnDisk().planModel, "zai-anthropic/glm-5.3", "plan model untouched by a normal-mode pick");
  });

  it("/plan-thinking sets the plan thinking level globally", async () => {
    cleanPrefs();
    const notices: string[] = [];
    const ext = createFakePi(["read"], {});
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    ctx.ui.notify = (m: string) => notices.push(m);
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);

    await ext.commands["plan-thinking"].handler("xhigh", ctx);
    assert.equal(prefsOnDisk().planThinking, "xhigh", "plan thinking persisted");
    assert.ok(notices.some((n) => /applies in plan mode/.test(n)), "explains it applies in plan mode");

    // Entering plan mode applies it; leaving restores the pre-plan level.
    await ext.commands["plan"].handler("", ctx);
    assert.equal(ext.thinkingLevel, "xhigh", "plan thinking applied on enter");
    await ext.commands["plan"].handler("", ctx);
    assert.notEqual(ext.thinkingLevel, "xhigh", "pre-plan thinking restored on leave");
  });

  it("/plan-model clear removes the global plan model and restores in-session", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({ version: 3, planModel: "zai-anthropic/glm-5.3" }));
    const ext = createFakePi(["read"], {});
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.commands["plan"].handler("", ctx); // enter plan mode -> glm-5.3
    ctx.model = { provider: "zai-anthropic", id: "glm-5.3" };

    ext.modelSets.length = 0;
    await ext.commands["plan-model"].handler("clear", ctx);
    assert.equal(prefsOnDisk().planModel, undefined, "plan model cleared");
    const restored = ext.modelSets[ext.modelSets.length - 1];
    assert.ok(restored && restored.provider === "opencode-go", "pre-plan model restored on clear");
  });

  it("plan model set while plan mode is active applies immediately", async () => {
    cleanPrefs();
    const ext = createFakePi(["read"], {});
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.commands["plan"].handler("", ctx); // enter plan mode (no plan model yet)
    ext.modelSets.length = 0;

    await ext.commands["plan-model"].handler("zai-anthropic/glm-5.3", ctx);
    const last = ext.modelSets[ext.modelSets.length - 1];
    assert.ok(last && last.provider === "zai-anthropic", "applied immediately while planning");
  });

  it("plan-mode starts with --plan apply the plan config; normal starts stay stock Pi", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({ version: 3, planModel: "zai-anthropic/glm-5.3", planThinking: "high" }));
    const ext = createFakePi(["read"], { plan: true });
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    assert.ok(ext.modelSets.some((m: any) => m.provider === "zai-anthropic" && m.id === "glm-5.3"),
      "--plan start applies the plan model");

    const ext2 = createFakePi(["read"], {});
    const ctx2 = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    await ext2.handlers.session_start?.[0]({ reason: "startup" }, ctx2);
    assert.equal(ext2.modelSets.length, 0, "normal start leaves the active model alone");
  });

  it("resume keeps the session model (no plan/global override)", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({ version: 3, planModel: "zai-anthropic/glm-5.3" }));
    const ext = createFakePi(["read"], {});
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    await ext.handlers.session_start?.[0]({ reason: "resume" }, ctx);
    assert.equal(ext.modelSets.length, 0, "resume does not switch models");
  });

  it("legacy v2 preferences migrate to v3 (plan model + thinking kept, normal-mode prefs dropped)", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({
      version: 2,
      defaults: { planThinking: "high", normalThinking: "low" },
      perModel: { "test/model-1": { planThinking: "low", normalThinking: "low" } },
      planModel: "zai-anthropic/glm-5.3",
      normalModel: "opencode-go/deepseek-v4.1-flash",
    }));
    const ext = createFakePi(["read"], { plan: true });
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    assert.ok(ext.modelSets.some((m: any) => m.provider === "zai-anthropic"), "v2 plan model honored");

    await ext.commands["plan-model"].handler("test/model-1", ctx); // rewrite -> v3 on disk
    const saved = prefsOnDisk();
    assert.equal(saved.version, 3, "rewritten as v3");
    assert.equal(saved.normalModel, undefined, "normal-mode model dropped");
    assert.equal(saved.defaults, undefined, "v2 defaults dropped");
  });

  it("a plan model missing from the registry warns once, then retries silently (bounded)", async function () {
    this.timeout(8000);
    cleanPrefs();
    writePrefs(JSON.stringify({ version: 3, planModel: "ghost/model" }));
    const notices: string[] = [];
    const ext = createFakePi(["read"], {});
    const models = [{ provider: "opencode-go", id: "deepseek-v4.1-flash" }];
    const ctx = fakeCtx({
      model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
      modelRegistry: {
        getAvailable: () => models,
        refresh: async () => {},
        find: (p: string, i: string) => models.find((m) => m.provider === p && m.id === i),
      },
    });
    ctx.ui.notify = (m: string) => notices.push(m);
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);

    await ext.commands["plan"].handler("", ctx); // enter plan mode -> ghost model missing
    const notLoaded = () => notices.filter((n) => /not loaded yet/.test(n)).length;
    assert.equal(notLoaded(), 1, "warns exactly once");
    assert.equal(ext.modelSets.length, 0);

    // Simulate the retry timer + router:models-loaded firing repeatedly.
    await new Promise((r) => setTimeout(r, 1700));
    ext.pi.events.emit("router:models-loaded", {});
    await new Promise((r) => setTimeout(r, 1700));
    ext.pi.events.emit("router:models-loaded", {});
    await new Promise((r) => setTimeout(r, 1700));
    assert.equal(notLoaded(), 1, "retries stay silent — no toast loop");
    assert.equal(ext.modelSets.length, 0);
  });

  it("session_tree to a non-plan branch restores the pre-plan model and thinking", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({ version: 3, planModel: "zai-anthropic/glm-5.3", planThinking: "high" }));
    const ext = createFakePi(["read"], {});
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.commands["plan"].handler("", ctx); // enter plan mode -> glm-5.3 + high
    ctx.model = { provider: "zai-anthropic", id: "glm-5.3" };
    ext.modelSets.length = 0;

    // Switch to a branch with no pi-plan entry (leaves plan mode implicitly).
    const branchCtx = modelCtx({ provider: "zai-anthropic", id: "glm-5.3" });
    await ext.handlers.session_tree?.[0]({}, branchCtx);

    const restored = ext.modelSets[ext.modelSets.length - 1];
    assert.ok(restored && restored.provider === "opencode-go", "pre-plan model restored on branch switch");
    assert.equal(ext.thinkingLevel, "medium", "pre-plan thinking restored on branch switch");
  });

  it("a corrupt settings.json is backed up before being replaced", async () => {
    cleanPrefs();
    writeFileSync(prefsPath(), "{ this is not json ");
    const ext = createFakePi(["read"], {});
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx); // loads defaults
    await ext.commands["plan-thinking"].handler("high", ctx); // triggers a save

    assert.ok(existsSync(`${prefsPath()}.corrupt`), "corrupt file backed up");
    assert.equal(readFileSync(`${prefsPath()}.corrupt`, "utf8"), "{ this is not json ", "original bytes retained");
    assert.equal(prefsOnDisk().planThinking, "high", "fresh settings written");
  });

  it("/plan-model without a ref opens the picker in the TUI", async () => {
    initTheme("dark");
    cleanPrefs();
    const ext = createFakePi(["read"], {});
    const ctx = modelCtx({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    ctx.mode = "tui";
    ctx.ui.custom = async (factory: any) => new Promise<any>((resolve) => {
      const done = (result: any) => resolve(result);
      const component = factory({ requestRender() {} }, {}, {}, done);
      setTimeout(() => component.handleInput("\r"), 0);
    });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);

    await ext.commands["plan-model"].handler("", ctx);
    assert.ok(prefsOnDisk().planModel, "picker selection saved as the plan model");
  });
});


describe("fallback model chain", () => {
  function fallbackCtx(model: any): any {
    const models = [
      { provider: "test", id: "model-1" },
      { provider: "opencode-go", id: "deepseek-v4-flash" },
      { provider: "zai-coding-cn", id: "glm-5-turbo" },
    ];
    return fakeCtx({
      model,
      modelRegistry: {
        getAvailable: () => models,
        refresh: async () => {},
        find: (p: string, i: string) => models.find((m) => m.provider === p && m.id === i),
      },
    });
  }

  function overloadMsg(): any {
    return { role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests: rate limit exceeded" };
  }

  function successMsg(): any {
    return { role: "assistant", stopReason: "end_turn", errorMessage: undefined };
  }

  it("switches to the first fallback on overload", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({
      version: 2,
      defaults: { planThinking: "high", normalThinking: "medium" },
      perModel: {},
      fallbackModels: ["opencode-go/deepseek-v4-flash", "zai-coding-cn/glm-5-turbo"],
    }));
    const ext = createFakePi(["read"], {});
    const ctx = fallbackCtx({ provider: "test", id: "model-1" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.handlers.before_agent_start?.[0]({ prompt: "fix the bug" }, ctx);

    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx);
    assert.ok(ext.modelSets.some((m: any) => m.provider === "opencode-go" && m.id === "deepseek-v4-flash"),
      "switches to first fallback on overload");
  });

  it("advances through the chain when each fallback also overloads (review: CRITICAL)", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({
      version: 2,
      defaults: { planThinking: "high", normalThinking: "medium" },
      perModel: {},
      fallbackModels: ["opencode-go/deepseek-v4-flash", "zai-coding-cn/glm-5-turbo"],
    }));
    const ext = createFakePi(["read"], {});
    const ctx = fallbackCtx({ provider: "test", id: "model-1" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.handlers.before_agent_start?.[0]({ prompt: "task" }, ctx);

    // Overload on primary -> switch to fallback[0] (deepseek). Pi's own retry
    // loop continues the SAME turn against the new model (agent.continue — no
    // before_agent_start fires on retry continuations, verified in
    // agent-session.js: emitBeforeAgentStart is only in the prompt() path).
    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx);
    // Overload on fallback[0] -> advance to fallback[1] (glm-5-turbo).
    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx);
    assert.ok(ext.modelSets.some((m: any) => m.provider === "zai-coding-cn" && m.id === "glm-5-turbo"),
      "advances to fallback[1] after fallback[0] also overloads");
  });

  it("skips a fallback missing from the registry (review: MEDIUM)", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({
      version: 2,
      defaults: { planThinking: "high", normalThinking: "medium" },
      perModel: {},
      fallbackModels: ["missing/model", "opencode-go/deepseek-v4-flash"],
    }));
    const ext = createFakePi(["read"], {});
    const ctx = fallbackCtx({ provider: "test", id: "model-1" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.handlers.before_agent_start?.[0]({ prompt: "task" }, ctx);

    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx);
    assert.ok(ext.modelSets.some((m: any) => m.provider === "opencode-go" && m.id === "deepseek-v4-flash"),
      "missing model is skipped, next valid fallback is used");
  });

  it("restores the primary model on a successful message (review: HIGH)", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({
      version: 2,
      defaults: { planThinking: "high", normalThinking: "medium" },
      perModel: {},
      fallbackModels: ["opencode-go/deepseek-v4-flash"],
    }));
    const ext = createFakePi(["read"], {});
    const ctx = fallbackCtx({ provider: "test", id: "model-1" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.handlers.before_agent_start?.[0]({ prompt: "task" }, ctx);

    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx);
    assert.equal(ext.modelSets.length, 1, "first overload switches once");

    // Success -> restores the primary model (test/model-1), not just resets
    // the index.
    await ext.handlers.message_end?.[0]({ message: successMsg() }, ctx);
    assert.ok(ext.modelSets.some((m: any) => m.provider === "test" && m.id === "model-1"),
      "success restores the primary model");
  });

  it("resets the chain on a successful message so the next overload switches again", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({
      version: 2,
      defaults: { planThinking: "high", normalThinking: "medium" },
      perModel: {},
      fallbackModels: ["opencode-go/deepseek-v4-flash"],
    }));
    const ext = createFakePi(["read"], {});
    const ctx = fallbackCtx({ provider: "test", id: "model-1" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.handlers.before_agent_start?.[0]({ prompt: "task" }, ctx);

    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx);
    assert.equal(ext.modelSets.length, 1, "first overload switches once");

    // Success -> reset. Next overload switches to fallback[0] again.
    await ext.handlers.message_end?.[0]({ message: successMsg() }, ctx);
    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx);
    assert.equal(ext.modelSets.length, 3, "success reset the chain (restore + switch again)");
  });

  it("does not trigger on non-overload errors (e.g. context overflow)", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({
      version: 2,
      defaults: { planThinking: "high", normalThinking: "medium" },
      perModel: {},
      fallbackModels: ["opencode-go/deepseek-v4-flash"],
    }));
    const ext = createFakePi(["read"], {});
    const ctx = fallbackCtx({ provider: "test", id: "model-1" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.handlers.before_agent_start?.[0]({ prompt: "task" }, ctx);

    await ext.handlers.message_end?.[0]({
      message: { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
    }, ctx);
    assert.equal(ext.modelSets.length, 0, "context overflow does not trigger fallback");
  });

  it("does not fall back when no fallbackModels are configured", async () => {
    cleanPrefs();
    const ext = createFakePi(["read"], {});
    const ctx = fallbackCtx({ provider: "test", id: "model-1" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.handlers.before_agent_start?.[0]({ prompt: "task" }, ctx);

    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx);
    assert.equal(ext.modelSets.length, 0, "no chain configured -> no switch");
  });

  it("restores the primary on the NEXT turn when a turn ended on a fallback (review: HIGH)", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({
      version: 2,
      defaults: { planThinking: "high", normalThinking: "medium" },
      perModel: {},
      normalModel: "test/model-1",
      fallbackModels: ["opencode-go/deepseek-v4-flash"],
    }));
    const ext = createFakePi(["read"], {});
    const ctx = fallbackCtx({ provider: "test", id: "model-1" });
    // Emulate a host that emits model_select (source 'set') on setModel — the
    // applyingStoredModel guard in before_agent_start must suppress preference
    // writes (review: MEDIUM — regression risk across plan-mode transitions).
    const origSetModel = ext.pi.setModel.bind(ext.pi);
    ext.pi.setModel = async (m: any) => {
      const ok = await origSetModel(m);
      const ms = ext.handlers.model_select?.[0];
      if (ms) await ms({ model: m, previousModel: ctx.model, source: "set" }, ctx);
      return ok;
    };
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.handlers.before_agent_start?.[0]({ prompt: "task" }, ctx);

    // Overload -> on fallback, turn ends (no success message; retry budget gone).
    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx);
    // Next fresh turn: before_agent_start MUST restore the primary, not strand us.
    await ext.handlers.before_agent_start?.[0]({ prompt: "next task" }, ctx);
    assert.ok(ext.modelSets.some((m: any) => m.provider === "test" && m.id === "model-1"),
      "before_agent_start restores the primary after a turn ended on a fallback");
    // The model_select emission during restore must NOT have overwritten the
    // persisted per-mode preference.
    const saved = JSON.parse(readFileSync(prefsPath(), "utf8"))["pi-plan"];
    assert.equal(saved.normalModel, "test/model-1", "restore did not corrupt normalModel");
  });

  it("does not corrupt per-mode model preferences on fallback switch (review: MEDIUM)", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({
      version: 2,
      defaults: { planThinking: "high", normalThinking: "medium" },
      perModel: {},
      normalModel: "test/model-1",
      fallbackModels: ["opencode-go/deepseek-v4-flash"],
    }));
    const ext = createFakePi(["read"], {});
    const ctx = fallbackCtx({ provider: "test", id: "model-1" });
    // Emulate a host that emits model_select (source 'set') when setModel is
    // called — the applyingStoredModel guard must suppress preference writes.
    const origSetModel = ext.pi.setModel.bind(ext.pi);
    ext.pi.setModel = async (m: any) => {
      const ok = await origSetModel(m);
      const ms = ext.handlers.model_select?.[0];
      if (ms) await ms({ model: m, previousModel: ctx.model, source: "set" }, ctx);
      return ok;
    };
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.handlers.before_agent_start?.[0]({ prompt: "task" }, ctx);

    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx);
    const saved = JSON.parse(readFileSync(prefsPath(), "utf8"))["pi-plan"];
    assert.equal(saved.normalModel, "test/model-1", "per-mode pick not overwritten by fallback switch");
  });

  it("exhausts the chain without looping when all fallbacks overload (review: LOW)", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({
      version: 2,
      defaults: { planThinking: "high", normalThinking: "medium" },
      perModel: {},
      fallbackModels: ["opencode-go/deepseek-v4-flash"],
    }));
    const ext = createFakePi(["read"], {});
    const ctx = fallbackCtx({ provider: "test", id: "model-1" });
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.handlers.before_agent_start?.[0]({ prompt: "task" }, ctx);

    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx); // -> deepseek
    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx); // deepseek overloaded, no more fallbacks
    assert.equal(ext.modelSets.length, 1, "no further switches after chain exhausted");
    assert.equal(ext.modelSets.filter((m: any) => m.provider === "test").length, 0, "no fallback re-loop");
  });

  it("notifies and keeps the reference when the primary is not in the registry (review: MEDIUM)", async () => {
    cleanPrefs();
    writePrefs(JSON.stringify({
      version: 2,
      defaults: { planThinking: "high", normalThinking: "medium" },
      perModel: {},
      fallbackModels: ["opencode-go/deepseek-v4-flash"],
    }));
    const ext = createFakePi(["read"], {});
    const ctx = fallbackCtx({ provider: "gone", id: "vanished" }); // primary NOT in registry
    const notices: string[] = [];
    ctx.ui.notify = (m: string) => notices.push(m);
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);
    await ext.handlers.before_agent_start?.[0]({ prompt: "task" }, ctx);

    await ext.handlers.message_end?.[0]({ message: overloadMsg() }, ctx); // -> deepseek, primary=gone/vanished
    await ext.handlers.message_end?.[0]({ message: successMsg() }, ctx);   // restore fails: not in registry
    assert.ok(notices.some((n) => /Could not restore primary model gone\/vanished/.test(n)), "user warned");
  });

  it("/plan-fallback set/clear/view manage the chain", async () => {
    cleanPrefs();
    const ext = createFakePi(["read"], {});
    const ctx = fallbackCtx({ provider: "test", id: "model-1" });
    const notices: string[] = [];
    ctx.ui.notify = (m: string) => notices.push(m);
    await ext.handlers.session_start?.[0]({ reason: "startup" }, ctx);

    await ext.commands["plan-fallback"].handler("set opencode-go/deepseek-v4-flash zai-coding-cn/glm-5-turbo", ctx);
    assert.ok(notices.some((n) => /Fallback chain set: opencode-go\/deepseek-v4-flash → zai-coding-cn\/glm-5-turbo/.test(n)));

    await ext.commands["plan-fallback"].handler("", ctx);
    assert.ok(notices.some((n) => /fallback: opencode-go\/deepseek-v4-flash → zai-coding-cn\/glm-5-turbo/.test(n)), "view shows the chain");

    await ext.commands["plan-fallback"].handler("set invalid-ref", ctx);
    assert.ok(notices.some((n) => /Invalid model ref/.test(n)), "invalid ref rejected");

    await ext.commands["plan-fallback"].handler("clear", ctx);
    assert.ok(notices.some((n) => /cleared/.test(n)));
    await ext.commands["plan-fallback"].handler("", ctx);
    assert.ok(notices.some((n) => /No fallback models configured/.test(n)), "view after clear");
  });
});

describe("ask_user_question validation", () => {
  it("schema requires 2-4 options and exposes recommended", async () => {
    const { toolDefs } = createFakePi(["read"], { plan: true });
    const def = toolDefs.ask_user_question;
    assert.ok(def);
    assert.equal(def.parameters?.properties?.options?.minItems, 2);
    assert.equal(def.parameters?.properties?.options?.maxItems, 4);
    assert.ok(def.parameters?.properties?.recommended, "recommended field should exist");
  });

  it("uses the built-in select dialog in non-TUI (rpc) mode (no custom() dependency)", async () => {
    // ctx.ui.select works in RPC mode (sends an RPC dialog request the host can handle),
    // unlike ctx.ui.custom which is a no-op stub. The tool must use select, not custom.
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    let selectCalled = false;
    const ctx = fakeCtx({
      hasUI: true,
      mode: "rpc",
      ui: {
        ...fakeCtx().ui,
        custom: async () => { throw new Error("custom() must not be called"); },
        select: async (_q: string, opts: string[]) => { selectCalled = true; return opts[0]; },
      },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const qd = toolDefs.ask_user_question;
    const res = await qd.execute("c1", { question: "Q?", options: [{ label: "A" }, { label: "B" }] }, undefined, undefined, ctx);
    assert.ok(selectCalled, "select dialog used in rpc mode");
    assert.equal(res.details?.answer, "A");
  });

  it("rejects blank label at execute", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: false });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const qd = toolDefs.ask_user_question;
    assert.ok(qd);
    await assert.rejects(
      qd.execute("c1", { question: "Q?", options: [{ label: "" }, { label: "Option 2" }] }, undefined, undefined, ctx),
      /Each option must have a non-blank label\./,
    );
  });

  it("rejects duplicate labels at execute", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: false });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const qd = toolDefs.ask_user_question;
    assert.ok(qd);
    await assert.rejects(
      qd.execute("c1", { question: "Q?", options: [{ label: "Duplicate" }, { label: "Duplicate" }] }, undefined, undefined, ctx),
      /Option labels must be unique\./,
    );
  });

  it("rejects 'Other' label at execute", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: false });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const qd = toolDefs.ask_user_question;
    assert.ok(qd);
    await assert.rejects(
      qd.execute("c1", { question: "Q?", options: [{ label: "Other" }, { label: "Option B" }] }, undefined, undefined, ctx),
      /Option labels cannot conflict with the "Other" label\./,
    );
  });

  it("rejects label starting with 'Other ' at execute", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: false });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const qd = toolDefs.ask_user_question;
    assert.ok(qd);
    await assert.rejects(
      qd.execute("c1", { question: "Q?", options: [{ label: "Other (specify)" }, { label: "Option B" }] }, undefined, undefined, ctx),
      /Option labels cannot conflict with the "Other" label\./,
    );
  });

  it("rejects 'other' (case-insensitive) label at execute", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: false });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const qd = toolDefs.ask_user_question;
    assert.ok(qd);
    await assert.rejects(
      qd.execute("c1", { question: "Q?", options: [{ label: "other" }, { label: "Option B" }] }, undefined, undefined, ctx),
      /Option labels cannot conflict with the "Other" label\./,
    );
  });

  it("rejects recommended that does not match any option label", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: false });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const qd = toolDefs.ask_user_question;
    assert.ok(qd);
    await assert.rejects(
      qd.execute("c1", { question: "Q?", options: [{ label: "A" }, { label: "B" }], recommended: "C" }, undefined, undefined, ctx),
      /recommended must match one of the option labels\./,
    );
  });

  it("accepts recommended matching an option (case-insensitive, trimmed)", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const ctx = fakeCtx({ hasUI: false });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const qd = toolDefs.ask_user_question;
    assert.ok(qd);
    // valid recommended → no throw, falls through to the no-UI fallback path
    const res = await qd.execute("c1", { question: "Q?", options: [{ label: "A" }, { label: "B" }], recommended: "  b " }, undefined, undefined, ctx);
    assert.ok(res);
    assert.match(res.content?.[0]?.text ?? "", /UI is not available/);
  });

  it("works in normal (non-plan) mode without guardPlanMode rejection", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: false });
    const ctx = fakeCtx({ hasUI: false });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const qd = toolDefs.ask_user_question;
    assert.ok(qd);
    // Previously guardPlanMode threw in normal mode; now it must succeed (no-UI fallback).
    const res = await qd.execute("c1", { question: "Q?", options: [{ label: "A" }, { label: "B" }] }, undefined, undefined, ctx);
    assert.ok(res);
    assert.match(res.content?.[0]?.text ?? "", /UI is not available/);
  });

  it("deprecated ask_plan_question alias still resolves and warns", async () => {
    const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
    const notified: string[] = [];
    const ctx = fakeCtx({
      hasUI: true,
      mode: "tui",
      ui: {
        ...fakeCtx().ui,
        notify: (msg: string) => { notified.push(msg); },
        select: async () => "A",
      },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);

    const qd = toolDefs.ask_plan_question;
    assert.ok(qd, "deprecated alias should still be registered");
    const res = await qd.execute("c1", { question: "Q?", options: [{ label: "A" }, { label: "B" }] }, undefined, undefined, ctx);
    assert.ok(res);
    assert.ok(notified.some((m) => m.includes("deprecated")), "should warn about deprecation");
    assert.equal(res.details?.answer, "A");
  });
});

describe("ask_user_question interactive list flow", () => {
  // Uses the built-in ctx.ui.select dialog (same UX as the original ask_plan_question).
  // The recommended option is marked with ★; "Other / type my answer" opens a simple editor.

  async function runWithSelect(
    toolDefs: any,
    params: any,
    selectChoice: string | null,
    editorValue?: string,
  ): Promise<any> {
    const ctx = fakeCtx({
      hasUI: true,
      mode: "tui",
      ui: {
        ...fakeCtx().ui,
        select: async (_q: string, _o: string[]) => selectChoice,
        editor: async (_t: string, _d: string) => editorValue ?? "",
      },
    });
    return toolDefs.ask_user_question.execute("c1", params, undefined, undefined, ctx);
  }

  it("shows the built-in select with the recommended option ★-marked", async () => {
    const { toolDefs } = createFakePi(["read"], { plan: false });
    let shownQuestion = "";
    let shownOptions: string[] = [];
    const ctx = fakeCtx({
      hasUI: true,
      mode: "tui",
      ui: {
        ...fakeCtx().ui,
        select: async (q: string, opts: string[]) => { shownQuestion = q; shownOptions = opts; return null; },
      },
    });
    await toolDefs.ask_user_question.execute("c1", {
      question: "Q?",
      options: [{ label: "A", description: "desc A" }, { label: "B" }],
      recommended: "B",
    }, undefined, undefined, ctx);
    assert.equal(shownQuestion, "Q?");
    assert.deepEqual(shownOptions, ["A — desc A", "★ B", "Other / type my answer"], "recommended B marked with ★, Other appended");
  });

  it("selecting an option returns the answer with 0-based selectedIndex", async () => {
    const { toolDefs } = createFakePi(["read"], { plan: false });
    const res = await runWithSelect(toolDefs, {
      question: "Q?",
      options: [{ label: "A" }, { label: "B" }],
    }, "B");
    assert.equal(res.details?.answer, "B");
    assert.equal(res.details?.wasCustom, false);
    assert.equal(res.details?.selectedIndex, 1, "0-based index of B");
  });

  it("cancellation (select returns null) reports cancelled", async () => {
    const { toolDefs } = createFakePi(["read"], { plan: false });
    const res = await runWithSelect(toolDefs, {
      question: "Q?",
      options: [{ label: "A" }, { label: "B" }],
    }, null);
    assert.equal(res.details?.cancelled, true);
    assert.equal(res.details?.answer, null);
  });

  it("Other / type my answer opens the editor and returns the custom text", async () => {
    const { toolDefs } = createFakePi(["read"], { plan: false });
    const res = await runWithSelect(toolDefs, {
      question: "Q?",
      options: [{ label: "A" }, { label: "B" }],
    }, "Other / type my answer", "my custom answer");
    assert.equal(res.details?.answer, "my custom answer");
    assert.equal(res.details?.wasCustom, true);
  });

  it("blank custom answer from Other is treated as cancelled", async () => {
    const { toolDefs } = createFakePi(["read"], { plan: false });
    const res = await runWithSelect(toolDefs, {
      question: "Q?",
      options: [{ label: "A" }, { label: "B" }],
    }, "Other / type my answer", "   ");
    assert.equal(res.details?.cancelled, true);
    assert.equal(res.details?.answer, null);
  });

  it("allowOther=false omits the Other row from the list", async () => {
    const { toolDefs } = createFakePi(["read"], { plan: false });
    let shownOptions: string[] = [];
    const ctx = fakeCtx({
      hasUI: true,
      mode: "tui",
      ui: {
        ...fakeCtx().ui,
        select: async (_q: string, opts: string[]) => { shownOptions = opts; return null; },
      },
    });
    await toolDefs.ask_user_question.execute("c1", {
      question: "Q?",
      options: [{ label: "A" }, { label: "B" }],
      allowOther: false,
    }, undefined, undefined, ctx);
    assert.deepEqual(shownOptions, ["A", "B"], "no Other row when allowOther=false");
  });

  it("works in normal (non-plan) mode", async () => {
    const { toolDefs } = createFakePi(["read"], { plan: false });
    const res = await runWithSelect(toolDefs, {
      question: "Q?",
      options: [{ label: "A" }, { label: "B" }],
    }, "A");
    assert.equal(res.details?.answer, "A");
  });
});

describe("flow loop regression coverage", () => {
  it("stops when verification marker is absent", async () => {
    const state = createFakePi(["read"], { plan: false });
    const ctx = fakeCtx({
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: "pi-plan",
            data: {
              enabled: false,
              lastPlanPath: "/some/path.md",
              lastPlanTitle: "Some Plan",
              flow: {
                phase: "implement",
                reviewPass: 0,
                baseline: "abc",
                initialDirty: "none",
                initialDirtyPatch: "",
                initialUntrackedSnapshot: "[]",
              },
            },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Done with no marker." }],
            },
          },
        ],
      },
    });

    await state.handlers.session_tree?.[0]({}, ctx);
    const settled = state.handlers.agent_settled?.[0];
    assert.ok(settled);
    await settled({}, ctx);

    const lastEntry = state.entries[state.entries.length - 1];
    assert.equal(lastEntry?.data?.flow?.phase, "stopped", "phase becomes stopped");
  });

  it("completes when verification passes and review has no blocking findings", async () => {
    const state = createFakePi(["read"], { plan: false });
    let reviewEventEmitted = false;
    state.onEmit = (event, data) => {
      if (event === "pi-review:run") {
        reviewEventEmitted = true;
        assert.equal(data.timeout, 3 * 60 * 1000);
        assert.equal(typeof data.onProgress, "function");
        assert.equal(data.gitRange, "abc...HEAD");
        assert.equal(data.requireExactRange, true);
        const accepted = data.accept();
        assert.ok(accepted);
        data.respond({ id: data.id, ok: true, result: { summary: "clean", findings: [] } });
      }
    };

    const flowCwd = createGitRepo("pi-plan-flow-ok-");

    const planPath = path.join(flowCwd, "plan.md");
    writeFileSync(planPath, "# Plan");

    const ctx = fakeCtx({
      cwd: flowCwd,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: "pi-plan",
            data: {
              enabled: false,
              lastPlanPath: planPath,
              lastPlanTitle: "Some Plan",
              flow: {
                phase: "implement",
                reviewPass: 0,
                baseline: "abc",
                initialDirty: "none",
                initialDirtyPatch: "",
                initialUntrackedSnapshot: "[]",
              },
            },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "We verified everything. [verification: pass]" }],
            },
          },
        ],
      },
    });

    await state.handlers.session_tree?.[0]({}, ctx);
    const settled = state.handlers.agent_settled?.[0];
    assert.ok(settled);
    await settled({}, ctx);

    assert.ok(reviewEventEmitted, "review event was emitted");
    const lastEntry = state.entries[state.entries.length - 1];
    assert.equal(lastEntry?.data?.flow?.phase, "done", "phase becomes done");
    assert.equal(state.customMessages.length, 1);
    assert.equal(state.customMessages[0].message?.customType, "pi-flow-result");
  });

  it("preserves non-blocking findings across a blocking fix pass", async () => {
    const finding = {
      severity: "low",
      file: "index.ts",
      line: 10,
      issue: "test issue",
      evidence: "xxx",
      expectedBehavior: "the issue is gone",
      suggestedFix: "fix it",
      acceptanceCriteria: "the regression check passes",
      blocking: false,
    };
    const blocker = { ...finding, severity: "high", issue: "blocking issue", blocking: true };
    const state = createFakePi(["read"], { plan: false });
    let reviewPass = 0;
    state.onEmit = (event, data) => {
      if (event === "pi-review:run") {
        assert.ok(data.accept());
        data.respond({ id: data.id, ok: true, result: { summary: "reviewed", findings: reviewPass++ === 0 ? [finding, blocker] : [] } });
      }
    };

    const flowCwd = createGitRepo("pi-plan-flow-mixed-");
    const planPath = path.join(flowCwd, "plan.md");
    writeFileSync(planPath, "# Plan");
    const ctx = fakeCtx({
      cwd: flowCwd,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: "pi-plan",
            data: {
              enabled: false,
              lastPlanPath: planPath,
              lastPlanTitle: "Some Plan",
              flow: {
                phase: "implement",
                reviewPass: 0,
                baseline: "abc",
                initialDirty: "none",
                initialDirtyPatch: "",
                initialUntrackedSnapshot: "[]",
              },
            },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Checks run. [verification: pass]" }],
            },
          },
        ],
      },
    });

    await state.handlers.session_tree?.[0]({}, ctx);
    const settled = state.handlers.agent_settled?.[0];
    assert.ok(settled);
    await settled({}, ctx);
    let lastEntry = state.entries[state.entries.length - 1];
    assert.equal(lastEntry?.data?.flow?.phase, "fix");
    assert.match(state.sentMessages[0].content, /blocking issue/);
    assert.doesNotMatch(state.sentMessages[0].content, /"issue": "test issue"/);

    await settled({}, ctx);
    lastEntry = state.entries[state.entries.length - 1];
    assert.equal(lastEntry?.data?.flow?.phase, "done");
    assert.deepEqual(lastEntry?.data?.flow?.reviewFindings, [finding]);
    assert.match(state.customMessages[0].message?.content, /1 non-blocking review finding/);
    assert.doesNotMatch(state.customMessages[0].message?.content, /review clean/);
  });

  it("sends valid blocking findings then fails closed on malformed review output", async () => {
    const state = createFakePi(["read"], { plan: false });
    let reviewEventEmitted = false;
    let reviewPass = 0;
    state.onEmit = (event, data) => {
      if (event === "pi-review:run") {
        reviewEventEmitted = true;
        const accepted = data.accept();
        assert.ok(accepted);
        if (reviewPass++ > 0) return data.respond({ id: data.id, ok: true, result: { findings: [] } });
        data.respond({
          id: data.id,
          ok: true,
          result: {
            summary: "blocking issue",
            findings: [
              {
                severity: "high",
                file: "index.ts",
                line: 10,
                issue: "test issue",
                evidence: "xxx",
                expectedBehavior: "the issue is gone",
                suggestedFix: "fix it",
                acceptanceCriteria: "the regression check passes",
                blocking: true,
              },
            ],
          },
        });
      }
    };

    const flowCwd = createGitRepo("pi-plan-flow-fail-");

    const planPath = path.join(flowCwd, "plan.md");
    writeFileSync(planPath, "# Plan");

    const ctx = fakeCtx({
      cwd: flowCwd,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: "pi-plan",
            data: {
              enabled: false,
              lastPlanPath: planPath,
              lastPlanTitle: "Some Plan",
              flow: {
                phase: "implement",
                reviewPass: 0,
                baseline: "abc",
                initialDirty: "none",
                initialDirtyPatch: "",
                initialUntrackedSnapshot: "[]",
              },
            },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Checks run. [verification: pass]" }],
            },
          },
        ],
      },
    });

    await state.handlers.session_tree?.[0]({}, ctx);
    const settled = state.handlers.agent_settled?.[0];
    assert.ok(settled);
    await settled({}, ctx);

    assert.ok(reviewEventEmitted, "review event was emitted");
    const lastEntry = state.entries[state.entries.length - 1];
    assert.equal(lastEntry?.data?.flow?.phase, "fix", "phase transitions to fix");
    assert.equal(state.sentMessages.length, 1);
    assert.ok(state.sentMessages[0].content?.includes("Independent review found blocking issues"), "sent fix prompt to user");
    assert.ok(state.sentMessages[0].content?.includes('"expectedBehavior": "the issue is gone"'), "preserves expected behavior");
    assert.ok(state.sentMessages[0].content?.includes('"acceptanceCriteria": "the regression check passes"'), "preserves acceptance criteria");

    await settled({}, ctx);
    const stoppedEntry = state.entries[state.entries.length - 1];
    assert.equal(stoppedEntry?.data?.flow?.phase, "stopped");
    assert.equal(state.customMessages.length, 0, "malformed review never reports clean completion");
  });
});

describe("slash-argument completions", () => {
  it("/plan-fallback set preserves the typed head in completion values", async () => {
    const { commands, handlers } = createFakePi([]);
    const ctx = fakeCtx({
      modelRegistry: {
        getAvailable: () => [
          { provider: "prov", id: "m1", contextWindow: 8_000 },
          { provider: "prov", id: "m2", contextWindow: 8_000 },
        ],
        find: () => undefined,
      },
    });
    await handlers.session_start?.[0]({ reason: "startup" }, ctx);
    const cmd = commands["plan-fallback"];
    const first = cmd.getArgumentCompletions("set");
    assert.deepEqual(first.map((i: any) => i.value), ["set", "clear"].filter((v) => v.startsWith("set")));
    const items = cmd.getArgumentCompletions("set ") as Array<{ value: string; label: string }>;
    assert.ok(items.length >= 2);
    for (const item of items) {
      assert.ok(item.value.startsWith("set "), `head preserved: ${item.value}`);
    }
    assert.ok(items.some((i) => i.value === "set prov/m1"));
    const narrowed = cmd.getArgumentCompletions("set prov/m1 ") as Array<{ value: string }>;
    assert.ok(narrowed.every((i) => i.value.startsWith("set prov/m1 ")), "second-chain refs keep first ref in head");
  });

  it("/plan-approve and /goal offer their keyword vocabularies", () => {
    const { commands } = createFakePi([]);
    const approve = commands["plan-approve"].getArgumentCompletions("") as Array<{ value: string }>;
    assert.deepEqual(approve.map((i) => i.value), ["current", "new", "flow"]);
    const goal = commands["goal"].getArgumentCompletions("") as Array<{ value: string }>;
    assert.deepEqual(goal.map((i) => i.value), ["status", "pause", "resume", "clear"]);
    assert.equal(commands["goal"].getArgumentCompletions("fix the bug"), null, "free-text objective → no popup");
  });

  it("/plan-model and /plan-thinking offer their value vocabularies", () => {
    const { commands } = createFakePi([]);
    const model = commands["plan-model"].getArgumentCompletions("") as Array<{ value: string }>;
    assert.deepEqual(model.map((i) => i.value), ["clear"], "no -g anymore; models resolve inline");
    assert.equal(commands["plan-model"].getArgumentCompletions("opencode"), null, "no registry primed -> no model popup");
    const thinking = commands["plan-thinking"].getArgumentCompletions("x") as Array<{ value: string }>;
    assert.deepEqual(thinking.map((i) => i.value), ["xhigh"]);
    const thinkingAll = commands["plan-thinking"].getArgumentCompletions("") as Array<{ value: string }>;
    assert.ok(thinkingAll.some((i) => i.value === "clear") && !thinkingAll.some((i) => i.value === "-g"));
  });
});
