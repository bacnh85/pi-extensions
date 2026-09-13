/**
 * Index-level integration tests for the herdr wiring — the registered
 * `subagent` and `herdr` tools driven through a fake pi host with a scripted
 * herdr CLI. Covers the paths unit tests on herdr.ts cannot reach: runner
 * resolution inside execute(), control-tool authorization, and close-tab
 * gating.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "mocha";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultExec } from "../runner.ts";
import { clearHerdrRegistry, herdrCli, prepareHerdrTask, type HerdrExec } from "../herdr.ts";

// ---------------------------------------------------------------------------
// Fake pi host + scripted exec
// ---------------------------------------------------------------------------

type Scripted = { code?: number; stdout?: string; stderr?: string };

function fakeExec(script: (cmd: string, args: string[]) => Scripted | undefined | Promise<Scripted | undefined>): { exec: HerdrExec; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec = (async (cmd: string, args: string[], _opts?: { timeout?: number }) => {
    calls.push({ cmd, args });
    const scripted = await script(cmd, args);
    return { code: 0, stdout: "", stderr: "", ...(scripted ?? {}) };
  }) as HerdrExec;
  return { exec, calls };
}

function loadTools(): Record<string, { execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<any> }> {
  const tools: Record<string, any> = {};
  const pi = {
    on: () => {},
    events: { on: () => {} },
    registerTool: (def: any) => { tools[def.name] = def; },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    getAllTools: () => [],
    sendMessage: () => {},
  };
  extension!(pi as any);
  return tools;
}

let extension: ((pi: any) => void) | undefined;
let indexModule: { default: (pi: any) => void; herdrHeartbeat: { intervalMs: number } } | undefined;

before(async () => {
  // index.ts resolves its bundled agents dir from __dirname at module scope —
  // provide it before the dynamic import (ESM has no __dirname).
  (globalThis as any).__dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  indexModule = await import("../index.ts");
  extension = indexModule.default;
});

function fakeCtx(cwd: string, settings: Record<string, unknown> = {}) {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
    settings,
    modelRegistry: {
      // Enough for resolveModel: one available "test/m" model.
      getAvailable: () => [{ provider: "test", id: "m" }],
      runtime: undefined,
      authStorage: undefined,
    },
    ui: undefined,
  };
}

const UNCONFIRMED = { allowUnconfirmedProjectAgents: true };

/** Write a project agent under <cwd>/.pi/agents. */
function writeAgent(cwd: string, frontmatter: string): void {
  const dir = path.join(cwd, ".pi", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${frontmatter.match(/name: (\S+)/)![1]}.md`), `---\n${frontmatter}\n---\nYou are a test agent.\n`);
}

/** Scripted herdr CLI covering a full dispatch: fresh tab, root pane, agent
 *  start, settled prompt, and a pane-read fallback report. Tracks pane
 *  occupancy/splits so multi-instance parallel tests behave like the real
 *  server. */
function dispatchExec(options: { prompt?: Scripted; get?: string; read?: string; promptDelayMs?: number } = {}) {
  const panes = ["w1:p9"];
  const occupied: string[] = [];
  return fakeExec(async (_cmd, args) => {
    if (args[0] === undefined || args[0] === "--version") return { stdout: "herdr 0.9.0" };
    if (args[1] === "list") {
      if (args[0] === "agent") return { stdout: JSON.stringify({ result: { agents: occupied.map((p) => ({ pane_id: p })) } }) };
      if (args[0] === "tab") return { stdout: JSON.stringify({ result: { tabs: [] } }) };
      if (args[0] === "pane") return { stdout: JSON.stringify({ result: { panes: panes.map((p) => ({ tab_id: "w1:t9", pane_id: p })) } }) };
    }
    if (args[1] === "create") return { stdout: TAB_CREATE_OK };
    if (args[1] === "split") {
      const id = `w1:p${9 + panes.length}`;
      panes.push(id);
      return { stdout: JSON.stringify({ result: { pane: { pane_id: id } } }) };
    }
    if (args[1] === "start") { occupied.push(args[6]!); return { stdout: "{}" }; }
    if (args[1] === "prompt") {
      if (options.prompt) return options.prompt;
      if (options.promptDelayMs) await new Promise((r) => setTimeout(r, options.promptDelayMs));
      return { stdout: "{}" };
    }
    if (args[1] === "get") return { stdout: JSON.stringify({ result: { agent: { agent_status: options.get ?? "done" } } }) };
    if (args[1] === "read") return { stdout: options.read ?? "PANE-REPORT TEXT" };
    return undefined;
  });
}

const TAB_CREATE_OK = JSON.stringify({ result: { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } } });

function text(result: any): string {
  return result?.content?.[0]?.text ?? "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("herdr index-level integration", () => {
  let tools: ReturnType<typeof loadTools>;
  let cwd: string;

  beforeEach(() => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;
    delete process.env.PI_SUBAGENT_HERDR;
    clearHerdrRegistry();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-herdr-idx-"));
    tools = loadTools();
    assert.ok(tools.subagent, "subagent tool registered");
    assert.ok(tools.herdr, "herdr tool registered");
  });

  afterEach(() => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;
    delete process.env.PI_SUBAGENT_HERDR;
    herdrCli.exec = defaultExec;
    clearHerdrRegistry();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("rejects runner:\"herdr\" outside herdr without touching the CLI", async () => {
    const { exec, calls } = fakeExec(() => undefined);
    herdrCli.exec = exec;
    const result = await tools.subagent!.execute("t1", { agent: "scout", task: "t", runner: "herdr" }, undefined, undefined, fakeCtx(cwd));
    assert.equal(result.isError, true);
    assert.match(text(result), /not running inside herdr/);
    assert.equal(calls.length, 0);
  });

  it("reports merge:\"3way\" + herdr as an explicit error instead of a silent drop", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    const { exec, calls } = fakeExec((_cmd, args) => {
      if (args[0] === undefined || args.join(" ").includes("--version")) return { stdout: "herdr 0.9.0" };
      return undefined;
    });
    herdrCli.exec = exec;
    const result = await tools.subagent!.execute("t1", { agent: "scout", task: "t", runner: "herdr", merge: "3way" }, undefined, undefined, fakeCtx(cwd));
    assert.equal(result.isError, true);
    assert.match(text(result), /merge:"3way".*requires runner:"sdk"/);
    // Rejected during validation — no tab/pane/agent ever created.
    // The only permitted call is the binary probe; create/split/start would
    // prove topology got built despite the rejection.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.args[0], "--version");
  });

  it("task-control (status) results never inherit the ambient herdr runner stamp", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    const { exec, calls } = fakeExec((_cmd, args) => {
      if (args[0] === undefined || args[0] === "--version") return { stdout: "herdr 0.9.0" };
      return undefined;
    });
    herdrCli.exec = exec;
    // herdrActive is true here — but a status lookup of an SDK background
    // task must not be labeled runner:"herdr".
    const result = await tools.subagent!.execute("t1", { operation: "status", taskId: "bg-nope" }, undefined, undefined, fakeCtx(cwd));
    const details = result.details as { runner?: string };
    assert.equal(details.runner, undefined);
    assert.match(text(result), /No background task with id/);
    // Task-control calls skip runner resolution entirely — zero CLI calls.
    assert.equal(calls.length, 0);
  });

  it("sandbox: read-only agent dispatches herdr children with the inline delivery contract", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    writeAgent(cwd, "name: ro\ndescription: ro agent\nmodel: test/m\nsandbox: read-only");
    const { exec, calls } = dispatchExec();
    herdrCli.exec = exec;
    const result = await tools.subagent!.execute(
      "t1", { agent: "ro", task: "t", runner: "herdr", agentScope: "both" },
      undefined, undefined, fakeCtx(cwd, UNCONFIRMED),
    );
    const details = result.details as { results: Array<{ status?: string }> };
    assert.equal(details.results[0]?.status, "success");
    // Drop the sandbox→readOnly mapping in prepareHerdrOne and this fails.
    const promptCall = calls.find((c) => c.args[1] === "prompt")!;
    assert.match(promptCall.args[3]!, /read-only tools/);
    assert.ok(!promptCall.args[3]!.includes("ro-1-"));
  });

  it("status of an evicted task falls back to durable history", async () => {
    const { exec } = fakeExec(() => undefined);
    herdrCli.exec = exec;
    const piDir = path.join(cwd, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "subagent-history.json"), JSON.stringify([
      { id: "bg-done-1", agent: "scout", task: "find auth", status: "completed", startedAt: 1, completedAt: 2, summary: "found 3 files", background: true },
      { id: "bg-run-1", agent: "worker", task: "long job", status: "running", startedAt: 1, background: true },
      { id: "fg-abc-1", agent: "scout", task: "fg job", status: "completed", startedAt: 1, completedAt: 2, background: false },
    ]));
    const result = await tools.subagent!.execute("t1", { operation: "status", taskId: "bg-done-1" }, undefined, undefined, fakeCtx(cwd));
    assert.match(text(result), /bg-done-1 \(scout\): completed/);
    assert.match(text(result), /no longer retained/);
    assert.match(text(result), /found 3 files/);
    // Non-terminal entries are not "finished".
    const running = await tools.subagent!.execute("t1", { operation: "status", taskId: "bg-run-1" }, undefined, undefined, fakeCtx(cwd));
    assert.match(text(running), /history shows running/);
    assert.ok(!/no longer retained/.test(text(running)));
    // Foreground ids never read as background tasks.
    const fg = await tools.subagent!.execute("t1", { operation: "status", taskId: "fg-abc-1" }, undefined, undefined, fakeCtx(cwd));
    assert.match(text(fg), /No background task with id "fg-abc-1"/);
    // Unknown ids still report missing.
    const miss = await tools.subagent!.execute("t1", { operation: "status", taskId: "bg-gone" }, undefined, undefined, fakeCtx(cwd));
    assert.match(text(miss), /No background task with id "bg-gone"/);
  });

  it("forget drops a stale registry entry without touching herdr", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    const { exec, calls } = dispatchExec();
    herdrCli.exec = exec;
    const handle = await prepareHerdrTask({
      agentType: "scout", systemPrompt: "x", task: "t", cwd, model: "p/m", timeoutMs: 60_000, exec,
    });
    const before = await tools.herdr!.execute("t1", { action: "list" }, undefined, undefined, fakeCtx(cwd));
    assert.match(text(before), /scout-1/);
    const result = await tools.herdr!.execute("t1", { action: "forget", name: handle.name }, undefined, undefined, fakeCtx(cwd));
    assert.equal(result.isError, false);
    assert.match(text(result), /Forgot scout-1/);
    const after = await tools.herdr!.execute("t1", { action: "list" }, undefined, undefined, fakeCtx(cwd));
    assert.match(text(after), /No herdr-delegated agents/);
    // Registry-only: no send-keys/close calls were made.
    assert.ok(!calls.some((c) => c.args[1] === "send-keys" || c.args[1] === "close"));
    const unknown = await tools.herdr!.execute("t1", { action: "forget", name: "ghost-1" }, undefined, undefined, fakeCtx(cwd));
    assert.equal(unknown.isError, true);
  });

  it("control-tool prompt on a read-only entry re-wraps with the inline delivery contract", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    const { exec, calls } = dispatchExec();
    herdrCli.exec = exec;
    const handle = await prepareHerdrTask({
      agentType: "scout", systemPrompt: "x", task: "t", cwd, model: "p/m", timeoutMs: 60_000, exec, readOnly: true,
    });
    const result = await tools.herdr!.execute("t1", { action: "prompt", name: handle.name, text: "summarize" }, undefined, undefined, fakeCtx(cwd));
    assert.equal(result.isError, false);
    // Drop `entry.readOnly` from the follow-up wrapper and this fails.
    const promptCall = calls.find((c) => c.args[1] === "prompt")!;
    assert.match(promptCall.args[3]!, /summarize/);
    assert.match(promptCall.args[3]!, /read-only tools/);
    assert.ok(!promptCall.args[3]!.includes("scout-1-"));
  });

  it("parallel same-type dispatch: prepares before prompts, per-index results", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    writeAgent(cwd, "name: light\ndescription: light agent\nmodel: test/m");
    const { exec, calls } = dispatchExec();
    herdrCli.exec = exec;
    const result = await tools.subagent!.execute(
      "t1", { tasks: [{ agent: "light", task: "a" }, { agent: "light", task: "b" }], runner: "herdr", agentScope: "both" },
      undefined, undefined, fakeCtx(cwd, UNCONFIRMED),
    );
    assert.match(text(result), /Parallel: 2\/2 succeeded/);
    const firstPrompt = calls.findIndex((c) => c.args[1] === "prompt");
    const lastStart = calls.map((c) => c.args[1]).lastIndexOf("start");
    assert.ok(lastStart < firstPrompt, "all panes must be started before any prompt is submitted");
    const details = result.details as { results: Array<{ status?: string; agent?: string }> };
    assert.equal(details.results.length, 2);
    assert.ok(details.results.every((r) => r.status === "success"));
  });

  it("parallel: a failing prepare yields per-task error while the sibling succeeds", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    writeAgent(cwd, "name: light\ndescription: light agent\nmodel: test/m");
    const { exec } = dispatchExec();
    herdrCli.exec = exec;
    const result = await tools.subagent!.execute(
      "t1", { tasks: [{ agent: "ghost", task: "a" }, { agent: "light", task: "b" }], runner: "herdr", agentScope: "both" },
      undefined, undefined, fakeCtx(cwd, UNCONFIRMED),
    );
    assert.match(text(result), /Parallel: 1\/2 succeeded/);
    assert.match(text(result), /Unknown agent: "ghost"/);
    const details = result.details as { results: Array<{ status?: string }> };
    assert.equal(details.results[0]!.status, "error");
    assert.equal(details.results[1]!.status, "success");
  });

  it("parallel abort mid-prompt: esc to every pane, aborted results, no listener leak", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    writeAgent(cwd, "name: light\ndescription: light agent\nmodel: test/m");
    const { exec, calls } = dispatchExec({ promptDelayMs: 400 });
    herdrCli.exec = exec;
    const controller = new AbortController();
    // Abort while the first prompt is still in flight.
    setTimeout(() => controller.abort(), 60);
    const before = calls.length;
    const result = await tools.subagent!.execute(
      "t1", { tasks: [{ agent: "light", task: "a" }, { agent: "light", task: "b" }], runner: "herdr", agentScope: "both" },
      controller.signal, undefined, fakeCtx(cwd, UNCONFIRMED),
    );
    assert.ok(text(result).includes("aborted") || /aborted/.test(text(result)));
    const escNames = calls.filter((c) => c.args[1] === "send-keys" && c.args[3] === "esc").map((c) => c.args[2]);
    assert.ok(escNames.length >= 2, `expected esc to both panes, got ${JSON.stringify(escNames)}`);
    // Listener cleanup: after the run settles, aborting again changes nothing.
    const after = calls.length;
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, after, "no new CLI calls may fire after settle (listener leak)");
    void before;
  });

  it("herdr delegations emit heartbeat onUpdate traffic (keep-alive parity)", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    writeAgent(cwd, "name: light\ndescription: light agent\nmodel: test/m");
    const { exec } = dispatchExec({ promptDelayMs: 60 });
    herdrCli.exec = exec;
    const previousInterval = indexModule!.herdrHeartbeat.intervalMs;
    indexModule!.herdrHeartbeat.intervalMs = 10;
    try {
      const beats: Array<any> = [];
      const result = await tools.subagent!.execute(
        "t1", { agent: "light", task: "t", runner: "herdr", agentScope: "both" },
        undefined,
        (update: any) => { beats.push(update); },
        fakeCtx(cwd, UNCONFIRMED),
      );
      assert.equal(result.isError, undefined);
      // Heartbeat signature: empty-text content + herdr-stamped details.
      assert.ok(beats.some((b) => b.content?.[0]?.text === "" && b.details?.runner === "herdr"),
        `expected at least one heartbeat, got ${JSON.stringify(beats.map((b) => b.content?.[0]?.text))}`);
    } finally {
      indexModule!.herdrHeartbeat.intervalMs = previousInterval;
    }
  });

  it("chain with an oversized step report truncates instead of failing step 2", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    writeAgent(cwd, "name: light\ndescription: light agent\nmodel: test/m");
    const big = "REPORT-LINE\n".repeat(12_000); // ~120KB report
    const { exec, calls } = dispatchExec({ read: big });
    herdrCli.exec = exec;
    const result = await tools.subagent!.execute(
      "t1", { chain: [{ agent: "light", task: "a" }, { agent: "light", task: "b: {previous}" }], runner: "herdr", agentScope: "both" },
      undefined, undefined, fakeCtx(cwd, UNCONFIRMED),
    );
    assert.ok(!text(result).includes("exceeds 65536 bytes"), "step 2 must not hit the argv ceiling");
    assert.ok(calls.some((c) => c.args[1] === "prompt" && (c.args[3] as string).includes("truncated")),
      "step-2 prompt must carry the truncation marker");
    const chainDetails = result.details as { results: Array<{ status?: string }> };
    assert.equal(chainDetails.results.length, 2, "both steps must run");
    assert.ok(chainDetails.results.every((r) => r.status === "success"));
  });

  it("herdr control tool refuses prompt/cancel/close-tab on agents this session did not delegate", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    const { exec, calls } = fakeExec(() => ({ stdout: "{}" }));
    herdrCli.exec = exec;

    for (const action of ["prompt", "cancel", "close-tab"]) {
      const result = await tools.herdr!.execute("t1", { action, name: "foreign-1", text: "hi" }, undefined, undefined, fakeCtx(cwd));
      assert.equal(result.isError, true, action);
      assert.match(text(result), /not delegated by this session/, action);
    }
    // Guards fire before any CLI call is made.
    assert.equal(calls.length, 0);
  });

  it("refuses worktree-sandboxed agents on the herdr runner instead of dropping isolation", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    writeAgent(cwd, "name: heavy\ndescription: worktree worker\nsandbox: worktree\nmodel: test/m");
    const { exec, calls } = dispatchExec();
    herdrCli.exec = exec;
    const result = await tools.subagent!.execute(
      "t1", { agent: "heavy", task: "t", runner: "herdr", agentScope: "both" },
      undefined, undefined, fakeCtx(cwd, UNCONFIRMED),
    );
    assert.equal(result.isError, true);
    assert.match(text(result), /Worktree isolation.*requires runner:"sdk"/);
    // Guard fires at validation — no topology was built.
    assert.ok(!calls.some((c) => c.args[1] === "create"));
    assert.ok(!calls.some((c) => c.args[1] === "start"));
  });

  it("dispatches a single herdr task end-to-end with runner stamped in details", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    writeAgent(cwd, "name: light\ndescription: light agent\nmodel: test/m");
    const { exec } = dispatchExec();
    herdrCli.exec = exec;
    const result = await tools.subagent!.execute(
      "t1", { agent: "light", task: "t", runner: "herdr", agentScope: "both" },
      undefined, undefined, fakeCtx(cwd, UNCONFIRMED),
    );
    assert.equal(result.isError, undefined);
    const details = result.details as { runner?: string; results: Array<{ status?: string }> };
    assert.equal(details.runner, "herdr");
    assert.equal(details.results[0]!.status, "success");
    assert.match(text(result), /PANE-REPORT TEXT/);
  });

  it("single blocked pane reports blocked — not an empty success", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    writeAgent(cwd, "name: light\ndescription: light agent\nmodel: test/m");
    const { exec } = dispatchExec({ get: "blocked" });
    herdrCli.exec = exec;
    const result = await tools.subagent!.execute(
      "t1", { agent: "light", task: "t", runner: "herdr", agentScope: "both" },
      undefined, undefined, fakeCtx(cwd, UNCONFIRMED),
    );
    assert.ok(!result.isError);
    assert.match(text(result), /blocked awaiting input in its herdr pane/);
    assert.ok(!text(result).includes("(no output)"));
  });

  it("parallel blocked panes get their own count instead of counting as succeeded", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    writeAgent(cwd, "name: light\ndescription: light agent\nmodel: test/m");
    const { exec } = dispatchExec({ get: "blocked" });
    herdrCli.exec = exec;
    const result = await tools.subagent!.execute(
      "t1", { tasks: [{ agent: "light", task: "a" }, { agent: "light", task: "b" }], runner: "herdr", agentScope: "both" },
      undefined, undefined, fakeCtx(cwd, UNCONFIRMED),
    );
    assert.match(text(result), /Parallel: 0\/2 succeeded \(2 blocked awaiting input\)/);
    assert.match(text(result), /blocked — awaiting input in its pane/);
  });


  it("pauses a chain when the first step's pane is blocked", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    writeAgent(cwd, "name: light\ndescription: light agent\nmodel: test/m");
    const { exec } = dispatchExec({
      prompt: { code: 1, stderr: JSON.stringify({ error: { message: "agent_blocked" } }) },
    });
    herdrCli.exec = exec;
    const result = await tools.subagent!.execute(
      "t1", { chain: [{ agent: "light", task: "a" }, { agent: "light", task: "b" }], runner: "herdr", agentScope: "both" },
      undefined, undefined, fakeCtx(cwd, UNCONFIRMED),
    );
    assert.match(text(result), /Chain paused at step 1\/2 \(light\)/);
    assert.ok(!result.isError);
    const details = result.details as { results: unknown[] };
    assert.equal(details.results.length, 1); // step 2 never dispatched
  });

  it("cancels the pane agent and reports aborted when the parent signal is already aborted", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    writeAgent(cwd, "name: light\ndescription: light agent\nmodel: test/m");
    const { exec, calls } = dispatchExec({ get: "idle" });
    herdrCli.exec = exec;
    const controller = new AbortController();
    controller.abort();
    const result = await tools.subagent!.execute(
      "t1", { agent: "light", task: "t", runner: "herdr", agentScope: "both" },
      controller.signal, undefined, fakeCtx(cwd, UNCONFIRMED),
    );
    assert.equal(result.isError, true);
    assert.match(text(result), /aborted/i);
    // The abort wiring interrupted the child pane.
    assert.ok(calls.some((c) => c.args[1] === "send-keys" && c.args[3] === "esc"));
  });

  it("closes a session-created tab and forgets its registry entries", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    const { exec, calls } = fakeExec((_cmd, args) => {
      if (args[0] === "agent" && args[1] === "list") return { stdout: JSON.stringify({ result: { agents: [] } }) };
      if (args[0] === "tab" && args[1] === "list") return { stdout: JSON.stringify({ result: { tabs: [] } }) };
      if (args[0] === "tab" && args[1] === "create") return { stdout: TAB_CREATE_OK };
      if (args[0] === "pane" && args[1] === "list") return { stdout: JSON.stringify({ result: { panes: [{ tab_id: "w1:t9", pane_id: "w1:p9" }] } }) };
      if (args[0] === "agent" && args[1] === "start") return { stdout: "{}" };
      if (args[0] === "tab" && args[1] === "close") return { stdout: "{}" };
      return undefined;
    });
    herdrCli.exec = exec;
    // The herdr tool itself uses herdrCli.exec — dispatch through prepareHerdrTask
    // with the same scripted exec so the registry entry is visible to the tool.
    const handle = await prepareHerdrTask({
      agentType: "scout", systemPrompt: "x", task: "t", cwd, model: "p/m", timeoutMs: 60_000, exec,
    });
    const result = await tools.herdr!.execute("t1", { action: "close-tab", name: handle.name }, undefined, undefined, fakeCtx(cwd));
    assert.equal(result.isError, false);
    assert.match(text(result), /Closed tab w1:t9/);
    assert.ok(calls.some((c) => c.args[1] === "close" && c.args[2] === "w1:t9"));
    const list = await tools.herdr!.execute("t1", { action: "list" }, undefined, undefined, fakeCtx(cwd));
    assert.match(text(list), /No herdr-delegated agents/);
  });
});
