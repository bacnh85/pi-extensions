/**
 * Tests for the herdr delegation backend — detection, topology, agent
 * lifecycle, result contract, and the session registry. All herdr CLI
 * interaction goes through a scripted fake exec.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "mocha";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  allocateName,
  buildHerdrResult,
  buildPiArgs,
  cancelAgent,
  busyHerdrSiblings,
  canCloseHerdrTab,
  clearHerdrRegistry,
  collectResult,
  ensurePane,
  ensureTab,
  executeHerdrTask,
  forgetHerdrTab,
  getHerdrRegistry,
  herdrDisabled,
  herdrEnvDetected,
  herdrTabCloseBlockers,
  isDelegatedHerdrAgent,
  isManagedHerdrTab,
  liveAgentNames,
  MAX_HERDR_TASK_BYTES,
  prepareHerdrTask,
  promptAndWait,
  resolveEffectiveRunner,
  HERDR_TASK_BUDGET,
  startAgent,
  truncateHerdrTask,
  wrapTaskPrompt,
  type HerdrExec,
} from "../herdr.ts";
import { isFailedResult, type SubAgentResult } from "../runner.ts";
import { READ_ONLY_TOOLS } from "../security.ts";

// ---------------------------------------------------------------------------
// Fake exec: scripts herdr CLI responses, records calls.
// ---------------------------------------------------------------------------

interface Call {
  cmd: string;
  args: string[];
}

type Scripted = { code?: number; stdout?: string; stderr?: string };

function fakeExec(script: (cmd: string, args: string[]) => Scripted | undefined): { exec: HerdrExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec = (async (cmd: string, args: string[], _opts?: { timeout?: number }) => {
    calls.push({ cmd, args });
    const scripted = script(cmd, args);
    return { code: 0, stdout: "", stderr: "", ...scripted };
  }) as HerdrExec;
  return { exec, calls };
}

function json(value: unknown): Scripted {
  return { stdout: JSON.stringify(value) };
}

const TAB_CREATE_OK = json({ result: { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } } });
const SPLIT_OK = json({ result: { pane: { pane_id: "w1:p10" } } });

function tabList(tabs: Array<{ label: string; tab_id: string }>): Scripted {
  return json({ result: { tabs } });
}

function paneList(panes: Array<{ tab_id: string; pane_id: string }>): Scripted {
  return json({ result: { panes } });
}

function agentList(agents: Array<{ name?: string; pane_id?: string; agent_status?: string }>): Scripted {
  return json({ result: { agents } });
}

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-herdr-"));
}

// ---------------------------------------------------------------------------
// Detection & runner resolution
// ---------------------------------------------------------------------------

describe("herdr detection", () => {
  beforeEach(() => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    delete process.env.PI_SUBAGENT_HERDR;
    clearHerdrRegistry();
  });
  afterEach(() => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;
    delete process.env.PI_SUBAGENT_HERDR;
    clearHerdrRegistry();
  });

  it("detects the herdr env only with HERDR_ENV=1 and a workspace id", () => {
    assert.equal(herdrEnvDetected(), true);
    delete process.env.HERDR_WORKSPACE_ID;
    assert.equal(herdrEnvDetected(), false);
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_ENV = "0";
    assert.equal(herdrEnvDetected(), false);
  });

  it("is disabled by settings subagent.herdr:\"off\" or the child recursion guard", () => {
    assert.equal(herdrDisabled(undefined), false);
    assert.equal(herdrDisabled({ herdr: "off" }), true);
    process.env.PI_SUBAGENT_HERDR = "off";
    assert.equal(herdrDisabled(undefined), true);
  });

  it("resolves the runner: explicit param wins, default auto-detects", async () => {
    const binaryOk = fakeExec(() => ({ stdout: "herdr 0.9.0" }));
    const binaryMissing = fakeExec(() => ({ code: 127, stderr: "command not found" }));

    // Explicit sdk — no probing at all.
    assert.deepEqual(await resolveEffectiveRunner("sdk", undefined, binaryOk.exec), { runner: "sdk" });
    assert.equal(binaryOk.calls.length, 0);

    // Explicit herdr outside herdr → error.
    delete process.env.HERDR_ENV;
    const outside = await resolveEffectiveRunner("herdr", undefined, binaryOk.exec);
    assert.equal(outside.runner, "sdk");
    assert.match(outside.error ?? "", /not running inside herdr/);
    process.env.HERDR_ENV = "1";

    // Default inside herdr with a working binary → herdr.
    assert.deepEqual(await resolveEffectiveRunner(undefined, undefined, binaryOk.exec), { runner: "herdr" });

    // Settings off → sdk.
    assert.deepEqual(await resolveEffectiveRunner(undefined, { herdr: "off" }, binaryOk.exec), { runner: "sdk" });

    // Binary missing → sdk.
    assert.deepEqual(await resolveEffectiveRunner(undefined, undefined, binaryMissing.exec), { runner: "sdk" });
  });
});

// ---------------------------------------------------------------------------
// Name allocation & child argv
// ---------------------------------------------------------------------------

describe("allocateName", () => {
  it("allocates scout-1, scout-2, … bumping on collisions", () => {
    assert.equal(allocateName("scout", []), "scout-1");
    assert.equal(allocateName("scout", ["scout-1"]), "scout-2");
    assert.equal(allocateName("scout", ["scout-1", "scout-2", "scout-4"]), "scout-3");
  });

  it("sanitizes to the herdr name charset and length", () => {
    const name = allocateName("Scout Agent! 9", []);
    assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
    const long = allocateName("a".repeat(40), []);
    assert.match(long, /^[a-z][a-z0-9_-]{0,31}$/);
    const digit = allocateName("9lives", []);
    assert.match(digit, /^[a-z]/);
  });
});

describe("buildPiArgs", () => {
  it("maps persona, model, thinking, tools, session and display name", () => {
    const args = buildPiArgs({
      name: "scout-1",
      systemPromptFile: "/repo/.pi/herdr/scout-1.system.md",
      model: "zai-anthropic/glm-5",
      thinking: "high",
      tools: ["read", "grep", "bash"],
      sessionStamp: "abc",
    });
    const idx = (flag: string) => args.indexOf(flag);
    // The persona travels as a file: herdr's `agent start --` encoder
    // rejects multi-line arguments.
    assert.equal(args[idx("--append-system-prompt") + 1], "/repo/.pi/herdr/scout-1.system.md");
    assert.equal(args.indexOf("--system-prompt"), -1);
    assert.equal(args[idx("--model") + 1], "zai-anthropic/glm-5");
    assert.equal(args[idx("--thinking") + 1], "high");
    assert.equal(args[idx("--tools") + 1], "read,grep,bash");
    // Fresh session per dispatch: the id is unique per stamp (a recycled
    // agent name must never resume a stale session).
    assert.match(args[idx("--session-id") + 1], /^herdr-scout-1-[a-z0-9]+$/);
    const again = buildPiArgs({ name: "scout-1", systemPromptFile: "/r/s.md", model: "p/m", sessionStamp: "other" });
    assert.notEqual(again[idx("--session-id") + 1], args[idx("--session-id") + 1]);
    assert.equal(args[idx("--name") + 1], "scout-1");
  });

  it("omits --thinking for off and filters read-only to the allowlist", () => {
    const off = buildPiArgs({ name: "s-1", systemPromptFile: "/tmp/s.system.md", model: "p/m", thinking: "off", tools: ["read"], sessionStamp: "abc" });
    assert.equal(off.indexOf("--thinking"), -1);
    const ro = buildPiArgs({ name: "s-1", systemPromptFile: "/tmp/s.system.md", model: "p/m", readOnly: true, tools: ["read", "bash", "web_search"], sessionStamp: "abc" });
    const toolsFlag = ro[ro.indexOf("--tools") + 1].split(",");
    assert.ok(!toolsFlag.includes("bash"));
    for (const tool of toolsFlag) assert.ok(READ_ONLY_TOOLS.includes(tool));
  });

  it("rejects a read-only agent whose tools never intersect the allowlist", () => {
    // Omitting --tools would hand the child pi's FULL default toolset — worse
    // than failing, so this must throw (mirrors the SDK path's rejection).
    assert.throws(
      () => buildPiArgs({ name: "s-1", systemPromptFile: "/tmp/s.system.md", model: "p/m", readOnly: true, tools: ["bash", "edit"], sessionStamp: "abc" }),
      /read-only sandbox leaves no allowed tools/,
    );
  });
});

describe("wrapTaskPrompt", () => {
  it("embeds the task and the report-file contract", () => {
    const prompt = wrapTaskPrompt("find auth code", "/repo/.pi/herdr/scout-1-abc.md");
    assert.ok(prompt.startsWith("find auth code"));
    assert.match(prompt, /write your full final report as Markdown to `\/repo\/\.pi\/herdr\/scout-1-abc\.md`/);
  });
});

describe("truncateHerdrTask", () => {
  it("leaves short tasks untouched", () => {
    assert.equal(truncateHerdrTask("normal task"), "normal task");
  });

  it("byte-caps oversized tasks with a visible marker and no split multibyte", () => {
    const marker = "\n\n…({previous} truncated: herdr task ceiling 64KB)";
    // An emoji straddles the cut boundary (4-byte UTF-8 split mid-sequence).
    const huge = "x".repeat(HERDR_TASK_BUDGET - Buffer.byteLength(marker, "utf8") - 2) + "🎉🎉🎉🎉 tail beyond ceiling with enough trailing padding to push the total past the line";
    const out = truncateHerdrTask(huge);
    // The truncated task must PASS the prepareHerdrTask validation budget —
    // cutting to the raw ceiling would throw after truncating.
    assert.ok(Buffer.byteLength(out, "utf8") <= HERDR_TASK_BUDGET, "must fit the validation budget, not just the ceiling");
    assert.ok(out.includes("{previous} truncated"), "marker must be present");
    assert.ok(!out.endsWith("\uFFFD"), "must not end with a split multibyte replacement char");
    assert.ok(!out.includes("tail beyond ceiling"), "content beyond the ceiling must be dropped");
  });
});

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

describe("ensureTab", () => {
  beforeEach(() => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
  });
  afterEach(() => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;
  });

  it("creates a labelled tab with the recursion guard env and no focus", async () => {
    const { exec, calls } = fakeExec((cmd, args) => {
      assert.equal(cmd, "herdr");
      if (args[0] === "tab" && args[1] === "list") return tabList([]);
      if (args[0] === "tab" && args[1] === "create") return TAB_CREATE_OK;
      return undefined;
    });
    const tab = await ensureTab({ agentType: "scout", cwd: "/repo", exec });
    assert.deepEqual(tab, { tabId: "w1:t9", rootPaneId: "w1:p9", created: true });
    const create = calls.find((c) => c.args[1] === "create")!;
    assert.ok(create);
    assert.ok(create.args.includes("--label") && create.args.includes("scout"));
    assert.ok(create.args.includes("--cwd") && create.args.includes("/repo"));
    assert.ok(create.args.includes("--env") && create.args.includes("PI_SUBAGENT_HERDR=off"));
    assert.ok(create.args.includes("--no-focus"));
    assert.ok(!create.args.includes("--focus"));
  });

  it("reuses an existing tab with a matching label", async () => {
    const { exec, calls } = fakeExec((_cmd, args) => {
      if (args[0] === "tab" && args[1] === "list") return tabList([{ label: "other", tab_id: "w1:t1" }, { label: "scout", tab_id: "w1:t3" }]);
      return undefined;
    });
    const tab = await ensureTab({ agentType: "scout", cwd: "/repo", exec });
    assert.deepEqual(tab, { tabId: "w1:t3", created: false });
    assert.equal(calls.find((c) => c.args[1] === "create"), undefined);
  });
});

describe("ensurePane", () => {
  beforeEach(() => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
  });
  afterEach(() => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;
  });

  it("reuses a free pane (fresh root shell) without splitting", async () => {
    const { exec, calls } = fakeExec((_cmd, args) => {
      if (args[0] === "pane" && args[1] === "list") return paneList([{ tab_id: "w1:t9", pane_id: "w1:p9" }]);
      if (args[0] === "agent" && args[1] === "list") return agentList([]);
      return undefined;
    });
    const paneId = await ensurePane({ tabId: "w1:t9", cwd: "/repo", exec, reuseFreePane: true });
    assert.equal(paneId, "w1:p9");
    assert.equal(calls.find((c) => c.args[1] === "split"), undefined);
  });

  it("splits the last pane when all are occupied, alternating direction", async () => {
    let paneCount = 1;
    const { exec, calls } = fakeExec((_cmd, args) => {
      if (args[0] === "pane" && args[1] === "list") {
        const panes = Array.from({ length: paneCount }, (_, i) => ({ tab_id: "w1:t9", pane_id: `w1:p${9 + i}` }));
        return paneList(panes);
      }
      if (args[0] === "pane" && args[1] === "split") {
        paneCount++;
        return SPLIT_OK;
      }
      if (args[0] === "agent" && args[1] === "list") return agentList([{ pane_id: "w1:p9" }, { pane_id: "w1:p10" }]);
      return undefined;
    });
    const first = await ensurePane({ tabId: "w1:t9", cwd: "/repo", exec, reuseFreePane: true });
    assert.equal(first, "w1:p10");
    const split = calls.find((c) => c.args[1] === "split")!;
    assert.equal(split.args[2], "w1:p9");
    assert.ok(split.args.includes("right"));
    const second = await ensurePane({ tabId: "w1:t9", cwd: "/repo", exec, reuseFreePane: true });
    assert.equal(second, "w1:p10");
    const split2 = calls.filter((c) => c.args[1] === "split")[1]!;
    assert.ok(split2.args.includes("down"));
  });

  it("never reuses a free pane in an adopted tab — always splits with the validated cwd", async () => {
    const { exec, calls } = fakeExec((_cmd, args) => {
      if (args[0] === "pane" && args[1] === "list") return paneList([{ tab_id: "w1:t1", pane_id: "w1:p1" }]);
      if (args[0] === "agent" && args[1] === "list") return agentList([]);
      if (args[0] === "pane" && args[1] === "split") return SPLIT_OK;
      return undefined;
    });
    // reuseFreePane:false — the tab was label-matched (adopted), so the free
    // pane w1:p1 belongs to whatever cwd/user was there before.
    const paneId = await ensurePane({ tabId: "w1:t1", cwd: "/validated/cwd", exec, reuseFreePane: false });
    assert.equal(paneId, "w1:p10");
    const split = calls.find((c) => c.args[1] === "split")!;
    assert.equal(split.args[2], "w1:p1");
    assert.ok(split.args.includes("--cwd") && split.args.includes("/validated/cwd"));
  });
});

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

describe("startAgent", () => {
  it("starts pi with --kind pi on the pane", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: "{}" }));
    await startAgent({ name: "scout-1", paneId: "w1:p9", piArgs: ["--model", "p/m"], exec });
    const start = calls[0]!;
    assert.deepEqual(start.args.slice(0, 7), ["agent", "start", "scout-1", "--kind", "pi", "--pane", "w1:p9"]);
    assert.deepEqual(start.args.slice(-3), ["--", "--model", "p/m"]);
  });

  it("retries briefly when a fresh pane is not yet an available shell", async () => {
    let attempts = 0;
    const { exec, calls } = fakeExec((_cmd, args) => {
      if (args[0] === "agent" && args[1] === "start") {
        attempts++;
        if (attempts === 1) return { code: 1, stderr: "agent target pane w1:p9 is not an available shell" };
        return { stdout: "{}" };
      }
      return undefined;
    });
    await startAgent({ name: "scout-1", paneId: "w1:p9", piArgs: [], exec, retryDelayMs: 1 });
    assert.equal(attempts, 2);
    assert.ok(calls.some((c) => c.args[1] === "start"));
  });


  it("waits for idle when startup reports agent_not_ready", async () => {
    const { exec, calls } = fakeExec((_cmd, args) => {
      if (args[0] === "agent" && args[1] === "start") return { code: 1, stderr: JSON.stringify({ error: { message: "agent_not_ready" } }) };
      if (args[0] === "agent" && args[1] === "wait") return { stdout: "{}" };
      return undefined;
    });
    await startAgent({ name: "scout-1", paneId: "w1:p9", piArgs: [], exec });
    const wait = calls.find((c) => c.args[1] === "wait")!;
    assert.ok(wait);
    assert.deepEqual(wait.args.slice(2, 6), ["scout-1", "--until", "idle", "--timeout"]);
  });

  it("surfaces other startup failures", async () => {
    const { exec } = fakeExec((_cmd, args) => {
      if (args[0] === "agent" && args[1] === "start") return { code: 1, stderr: "pane not available" };
      return undefined;
    });
    await assert.rejects(
      () => startAgent({ name: "scout-1", paneId: "w1:p9", piArgs: [], exec }),
      /agent start failed/,
    );
  });
});

describe("promptAndWait", () => {
  function scripted(stderr = "", code = 0, agentStatus = "done") {
    return fakeExec((_cmd, args) => {
      if (args[0] === "agent" && args[1] === "prompt") return { code, stderr };
      if (args[0] === "agent" && args[1] === "get") return agentList([]) && json({ result: { agent: { agent_status: agentStatus } } });
      return undefined;
    });
  }

  it("submits with --wait and reports the settled state", async () => {
    const { exec, calls } = scripted("", 0, "done");
    const outcome = await promptAndWait({ name: "scout-1", text: "do it", timeoutMs: 60_000, exec });
    assert.deepEqual(outcome, { state: "done", delivered: true });
    const prompt = calls.find((c) => c.args[1] === "prompt")!;
    assert.ok(prompt.args.includes("--wait"));
    assert.ok(prompt.args.includes("60000"));
  });

  it("reports agent_blocked as undelivered", async () => {
    const { exec } = scripted(JSON.stringify({ error: { message: "agent_blocked" } }), 1);
    const outcome = await promptAndWait({ name: "scout-1", text: "do it", timeoutMs: 60_000, exec });
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.state, "blocked");
  });

  it("reports timeouts as delivered but errored", async () => {
    const { exec } = scripted(JSON.stringify({ error: { message: "timeout after 60000ms" } }), 1, "working");
    const outcome = await promptAndWait({ name: "scout-1", text: "do it", timeoutMs: 60_000, exec });
    assert.equal(outcome.delivered, true);
    assert.match(outcome.error ?? "", /timeout/);
  });
});

describe("collectResult", () => {
  it("prefers the report file", async () => {
    const cwd = tmpCwd();
    try {
      const resultFile = path.join(cwd, ".pi", "herdr", "s-1.md");
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(resultFile, "# Report\nAll done.");
      const { exec, calls } = fakeExec(() => ({ stdout: "pane noise" }));
      const out = await collectResult({ handle: { ...stubHandle(cwd), resultFile }, exec });
      assert.deepEqual(out, { output: "# Report\nAll done.", source: "file" });
      assert.equal(calls.length, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to the pane read when no file exists", async () => {
    const cwd = tmpCwd();
    try {
      const { exec } = fakeExec((_cmd, args) => {
        if (args[0] === "agent" && args[1] === "read") return { stdout: "partial pane output\n" };
        return undefined;
      });
      const out = await collectResult({ handle: stubHandle(cwd), exec });
      assert.deepEqual(out, { output: "partial pane output", source: "pane" });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("caps pane captures to the tail so stale scrollback never flows into {previous}", async () => {
    const cwd = tmpCwd();
    try {
      const stale = "OLD-SESSION-NOISE-MARKER" + "x".repeat(17_000); // old session noise at the front
      const fresh = "FINAL-REPLY: T-DONE";
      const { exec } = fakeExec((_cmd, args) => {
        if (args[0] === "agent" && args[1] === "read") return { stdout: stale + fresh };
        return undefined;
      });
      const out = await collectResult({ handle: stubHandle(cwd), exec });
      assert.equal(out.source, "pane");
      assert.ok(out.output.length <= 8 * 1024 + 64, "output must be tail-capped");
      assert.ok(out.output.startsWith("…(earlier pane output truncated)"));
      assert.ok(out.output.endsWith(fresh), "the final reply must survive at the tail");
      assert.ok(!out.output.includes("OLD-SESSION-NOISE"), "the oldest front content must be dropped");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

describe("cancelAgent", () => {
  it("sends esc, then ctrl+c only when still working", async () => {
    let working = true;
    const { exec, calls } = fakeExec((_cmd, args) => {
      if (args[0] === "agent" && args[1] === "get") return json({ result: { agent: { agent_status: working ? "working" : "idle" } } });
      if (args[0] === "agent" && args[1] === "send-keys" && args[3] === "esc") working = false;
      return undefined;
    });
    await cancelAgent("scout-1", exec);
    const keys = calls.filter((c) => c.args[1] === "send-keys").map((c) => c.args[3]);
    assert.deepEqual(keys, ["esc"]);
  });
});

// ---------------------------------------------------------------------------
// Result building
// ---------------------------------------------------------------------------

function stubHandle(cwd = "/repo"): Parameters<typeof collectResult>[0]["handle"] {
  return {
    name: "scout-1",
    agentType: "scout",
    tabId: "w1:t9",
    paneId: "w1:p9",
    resultFile: path.join(cwd, ".pi", "herdr", "scout-1-x.md"),
    task: "find auth code",
    model: "zai-anthropic/glm-5",
    timeoutMs: 60_000,
    tabCreatedHere: true,
  };
}

describe("buildHerdrResult", () => {
  it("maps a settled done state to success with a synthetic assistant message", () => {
    const result = buildHerdrResult(stubHandle(), {
      state: "done", delivered: true, output: "# Report\ndone", outputSource: "file", durationMs: 1_500,
    });
    assert.equal(result.status, "success");
    assert.equal(result.exitCode, 0);
    assert.equal(isFailedResult(result), false);
    const text = (result.messages[0] as any)?.content?.[0]?.text;
    assert.equal(text, "# Report\ndone");
    assert.match(result.model ?? "", /herdr pane:scout-1/);
    assert.equal(result.durationMs, 1_500);
  });

  it("maps blocked to partial (needs human input, not a failure)", () => {
    const result = buildHerdrResult(stubHandle(), {
      state: "blocked", delivered: true, output: "", outputSource: "none", durationMs: 100,
    });
    assert.equal(result.status, "partial");
    assert.equal(result.stopReason, "blocked");
    assert.equal(isFailedResult(result), false);
    assert.match(result.errorMessage ?? "", /Blocked awaiting user input/);
  });

  it("maps timeouts to the canonical timeout status", () => {
    const result = buildHerdrResult(stubHandle(), {
      state: "unknown", delivered: true, error: "timeout after 60000ms", output: "", outputSource: "none", durationMs: 60_000,
    });
    assert.equal(result.status, "timeout");
    assert.equal(result.stopReason, "timeout");
    assert.equal(isFailedResult(result), true);
  });

  it("maps undelivered prompts to errors", () => {
    const result = buildHerdrResult(stubHandle(), {
      state: "unknown", delivered: false, error: "agent_prompt_stalled", output: "", outputSource: "none", durationMs: 5_000,
    });
    assert.equal(result.status, "error");
    assert.equal(isFailedResult(result), true);
  });

  it("delivered errors with a settled state never map to success", () => {
    for (const state of ["working", "idle", "done"] as const) {
      const result = buildHerdrResult(stubHandle(), {
        state, delivered: true, error: "spawn E2BIG", output: "", outputSource: "none", durationMs: 10,
      });
      assert.equal(result.status, "error", `state ${state}`);
      assert.equal(result.stopReason, "error", `state ${state}`);
      assert.equal(isFailedResult(result), true, `state ${state}`);
      assert.equal(result.errorMessage, "spawn E2BIG");
    }
  });

  it("never fabricates an empty success when the state read fails", () => {
    // Settled per the CLI, but agent get failed (unknown) and nothing collected.
    const result = buildHerdrResult(stubHandle(), {
      state: "unknown", delivered: true, output: "", outputSource: "none", durationMs: 100,
    });
    assert.equal(result.status, "error");
    assert.equal(isFailedResult(result), true);
    assert.match(result.errorMessage ?? "", /could not be verified/);
    // With a collected report the result is honestly successful.
    const withOutput = buildHerdrResult(stubHandle(), {
      state: "unknown", delivered: true, output: "# Report", outputSource: "file", durationMs: 100,
    });
    assert.equal(withOutput.status, "success");
  });
});

// ---------------------------------------------------------------------------
// High-level flow + registry
// ---------------------------------------------------------------------------

describe("prepareHerdrTask + executeHerdrTask", () => {
  beforeEach(() => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    clearHerdrRegistry();
  });
  afterEach(() => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;
    clearHerdrRegistry();
  });

  function happyExec() {
    return fakeExec((_cmd, args) => {
      if (args[0] === "agent" && args[1] === "list") return agentList([]);
      if (args[0] === "tab" && args[1] === "list") return tabList([]);
      if (args[0] === "tab" && args[1] === "create") return TAB_CREATE_OK;
      if (args[0] === "pane" && args[1] === "list") return paneList([{ tab_id: "w1:t9", pane_id: "w1:p9" }]);
      if (args[0] === "agent" && args[1] === "get") return json({ result: { agent: { agent_status: "done" } } });
      if (args[0] === "agent" && args[1] === "prompt") return { stdout: "{}" };
      if (args[0] === "agent" && args[1] === "start") return { stdout: "{}" };
      return undefined;
    });
  }

  it("runs the full dispatch → prompt → collect flow and records the registry entry", async () => {
    const cwd = tmpCwd();
    try {
      const { exec } = happyExec();
      const handle = await prepareHerdrTask({
        agentType: "scout",
        systemPrompt: "You are a scout.",
        task: "find auth code",
        cwd,
        model: "zai-anthropic/glm-5",
        timeoutMs: 60_000,
        exec,
      });
      assert.equal(handle.name, "scout-1");
      assert.equal(handle.tabId, "w1:t9");
      assert.ok(handle.resultFile.startsWith(path.join(cwd, ".pi", "herdr", "scout-1-")));
      // The report file lands before the prompt is submitted.
      fs.writeFileSync(handle.resultFile, "# Report\nfound 3 files");
      const result = await executeHerdrTask(handle, { exec });
      assert.equal(result.agent, "scout");
      assert.equal(result.status, "success");
      assert.equal((result.messages[0] as any)?.content?.[0]?.text, "# Report\nfound 3 files");
      const entries = getHerdrRegistry();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.name, "scout-1");
      assert.equal(isManagedHerdrTab("w1:t9"), true);
      assert.equal(isManagedHerdrTab("w9:t1"), false);
      forgetHerdrTab("w1:t9");
      assert.equal(getHerdrRegistry().length, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("marks adopted (label-matched) tabs as not ours to close", async () => {
    const cwd = tmpCwd();
    try {
      // Pre-existing tab labelled "scout" — dispatch adopts it, close-tab must not.
      const { exec, calls } = fakeExec((_cmd, args) => {
        if (args[0] === "agent" && args[1] === "list") return agentList([]);
        if (args[0] === "tab" && args[1] === "list") return tabList([{ label: "scout", tab_id: "w1:t1" }]);
        if (args[0] === "pane" && args[1] === "list") return paneList([{ tab_id: "w1:t1", pane_id: "w1:p1" }]);
        if (args[0] === "pane" && args[1] === "split") return SPLIT_OK;
        if (args[0] === "agent" && args[1] === "start") return { stdout: "{}" };
        return undefined;
      });
      const handle = await prepareHerdrTask({
        agentType: "scout", systemPrompt: "x", task: "t", cwd, model: "p/m", timeoutMs: 60_000, exec,
      });
      assert.equal(handle.tabId, "w1:t1");
      // The foreign free pane must NOT be reused — a fresh split carries the cwd.
      assert.equal(handle.paneId, "w1:p10");
      const split = calls.find((c) => c.args[1] === "split")!;
      assert.ok(split.args.includes("--cwd") && split.args.includes(cwd));
      assert.equal(handle.tabCreatedHere, false);
      assert.equal(canCloseHerdrTab(handle.name), false);
      // Mutating control actions scope to session-delegated agents only.
      assert.equal(isDelegatedHerdrAgent(handle.name), true);
      assert.equal(isDelegatedHerdrAgent("foreign-1"), false);
      assert.equal(isManagedHerdrTab("w1:t1"), true); // tracked, but…
      // …no `tab close` may be issued by close-tab eligibility for adopted tabs.
      assert.ok(!calls.some((c) => c.args[1] === "close"));
      // A tab this session created stays closable.
      assert.equal(canCloseHerdrTab("nobody-1"), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      clearHerdrRegistry();
    }
  });

  it("keeps created tabs closable", async () => {
    const cwd = tmpCwd();
    try {
      const { exec } = fakeExec((_cmd, args) => {
        if (args[0] === "agent" && args[1] === "list") return agentList([]);
        if (args[0] === "tab" && args[1] === "list") return tabList([]);
        if (args[0] === "tab" && args[1] === "create") return TAB_CREATE_OK;
        if (args[0] === "pane" && args[1] === "list") return paneList([{ tab_id: "w1:t9", pane_id: "w1:p9" }]);
        if (args[0] === "agent" && args[1] === "start") return { stdout: "{}" };
        return undefined;
      });
      const handle = await prepareHerdrTask({
        agentType: "scout", systemPrompt: "x", task: "t", cwd, model: "p/m", timeoutMs: 60_000, exec,
      });
      assert.equal(handle.tabCreatedHere, true);
      assert.equal(canCloseHerdrTab(handle.name), true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      clearHerdrRegistry();
    }
  });

  it("flags busy siblings sharing the tab, but not settled or other-tab ones", () => {
    const cwd = tmpCwd();
    try {
      const panes = ["w1:p9"];
      const occupied: string[] = [];
      const { exec } = fakeExec((_cmd, args) => {
        if (args[0] === "agent" && args[1] === "list") return agentList(occupied.map((pane) => ({ pane_id: pane })));
        if (args[0] === "tab" && args[1] === "list") return tabList([]);
        if (args[0] === "tab" && args[1] === "create") return TAB_CREATE_OK;
        if (args[0] === "pane" && args[1] === "split") {
          const id = `w1:p${9 + panes.length}`;
          panes.push(id);
          return json({ result: { pane: { pane_id: id } } });
        }
        if (args[0] === "pane" && args[1] === "list") return paneList(panes.map((pane) => ({ tab_id: "w1:t9", pane_id: pane })));
        if (args[0] === "agent" && args[1] === "start") { occupied.push(args[6]!); return { stdout: "{}" }; }
        return undefined;
      });
      const mk = (i: number) => prepareHerdrTask({
        agentType: "scout", systemPrompt: "x", task: `t${i}`, cwd, model: "p/m", timeoutMs: 60_000, exec,
      });
      return Promise.all([mk(1), mk(2), mk(3)]).then((handles) => {
        // scout-1: w1:p9 (root), scout-2: w1:p10, scout-3: w1:p11 (splits alternate)
        assert.deepEqual(handles.map((h) => h.paneId), ["w1:p9", "w1:p10", "w1:p11"]);
        const states = new Map<string, string | undefined>([
          ["w1:p10", "working"],   // busy sibling
          ["w1:p11", "done"],      // settled sibling
        ]);
        assert.deepEqual(busyHerdrSiblings(handles[0]!.name, states).sort(), [handles[1]!.name]);
        // Fail closed: unrecognized states count as busy.
        const novel = new Map<string, string | undefined>([
          ["w1:p10", "starting"],
          ["w1:p11", "done"],
        ]);
        assert.deepEqual(busyHerdrSiblings(handles[0]!.name, novel), [handles[1]!.name]);
        // unknown state counts as busy (safe default)
        assert.deepEqual(busyHerdrSiblings(handles[0]!.name, new Map()).length, 2);
        // a settled tab has no busy siblings
        const settled = new Map<string, string | undefined>([["w1:p10", "done"], ["w1:p11", "idle"]]);
        assert.deepEqual(busyHerdrSiblings(handles[0]!.name, settled), []);
        // unknown agent name → no siblings
        assert.deepEqual(busyHerdrSiblings("nobody-1", states), []);
      }).finally(() => {
        fs.rmSync(cwd, { recursive: true, force: true });
        clearHerdrRegistry();
      });
    } catch (err) {
      fs.rmSync(cwd, { recursive: true, force: true });
      throw err;
    }
  });

  it("herdrTabCloseBlockers: refuses a busy named agent, allows settled or missing self state", () => {
    const cwd = tmpCwd();
    try {
      const { exec } = fakeExec((_cmd, args) => {
        if (args[0] === "agent" && args[1] === "list") return agentList([]);
        if (args[0] === "tab" && args[1] === "list") return tabList([]);
        if (args[0] === "tab" && args[1] === "create") return TAB_CREATE_OK;
        if (args[0] === "pane" && args[1] === "list") return paneList([{ tab_id: "w1:t9", pane_id: "w1:p9" }]);
        if (args[0] === "agent" && args[1] === "start") return { stdout: "{}" };
        return undefined;
      });
      return prepareHerdrTask({
        agentType: "scout", systemPrompt: "x", task: "t", cwd, model: "p/m", timeoutMs: 60_000, exec,
      }).then((handle) => {
        // named agent busy → blocker
        let out = herdrTabCloseBlockers(handle.name, new Map([["w1:p9", "working"] as const]));
        assert.equal(out.self, "working");
        assert.deepEqual(out.siblings, []);
        out = herdrTabCloseBlockers(handle.name, new Map([["w1:p9", "blocked"] as const]));
        assert.equal(out.self, "blocked");
        // Fail closed: unrecognized states block too (raw state in the message).
        out = herdrTabCloseBlockers(handle.name, new Map([["w1:p9", "starting"] as const]));
        assert.equal(out.self, "starting");
        // settled or missing self state → no blocker (missing = pane already gone)
        for (const state of ["idle", "done", undefined]) {
          const map = state === undefined ? new Map() : new Map([["w1:p9", state] as const]);
          out = herdrTabCloseBlockers(handle.name, map);
          assert.equal(out.self, undefined, `state ${state}`);
        }
        // unknown agent → nothing blocks (close-tab's own registry check handles it)
        assert.deepEqual(herdrTabCloseBlockers("nobody-1", new Map()), { siblings: [], self: undefined });
      }).finally(() => {
        fs.rmSync(cwd, { recursive: true, force: true });
        clearHerdrRegistry();
      });
    } catch (err) {
      fs.rmSync(cwd, { recursive: true, force: true });
      throw err;
    }
  });

  it("rejects oversized tasks before touching herdr", async () => {
    const { exec, calls } = fakeExec(() => undefined);
    await assert.rejects(
      () => prepareHerdrTask({
        agentType: "scout",
        systemPrompt: "x",
        task: "x".repeat(MAX_HERDR_TASK_BYTES + 1),
        cwd: "/repo",
        model: "p/m",
        timeoutMs: 60_000,
        exec,
      }),
      /exceeds/,
    );
    assert.equal(calls.length, 0);
  });

  it("interrupts the agent and reports timeout when the wait expires", async () => {
    const cwd = tmpCwd();
    try {
      const { exec, calls } = fakeExec((_cmd, args) => {
        if (args[0] === "agent" && args[1] === "list") return agentList([]);
        if (args[0] === "tab" && args[1] === "list") return tabList([]);
        if (args[0] === "tab" && args[1] === "create") return TAB_CREATE_OK;
        if (args[0] === "pane" && args[1] === "list") return paneList([{ tab_id: "w1:t9", pane_id: "w1:p9" }]);
        if (args[0] === "agent" && args[1] === "start") return { stdout: "{}" };
        if (args[0] === "agent" && args[1] === "prompt") {
          return { code: 1, stderr: JSON.stringify({ error: { message: "timeout after 60000ms" } }) };
        }
        if (args[0] === "agent" && args[1] === "get") return json({ result: { agent: { agent_status: "working" } } });
        return undefined;
      });
      const handle = await prepareHerdrTask({
        agentType: "scout", systemPrompt: "x", task: "long task", cwd, model: "p/m", timeoutMs: 60_000, exec,
      });
      const result: SubAgentResult = await executeHerdrTask(handle, { exec });
      assert.equal(result.status, "timeout");
      assert.ok(calls.some((c) => c.args[1] === "send-keys" && c.args[3] === "esc"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("maps an aborted signal to status aborted — never success", async () => {
    const cwd = tmpCwd();
    try {
      const { exec, calls } = fakeExec((_cmd, args) => {
        if (args[0] === "agent" && args[1] === "list") return agentList([]);
        if (args[0] === "tab" && args[1] === "list") return tabList([]);
        if (args[0] === "tab" && args[1] === "create") return TAB_CREATE_OK;
        if (args[0] === "pane" && args[1] === "list") return paneList([{ tab_id: "w1:t9", pane_id: "w1:p9" }]);
        if (args[0] === "agent" && args[1] === "start") return { stdout: "{}" };
        // Child settles to idle after the abort's esc — must still map to aborted.
        if (args[0] === "agent" && args[1] === "get") return json({ result: { agent: { agent_status: "idle" } } });
        if (args[0] === "agent" && args[1] === "prompt") return { stdout: "{}" };
        return undefined;
      });
      const handle = await prepareHerdrTask({
        agentType: "scout", systemPrompt: "x", task: "t", cwd, model: "p/m", timeoutMs: 60_000, exec,
      });
      const controller = new AbortController();
      controller.abort(); // aborted at prompt time — the esc wiring fires in the caller
      const result = await executeHerdrTask(handle, { exec, signal: controller.signal });
      assert.equal(result.status, "aborted");
      assert.equal(result.stopReason, "aborted");
      assert.equal(result.exitCode, 1);
      assert.equal(isFailedResult(result), true);
      assert.match(result.errorMessage ?? "", /Cancelled/);
      // A pre-aborted dispatch must never submit the task to the live child.
      assert.ok(!calls.some((c) => c.args[1] === "prompt"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      clearHerdrRegistry();
    }

  });

  it("merges live herdr names into allocation to avoid cross-session collisions", async () => {
    const cwd = tmpCwd();
    try {
      const { exec } = fakeExec((_cmd, args) => {
        if (args[0] === "agent" && args[1] === "list") return agentList([{ name: "scout-1" }, { name: "scout-2" }]);
        if (args[0] === "tab" && args[1] === "list") return tabList([]);
        if (args[0] === "tab" && args[1] === "create") return TAB_CREATE_OK;
        if (args[0] === "pane" && args[1] === "list") return paneList([{ tab_id: "w1:t9", pane_id: "w1:p9" }]);
        if (args[0] === "agent" && args[1] === "start") return { stdout: "{}" };
        return undefined;
      });
      const handle = await prepareHerdrTask({
        agentType: "scout", systemPrompt: "x", task: "t", cwd, model: "p/m", timeoutMs: 60_000, exec,
      });
      assert.equal(handle.name, "scout-3");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("retries past a name collision avoiding live herdr names too", async () => {
    const cwd = tmpCwd();
    try {
      let listCalls = 0;
      let startCalls = 0;
      const { exec, calls } = fakeExec((_cmd, args) => {
        if (args[0] === "agent" && args[1] === "list") {
          listCalls++;
          // Another session holds scout-1; after our first start fails, it also holds scout-2.
          return agentList(listCalls === 1 ? [{ name: "scout-1" }] : [{ name: "scout-1" }, { name: "scout-2" }]);
        }
        if (args[0] === "tab" && args[1] === "list") return tabList([]);
        if (args[0] === "tab" && args[1] === "create") return TAB_CREATE_OK;
        if (args[0] === "pane" && args[1] === "list") return paneList([{ tab_id: "w1:t9", pane_id: "w1:p9" }]);
        if (args[0] === "agent" && args[1] === "start") {
          startCalls++;
          if (startCalls === 1) return { code: 1, stderr: JSON.stringify({ error: { message: "agent name scout-2 is already used" } }) };
          return { stdout: "{}" };
        }
        return undefined;
      });
      const handle = await prepareHerdrTask({
        agentType: "scout", systemPrompt: "x", task: "t", cwd, model: "p/m", timeoutMs: 60_000, exec,
      });
      assert.equal(startCalls, 2);
      assert.equal(handle.name, "scout-3"); // avoids live scout-1 AND collided scout-2
      assert.ok(calls.some((c) => c.args[1] === "start" && c.args[2] === "scout-2"));
      assert.ok(calls.some((c) => c.args[1] === "start" && c.args[2] === "scout-3"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      clearHerdrRegistry();
    }
  });

  it("caps oversized report files with a truncation marker", async () => {
    const cwd = tmpCwd();
    try {
      const resultFile = path.join(cwd, ".pi", "herdr", "big.md");
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(resultFile, Buffer.alloc(300 * 1024, 97)); // 300KB of 'a'
      const { exec } = fakeExec(() => ({ stdout: "" }));
      const out = await collectResult({ handle: { ...stubHandle(cwd), resultFile }, exec });
      assert.equal(out.source, "file");
      assert.ok(out.output.length <= 256 * 1024 + 64);
      assert.ok(out.output.endsWith("…(truncated)"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });


  it("lists live agent names defensively", async () => {
    const { exec } = fakeExec((_cmd, args) => {
      if (args[0] === "agent" && args[1] === "list") return agentList([{ name: "a-1", pane_id: "p1" }, { pane_id: "p2" }]);
      return undefined;
    });
    assert.deepEqual(await liveAgentNames(exec), ["a-1"]);
  });
});
