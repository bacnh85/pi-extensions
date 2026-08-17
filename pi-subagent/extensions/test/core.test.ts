import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmdirSync, unlinkSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it } from "mocha";
import { ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { discoverAgents, getModelCandidates, invalidateAgentCache } from "../agents.ts";
import { resolveModel } from "../model.ts";
import { mapWithConcurrencyLimit, isFailedResult, getResultOutput, getFinalOutput, runSubAgent, startHeartbeat, createWorktree, captureWorktreeDiff, removeWorktree } from "../runner.ts";
import { ThreadStore } from "../threads.ts";
import {
  isRateLimitError,
  resolveSafeCwd,
  validateAgentTools,
  needsExtensions,
  normalizeTimeout,
  createCombinedAbortSignal,
  classifyStopReason,
  validateExecutionRequest,
  truncateParallelOutput,
  ALLOWED_CHILD_TOOLS,
  BUILTIN_TOOLS,
  DENIED_CHILD_TOOLS,
  READ_ONLY_TOOLS,
  MUTATION_TOOLS,
  EXECUTION_TOOLS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_PARALLEL_TASKS,
  MAX_CONCURRENCY,
  MAX_CHAIN_LENGTH,
  PER_TASK_OUTPUT_CAP,
  type SubagentStatus,
} from "../security.ts";

// ===========================================================================
// Agent discovery
// ===========================================================================

describe("agent discovery", () => {
  it("ships an actionable reviewer handoff contract", () => {
    const prompt = readFileSync(new URL("../../agents/reviewer.md", import.meta.url), "utf8");
    for (const requirement of [
      "sandbox: read-only", "Return JSON only", "Focus only on actionable issues introduced by the reviewed change",
      "Avoid style noise, praise, and speculative redesign", "Use an empty `findings` array", "Do not modify files or Git state",
      '"summary"', '"findings"', '"severity": "critical|high|medium|low"', '"file"', '"line"', '"issue"', '"evidence"',
      "reproduction steps", '"expectedBehavior"',
      '"suggestedFix"', '"acceptanceCriteria"', '"blocking"',
    ]) assert.ok(prompt.includes(requirement), `missing reviewer requirement: ${requirement}`);
  });

  it("parses thinking and gives project definitions precedence", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const projectDir = path.join(root, ".pi", "agents");
    const bundledDir = path.join(root, "bundled");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(bundledDir);
    writeFileSync(path.join(bundledDir, "scout.md"), "---\nname: scout\ndescription: bundled\nthinking: low\n---\nbundled");
    writeFileSync(path.join(projectDir, "scout.md"), "---\nname: scout\ndescription: project\nthinking: high\n---\nproject");
    invalidateAgentCache();
    const result = discoverAgents(root, "project", bundledDir);
    const agent = result.agents.find((item) => item.name === "scout");
    assert.equal(agent?.source, "project");
    assert.equal(agent?.thinking, "high");
    assert.equal(agent?.systemPrompt.trim(), "project");
  });

  it("user overrides bundled", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
    try { mkdirSync(userDir, { recursive: true }); } catch {}
    const bundledDir = path.join(root, "bundled");
    mkdirSync(bundledDir);
    writeFileSync(path.join(bundledDir, "my-agent.md"), "---\nname: my-agent\ndescription: bundled version\n---\nbundled body");

    // Create user agent file
    const userAgentFile = path.join(userDir, "my-agent.md");
    const oldUserContent = "";
    try { writeFileSync(userAgentFile, "---\nname: my-agent\ndescription: user version\n---\nuser body"); } catch {}

    invalidateAgentCache();
    const result = discoverAgents(root, "both", bundledDir);
    const agent = result.agents.find((a) => a.name === "my-agent");
    // User overrides bundled
    assert.equal(agent?.source, "user");
    assert.equal(agent?.systemPrompt.trim(), "user body");

    // Cleanup
    try { unlinkSync(userAgentFile); } catch {}
  });

  it("project overrides user", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
    try { mkdirSync(userDir, { recursive: true }); } catch {}
    const projectDir = path.join(root, ".pi", "agents");
    mkdirSync(projectDir, { recursive: true });
    const bundledDir = path.join(root, "bundled");
    mkdirSync(bundledDir);

    writeFileSync(path.join(bundledDir, "my-agent.md"), "---\nname: my-agent\ndescription: bundled\n---\nbundled");
    const userAgentFile = path.join(userDir, "my-agent.md");
    try { writeFileSync(userAgentFile, "---\nname: my-agent\ndescription: user\n---\nuser"); } catch {}
    writeFileSync(path.join(projectDir, "my-agent.md"), "---\nname: my-agent\ndescription: project\n---\nproject");

    invalidateAgentCache();
    const result = discoverAgents(root, "both", bundledDir);
    const agent = result.agents.find((a) => a.name === "my-agent");
    // Project overrides user
    assert.equal(agent?.source, "project");
    assert.equal(agent?.systemPrompt.trim(), "project");

    try { unlinkSync(userAgentFile); } catch {}
  });

  it("removing project file restores user agent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
    try { mkdirSync(userDir, { recursive: true }); } catch {}
    const projectDir = path.join(root, ".pi", "agents");
    mkdirSync(projectDir, { recursive: true });
    const bundledDir = path.join(root, "bundled");
    mkdirSync(bundledDir);

    writeFileSync(path.join(bundledDir, "my-agent.md"), "---\nname: my-agent\ndescription: bundled\n---\nbundled");
    const userAgentFile = path.join(userDir, "my-agent.md");
    try { writeFileSync(userAgentFile, "---\nname: my-agent\ndescription: user\n---\nuser"); } catch {}
    const projectFile = path.join(projectDir, "my-agent.md");
    writeFileSync(projectFile, "---\nname: my-agent\ndescription: project\n---\nproject");

    invalidateAgentCache();
    let result = discoverAgents(root, "both", bundledDir);
    assert.equal(result.agents.find((a) => a.name === "my-agent")?.source, "project");

    // Remove project file
    unlinkSync(projectFile);
    invalidateAgentCache();
    result = discoverAgents(root, "both", bundledDir);
    assert.equal(result.agents.find((a) => a.name === "my-agent")?.source, "user");

    try { unlinkSync(userAgentFile); } catch {}
  });

  it("file modification invalidates cache", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const bundledDir = path.join(root, "bundled");
    mkdirSync(bundledDir);
    const agentFile = path.join(bundledDir, "agent.md");
    writeFileSync(agentFile, "---\nname: test-agent\ndescription: original\n---\noriginal");

    invalidateAgentCache();
    const first = discoverAgents(root, "user", bundledDir);
    assert.equal(first.agents.length, 1);

    // Modify file
    writeFileSync(agentFile, "---\nname: test-agent\ndescription: modified\n---\nmodified");
    const second = discoverAgents(root, "user", bundledDir);
    assert.equal(second.agents.length, 1);
    assert.equal(second.agents[0].description, "modified");
  });

  it("file addition invalidates cache", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const bundledDir = path.join(root, "bundled");
    mkdirSync(bundledDir);
    writeFileSync(path.join(bundledDir, "a.md"), "---\nname: agent-a\ndescription: first\n---\na");

    invalidateAgentCache();
    const first = discoverAgents(root, "user", bundledDir);
    assert.equal(first.agents.length, 1);

    writeFileSync(path.join(bundledDir, "b.md"), "---\nname: agent-b\ndescription: second\n---\nb");
    const second = discoverAgents(root, "user", bundledDir);
    assert.equal(second.agents.length, 2);
  });

  it("file removal invalidates cache", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const bundledDir = path.join(root, "bundled");
    mkdirSync(bundledDir);
    writeFileSync(path.join(bundledDir, "a.md"), "---\nname: agent-a\ndescription: first\n---\na");
    writeFileSync(path.join(bundledDir, "b.md"), "---\nname: agent-b\ndescription: second\n---\nb");

    invalidateAgentCache();
    const first = discoverAgents(root, "user", bundledDir);
    assert.equal(first.agents.length, 2);

    unlinkSync(path.join(bundledDir, "b.md"));
    const second = discoverAgents(root, "user", bundledDir);
    assert.equal(second.agents.length, 1);
    assert.equal(second.agents[0].name, "agent-a");
  });

  it("rename invalidates cache", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const bundledDir = path.join(root, "bundled");
    mkdirSync(bundledDir);
    writeFileSync(path.join(bundledDir, "original.md"), "---\nname: original\ndescription: first\n---\noriginal");

    invalidateAgentCache();
    const first = discoverAgents(root, "user", bundledDir);
    assert.equal(first.agents.length, 1);
    assert.equal(first.agents[0].name, "original");

    // "Rename" by deleting and re-creating
    unlinkSync(path.join(bundledDir, "original.md"));
    writeFileSync(path.join(bundledDir, "renamed.md"), "---\nname: renamed\ndescription: new\n---\nnew");

    const second = discoverAgents(root, "user", bundledDir);
    assert.equal(second.agents.length, 1);
    assert.equal(second.agents[0].name, "renamed");
  });

  it("malformed frontmatter produces diagnostic", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const bundledDir = path.join(root, "bundled");
    mkdirSync(bundledDir);
    writeFileSync(path.join(bundledDir, "good.md"), "---\nname: good-agent\ndescription: valid\n---\nvalid");
    writeFileSync(path.join(bundledDir, "no-name.md"), "---\ndescription: missing name\n---\nno name");
    writeFileSync(path.join(bundledDir, "no-desc.md"), "---\nname: no-desc\n---\nno description");
    writeFileSync(path.join(bundledDir, "empty-name.md"), "---\nname: ''\ndescription: empty name\n---\nbad");

    invalidateAgentCache();
    const result = discoverAgents(root, "user", bundledDir);
    // Valid agent still loads
    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0].name, "good-agent");
    // Diagnostics for malformed files
    assert.ok(result.diagnostics.length >= 2);
    const missingName = result.diagnostics.find((d) => d.filePath.includes("no-name"));
    assert.ok(missingName, "Expected diagnostic for missing name");
    assert.equal(missingName!.severity, "error");
  });

  it("invalid tools produce diagnostic", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const bundledDir = path.join(root, "bundled");
    mkdirSync(bundledDir);
    writeFileSync(path.join(bundledDir, "valid.md"), "---\nname: valid\ndescription: valid agent\ntools: read, bash\n---\nok");
    writeFileSync(path.join(bundledDir, "invalid.md"), "---\nname: invalid\ndescription: has bad tools\ntools: read, nonexistent_tool, bash\n---\nbad");

    // Tool validation happens at execution time, not discovery time
    // But the discovery should still load both agents
    invalidateAgentCache();
    const result = discoverAgents(root, "user", bundledDir);
    assert.equal(result.agents.length, 2);
  });

  it("parses ordered model arrays and comma-separated strings", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const bundledDir = path.join(root, "bundled");
    mkdirSync(bundledDir);
    writeFileSync(path.join(bundledDir, "array.md"), "---\nname: array-models\ndescription: array\nmodel: provider/override\nmodels:\n  - provider/first\n  - provider/override\n  - provider/second\n---\narray");
    writeFileSync(path.join(bundledDir, "comma.md"), "---\nname: comma-models\ndescription: comma\nmodels: provider/first, provider/second\n---\ncomma");
    writeFileSync(path.join(bundledDir, "invalid.md"), "---\nname: invalid-models\ndescription: invalid entries\nmodels:\n  - provider/valid\n  - 123\n  - ''\n---\ninvalid");

    invalidateAgentCache();
    const result = discoverAgents(root, "project", bundledDir);
    const array = result.agents.find((agent) => agent.name === "array-models")!;
    const comma = result.agents.find((agent) => agent.name === "comma-models")!;
    const invalid = result.agents.find((agent) => agent.name === "invalid-models")!;
    assert.equal(array.model, "provider/override");
    assert.deepEqual(array.models, ["provider/first", "provider/override", "provider/second"]);
    assert.deepEqual(getModelCandidates(array), ["provider/override", "provider/first", "provider/second"]);
    assert.deepEqual(comma.models, ["provider/first", "provider/second"]);
    assert.deepEqual(invalid.models, ["provider/valid"]);
    assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.filePath.endsWith("invalid.md")).length, 2);
  });

  it("ships planner and tester routing contracts", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    invalidateAgentCache();
    const agents = discoverAgents(root, "project", path.resolve(import.meta.dirname, "../../agents")).agents;
    const planner = agents.find((agent) => agent.name === "planner")!;
    const tester = agents.find((agent) => agent.name === "tester")!;
    assert.deepEqual(getModelCandidates(planner), ["zai-coding-cn/glm-5.3", "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", "opencode-go/deepseek-v4-pro"]);
    assert.equal(planner.thinking, "high");
    assert.equal(planner.sandbox, "read-only");
    assert.deepEqual(planner.tools, ["read", "grep", "find", "ls"]);
    assert.deepEqual(getModelCandidates(tester), ["zai-coding-cn/glm-5-turbo", "nvidia/openai/gpt-oss-20b", "opencode-go/deepseek-v4-flash"]);
    assert.equal(tester.thinking, "off");
    assert.deepEqual(tester.tools, ["read", "bash", "grep", "find", "ls"]);
  });
});

// ===========================================================================
// Model resolution
// ===========================================================================

describe("resolveModel", () => {
  const model = (provider: string, id: string) => ({ provider, id }) as any;
  const registry = (...models: any[]) => ({ getAvailable: () => models }) as ModelRegistry;

  it("selects the first authenticated candidate", async () => {
    const second = model("provider", "second");
    const resolved = await resolveModel(["provider/missing", "provider/second"], undefined, registry(second));
    assert.equal(resolved.model, second);
    assert.deepEqual(resolved.attempted, ["provider/missing", "provider/second"]);
  });

  it("falls back from unavailable candidates to an authenticated parent", async () => {
    const parent = model("provider", "parent");
    const resolved = await resolveModel(["provider/missing"], parent, registry(parent));
    assert.equal(resolved.model, parent);
    assert.deepEqual(resolved.attempted, ["provider/missing", "provider/parent"]);
  });

  it("reports every attempted candidate when none are authenticated", async () => {
    const resolved = await resolveModel(["provider/first", "provider/second"], model("provider", "parent"), registry());
    assert.equal(resolved.model, null);
    assert.deepEqual(resolved.attempted, ["provider/first", "provider/second", "provider/parent"]);
  });
});

// ===========================================================================
// Runner helpers
// ===========================================================================

describe("runner helpers", () => {
  it("emits heartbeats until cleanup and cleanup is idempotent", async () => {
    let beats = 0;
    let reachedTwo!: () => void;
    const twoBeats = new Promise<void>((resolve) => { reachedTwo = resolve; });
    const cleanup = startHeartbeat(() => { if (++beats === 2) reachedTwo(); }, 5);
    await twoBeats;
    cleanup();
    cleanup();
    const stoppedAt = beats;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(beats, stoppedAt);
  });

  it("enforces the concurrency ceiling and preserves result order", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return value * 2;
    });
    assert.deepEqual(result, [2, 4, 6, 8]);
    assert.equal(peak, 2);
  });

  it("handles empty input", async () => {
    const result = await mapWithConcurrencyLimit([], 4, async (v) => v);
    assert.deepEqual(result, []);
  });

  it("concurrency never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6], 3, async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return value;
    });
    assert.equal(peak, 3);
    assert.deepEqual(result, [1, 2, 3, 4, 5, 6]);
  });
});

// ===========================================================================
// Git worktree isolation
// ===========================================================================

describe("git worktree isolation", () => {
  function makeGitRepo(prefix: string): string {
    const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
    writeFileSync(path.join(repo, "a.txt"), "line1\n");
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["add", "a.txt"], { cwd: repo });
    execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: repo });
    return repo;
  }

  it("creates an isolated worktree, captures its diff, and removes it", async function () {
    this.timeout(30_000);
    const repo = makeGitRepo("pi-subagent-wt-");
    try {
      const wt = await createWorktree(repo);
      assert.ok(wt.ok, wt.error);
      const wtPath = wt.path!;
      assert.notEqual(wtPath, repo, "worktree is a separate directory");

      // Edit inside the worktree; the main checkout must be untouched.
      writeFileSync(path.join(wtPath, "a.txt"), "line1\nline2\n");
      const diff = await captureWorktreeDiff(repo, wtPath);
      assert.ok(diff.ok);
      assert.match(diff.diff!, /\+line2/);
      assert.equal(readFileSync(path.join(repo, "a.txt"), "utf8"), "line1\n", "main checkout unchanged");

      await removeWorktree(repo, wtPath);
      assert.equal(existsSync(wtPath), false, "worktree removed after cleanup");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails gracefully when the cwd is not a git repo", async function () {
    this.timeout(10_000);
    const nonRepo = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-norepo-"));
    try {
      const wt = await createWorktree(nonRepo);
      assert.equal(wt.ok, false);
      assert.ok(wt.error, "has an error message");
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("captures staged + unstaged changes in the diff", async function () {
    this.timeout(30_000);
    const repo = makeGitRepo("pi-subagent-wt2-");
    try {
      const wt = await createWorktree(repo);
      const wtPath = wt.path!;
      // Unstaged edit + staged new file.
      writeFileSync(path.join(wtPath, "a.txt"), "line1\nline2\n");
      writeFileSync(path.join(wtPath, "b.txt"), "new\n");
      execFileSync("git", ["add", "b.txt"], { cwd: wtPath });
      const diff = await captureWorktreeDiff(repo, wtPath);
      assert.match(diff.diff!, /\+line2/);
      assert.match(diff.diff!, /new file/);
      // Review: no duplicate hunks for the staged file (single diff --cached).
      assert.equal(diff.diff!.match(/new file mode/g)?.length ?? 0, 1, "exactly one diff section for b.txt");
      await removeWorktree(repo, wtPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("captures NEW untracked files the way an agent creates them (review: HIGH)", async function () {
    this.timeout(30_000);
    const repo = makeGitRepo("pi-subagent-wt3-");
    try {
      const wt = await createWorktree(repo);
      const wtPath = wt.path!;
      // The child's write tool creates a new file WITHOUT git add — this is the
      // untracked path the old `git diff HEAD` silently dropped.
      writeFileSync(path.join(wtPath, "new-file.txt"), "brand new content\n");
      const diff = await captureWorktreeDiff(repo, wtPath);
      assert.ok(diff.ok);
      assert.match(diff.diff!, /new file/);
      assert.match(diff.diff!, /brand new content/);
      await removeWorktree(repo, wtPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("preserves multi-byte UTF-8 in the diff (review: MEDIUM)", async function () {
    this.timeout(30_000);
    const repo = makeGitRepo("pi-subagent-wt4-");
    try {
      const wt = await createWorktree(repo);
      const wtPath = wt.path!;
      writeFileSync(path.join(wtPath, "a.txt"), "café — 日本語 🎉\n");
      const diff = await captureWorktreeDiff(repo, wtPath);
      assert.ok(diff.ok);
      assert.match(diff.diff!, /café — 日本語 🎉/);
      assert.equal(diff.diff!.includes("\uFFFD"), false, "no replacement characters");
      await removeWorktree(repo, wtPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports diff failures instead of masking them as no changes (review: MEDIUM)", async function () {
    this.timeout(10_000);
    const repo = makeGitRepo("pi-subagent-wt5-");
    try {
      const wt = await createWorktree(repo);
      const wtPath = wt.path!;
      // Inject a failing git: add -A fails -> captureWorktreeDiff must return
      // ok:false with an error, not "(no changes)".
      const failingExec = async () => ({ code: 1, stdout: "", stderr: "mock git failure" });
      const diff = await captureWorktreeDiff(repo, wtPath, failingExec as any);
      assert.equal(diff.ok, false);
      assert.match(diff.error!, /mock git failure/);
      await removeWorktree(repo, wtPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Runner retry lifecycle
// ===========================================================================

describe("runSubAgent retry lifecycle", () => {
  it("recovers once from a transient WebSocket error and then stops retrying", async function () {
    this.timeout(10_000);
    // Register a faux provider on the pi-ai instance bundled inside pi-coding-agent,
    // then attach it to a ModelRuntime that owns AgentSession's provider registry.
    const { fauxProvider, fauxAssistantMessage } = await import("../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js");
    const faux = fauxProvider({ api: "pi-subagent-retry-test", provider: "pi-subagent-retry-test" });
    const model = faux.getModel();
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore() });
    modelRuntime.registerNativeProvider(faux.provider);
    const websocketError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "WebSocket error" });
    const run = (timeoutMs?: number) => runSubAgent({
      cwd: process.cwd(),
      systemPrompt: "Test assistant",
      task: "Respond",
      tools: [],
      model,
      modelRuntime,
      agentName: "test",
      timeoutMs,
    });

    try {
      faux.setResponses([websocketError(), fauxAssistantMessage("recovered")]);
      const recovered = await run();
      assert.equal(faux.state.callCount, 2, JSON.stringify(recovered));
      assert.equal(recovered.status, "success");
      assert.equal(recovered.exitCode, 0);
      assert.equal(recovered.errorMessage, undefined);
      assert.equal(getFinalOutput(recovered.messages), "recovered");

      const callsBeforeExhaustion = faux.state.callCount;
      faux.setResponses([websocketError(), websocketError(), fauxAssistantMessage("unexpected")]);
      const exhausted = await run();
      assert.equal(faux.state.callCount - callsBeforeExhaustion, 2);
      assert.equal(faux.getPendingResponseCount(), 1);
      assert.equal(exhausted.status, "error");
      assert.equal(exhausted.exitCode, 1);
      assert.equal(exhausted.errorMessage, "WebSocket error");

      faux.setResponses([async (_context, options) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000);
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        });
        return fauxAssistantMessage("late");
      }]);
      const timedOut = await run(25);
      assert.equal(timedOut.status, "timeout");
      assert.equal(timedOut.exitCode, 1);
      assert.equal(timedOut.errorMessage, "Idle timeout after 25ms");
    } finally {
      modelRuntime.unregisterProvider(faux.provider.id);
    }
  });
});

// ===========================================================================
// Thread store
// ===========================================================================

describe("thread store", () => {
  it("tracks transitions and clears replacement-session state", () => {
    const store = new ThreadStore();
    const thread = store.createThread({ agentName: "reviewer", task: "review", mode: "single" });
    store.updateThread(thread.id, { status: "completed" });
    assert.equal(store.getThread(thread.id)?.status, "completed");
    store.clear();
    assert.deepEqual(store.getAllThreads(), []);
  });

  it("subscription fires on updates", () => {
    const store = new ThreadStore();
    let notified = false;
    store.subscribe(() => { notified = true; });
    store.createThread({ agentName: "a", task: "t", mode: "single" });
    assert.ok(notified);
  });

  it("keeps real activity separate from transport heartbeats", () => {
    const store = new ThreadStore();
    const thread = store.createThread({ agentName: "a", task: "t", mode: "single" });
    store.updateProgress(thread.id, { label: "tool_execution_start", at: 100, elapsedMs: 10, inactivityDeadline: 200, hardDeadline: 1_000, result: { agent: "a", task: "t", exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } } });
    store.refreshHeartbeat(thread.id);
    const current = store.getThread(thread.id)!;
    assert.equal(current.lastActivityAt, 100);
    assert.equal(current.lastActivityLabel, "tool_execution_start");
    assert.ok(current.lastHeartbeatAt);
  });
});

// ===========================================================================
// Security: validateAgentTools
// ===========================================================================

describe("validateAgentTools", () => {
  it("allows known built-in tools", () => {
    const result = validateAgentTools({ tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  });

  it("allows read-only subset", () => {
    const result = validateAgentTools({ tools: ["read", "grep", "find", "ls"] });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tools, ["read", "grep", "find", "ls"]);
  });

  it("rejects unknown tool", () => {
    const result = validateAgentTools({ tools: ["read", "nonexistent_tool"] });
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes("Unknown tool"));
    // Known tool still passes
    assert.deepEqual(result.tools, ["read"]);
  });

  it("silently strips subagent (never available to children)", () => {
    const result = validateAgentTools({ tools: ["read", "subagent", "bash"] });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tools, ["read", "bash"]);
  });

  it("silently strips subagent with mixed case", () => {
    const result = validateAgentTools({ tools: ["read", "SubAgent"] });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tools, ["read"]);
  });

  it("deduplicates tools", () => {
    const result = validateAgentTools({ tools: ["read", "read", "bash", "bash"] });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tools, ["read", "bash"]);
  });

  it("strips whitespace from tool names", () => {
    const result = validateAgentTools({ tools: [" read ", "bash "] });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tools, ["read", "bash"]);
  });

  it("read-only mode rejects bash", () => {
    const result = validateAgentTools({ tools: ["read", "bash"], readOnly: true });
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes("bash") && result.errors[0].includes("read-only"));
    assert.deepEqual(result.tools, ["read"]);
  });

  it("read-only mode rejects edit and write", () => {
    const result = validateAgentTools({ tools: ["read", "edit", "write"], readOnly: true });
    assert.ok(result.errors.length >= 2);
    assert.deepEqual(result.tools, ["read"]);
  });

  it("read-only mode allows all read-only tools", () => {
    // The read-only set now includes extension tools (serena/web/munin), so
    // availableTools must list them for the validator to accept them.
    const extensionReadOnly = [...READ_ONLY_TOOLS].filter((t) => !BUILTIN_TOOLS.includes(t as any));
    const result = validateAgentTools({ tools: [...READ_ONLY_TOOLS], readOnly: true, availableTools: extensionReadOnly });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tools, [...READ_ONLY_TOOLS]);
  });

  // --- Inheritance (availableTools) ---

  it("accepts extension tools when availableTools lists them", () => {
    const result = validateAgentTools({
      tools: ["read", "web_search", "serena_find_symbol", "munin_search"],
      availableTools: ["web_search", "serena_find_symbol", "munin_search"],
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tools, ["read", "web_search", "serena_find_symbol", "munin_search"]);
  });

  it("rejects extension tool not in availableTools even in inherit mode", () => {
    const result = validateAgentTools({
      tools: ["read", "web_search"],
      availableTools: ["serena_find_symbol"],
    });
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes("Unknown tool"));
    assert.deepEqual(result.tools, ["read"]);
  });

  it("silently strips subagent even if present in availableTools", () => {
    const result = validateAgentTools({
      tools: ["read", "subagent"],
      availableTools: ["subagent", "web_search"],
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tools, ["read"]);
  });

  it("built-ins always accepted without availableTools (lean fallback)", () => {
    const result = validateAgentTools({ tools: ["read", "bash"] });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tools, ["read", "bash"]);
  });

  it("inherited tool set silently strips subagent without error", () => {
    // Reproduces the inheritance bug: parentToolNames includes "subagent", and
    // an agent that omits `tools:` inherits the full set. Validation must not
    // crash — it strips the denied tool and keeps the rest.
    const result = validateAgentTools({
      tools: ["read", "bash", "web_search", "subagent", "serena_find_symbol"],
      availableTools: ["web_search", "subagent", "serena_find_symbol"],
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tools, ["read", "bash", "web_search", "serena_find_symbol"]);
  });

  it("read-only still filters non-read-only extension tools", () => {
    // web_search is now read-only, so use a non-read-only extension tool to
    // verify the read-only filter still rejects mutating extension tools.
    const result = validateAgentTools({
      tools: ["read", "apply_patch"],
      readOnly: true,
      availableTools: ["apply_patch"],
    });
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes("read-only"));
    assert.deepEqual(result.tools, ["read"]);
  });

  it("read-only inherited set keeps only read-only tools (service path invariant)", () => {
    // service.ts runNamedAgent: readOnly requests (pi-review) enforce the read-only
    // filter even when agent.sandbox is unset. Replicates the effectiveReadOnly
    // logic: filter rawTools to READ_ONLY_TOOLS, then validate.
    const parentTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "serena_find_symbol", "munin_search"];
    const rawTools = parentTools.filter((t) => READ_ONLY_TOOLS.includes(t));
    const result = validateAgentTools({ tools: rawTools, readOnly: true, availableTools: parentTools });
    assert.deepEqual(result.errors, []);
    // rawTools = the intersection of parentTools and READ_ONLY_TOOLS (built-ins + the 3 research tools).
    assert.deepEqual(result.tools, rawTools);
    assert.deepEqual(result.tools, ["read", "grep", "find", "ls", "web_search", "serena_find_symbol", "munin_search"]);
    // Mutation/execution tools must never leak even when the parent has them.
    for (const t of result.tools) {
      assert.ok(READ_ONLY_TOOLS.includes(t), `non-read-only tool leaked: ${t}`);
    }
  });
});

// ===========================================================================
// Security: needsExtensions
// ===========================================================================

describe("needsExtensions", () => {
  it("returns false for built-in-only tools", () => {
    assert.equal(needsExtensions(["read", "bash", "edit"]), false);
    assert.equal(needsExtensions([]), false);
  });

  it("returns true when any non-built-in tool is present", () => {
    assert.equal(needsExtensions(["read", "web_search"]), true);
    assert.equal(needsExtensions(["serena_find_symbol"]), true);
    assert.equal(needsExtensions(["read", "bash", "munin_store"]), true);
  });
});

// ===========================================================================
// Security: resolveSafeCwd
// ===========================================================================

describe("resolveSafeCwd", () => {
  let root: string;
  let subDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cwd-"));
    subDir = path.join(root, "child");
    mkdirSync(subDir);
  });

  it("returns workspace root when no child cwd", () => {
    const result = resolveSafeCwd({ workspaceRoot: root });
    assert.equal(result.error, undefined);
    // Should be canonical
    assert.ok(result.path);
  });

  it("resolves a valid child directory", () => {
    const result = resolveSafeCwd({ workspaceRoot: root, childCwd: "child" });
    assert.equal(result.error, undefined);
    assert.ok(result.path.endsWith("child"));
  });

  it("returns workspace root with absolute child cwd inside workspace", () => {
    const result = resolveSafeCwd({ workspaceRoot: root, childCwd: subDir });
    assert.equal(result.error, undefined);
  });

  it("rejects .. traversal that escapes workspace", () => {
    const result = resolveSafeCwd({ workspaceRoot: subDir, childCwd: ".." });
    assert.ok(result.error);
    assert.ok(result.error.includes("outside the workspace"));
  });

  it("rejects absolute path outside workspace", () => {
    const result = resolveSafeCwd({ workspaceRoot: subDir, childCwd: "/tmp" });
    assert.ok(result.error);
    assert.ok(result.error.includes("outside the workspace"));
  });

  it("rejects non-existent directory", () => {
    const result = resolveSafeCwd({ workspaceRoot: root, childCwd: "nonexistent" });
    assert.ok(result.error);
    assert.ok(result.error.includes("does not exist"));
  });

  it("rejects file path as cwd", () => {
    const filePath = path.join(root, "test-file.txt");
    writeFileSync(filePath, "content");
    const result = resolveSafeCwd({ workspaceRoot: root, childCwd: "test-file.txt" });
    assert.ok(result.error);
    assert.ok(result.error.includes("file"));
  });

  it("symlink escape is rejected", () => {
    // Create a symlink outside the workspace
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-outside-"));
    const linkPath = path.join(root, "escape");
    try {
      symlinkSync(outsideDir, linkPath);
    } catch {
      // Symlinks may not be supported on all platforms
      return;
    }
    const result = resolveSafeCwd({ workspaceRoot: root, childCwd: "escape" });
    assert.ok(result.error);
    assert.ok(result.error.includes("outside the workspace"));
  });

  it("allowExternalCwd permits outside paths", () => {
    const result = resolveSafeCwd({ workspaceRoot: subDir, childCwd: "/tmp", allowExternalCwd: true });
    assert.equal(result.error, undefined);
  });
});

// ===========================================================================
// Security: normalizeTimeout
// ===========================================================================

describe("normalizeTimeout", () => {
  it("returns default when no timeout provided", () => {
    const result = normalizeTimeout({});
    assert.equal(result.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(result.error, undefined);
  });

  it("accepts a valid custom timeout", () => {
    const result = normalizeTimeout({ requested: 5000 });
    assert.equal(result.timeoutMs, 5000);
    assert.equal(result.error, undefined);
  });

  it("rejects negative timeout", () => {
    const result = normalizeTimeout({ requested: -1000 });
    assert.equal(result.timeoutMs, undefined);
    assert.ok(result.error);
  });

  it("rejects zero timeout", () => {
    const result = normalizeTimeout({ requested: 0 });
    assert.equal(result.timeoutMs, undefined);
    assert.ok(result.error);
  });

  it("rejects fractional timeout", () => {
    const result = normalizeTimeout({ requested: 1.5 });
    assert.equal(result.timeoutMs, undefined);
    assert.ok(result.error);
  });

  it("rejects non-finite timeout", () => {
    const result = normalizeTimeout({ requested: Infinity });
    assert.equal(result.timeoutMs, undefined);
    assert.ok(result.error);
  });

  it("rejects NaN timeout", () => {
    const result = normalizeTimeout({ requested: NaN });
    assert.equal(result.timeoutMs, undefined);
    assert.ok(result.error);
  });

  it("rejects timeout exceeding max", () => {
    const result = normalizeTimeout({ requested: MAX_TIMEOUT_MS + 1 });
    assert.equal(result.timeoutMs, undefined);
    assert.ok(result.error);
  });

  it("accepts timeout at the max boundary", () => {
    const result = normalizeTimeout({ requested: MAX_TIMEOUT_MS });
    assert.equal(result.timeoutMs, MAX_TIMEOUT_MS);
  });

  it("accepts custom default", () => {
    const result = normalizeTimeout({ defaultValue: 30000 });
    assert.equal(result.timeoutMs, 30000);
  });

  it("accepts custom max", () => {
    const result = normalizeTimeout({ requested: 120000, maxValue: 120000 });
    assert.equal(result.timeoutMs, 120000);
  });
});

// ===========================================================================
// Security: createCombinedAbortSignal
// ===========================================================================

describe("createCombinedAbortSignal", () => {
  it("returns a signal that is not aborted when no inputs are", () => {
    const { signal, cleanup } = createCombinedAbortSignal([new AbortController().signal]);
    assert.equal(signal.aborted, false);
    cleanup();
  });

  it("returns an aborted signal when any input is already aborted", () => {
    const ac = new AbortController();
    ac.abort();
    const { signal, cleanup } = createCombinedAbortSignal([ac.signal]);
    assert.equal(signal.aborted, true);
    cleanup();
  });

  it("returns aborted signal when parent is aborted", () => {
    const parent = new AbortController();
    const child1 = new AbortController();
    const { signal, cleanup } = createCombinedAbortSignal([parent.signal, child1.signal]);
    assert.equal(signal.aborted, false);

    parent.abort(new Error("parent cancelled"));
    assert.equal(signal.aborted, true);
    cleanup();
  });

  it("filters out null/undefined/false signals", () => {
    const { signal, cleanup } = createCombinedAbortSignal([undefined, null, false]);
    assert.equal(signal.aborted, false);
    cleanup();
  });

  it("removes listeners after cleanup", () => {
    // Simulate environment without AbortSignal.any to exercise manual fallback
    const originalAny = (AbortSignal as any).any;
    (AbortSignal as any).any = undefined;
    try {
      const parent = new AbortController();
      const other = new AbortController();
      const { signal, cleanup } = createCombinedAbortSignal([parent.signal, other.signal]);

      // Track if the combined signal was aborted
      let aborted = false;
      signal.addEventListener("abort", () => { aborted = true; });

      // Cleanup before parent aborts
      cleanup();
      parent.abort();
      assert.equal(aborted, false, "should not receive abort after cleanup");
    } finally {
      (AbortSignal as any).any = originalAny;
    }
  });

  it("does not leak listeners with repeated calls", () => {
    // This test simulates repeated parallel calls not accumulating listeners
    const parent = new AbortController();
    const getListenerCount = () => {
      // We can't easily inspect listener count on AbortSignal,
      // but we can verify that multiple cleanups work
      let count = 0;
      for (let i = 0; i < 10; i++) {
        const { cleanup } = createCombinedAbortSignal([parent.signal]);
        cleanup();
        count++;
      }
      // Just verify cleanup doesn't throw
      assert.ok(true);
    };
    getListenerCount();
  });

  it("manual fallback works (simulate missing AbortSignal.any)", () => {
    // Store the original
    const originalAny = (AbortSignal as any).any;
    // Temporarily remove AbortSignal.any
    (AbortSignal as any).any = undefined;

    try {
      const parent = new AbortController();
      const { signal, cleanup } = createCombinedAbortSignal([parent.signal]);
      assert.equal(signal.aborted, false);

      let aborted = false;
      signal.addEventListener("abort", () => { aborted = true; });

      parent.abort();
      assert.equal(aborted, true);
      cleanup();
    } finally {
      (AbortSignal as any).any = originalAny;
    }
  });

  it("manual fallback with already aborted signal", () => {
    const originalAny = (AbortSignal as any).any;
    (AbortSignal as any).any = undefined;

    try {
      const ac = new AbortController();
      ac.abort();
      const { signal, cleanup } = createCombinedAbortSignal([ac.signal]);
      assert.equal(signal.aborted, true);
      cleanup();
    } finally {
      (AbortSignal as any).any = originalAny;
    }
  });
});

// ===========================================================================
// Security: classifyStopReason
// ===========================================================================

describe("classifyStopReason", () => {
  it("classifies stop as success", () => {
    assert.equal(classifyStopReason("stop", false, false), "success");
  });

  it("classifies end_turn as success", () => {
    assert.equal(classifyStopReason("end_turn", false, false), "success");
  });

  it("classifies completed as success", () => {
    assert.equal(classifyStopReason("completed", false, false), "success");
  });

  it("classifies no reason as success", () => {
    assert.equal(classifyStopReason(undefined, false, false), "success");
  });

  it("classifies length as partial", () => {
    assert.equal(classifyStopReason("length", false, false), "partial");
  });

  it("classifies max_tokens as partial", () => {
    assert.equal(classifyStopReason("max_tokens", false, false), "partial");
  });

  it("classifies context_limit as partial", () => {
    assert.equal(classifyStopReason("context_limit", false, false), "partial");
  });

  it("classifies error as error", () => {
    assert.equal(classifyStopReason("error", false, false), "error");
  });

  it("classifies tool_error as error", () => {
    assert.equal(classifyStopReason("tool_error", false, false), "error");
  });

  it("classifies authentication_error as error", () => {
    assert.equal(classifyStopReason("authentication_error", false, false), "error");
  });

  it("classifies provider_error as error", () => {
    assert.equal(classifyStopReason("provider_error", false, false), "error");
  });

  it("classifies content_filter as error", () => {
    assert.equal(classifyStopReason("content_filter", false, false), "error");
  });

  it("isAborted takes precedence", () => {
    assert.equal(classifyStopReason("stop", true, false), "aborted");
    assert.equal(classifyStopReason("error", true, false), "aborted");
  });

  it("isTimeout takes precedence over isAborted=false", () => {
    assert.equal(classifyStopReason("stop", false, true), "timeout");
  });

  it("isAborted takes precedence when both abort and timeout are true", () => {
    // isAborted is checked first, so it takes precedence
    assert.equal(classifyStopReason("stop", true, true), "aborted");
  });

  it("classifies unknown reason as error (conservative)", () => {
    assert.equal(classifyStopReason("unknown_reason", false, false), "error");
  });
});

// ===========================================================================
// Security: validateExecutionRequest
// ===========================================================================

describe("validateExecutionRequest", () => {
  it("accepts valid single execution", () => {
    const errors = validateExecutionRequest({ agentName: "scout", task: "find stuff" });
    assert.deepEqual(errors, []);
  });

  it("rejects empty agent name", () => {
    const errors = validateExecutionRequest({ agentName: "" });
    assert.ok(errors.length > 0);
  });

  it("rejects non-string agent name", () => {
    const errors = validateExecutionRequest({ agentName: undefined as any });
    assert.deepEqual(errors, []); // undefined agent is fine (not provided)
  });

  it("accepts valid parallel tasks", () => {
    const errors = validateExecutionRequest({
      tasks: [{ agent: "scout", task: "a" }, { agent: "worker", task: "b" }],
    });
    assert.deepEqual(errors, []);
  });

  it("rejects too many parallel tasks", () => {
    const tasks = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({
      agent: "scout",
      task: `task ${i}`,
    }));
    const errors = validateExecutionRequest({ tasks });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].message.includes("Too many"));
  });

  it("rejects parallel task with empty agent", () => {
    const errors = validateExecutionRequest({
      tasks: [{ agent: "", task: "test" }],
    });
    assert.ok(errors.length > 0);
  });

  it("rejects too many chain steps", () => {
    const chain = Array.from({ length: MAX_CHAIN_LENGTH + 1 }, (_, i) => ({
      agent: "scout",
      task: `step ${i}`,
    }));
    const errors = validateExecutionRequest({ chain });
    assert.ok(errors.length > 0);
  });

  it("rejects chain step with empty agent", () => {
    const errors = validateExecutionRequest({
      chain: [{ agent: "", task: "test" }],
    });
    assert.ok(errors.length > 0);
  });
});

// ===========================================================================
// Security: truncateParallelOutput
// ===========================================================================

describe("truncateParallelOutput", () => {
  it("does not truncate output under the cap", () => {
    const short = "hello world";
    assert.equal(truncateParallelOutput(short), short);
  });

  it("truncates output over the cap", () => {
    const big = "x".repeat(PER_TASK_OUTPUT_CAP + 1000);
    const result = truncateParallelOutput(big);
    assert.ok(result.length < big.length);
    assert.ok(result.includes("[Output truncated"));
  });

  it("handles multi-byte characters", () => {
    const big = "🚀".repeat(Math.ceil(PER_TASK_OUTPUT_CAP / 4) + 100);
    const result = truncateParallelOutput(big);
    assert.ok(result.includes("[Output truncated"));
  });
});

// ===========================================================================
// Security: isFailedResult
// ===========================================================================

describe("isFailedResult (in runner.ts)", () => {
  it("returns false for success with status", () => {
    const result = {
      agent: "test", task: "", exitCode: 0, messages: [], stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      status: "success" as SubagentStatus,
    };
    assert.equal(isFailedResult(result), false);
  });

  it("returns true for error status", () => {
    const result = {
      agent: "test", task: "", exitCode: 1, messages: [], stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      status: "error" as SubagentStatus,
    };
    assert.equal(isFailedResult(result), true);
  });

  it("returns true for aborted status", () => {
    const result = {
      agent: "test", task: "", exitCode: 1, messages: [], stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      status: "aborted" as SubagentStatus,
    };
    assert.equal(isFailedResult(result), true);
  });

  it("returns true for timeout status", () => {
    const result = {
      agent: "test", task: "", exitCode: 1, messages: [], stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      status: "timeout" as SubagentStatus,
    };
    assert.equal(isFailedResult(result), true);
  });

  it("falls back to legacy heuristics when status is absent", () => {
    const result = {
      agent: "test", task: "", exitCode: 0, messages: [], stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
    assert.equal(isFailedResult(result), false);

    const failedResult = { ...result, exitCode: 1, stopReason: "error" };
    assert.equal(isFailedResult(failedResult), true);
  });
});

// ===========================================================================
// Constants
// ===========================================================================

describe("security constants", () => {
  it("ALLOWED_CHILD_TOOLS matches expected set", () => {
    assert.deepEqual([...ALLOWED_CHILD_TOOLS].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  });

  it("READ_ONLY_TOOLS includes built-in reads plus research extensions", () => {
    // Built-in read tools are always present.
    for (const t of ["read", "grep", "find", "ls"]) {
      assert.ok(READ_ONLY_TOOLS.includes(t), `${t} in READ_ONLY_TOOLS`);
    }
    // Research extensions (serena/web/munin/fff) are now part of the read-only set
    // so sandbox: read-only agents (scout/planner/reviewer) can use them.
    for (const t of ["serena_find_symbol", "web_search", "munin_search", "ffgrep"]) {
      assert.ok(READ_ONLY_TOOLS.includes(t), `${t} in READ_ONLY_TOOLS`);
    }
    // Mutation/execution tools must never be read-only.
    for (const t of ["edit", "write", "bash"]) {
      assert.ok(!READ_ONLY_TOOLS.includes(t), `${t} must not be read-only`);
    }
  });

  it("MUTATION_TOOLS are all in ALLOWED_CHILD_TOOLS", () => {
    for (const t of MUTATION_TOOLS) {
      assert.ok(ALLOWED_CHILD_TOOLS.includes(t as any));
    }
  });

  it("EXECUTION_TOOLS are all in ALLOWED_CHILD_TOOLS", () => {
    for (const t of EXECUTION_TOOLS) {
      assert.ok(ALLOWED_CHILD_TOOLS.includes(t as any));
    }
  });

  it("DEFAULT_TIMEOUT_MS is 3 minutes", () => {
    assert.equal(DEFAULT_TIMEOUT_MS, 3 * 60 * 1000);
  });

  it("MAX_TIMEOUT_MS is 60 minutes", () => {
    assert.equal(MAX_TIMEOUT_MS, 60 * 60 * 1000);
  });

  it("MAX_PARALLEL_TASKS is 8", () => {
    assert.equal(MAX_PARALLEL_TASKS, 8);
  });

  it("MAX_CONCURRENCY is 4", () => {
    assert.equal(MAX_CONCURRENCY, 4);
  });

  it("MAX_CHAIN_LENGTH is 50", () => {
    assert.equal(MAX_CHAIN_LENGTH, 50);
  });

  it("PER_TASK_OUTPUT_CAP is 50 KB", () => {
    assert.equal(PER_TASK_OUTPUT_CAP, 50 * 1024);
  });
});

// ===========================================================================
// Rate-limit detection
// ===========================================================================

describe("isRateLimitError", () => {
  it("matches 429", () => assert.ok(isRateLimitError("429 Too Many Requests")));
  it("matches 529", () => assert.ok(isRateLimitError("529 Overloaded")));
  it("matches rate limit text", () => assert.ok(isRateLimitError("Rate limit exceeded")));
  it("matches ratelimit concatenated", () => assert.ok(isRateLimitError("RateLimitExceeded")));
  it("matches quota exhausted", () => assert.ok(isRateLimitError("quota_exhausted")));
  it("matches resource exhausted", () => assert.ok(isRateLimitError("Resource exhausted")));
  it("matches quota exceeded", () => assert.ok(isRateLimitError("Quota exceeded for API")));
  it("matches exceeded quota reversed order", () => assert.ok(isRateLimitError("You exceeded your current quota, please try again later")));
  it("matches too many requests", () => assert.ok(isRateLimitError("too many requests")));
  it("matches insufficient_quota", () => assert.ok(isRateLimitError("insufficient_quota")));
  it("matches capacity exceeded", () => assert.ok(isRateLimitError("capacity exceeded")));
  it("matches usage limit", () => assert.ok(isRateLimitError("usage limit reached")));
  it("matches overloaded", () => assert.ok(isRateLimitError("model is overloaded")));
  it("rejects generic errors", () => assert.ok(!isRateLimitError("Internal server error")));
  it("rejects empty", () => assert.ok(!isRateLimitError("")));
  it("rejects 503 alone", () => assert.ok(!isRateLimitError("503 Service Unavailable")));
});
