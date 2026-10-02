import { assert } from "chai";
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { DEFAULTS } from "./helpers";
import { makeTempDir } from "./tmp";
import { a2aCall, a2aList, drainQueue, metrics } from "../lib/client";
import { A2AServer, type SessionRunner } from "../lib/server";
import { loadQueue, queueDir } from "../lib/queue";
import { STATE_COMPLETED } from "../lib/protocol";
import type { A2AConfig } from "../lib/config";

// ---------------------------------------------------------------------------
// fetch mock: scripted POST outcomes, every request recorded.
// ---------------------------------------------------------------------------

type Step =
  | { kind: "down"; code?: string }                         // connection refused
  | { kind: "http"; status: number; headers?: Record<string, string>; body?: any }
  | { kind: "hang" }                                         // never answers (client timeout)
  | { kind: "ok"; reply?: string };

interface Posted { url: string; messageId: string; text: string; body: any; headers: Record<string, string> }

function resp(body: any, status = 200, headers: Record<string, string> = {}): any {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => text,
  };
}

function installFetch(script: Step[] | (() => Step)) {
  const posts: Posted[] = [];
  let i = 0;
  const next = typeof script === "function" ? script : () => script[Math.min(i++, script.length - 1)]!;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if ((init?.method ?? "GET") !== "POST") return resp({}, 404); // card discovery → tolerated miss
    const body = JSON.parse(init.body);
    posts.push({
      url: u,
      messageId: body.params?.message?.messageId,
      text: body.params?.message?.parts?.[0]?.text,
      body,
      headers: init.headers,
    });
    const step = next();
    if (step.kind === "down") {
      const err: any = new TypeError("fetch failed");
      err.cause = { code: step.code ?? "ECONNREFUSED" };
      throw err;
    }
    if (step.kind === "hang") {
      return new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    if (step.kind === "http") {
      return resp(step.body ?? { jsonrpc: "2.0", id: 1, error: { code: -32000, message: `status ${step.status}` } }, step.status, step.headers);
    }
    const task = { id: "peer-task-1", contextId: body.params.message.contextId, status: { state: STATE_COMPLETED }, artifacts: [{ artifactId: "a", parts: [{ text: step.reply ?? "pong", mediaType: "text/plain" }] }] };
    return resp({ jsonrpc: "2.0", id: body.id, result: { task } });
  }) as any;
  return posts;
}

function cfgFor(queue: Partial<A2AConfig["queue"]> = {}): A2AConfig {
  const c = DEFAULTS();
  c.queue = { ...c.queue, enabled: true, baseDelayMs: 1000, maxDelayMs: 8000, ...queue };
  c.peers = {
    alpha: { url: "http://127.0.0.1:9", auth: { type: "bearer", token: "SECRET-PEER-TOKEN-123" }, timeout: 150, capabilities: [] },
  };
  return c;
}

describe("client: outbound queue", () => {
  let originalFetch: typeof globalThis.fetch;
  let piDir: string;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    piDir = makeTempDir("pi-a2a-qclient-");
    metrics.reset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch as any;
  });

  it("disabled (default): identical to pre-queue behavior — one POST, no queue dir, original error text", async () => {
    const cfg = cfgFor({ enabled: false });
    const posts = installFetch([{ kind: "down" }]);
    const out = await a2aCall({ cfg, piDir, agent: "alpha", message: "hi" });
    assert.equal(posts.length, 1);
    assert.equal(out, "Error: call to 'alpha' failed — connection failed — fetch failed");
    assert.isFalse(existsSync(queueDir(piDir)));
    // success path unchanged too
    installFetch([{ kind: "ok", reply: "hello back" }]);
    const ok = await a2aCall({ cfg, piDir, agent: "alpha", message: "hi" });
    assert.match(ok, /hello back/);
    assert.isFalse(existsSync(queueDir(piDir)));
  });

  it("persist-before-send: entry (messageId + redacted text) is on disk at POST time; success removes it", async () => {
    const cfg = cfgFor();
    let onDiskAtPost: any;
    const posts = installFetch(() => {
      onDiskAtPost = loadQueue(piDir);
      return { kind: "ok" };
    });
    const out = await a2aCall({ cfg, piDir, agent: "alpha", message: "ship it" });
    assert.match(out, /pong/);
    assert.equal(posts.length, 1);
    assert.lengthOf(onDiskAtPost, 1);
    assert.equal(onDiskAtPost[0].messageId, posts[0]!.messageId);
    assert.equal(onDiskAtPost[0].message, "ship it");
    assert.deepEqual(loadQueue(piDir), [], "delivered → entry removed");
  });

  it("never persists credentials, and persists only the REDACTED text", async () => {
    const cfg = cfgFor();
    installFetch([{ kind: "down" }]);
    await a2aCall({ cfg, piDir, agent: "alpha", message: "key sk-test-abcdEFGH01234567JKLM please" });
    const files = readdirSync(queueDir(piDir)).filter((f) => f.endsWith(".json"));
    assert.lengthOf(files, 1);
    const raw = readFileSync(join(queueDir(piDir), files[0]!), "utf-8");
    assert.notInclude(raw, "SECRET-PEER-TOKEN-123");
    assert.notInclude(raw, "sk-test-abcdEFGH01234567JKLM");
  });

  it("receiver down → 'queued' result; later drain delivers with the SAME messageId; reply lands in history", async () => {
    const cfg = cfgFor();
    let t = 1_000_000;
    const now = () => t;
    const posts = installFetch([{ kind: "down" }, { kind: "ok", reply: "finally" }]);
    const first = await a2aCall({ cfg, piDir, agent: "alpha", message: "do work", contextId: "ctx-keep" });
    assert.match(first, /\[A2A → alpha · context ctx-keep · queued\]/);
    assert.match(first, /retried in the background/);
    const [pending] = loadQueue(piDir);
    assert.equal(pending!.attempts, 1);
    assert.equal(pending!.messageId, posts[0]!.messageId);

    // not due yet → no attempt
    let r = await drainQueue({ cfg, piDir, now: () => pending!.nextAttemptAt - 1 });
    assert.equal(r.delivered + r.retried + r.dropped, 0);
    assert.equal(posts.length, 1);

    // due → delivered, same messageId, entry gone
    t = pending!.nextAttemptAt + 1;
    const events: string[] = [];
    r = await drainQueue({ cfg, piDir, now, onEvent: (e) => events.push(e.type) });
    assert.equal(r.delivered, 1);
    assert.deepEqual(events, ["delivered"]);
    assert.equal(posts.length, 2);
    assert.equal(posts[1]!.messageId, posts[0]!.messageId, "retry must reuse the messageId");
    assert.equal(posts[1]!.text, "do work");
    assert.deepEqual(loadQueue(piDir), []);
    const convo = readFileSync(join(piDir, "a2a_conversations", "ctx-keep.jsonl"), "utf-8");
    assert.include(convo, "finally");
  });

  it("restart resume: a brand-new drain (new cfg object, no in-memory state) delivers what a previous run queued", async () => {
    installFetch([{ kind: "down" }]);
    await a2aCall({ cfg: cfgFor(), piDir, agent: "alpha", message: "survive restart" });
    assert.lengthOf(loadQueue(piDir), 1);
    const posts = installFetch([{ kind: "ok" }]);
    const r = await drainQueue({ cfg: cfgFor(), piDir, now: () => Date.now() + 10_000 });
    assert.equal(r.delivered, 1);
    assert.equal(posts[0]!.text, "survive restart");
    assert.deepEqual(loadQueue(piDir), []);
  });

  it("retries 5xx and 429; honors Retry-After; reuses messageId throughout", async () => {
    const cfg = cfgFor();
    const posts = installFetch([
      { kind: "http", status: 503 },
      { kind: "http", status: 429, headers: { "retry-after": "120" } },
      { kind: "ok" },
    ]);
    const first = await a2aCall({ cfg, piDir, agent: "alpha", message: "x" });
    assert.match(first, /queued/);
    let [e] = loadQueue(piDir);
    const t0 = Date.now();
    let r = await drainQueue({ cfg, piDir, now: () => e!.nextAttemptAt + 1 });
    assert.equal(r.retried, 1, "429 is retryable");
    [e] = loadQueue(piDir);
    assert.isAtLeast(e!.nextAttemptAt - (t0 - 5), 120_000 - 6_000, "Retry-After: 120s must push the next attempt out");
    r = await drainQueue({ cfg, piDir, now: () => e!.nextAttemptAt + 1 });
    assert.equal(r.delivered, 1);
    assert.lengthOf(new Set(posts.map((p) => p.messageId)), 1);
    assert.equal(posts.length, 3);
  });

  it("does NOT retry 4xx (400/401/404): one POST, original-style error, nothing queued", async () => {
    const cfg = cfgFor();
    for (const status of [400, 401, 404]) {
      const posts = installFetch([{ kind: "http", status }]);
      const out = await a2aCall({ cfg, piDir, agent: "alpha", message: `m${status}` });
      assert.match(out, /^Error:/, String(status));
      assert.equal(posts.length, 1);
      assert.deepEqual(loadQueue(piDir), [], `${status} must not stay queued`);
    }
  });

  it("timeout then success: the retry carries the same messageId (duplicate avoidance)", async () => {
    const cfg = cfgFor();
    const posts = installFetch([{ kind: "hang" }, { kind: "ok" }]);
    const first = await a2aCall({ cfg, piDir, agent: "alpha", message: "slow one" });
    assert.match(first, /queued/);
    assert.match(first, /reply timed out after 150ms; delivery status unknown/);
    const [e] = loadQueue(piDir);
    const r = await drainQueue({ cfg, piDir, now: () => e!.nextAttemptAt + 1 });
    assert.equal(r.delivered, 1);
    assert.equal(posts.length, 2);
    assert.equal(posts[0]!.messageId, posts[1]!.messageId);
    // metrics count one logical send, not one per attempt
    assert.equal(metrics.outboundTotal, 1);
  });

  it("size bound: when full a new message is sent once WITHOUT queueing (accepted entries are never evicted)", async () => {
    const cfg = cfgFor({ maxSize: 1 });
    installFetch([{ kind: "down" }]);
    const a = await a2aCall({ cfg, piDir, agent: "alpha", message: "first" });
    assert.match(a, /queued/);
    const b = await a2aCall({ cfg, piDir, agent: "alpha", message: "second" });
    assert.match(b, /^Error: call to 'alpha' failed — connection failed — fetch failed \(outbound queue full — not queued for retry\)$/);
    assert.deepEqual(loadQueue(piDir).map((e) => e.message), ["first"]);
  });

  it("TTL expiry through the client: expired entry is dropped (not sent), logged, and visible in a2a_list", async () => {
    const cfg = cfgFor({ ttlSec: 10 });
    installFetch([{ kind: "down" }]);
    await a2aCall({ cfg, piDir, agent: "alpha", message: "stale" });
    const [e] = loadQueue(piDir);
    const posts = installFetch([{ kind: "ok" }]);
    const r = await drainQueue({ cfg, piDir, now: () => e!.createdAt + 11_000 });
    assert.equal(r.dropped, 1);
    assert.equal(posts.length, 0, "an expired message must never be sent");
    const list = a2aList({ cfg, piDir });
    assert.match(list, /Outbound queue: enabled — 0\/100 pending/);
    assert.match(list, /expired after 1 attempt/);
  });

  it("maxAttempts: attempts exhausted → dropped with a 'exhausted' record", async () => {
    const cfg = cfgFor({ maxAttempts: 2 });
    installFetch([{ kind: "down" }]);
    await a2aCall({ cfg, piDir, agent: "alpha", message: "limited" });
    const [e] = loadQueue(piDir);
    const r = await drainQueue({ cfg, piDir, now: () => e!.nextAttemptAt + 1 });
    assert.equal(r.dropped, 1);
    assert.match(readFileSync(join(queueDir(piDir), "dropped.jsonl"), "utf-8"), /"reason":"exhausted"/);
  });

  it("maxAttempts=1 behaves like no queue: the original transient error is returned, nothing kept", async () => {
    const cfg = cfgFor({ maxAttempts: 1 });
    installFetch([{ kind: "down" }]);
    const out = await a2aCall({ cfg, piDir, agent: "alpha", message: "once" });
    assert.equal(out, "Error: call to 'alpha' failed — connection failed — fetch failed");
    assert.deepEqual(loadQueue(piDir), []);
  });

  it("drain is a no-op when the queue is disabled (entries stay on disk, nothing is sent)", async () => {
    installFetch([{ kind: "down" }]);
    await a2aCall({ cfg: cfgFor(), piDir, agent: "alpha", message: "parked" });
    const posts = installFetch([{ kind: "ok" }]);
    const r = await drainQueue({ cfg: cfgFor({ enabled: false }), piDir, now: () => Date.now() + 9e9 });
    assert.deepEqual(r, { delivered: 0, retried: 0, dropped: 0 });
    assert.equal(posts.length, 0);
    assert.lengthOf(loadQueue(piDir), 1);
  });

  it("async_dispatch is queued too (detached returnImmediately send); the ack is recorded in history", async () => {
    const cfg = cfgFor();
    const posts = installFetch([{ kind: "down" }, { kind: "ok", reply: "" }]);
    const first = await a2aCall({ cfg, piDir, agent: "alpha", message: "long job", asyncDispatch: true, contextId: "ctx-async" });
    assert.match(first, /queued/);
    const [e] = loadQueue(piDir);
    assert.isTrue(e!.asyncDispatch);
    await drainQueue({ cfg, piDir, now: () => e!.nextAttemptAt + 1 });
    assert.deepEqual(posts[1]!.body.params.configuration, { returnImmediately: true });
    assert.include(readFileSync(join(piDir, "a2a_conversations", "ctx-async.jsonl"), "utf-8"), "peer-task-1");
  });
});

// ---------------------------------------------------------------------------
// End-to-end over real sockets on localhost: real A2AServer receiver + real
// fetch sender. Receiver OFF → send → receiver ON → delivered exactly once.
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

describe("queue end-to-end (real HTTP on localhost)", () => {
  it("receiver off → send → receiver on → delivered exactly once (retry carries same messageId; receiver dedupes)", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const senderDir = makeTempDir("pi-a2a-e2e-send-");
    const recvDir = makeTempDir("pi-a2a-e2e-recv-");
    const cfg = DEFAULTS();
    cfg.queue = { ...cfg.queue, enabled: true, baseDelayMs: 20, maxDelayMs: 100 };
    cfg.timeouts.send = 2000;

    // 1) receiver is DOWN: the call returns "queued", entry persisted.
    const first = await a2aCall({ cfg, piDir: senderDir, agent: url, message: "hello from the sender" });
    assert.match(first, /queued/);
    assert.match(first, /connection failed/);
    assert.lengthOf(loadQueue(senderDir), 1);

    // 2) receiver comes UP with a counting runner.
    const runs: string[] = [];
    const runner: SessionRunner = async ({ message }) => {
      runs.push(message);
      return { reply: "received", inputRequired: false };
    };
    const rcfg = DEFAULTS();
    rcfg.server = { ...rcfg.server, port };
    const server = new A2AServer({ cfg: rcfg, cwd: makeTempDir("pi-a2a-e2e-cwd-"), piDir: recvDir, runner });
    await server.start();
    try {
      // 3) drain (sender "restart": fresh cfg object, state only from disk).
      const fresh = DEFAULTS();
      fresh.queue = { ...cfg.queue };
      fresh.timeouts.send = 2000;
      const r = await drainQueue({ cfg: fresh, piDir: senderDir, now: () => Date.now() + 10_000 });
      assert.equal(r.delivered, 1);
      assert.lengthOf(runs, 1);
      assert.include(runs[0]!, "hello from the sender");
      assert.deepEqual(loadQueue(senderDir), []);
      // 4) draining again sends nothing more.
      const r2 = await drainQueue({ cfg: fresh, piDir: senderDir, now: () => Date.now() + 20_000 });
      assert.equal(r2.delivered, 0);
      assert.lengthOf(runs, 1, "delivered exactly once");
    } finally {
      await server.stop();
    }
  });

  it("timeout while the receiver is still working: the retry reuses the messageId, receiver dedupes → ONE run, no duplicate task", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const senderDir = makeTempDir("pi-a2a-e2e-send-");
    let runs = 0;
    const runner: SessionRunner = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 700)); // slower than the sender's first timeout
      return { reply: "slow-but-done", inputRequired: false };
    };
    const rcfg = DEFAULTS();
    rcfg.server = { ...rcfg.server, port };
    const server = new A2AServer({ cfg: rcfg, cwd: makeTempDir("pi-a2a-e2e-cwd-"), piDir: makeTempDir("pi-a2a-e2e-recv-"), runner });
    await server.start();
    try {
      const cfg = DEFAULTS();
      cfg.queue = { ...cfg.queue, enabled: true, baseDelayMs: 20, maxDelayMs: 100 };
      cfg.timeouts.send = 250; // sender gives up long before the receiver finishes
      const first = await a2aCall({ cfg, piDir: senderDir, agent: url, message: "take your time" });
      assert.match(first, /queued/);
      assert.match(first, /delivery status unknown/);
      cfg.timeouts.send = 5000; // retry waits long enough
      const r = await drainQueue({ cfg, piDir: senderDir, now: () => Date.now() + 10_000 });
      assert.equal(r.delivered, 1);
      assert.equal(runs, 1, "the timed-out attempt must not have produced a second task");
    } finally {
      await server.stop();
    }
  });
});
