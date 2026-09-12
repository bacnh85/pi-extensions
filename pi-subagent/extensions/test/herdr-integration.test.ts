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

function fakeExec(script: (cmd: string, args: string[]) => Scripted | undefined): { exec: HerdrExec; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec = (async (cmd: string, args: string[], _opts?: { timeout?: number }) => {
    calls.push({ cmd, args });
    return { code: 0, stdout: "", stderr: "", ...script(cmd, args) };
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

before(async () => {
  // index.ts resolves its bundled agents dir from __dirname at module scope —
  // provide it before the dynamic import (ESM has no __dirname).
  (globalThis as any).__dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  ({ default: extension } = await import("../index.ts"));
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
 *  start, settled prompt, and a pane-read fallback report. */
function dispatchExec(options: { prompt?: Scripted; get?: string } = {}) {
  return fakeExec((_cmd, args) => {
    if (args[0] === undefined || args[0] === "--version") return { stdout: "herdr 0.9.0" };
    if (args[1] === "list") {
      if (args[0] === "agent") return { stdout: JSON.stringify({ result: { agents: [] } }) };
      if (args[0] === "tab") return { stdout: JSON.stringify({ result: { tabs: [] } }) };
      if (args[0] === "pane") return { stdout: JSON.stringify({ result: { panes: [{ tab_id: "w1:t9", pane_id: "w1:p9" }] } }) };
    }
    if (args[1] === "create") return { stdout: TAB_CREATE_OK };
    if (args[1] === "start") return { stdout: "{}" };
    if (args[1] === "prompt") return options.prompt ?? { stdout: "{}" };
    if (args[1] === "get") return { stdout: JSON.stringify({ result: { agent: { agent_status: options.get ?? "done" } } }) };
    if (args[1] === "read") return { stdout: "PANE-REPORT TEXT" };
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
    assert.equal(calls.length, 1); // probe only
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
