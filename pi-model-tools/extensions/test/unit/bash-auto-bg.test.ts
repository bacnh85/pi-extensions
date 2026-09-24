import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import {
  autoBgEnabled,
  autoBgThresholdSecs,
  bashAutoBgClause,
  wrapWithAutoBg,
  abortAllBgJobs,
  setBgDeliveryEnabled,
  bgJobCount,
  activeBgLogPaths,
  type AutoBgDeps,
} from "../../lib/bash-auto-bg.ts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

/**
 * Controllable fake BashOperations. Models the real local ops' abort contract:
 * a fired signal rejects the pending exec with Error("aborted").
 */
function makeFakeOps() {
  type Pending = { resolve: (r: { exitCode: number | null }) => void; reject: (e: Error) => void; options: any };
  const pending: Pending[] = [];
  const ops: BashOperations = {
    exec: (command: string, cwd: string, options: any) =>
      new Promise<{ exitCode: number | null }>((resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        pending.push({ resolve, reject, options });
      }),
  };
  return { ops, pending };
}

function makeDeps(thresholdSecs = 0.05): { pi: any; deps: AutoBgDeps; messages: Array<{ message: any; options: any }> } {
  const messages: Array<{ message: any; options: any }> = [];
  const pi = {
    sendMessage(message: unknown, options: unknown) {
      messages.push({ message, options });
    },
  };
  return { pi, deps: { pi: pi as any, thresholdSecs }, messages };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Logs the lib deliberately KEEPS (truncated ≥5MB) outlive the job by design —
// track the ones our tests create and remove them at suite end so runs don't
// leak 5MB files into the shared tmpdir.
const keptLogs: string[] = [];
after(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(keptLogs.map((l) => rm(l, { force: true }).catch(() => {})));
});

describe("bash auto-background config toggles", () => {
  it("autoBgEnabled defaults off, enabled by true-like values", () => {
    assert.equal(autoBgEnabled({}), false);
    assert.equal(autoBgEnabled({ PI_MODEL_TOOLS_BASH_AUTO_BG: "0" }), false);
    assert.equal(autoBgEnabled({ PI_MODEL_TOOLS_BASH_AUTO_BG: "1" }), true);
    assert.equal(autoBgEnabled({ PI_MODEL_TOOLS_BASH_AUTO_BG: "yes" }), true);
  });

  it("autoBgThresholdSecs defaults 120, floors invalid values, accepts valid", () => {
    assert.equal(autoBgThresholdSecs({}), 120);
    assert.equal(autoBgThresholdSecs({ PI_MODEL_TOOLS_BASH_AUTO_BG_SECS: "0" }), 120);
    assert.equal(autoBgThresholdSecs({ PI_MODEL_TOOLS_BASH_AUTO_BG_SECS: "abc" }), 120);
    assert.equal(autoBgThresholdSecs({ PI_MODEL_TOOLS_BASH_AUTO_BG_SECS: "30.9" }), 30);
    assert.equal(autoBgThresholdSecs({ PI_MODEL_TOOLS_BASH_AUTO_BG_SECS: "0.5" }), 1, "fractional floors to 0 → clamped to 1");
  });
});

describe("bashAutoBgClause", () => {
  it("OFF variant: anti-poll guidance, no wake promise", () => {
    const c = bashAutoBgClause(false, 120);
    assert.match(c, /NEVER wait by looping/);
    assert.match(c, /nohup/);
    assert.doesNotMatch(c, /you will be woken/);
  });

  it("ON variant: OMP wake contract and threshold", () => {
    const c = bashAutoBgClause(true, 90);
    assert.match(c, /~90s auto-background/);
    assert.match(c, /NEVER poll a backgrounded job/);
    assert.match(c, /you will be woken with its output/);
    assert.match(c, /total-runtime kill/);
  });

  it("both variants are deterministic single strings (cache-stable description head)", () => {
    assert.equal(bashAutoBgClause(true, 120), bashAutoBgClause(true, 120));
    assert.equal(bashAutoBgClause(false, 120), bashAutoBgClause(false, 120));
  });
});

describe("wrapWithAutoBg", () => {
  // Leftover backgrounded jobs share one module-level registry — abort them so
  // the 4-job cap never leaks across tests.
  afterEach(() => abortAllBgJobs());

  it("fast command: passthrough result, no receipt, no registry entry", async () => {
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps();
    const wrapped = wrapWithAutoBg(ops, deps);
    const p = wrapped.exec("echo hi", "/tmp", { onData: () => {}, timeout: undefined, env: {} });
    await sleep(5);
    assert.equal(pending.length, 1);
    assert.equal(bgJobCount(), 0);
    pending[0].resolve({ exitCode: 0 });
    assert.equal((await p).exitCode, 0);
    assert.equal(messages.length, 0);
    assert.equal(bgJobCount(), 0);
  });

  it("threshold hit: receipt in tool output, completion follow-up with output tail", async () => {
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, deps);
    const chunks: Buffer[] = [];
    const p = wrapped.exec("sleep 30 && echo done", "/tmp", { onData: (d: Buffer) => chunks.push(d), timeout: undefined, env: {} });

    await sleep(100); // cross the threshold
    assert.equal(bgJobCount(), 1, "job registered");
    assert.equal(messages.length, 0, "no separate receipt message — receipt rides the tool output");
    const receipt = Buffer.concat(chunks).toString("utf8");
    assert.match(receipt, /Backgrounded as job bg-\d+/);
    assert.match(receipt, /NEVER poll/);
    assert.match(receipt, /you will be woken with its output/);
    pending[0].options.onData(Buffer.from("partial out\n")); // post-background output → tail

    pending[0].resolve({ exitCode: 3 });
    assert.equal((await p).exitCode, 0, "receipt resolves exit 0");
    await sleep(10);
    assert.equal(bgJobCount(), 0, "job removed on completion");
    assert.equal(messages.length, 1, "exactly one wake-up: the completion");
    const { message, options } = messages[0];
    assert.match(message.content, /finished \(exit 3\)/);
    assert.match(message.content, /partial out/);
    assert.equal(options.deliverAs, "followUp");
    assert.equal(options.triggerTurn, true);
    assert.equal(message.display, true);
  });

  it("exec failure after backgrounding: failure follow-up with timeout translation", async () => {
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, deps);
    const p = wrapped.exec("sleep 30", "/tmp", { onData: () => {}, timeout: 5, env: {} });
    await sleep(100);
    assert.equal(bgJobCount(), 1);
    assert.equal((await p).exitCode, 0);

    pending[0].reject(new Error("timeout:5"));
    await sleep(10);
    assert.equal(messages.length, 1);
    assert.match(messages[0].message.content, /timed out after 5 seconds/);
  });

  it("concurrent cap: jobs over cap stay foreground (no receipt)", async () => {
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, { ...deps, maxConcurrent: 2 });
    const chunks = [0, 1, 2].map(() => [] as Buffer[]);
    const ps = [0, 1, 2].map((i) => wrapped.exec(`cmd-${i}`, "/tmp", { onData: (d: Buffer) => chunks[i].push(d), timeout: undefined, env: {} }));
    await sleep(100);
    assert.equal(bgJobCount(), 2, "cap respected");
    const text = (i: number) => Buffer.concat(chunks[i]).toString("utf8");
    assert.match(text(0), /Backgrounded as job bg-\d+/);
    assert.match(text(1), /Backgrounded as job bg-\d+/);
    assert.doesNotMatch(text(2), /Backgrounded/, "over-cap job stays foreground");

    // The foreground job completes first: passthrough, no message.
    pending[2].resolve({ exitCode: 0 });
    assert.equal((await ps[2]).exitCode, 0);
    assert.equal(messages.length, 0, "foreground completion does not message");
    pending[0].resolve({ exitCode: 0 });
    pending[1].resolve({ exitCode: 0 });
    await sleep(10);
    assert.equal(messages.length, 2, "both background jobs delivered wake-ups");
  });

  it("tool-signal abort during foreground wait rejects; after backgrounding abort is a no-op", async () => {
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, deps);

    // Foreground phase: abort propagates to the ops signal and rejects the tool call.
    const controllerA = new AbortController();
    const pa = wrapped.exec("a", "/tmp", { onData: () => {}, signal: controllerA.signal, timeout: undefined, env: {} });
    await sleep(5);
    assert.equal(pending.length, 1);
    controllerA.abort();
    await assert.rejects(pa, /aborted/);
    assert.ok(pending[0].options.signal.aborted, "abort forwarded to real exec");

    // Background phase: aborting the (already settled) tool signal changes nothing.
    const controllerB = new AbortController();
    const pb = wrapped.exec("b", "/tmp", { onData: () => {}, signal: controllerB.signal, timeout: undefined, env: {} });
    await sleep(100);
    assert.equal(bgJobCount(), 1);
    assert.equal((await pb).exitCode, 0, "receipt already resolved");
    const bgSignal = pending[1].options.signal as AbortSignal;
    controllerB.abort();
    assert.ok(!bgSignal.aborted, "tool abort NOT forwarded after backgrounding");
    pending[1].resolve({ exitCode: 0 });
    await sleep(10);
    assert.equal(messages.length, 1, "completion still delivered");
  });

  it("abortAllBgJobs aborts live background execs → failure follow-ups", async () => {
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, deps);
    const p = wrapped.exec("sleep 30", "/tmp", { onData: () => {}, timeout: undefined, env: {} });
    await sleep(100);
    assert.equal(bgJobCount(), 1);
    abortAllBgJobs();
    assert.equal(bgJobCount(), 0);
    await sleep(10);
    assert.equal(messages.length, 1);
    assert.match(messages[0].message.content, /Background job bg-\d+ failed: aborted/);
    // The receipt promise already resolved; nothing hangs.
    assert.equal((await p).exitCode, 0);
  });
});

describe("bash auto-bg reviewer round (hardening)", () => {
  // Leftover backgrounded jobs share one module-level registry — abort them so
  // the 4-job cap never leaks across tests. Delivery gate reset per test.
  afterEach(() => {
    abortAllBgJobs(true);
    setBgDeliveryEnabled(true);
  });

  it("abortAllBgJobs(suppressDelivery) delivers nothing (session_shutdown path)", async () => {
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, deps);
    const p = wrapped.exec("sleep 30", "/tmp", { onData: () => {}, timeout: undefined, env: {} });
    await sleep(100);
    assert.equal(bgJobCount(), 1);
    assert.equal((await p).exitCode, 0);
    abortAllBgJobs(true);
    await sleep(10);
    assert.equal(bgJobCount(), 0);
    assert.equal(messages.length, 0, "no wake-up fired into a shutting-down session");
  });

  it("setBgDeliveryEnabled(false) gates completion wake-ups", async () => {
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, deps);
    const p = wrapped.exec("sleep 30", "/tmp", { onData: () => {}, timeout: undefined, env: {} });
    await sleep(100);
    assert.equal((await p).exitCode, 0);
    setBgDeliveryEnabled(false);
    pending[0].resolve({ exitCode: 0 });
    await sleep(10);
    assert.equal(messages.length, 0, "gated completion delivers nothing");
  });

  it("completion wake-up tail excludes the receipt boilerplate; null exitCode branch covered", async () => {
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, deps);
    const p = wrapped.exec("sleep 30", "/tmp", { onData: () => {}, timeout: undefined, env: {} });
    await sleep(100);
    assert.equal(bgJobCount(), 1);
    pending[0].options.onData(Buffer.from("real output\n"));
    pending[0].resolve({ exitCode: null });
    assert.equal((await p).exitCode, 0);
    await sleep(10);
    assert.equal(messages.length, 1);
    const content = String(messages[0].message.content);
    assert.match(content, /terminated without an exit code/);
    assert.match(content, /real output/);
    const tailBlock = content.split("Output (tail):")[1] ?? "";
    assert.ok(tailBlock, "tail block present");
    assert.doesNotMatch(tailBlock, /Backgrounded as job/, "receipt boilerplate must not re-enter the wake-up tail");
  });

  it("on-disk log: random filename, owner-only perms, content written, deleted after wake-up", async () => {
    const { stat, readFile } = await import("node:fs/promises");
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, deps);
    const p = wrapped.exec("sleep 30", "/tmp", { onData: () => {}, timeout: undefined, env: {} });
    await sleep(100);
    assert.equal(bgJobCount(), 1);
    const logs = activeBgLogPaths();
    assert.equal(logs.length, 1, "one live job log");
    const logPath = logs[0];
    assert.match(logPath, /pi-model-tools-bg-[0-9a-f-]{36}\.log$/, "filename carries a randomUUID component");
    pending[0].options.onData(Buffer.from("log line\n"));
    await sleep(30); // allow the async open + write to land
    const st = await stat(logPath);
    assert.equal(st.mode & 0o777, 0o600, "log is owner-only (0600)");
    assert.equal((await readFile(logPath, "utf8")).includes("log line"), true, "post-background output reached the log");
    // Non-truncated log is removed once the wake-up carries the tail.
    pending[0].resolve({ exitCode: 0 });
    await p;
    await sleep(30);
    await assert.rejects(stat(logPath), /ENOENT/, "log deleted after wake-up");
  });

  it("job finishing before the async log open() resolves leaves no log file (j.finished race)", async () => {
    const { stat } = await import("node:fs/promises");
    const { ops, pending } = makeFakeOps();
    const { pi, deps } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, deps);

    const p = wrapped.exec("instant job", "/tmp", { onData: () => {}, timeout: undefined, env: {} });
    await sleep(100); // threshold fires → backgrounded, open() still in flight
    const logPath = activeBgLogPaths()[0];
    // Resolve the exec IMMEDIATELY — finishJob runs before open()'s .then does.
    pending[0].resolve({ exitCode: 0 });
    await p;
    // Wait past the threshold timer AND a tick so the racing open() has landed.
    await sleep(100);
    assert.equal(bgJobCount(), 0, "registry empty");
    await assert.rejects(stat(logPath), /ENOENT/, "no log file remains — race closed the fd and removed it");
  });
});

describe("bash auto-bg log size cap", () => {
  afterEach(() => {
    abortAllBgJobs(true);
    setBgDeliveryEnabled(true);
  });

  it("chatty job: log capped, wake-up notes truncation", async () => {
    const { stat } = await import("node:fs/promises");
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, deps);
    const p = wrapped.exec("yes | head -c 20m", "/tmp", { onData: () => {}, timeout: undefined, env: {} });
    await sleep(100);
    assert.equal(bgJobCount(), 1);
    const mb = Buffer.alloc(1024 * 1024, "x");
    for (let i = 0; i < 10; i++) pending[0].options.onData(mb); // 10MB after backgrounding
    pending[0].resolve({ exitCode: 0 });
    assert.equal((await p).exitCode, 0);
    await sleep(50);
    const content = String(messages[0].message.content);
    assert.match(content, /Full log \(kept, truncated at 5120KB\)/, "wake-up notes the cap");
    const logPath = content.match(/truncated at 5120KB\): (.+)$/m)![1];
    const st = await stat(logPath);
    assert.ok(st.size <= 5 * 1024 * 1024 + 1024 * 1024, `log bounded (got ${st.size})`);
    keptLogs.push(logPath); // ≤ cap + one chunk overshoot
  });
});

describe("bash auto-bg reviewer round 2 (foreground output + log lifecycle)", () => {
  afterEach(() => {
    abortAllBgJobs(true);
    setBgDeliveryEnabled(true);
  });

  it("fast command: pre-threshold chunks stream to caller unchanged", async () => {
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps();
    const wrapped = wrapWithAutoBg(ops, deps);
    const chunks: Buffer[] = [];
    const p = wrapped.exec("echo hi", "/tmp", { onData: (d: Buffer) => chunks.push(d), timeout: undefined, env: {} });
    await sleep(5);
    pending[0].options.onData(Buffer.from("early "));
    pending[0].options.onData(Buffer.from("output\n"));
    pending[0].resolve({ exitCode: 0 });
    await p;
    assert.equal(Buffer.concat(chunks).toString("utf8"), "early output\n", "foreground chunks reach the caller");
    assert.equal(messages.length, 0);
  });

  it("backgrounded job: pre-threshold output seeds the wake-up tail", async () => {
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, deps);
    const chunks: Buffer[] = [];
    const p = wrapped.exec("slow", "/tmp", { onData: (d: Buffer) => chunks.push(d), timeout: undefined, env: {} });
    pending[0].options.onData(Buffer.from("pre-threshold out\n")); // BEFORE threshold
    await sleep(100); // crosses the threshold → backgrounded
    assert.equal(bgJobCount(), 1);
    pending[0].resolve({ exitCode: 0 });
    await p;
    await sleep(10);
    assert.equal(messages.length, 1);
    const content = String(messages[0].message.content);
    assert.match(content, /pre-threshold out/, "wake-up includes output the model already saw");
    // The pre-threshold chunk was ALSO forwarded live (exactly once).
    assert.equal(Buffer.concat(chunks).toString("utf8").split("pre-threshold out\n").length - 1, 1, "forwarded exactly once");
  });

  it("non-truncated log removed at completion; truncated log kept", async () => {
    const { stat } = await import("node:fs/promises");
    const { ops, pending } = makeFakeOps();
    const { pi, deps, messages } = makeDeps(0.05);
    const wrapped = wrapWithAutoBg(ops, deps);

    // Non-truncated: file deleted after wake-up.
    const p1 = wrapped.exec("quiet job", "/tmp", { onData: () => {}, timeout: undefined, env: {} });
    await sleep(100);
    const log1 = activeBgLogPaths()[0];
    pending[0].resolve({ exitCode: 0 });
    await p1;
    await sleep(30);
    await assert.rejects(stat(log1), /ENOENT/, "non-truncated log removed");

    // Truncated: file kept and advertised.
    const p2 = wrapped.exec("chatty job", "/tmp", { onData: () => {}, timeout: undefined, env: {} });
    await sleep(100);
    const log2 = activeBgLogPaths()[0];
    const mb = Buffer.alloc(1024 * 1024, "x");
    for (let i = 0; i < 6; i++) pending[1].options.onData(mb);
    pending[1].resolve({ exitCode: 0 });
    await p2;
    await sleep(30);
    const content = String(messages[1].message.content);
    assert.match(content, /Full log \(kept, truncated at 5120KB\)/);
    await stat(log2); // must still exist
    keptLogs.push(log2);
  });
});
