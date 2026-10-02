import { assert } from "chai";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULTS } from "./helpers";
import { makeTempDir } from "./tmp";
import { loadConfig, SECURITY_ENV_KEYS, buildA2ASettingsPatch } from "../lib/config";
import {
  A2ASendError,
  QUEUE_DEFAULTS,
  attemptEntry,
  backoffDelayMs,
  drainDue,
  enqueue,
  hasPending,
  isRetryableError,
  isRetryableStatus,
  loadQueue,
  networkErrorCode,
  parseRetryAfterMs,
  queueDir,
  queueStatus,
  recentDrops,
  type QueueConfig,
  type QueueEntry,
} from "../lib/queue";

const Q = (over: Partial<QueueConfig> = {}): QueueConfig => ({ ...QUEUE_DEFAULTS, enabled: true, ...over });

function entry(id: string, over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    v: 1,
    messageId: id,
    agent: "peer-a",
    message: `hello ${id}`,
    contextId: "ctx-1",
    asyncDispatch: false,
    createdAt: 1_000,
    attempts: 0,
    nextAttemptAt: 1_000,
    ...over,
  };
}

const down = () => new A2ASendError("connection failed — fetch failed", { retryable: true, code: "ECONNREFUSED" });

describe("queue: backoff schedule", () => {
  it("doubles from baseDelayMs and is capped at maxDelayMs (no jitter: random=1)", () => {
    const q = Q({ baseDelayMs: 1000, maxDelayMs: 10_000 });
    const sched = [1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelayMs(n, q, { random: () => 1 }));
    assert.deepEqual(sched, [1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });

  it("jitter spans -20%..0% and never exceeds the cap", () => {
    const q = Q({ baseDelayMs: 1000, maxDelayMs: 10_000 });
    assert.equal(backoffDelayMs(3, q, { random: () => 0 }), 3200); // 4000 * 0.8
    assert.equal(backoffDelayMs(3, q, { random: () => 1 }), 4000);
    for (let n = 1; n < 40; n++) {
      for (const r of [0, 0.5, 0.999, 1]) assert.isAtMost(backoffDelayMs(n, q, { random: () => r }), 10_000);
    }
  });

  it("honors a larger Retry-After but never beyond the TTL horizon", () => {
    const q = Q({ baseDelayMs: 1000, maxDelayMs: 10_000, ttlSec: 60 });
    assert.equal(backoffDelayMs(1, q, { retryAfterMs: 30_000, random: () => 1 }), 30_000);
    assert.equal(backoffDelayMs(1, q, { retryAfterMs: 500, random: () => 1 }), 1000);
    assert.equal(backoffDelayMs(1, q, { retryAfterMs: 9_999_999, random: () => 1 }), 60_000);
  });
});

describe("queue: error classification", () => {
  it("retries 5xx and 429, never other 4xx", () => {
    for (const s of [429, 500, 502, 503, 504, 599]) assert.isTrue(isRetryableStatus(s), String(s));
    for (const s of [200, 400, 401, 403, 404, 409, 422, undefined]) assert.isFalse(isRetryableStatus(s as any), String(s));
  });

  it("finds receiver-down codes on the error, its cause, and AggregateError members", () => {
    assert.equal(networkErrorCode({ cause: { code: "ECONNREFUSED" } }), "ECONNREFUSED");
    assert.equal(networkErrorCode({ cause: { errors: [{ code: "EHOSTUNREACH" }] } }), "EHOSTUNREACH");
    assert.equal(networkErrorCode({ code: "ETIMEDOUT" }), "ETIMEDOUT");
    assert.isUndefined(networkErrorCode({ cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }));
    assert.isUndefined(networkErrorCode(new Error("fetch failed")));
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    assert.equal(parseRetryAfterMs("7"), 7000);
    assert.equal(parseRetryAfterMs(null), undefined);
    assert.equal(parseRetryAfterMs("garbage"), undefined);
    const now = Date.parse("2026-01-01T00:00:00Z");
    assert.equal(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:10 GMT", now), 10_000);
  });

  it("plain errors are not retryable", () => {
    assert.isFalse(isRetryableError(new Error("x")));
    assert.isFalse(isRetryableError(new A2ASendError("HTTP 401", { status: 401 })));
    assert.isTrue(isRetryableError(down()));
  });
});

describe("queue: storage + bounds", () => {
  it("enqueue persists atomically (no tmp left), 0600, and loads oldest-first", () => {
    const dir = makeTempDir("pi-a2a-queue-");
    assert.deepEqual(enqueue(dir, entry("b", { createdAt: 2 }), Q(), 5), { ok: true });
    assert.deepEqual(enqueue(dir, entry("a", { createdAt: 1 }), Q(), 5), { ok: true });
    const files = readdirSync(queueDir(dir));
    assert.sameMembers(files, ["a.json", "b.json"]);
    assert.equal(statSync(join(queueDir(dir), "a.json")).mode & 0o777, 0o600);
    assert.deepEqual(loadQueue(dir).map((e) => e.messageId), ["a", "b"]);
    assert.isTrue(hasPending(dir));
  });

  it("rejects a NEW entry when full (never evicts accepted ones)", () => {
    const dir = makeTempDir("pi-a2a-queue-");
    const q = Q({ maxSize: 2 });
    assert.isTrue(enqueue(dir, entry("1"), q, 1_000).ok);
    assert.isTrue(enqueue(dir, entry("2"), q, 1_000).ok);
    assert.deepEqual(enqueue(dir, entry("3"), q, 1_000), { ok: false, reason: "full" });
    assert.deepEqual(loadQueue(dir).map((e) => e.messageId), ["1", "2"]);
  });

  it("sweeps expired entries (logged) before judging fullness", () => {
    const dir = makeTempDir("pi-a2a-queue-");
    const q = Q({ maxSize: 1, ttlSec: 10 });
    assert.isTrue(enqueue(dir, entry("old", { createdAt: 0 }), q, 0).ok);
    assert.isTrue(enqueue(dir, entry("new", { createdAt: 20_000 }), q, 20_000).ok);
    assert.deepEqual(loadQueue(dir).map((e) => e.messageId), ["new"]);
    const drops = recentDrops(dir);
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.messageId, "old");
    assert.equal(drops[0]!.reason, "expired");
    assert.notInclude(JSON.stringify(drops), "hello old", "drop log must not store message text");
  });

  it("quarantines a corrupt file instead of wedging the queue", () => {
    const dir = makeTempDir("pi-a2a-queue-");
    enqueue(dir, entry("good"), Q(), 1);
    writeFileSync(join(queueDir(dir), "bad.json"), "{not json");
    assert.deepEqual(loadQueue(dir).map((e) => e.messageId), ["good"]);
    assert.isTrue(existsSync(join(queueDir(dir), "bad.json.corrupt")));
  });
});

describe("queue: attemptEntry / drainDue", () => {
  it("persist-before-send: the entry is on disk while deliver() runs; success removes it", async () => {
    const dir = makeTempDir("pi-a2a-queue-");
    const e = entry("m1");
    enqueue(dir, e, Q(), 1_000);
    let seenOnDisk = false;
    const out = await attemptEntry({
      piDir: dir,
      entry: e,
      q: Q(),
      deliver: async () => {
        seenOnDisk = loadQueue(dir).some((x) => x.messageId === "m1");
        return "ok";
      },
    });
    assert.isTrue(seenOnDisk);
    assert.equal(out.kind, "delivered");
    assert.deepEqual(loadQueue(dir), []);
  });

  it("retryable failure persists attempts + next due time on the backoff schedule", async () => {
    const dir = makeTempDir("pi-a2a-queue-");
    const q = Q({ baseDelayMs: 1000, maxDelayMs: 8000 });
    const e = entry("m2");
    enqueue(dir, e, q, 1_000);
    const nows = [1_000, 3_000, 7_000];
    const due: number[] = [];
    for (const t of nows) {
      const out = await attemptEntry({ piDir: dir, entry: e, q, deliver: async () => { throw down(); }, now: () => t, random: () => 1 });
      assert.equal(out.kind, "retry");
      due.push((out as any).nextAttemptAt - t);
    }
    assert.deepEqual(due, [1000, 2000, 4000]);
    const onDisk = loadQueue(dir)[0]!;
    assert.equal(onDisk.attempts, 3);
    assert.match(onDisk.lastError ?? "", /connection failed/);
  });

  it("does NOT retry a non-retryable failure (4xx): one attempt, entry removed", async () => {
    const dir = makeTempDir("pi-a2a-queue-");
    for (const status of [400, 401, 404]) {
      const e = entry(`m-${status}`);
      enqueue(dir, e, Q(), 1_000);
      let calls = 0;
      const out = await attemptEntry({
        piDir: dir,
        entry: e,
        q: Q(),
        deliver: async () => {
          calls++;
          throw new A2ASendError(`HTTP ${status}`, { status, retryable: false });
        },
      });
      assert.equal(out.kind, "failed");
      assert.equal((out as any).reason, "rejected");
      assert.equal(calls, 1);
    }
    assert.deepEqual(loadQueue(dir), []);
  });

  it("maxAttempts exhausts: entry removed and reported as exhausted", async () => {
    const dir = makeTempDir("pi-a2a-queue-");
    const q = Q({ maxAttempts: 2 });
    const e = entry("m3");
    enqueue(dir, e, q, 1_000);
    const deliver = async () => { throw down(); };
    assert.equal((await attemptEntry({ piDir: dir, entry: e, q, deliver })).kind, "retry");
    const out = await attemptEntry({ piDir: dir, entry: e, q, deliver });
    assert.equal(out.kind, "failed");
    assert.equal((out as any).reason, "exhausted");
    assert.deepEqual(loadQueue(dir), []);
  });

  it("receiver down, then up: a later drain delivers once and empties the queue", async () => {
    const dir = makeTempDir("pi-a2a-queue-");
    const q = Q({ baseDelayMs: 1000, maxDelayMs: 4000 });
    enqueue(dir, entry("m4"), q, 1_000);
    let up = false;
    const delivered: string[] = [];
    const deliver = async (e: QueueEntry) => {
      if (!up) throw down();
      delivered.push(e.messageId);
      return "ok";
    };
    // pass 1 (t=1000): receiver down → stays queued
    let r = await drainDue({ piDir: dir, q, deliver, now: () => 1_000, random: () => 1 });
    assert.deepEqual(r, { delivered: 0, retried: 1, dropped: 0 });
    // pass 2 (t=1500): not due yet → no attempt at all
    r = await drainDue({ piDir: dir, q, deliver, now: () => 1_500, random: () => 1 });
    assert.deepEqual(r, { delivered: 0, retried: 0, dropped: 0 });
    // receiver comes up; pass 3 (t=5000): due → delivered
    up = true;
    r = await drainDue({ piDir: dir, q, deliver, now: () => 5_000, random: () => 1 });
    assert.deepEqual(r, { delivered: 1, retried: 0, dropped: 0 });
    assert.deepEqual(delivered, ["m4"]);
    assert.deepEqual(loadQueue(dir), []);
    // pass 4: nothing left → never re-delivered
    await drainDue({ piDir: dir, q, deliver, now: () => 9_000 });
    assert.deepEqual(delivered, ["m4"]);
  });

  it("TTL expiry: expired entries are dropped, logged, and shown in status", async () => {
    const dir = makeTempDir("pi-a2a-queue-");
    const q = Q({ ttlSec: 5 });
    enqueue(dir, entry("m5", { createdAt: 0 }), q, 0);
    const events: string[] = [];
    let calls = 0;
    const r = await drainDue({
      piDir: dir, q, now: () => 6_000,
      deliver: async () => { calls++; return "x"; },
      onEvent: (ev) => events.push(`${ev.type}:${(ev as any).reason ?? ""}`),
    });
    assert.deepEqual(r, { delivered: 0, retried: 0, dropped: 1 });
    assert.equal(calls, 0, "an expired message must not be sent");
    assert.deepEqual(events, ["dropped:expired"]);
    const status = queueStatus(dir, q, 6_000).join("\n");
    assert.match(status, /0\/100 pending/);
    assert.match(status, /m5 → peer-a: expired/);
  });

  it("restart resume: a fresh drain over the same dir delivers entries a dead process left behind", async () => {
    const dir = makeTempDir("pi-a2a-queue-");
    const q = Q();
    // "process 1": enqueue two messages, attempt once (peer down), then exit.
    const a = entry("r1", { createdAt: 1 }); const b = entry("r2", { createdAt: 2, agent: "peer-b" });
    enqueue(dir, a, q, 1_000); enqueue(dir, b, q, 1_000);
    await attemptEntry({ piDir: dir, entry: a, q, deliver: async () => { throw down(); }, now: () => 1_000, random: () => 1 });
    // "process 2": nothing in memory — only the files.
    assert.deepEqual(loadQueue(dir).map((e) => [e.messageId, e.attempts]), [["r1", 1], ["r2", 0]]);
    const got: string[] = [];
    const r = await drainDue({ piDir: dir, q, now: () => 1_000_000, deliver: async (e) => { got.push(e.messageId); return 1; } });
    assert.equal(r.delivered, 2);
    assert.sameMembers(got, ["r1", "r2"]);
    assert.deepEqual(loadQueue(dir), []);
  });

  it("keeps FIFO per peer: a not-due head blocks later entries to the same peer only", async () => {
    const dir = makeTempDir("pi-a2a-queue-");
    const q = Q();
    enqueue(dir, entry("h", { createdAt: 1, nextAttemptAt: 50_000 }), q, 1_000);          // peer-a head, not due
    enqueue(dir, entry("t", { createdAt: 2 }), q, 1_000);                                  // peer-a tail, due
    enqueue(dir, entry("o", { createdAt: 3, agent: "peer-z" }), q, 1_000);                 // other peer, due
    const got: string[] = [];
    await drainDue({ piDir: dir, q, now: () => 2_000, deliver: async (e) => { got.push(e.messageId); return 1; } });
    assert.deepEqual(got, ["o"]);
  });
});

describe("queue: config", () => {
  function cfgWith(settings: any, env: Record<string, string> = {}) {
    const dir = makeTempDir("pi-a2a-qcfg-");
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ a2a: settings }));
      return loadConfig({ cwd: dir, env });
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  }

  it("defaults: queue disabled, documented bounds, dedupe 300s", () => {
    const c = cfgWith({});
    assert.deepEqual(c.queue, { enabled: false, maxSize: 100, ttlSec: 3600, baseDelayMs: 2000, maxDelayMs: 300000, maxAttempts: 0 });
    assert.equal(c.server.dedupeTtlSec, 300);
    assert.equal(c.retryAttempts, 2);
  });

  it("settings.json queue.* overrides defaults; env fills gaps; settings win over env", () => {
    const c = cfgWith({ queue: { enabled: true, maxSize: 7 } }, { A2A_QUEUE_MAX_SIZE: "99", A2A_QUEUE_TTL_SEC: "30", A2A_QUEUE_BASE_DELAY_MS: "10", A2A_QUEUE_MAX_DELAY_MS: "100" });
    assert.equal(c.queue.enabled, true);
    assert.equal(c.queue.maxSize, 7);
    assert.equal(c.queue.ttlSec, 30);
    assert.equal(c.queue.baseDelayMs, 10);
    assert.equal(c.queue.maxDelayMs, 100);
  });

  it("A2A_QUEUE_ENABLED env switches the queue on/off", () => {
    assert.isTrue(cfgWith({}, { A2A_QUEUE_ENABLED: "true" }).queue.enabled);
    assert.isFalse(cfgWith({ queue: { enabled: false } }, { A2A_QUEUE_ENABLED: "true" }).queue.enabled);
    assert.isFalse(cfgWith({}, { A2A_QUEUE_ENABLED: "0" }).queue.enabled);
  });

  it("legacy retryAttempts aliases queue.maxAttempts only when set explicitly (retries + 1)", () => {
    assert.equal(cfgWith({}).queue.maxAttempts, 0, "unset retryAttempts must not cap the queue");
    assert.equal(cfgWith({ retryAttempts: 2 }).queue.maxAttempts, 3);
    assert.equal(cfgWith({ retryAttempts: 0 }).queue.maxAttempts, 1);
    assert.equal(cfgWith({ retryAttempts: 2, queue: { maxAttempts: 9 } }).queue.maxAttempts, 9, "queue.maxAttempts wins");
  });

  it("clamps nonsense values (maxSize>=1, maxDelay>=base, ttl/attempts>=0)", () => {
    const c = cfgWith({ queue: { maxSize: -5, ttlSec: -1, baseDelayMs: 500, maxDelayMs: 10, maxAttempts: -3 } });
    assert.equal(c.queue.maxSize, 1);
    assert.equal(c.queue.ttlSec, 0);
    assert.equal(c.queue.maxDelayMs, 500);
    assert.equal(c.queue.maxAttempts, 0);
  });

  it("a repo-controlled .pi/settings.json cannot enable the queue or switch off dedupe", () => {
    const repo = makeTempDir("pi-a2a-qrepo-");
    const home = makeTempDir("pi-a2a-qhome-");
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = home;
    try {
      mkdirSync(join(repo, ".pi"));
      writeFileSync(join(repo, ".pi", "settings.json"), JSON.stringify({ a2a: { queue: { enabled: true }, retryAttempts: 9, server: { dedupeTtlSec: 0 } } }));
      const c = loadConfig({ cwd: repo, env: {} });
      assert.isFalse(c.queue.enabled);
      assert.equal(c.server.dedupeTtlSec, 300);
      assert.equal(c.queue.maxAttempts, 0);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });

  it("queue/dedupe env keys are repo-.env.local-stripped (SECURITY_ENV_KEYS)", () => {
    for (const k of ["A2A_QUEUE_ENABLED", "A2A_QUEUE_MAX_SIZE", "A2A_QUEUE_TTL_SEC", "A2A_QUEUE_BASE_DELAY_MS", "A2A_QUEUE_MAX_DELAY_MS", "A2A_QUEUE_MAX_ATTEMPTS", "A2A_DEDUPE_TTL_SEC"]) {
      assert.isTrue(SECURITY_ENV_KEYS.has(k), k);
    }
  });

  it("panel save persists a changed queue block (and only then)", () => {
    const cfg = DEFAULTS();
    const working = structuredClone(cfg);
    const none = buildA2ASettingsPatch({ cfg, working, peerChanges: false, gatewayChanged: false })({});
    assert.notProperty(none, "queue");
    working.queue.enabled = true;
    const saved = buildA2ASettingsPatch({ cfg, working, peerChanges: false, gatewayChanged: false })({});
    assert.equal(saved.queue.enabled, true);
  });
});
