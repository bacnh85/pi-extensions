import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  DEFAULT_MIN_INTERVAL_MS,
  MIN_INTERVAL_ENV,
  acquireLock,
  defaultThrottlePaths,
  throttleDispatch,
  throttleZaiDispatch,
  zaiThrottleIntervalMs,
} from "../../lib/zai-throttle.ts";

interface Ctx {
  dir: string;
  statePath: string;
  lockPath: string;
  n: number;
}

const ctx: Ctx = {
  dir: "",
  statePath: "",
  lockPath: "",
  n: 0,
};

after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

const tmpDirs: string[] = [];

async function freshCtx(): Promise<Ctx> {
  ctx.dir = await mkdtemp(join(tmpdir(), "zai-throttle-"));
  tmpDirs.push(ctx.dir);
  ctx.statePath = join(ctx.dir, "zai-anthropic-dispatch.json");
  ctx.lockPath = join(ctx.dir, ".zai-anthropic-dispatch.lock");
  ctx.n++;
  return ctx;
}

/** Fake clock: sleep() advances now() so waits resolve instantly but stay observable. */
function fakeClock(start = 10_000) {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
}

describe("zai-throttle interval config", () => {
  it("defaults to 1000ms; explicit 0 disables; garbage falls back to default", () => {
    assert.equal(zaiThrottleIntervalMs({}), DEFAULT_MIN_INTERVAL_MS);
    assert.equal(zaiThrottleIntervalMs({ [MIN_INTERVAL_ENV]: "0" }), 0);
    assert.equal(zaiThrottleIntervalMs({ [MIN_INTERVAL_ENV]: "2500" }), 2500);
    assert.equal(zaiThrottleIntervalMs({ [MIN_INTERVAL_ENV]: "bogus" }), DEFAULT_MIN_INTERVAL_MS);
    assert.equal(zaiThrottleIntervalMs({ [MIN_INTERVAL_ENV]: "-5" }), DEFAULT_MIN_INTERVAL_MS);
  });

  it("defaultThrottlePaths lands both files in the agent dir", () => {
    const paths = defaultThrottlePaths("/agents");
    assert.equal(paths.statePath, join("/agents", "zai-anthropic-dispatch.json"));
    assert.equal(paths.lockPath, join("/agents", ".zai-anthropic-dispatch.lock"));
  });
});

describe("throttleDispatch", () => {
  it("interval 0 → no-op, touches no files", async () => {
    const c = await freshCtx();
    const waited = await throttleDispatch({ intervalMs: 0, statePath: c.statePath, lockPath: c.lockPath });
    assert.equal(waited, 0);
    assert.equal(existsSync(c.statePath), false, "no state written");
    assert.equal(existsSync(c.lockPath), false, "no lock left");
  });

  it("first dispatch claims immediately, records ts, releases the lock before returning", async () => {
    const c = await freshCtx();
    const clock = fakeClock();
    const waited = await throttleDispatch({ intervalMs: 1000, statePath: c.statePath, lockPath: c.lockPath, ...clock });
    assert.equal(waited, 0, "no state file yet → no wait");
    assert.deepEqual(clock.slept, [], "slept nothing");
    const state = JSON.parse(await readFile(c.statePath, "utf-8"));
    assert.equal(state.ts, 10_000);
    assert.equal(existsSync(c.lockPath), false, "lock released even though no request ever ran");
  });

  it("second dispatch inside the interval waits for the slot (claim held during sleep)", async () => {
    const c = await freshCtx();
    await writeFile(c.statePath, JSON.stringify({ ts: 10_000 }));
    const clock = fakeClock(10_500); // 500ms after last slot, interval 1000 → wait 500
    const waited = await throttleDispatch({ intervalMs: 1000, statePath: c.statePath, lockPath: c.lockPath, ...clock });
    assert.equal(waited, 500);
    assert.deepEqual(clock.slept, [500]);
    assert.equal(JSON.parse(await readFile(c.statePath, "utf-8")).ts, 11_000, "slot recorded after the wait");
    assert.equal(existsSync(c.lockPath), false);
  });

  it("dispatch past the interval does not wait", async () => {
    const c = await freshCtx();
    await writeFile(c.statePath, JSON.stringify({ ts: 10_000 }));
    const clock = fakeClock(12_000); // 2s later, interval 1000 → free
    const waited = await throttleDispatch({ intervalMs: 1000, statePath: c.statePath, lockPath: c.lockPath, ...clock });
    assert.equal(waited, 0);
    assert.deepEqual(clock.slept, []);
  });

  it("stale lock (crash mid-claim) is broken after 30s", async () => {
    const c = await freshCtx();
    await writeFile(c.lockPath, "99999");
    const old = new Date(Date.now() - 40_000);
    await utimes(c.lockPath, old, old);
    const waited = await throttleDispatch({ intervalMs: 1000, statePath: c.statePath, lockPath: c.lockPath });
    assert.equal(waited, 0);
    assert.equal(existsSync(c.lockPath), false, "stale lock broken and our claim released");
    assert.ok(existsSync(c.statePath));
  });

  it("fail-open: unwritable state → returns 0, does not throw, lock still released", async () => {
    const c = await freshCtx();
    await mkdir(c.statePath); // state path is a directory → readFile AND writeFile both fail
    const waited = await throttleDispatch({ intervalMs: 1000, statePath: c.statePath, lockPath: c.lockPath });
    assert.equal(waited, 0);
    assert.equal(existsSync(c.lockPath), false, "no lock leak on fail-open");
  });

  it("concurrent dispatches space out by the interval (real timers)", async () => {
    const c = await freshCtx();
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const t0 = Date.now();
    // Queued claimants sleep while holding the mutex, so each waits ~one
    // interval from ITS acquisition; total wall clock spans (N-1)×interval.
    const waits = await Promise.all([
      throttleDispatch({ intervalMs: 120, statePath: c.statePath, lockPath: c.lockPath, sleep }),
      throttleDispatch({ intervalMs: 120, statePath: c.statePath, lockPath: c.lockPath, sleep }),
      throttleDispatch({ intervalMs: 120, statePath: c.statePath, lockPath: c.lockPath, sleep }),
    ]);
    const elapsed = Date.now() - t0;
    waits.sort((a, b) => a - b);
    assert.ok(elapsed >= 230, `three claims at 120ms interval must queue, took ${elapsed}ms`);
    assert.equal(waits[0], 0, "first claimant goes immediately");
    // Slot spacing is the invariant (pinned deterministically by the fake-clock
    // tests above); per-claimant sleeps vary by poll timing (up to one 40ms
    // poll cycle late to the mutex) — just require real queueing happened.
    assert.ok(Math.max(...waits) >= 60, `queued claimants slept real intervals (${waits.join(", ")})`);
    assert.equal(existsSync(c.lockPath), false, "lock released after all claims");
    const ts1 = JSON.parse(await readFile(c.statePath, "utf-8")).ts as number;
    assert.ok(Math.abs(ts1 - Date.now()) < 5_000, "state holds a fresh ts");
  });
});

describe("review hardening: lock protocol defects", () => {
  it("unremovable stale lock → fails fast after deadline (no hot loop), fail-open with onError", async () => {
    const c = await freshCtx();
    // A directory at the lock path: open(…,"wx") → EEXIST, but unlink → EISDIR forever.
    await mkdir(c.lockPath);
    const old = new Date(Date.now() - 40_000);
    await utimes(c.lockPath, old, old);
    const errors: Error[] = [];
    const t0 = Date.now();
    const waited = await throttleDispatch({
      intervalMs: 1000,
      statePath: c.statePath,
      lockPath: c.lockPath,
      pollMs: 5,
      lockDeadlineMs: 150,
      onError: (e) => errors.push(e),
    });
    const elapsed = Date.now() - t0;
    assert.equal(waited, 0, "fail-open");
    assert.ok(elapsed < 5_000, `must hit the deadline fast, took ${elapsed}ms (hot loop would hang)`);
    assert.equal(errors.length, 1, "fail-open reported via onError");
    assert.match(errors[0].message, /lock busy/);
    assert.equal(existsSync(c.statePath), false, "nothing claimed");
  });

  it("future/corrupt ts (clock step-back) is ignored → immediate dispatch, not an hour-long nap", async () => {
    const c = await freshCtx();
    await writeFile(c.statePath, JSON.stringify({ ts: Date.now() + 3_600_000 }));
    const t0 = Date.now();
    const waited = await throttleDispatch({ intervalMs: 1000, statePath: c.statePath, lockPath: c.lockPath });
    assert.ok(Date.now() - t0 < 5_000, "returns within seconds");
    assert.equal(waited, 0);
    const ts = JSON.parse(await readFile(c.statePath, "utf-8")).ts as number;
    assert.ok(Math.abs(ts - Date.now()) < 5_000, "state rewritten with a sane fresh ts");
  });

  it("long wait naps in bounded holds and re-queues — never holds ≥ stale threshold (fake clock)", async () => {
    const c = await freshCtx();
    await writeFile(c.statePath, JSON.stringify({ ts: 10_000 }));
    const clock = fakeClock(10_500); // wait = 19_500 > MAX_HOLD_MS(15_000) → 2 holds
    const waited = await throttleDispatch({ intervalMs: 20_000, statePath: c.statePath, lockPath: c.lockPath, ...clock });
    assert.equal(waited, 19_500);
    assert.deepEqual(clock.slept, [15_000, 4_500], "first nap capped at MAX_HOLD_MS, remainder re-queued");
    assert.equal(JSON.parse(await readFile(c.statePath, "utf-8")).ts, 30_000);
    assert.equal(existsSync(c.lockPath), false);
  });

  it("wrong-typed ts (string/object) is corrupt → immediate dispatch, no NaN/hot loop", async () => {
    const c = await freshCtx();
    await writeFile(c.statePath, JSON.stringify({ ts: "12345" }));
    const clock = fakeClock();
    const waited = await throttleDispatch({ intervalMs: 1000, statePath: c.statePath, lockPath: c.lockPath, ...clock });
    assert.equal(waited, 0, "string ts → dispatch now");
    assert.deepEqual(clock.slept, []);
    assert.equal(JSON.parse(await readFile(c.statePath, "utf-8")).ts, 10_000, "state rewritten with numeric ts");

    await writeFile(c.statePath, JSON.stringify({ ts: { nested: true } }));
    const clock2 = fakeClock();
    const waited2 = await throttleDispatch({ intervalMs: 1000, statePath: c.statePath, lockPath: c.lockPath, ...clock2 });
    assert.equal(waited2, 0, "object ts → dispatch now");
    assert.deepEqual(clock2.slept, []);
  });

  it("fresh agent dir (missing parents) is created before the lock is claimed", async () => {
    const root = await mkdtemp(join(tmpdir(), "zai-throttle-fresh-"));
    const statePath = join(root, "does", "not", "exist", "zai-anthropic-dispatch.json");
    const lockPath = join(root, "does", "not", "exist", ".zai-anthropic-dispatch.lock");
    try {
      const waited = await throttleDispatch({ intervalMs: 1000, statePath, lockPath });
      assert.equal(waited, 0);
      assert.ok(existsSync(statePath), "state written — throttle is not a permanent silent no-op");
      assert.equal(existsSync(lockPath), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("release() deletes only OUR lock, never a stale-breaker's replacement", async () => {
    const c = await freshCtx();
    const lock = await acquireLock(c.lockPath, () => 0, (ms) => new Promise((r) => setTimeout(r, ms)));
    // Simulate a stale-breaker replacing our lock while we "hold" it.
    await writeFile(c.lockPath, "OTHER-PID");
    await lock.release();
    assert.equal(existsSync(c.lockPath), true, "foreign lock preserved");
    await rm(c.lockPath, { force: true });

    const mine = await acquireLock(c.lockPath, () => 0, (ms) => new Promise((r) => setTimeout(r, ms)));
    assert.equal(existsSync(c.lockPath), true);
    await mine.release();
    assert.equal(existsSync(c.lockPath), false, "our own lock is removed");
  });

  it("second claim after a big-interval slot waits another full interval — no stale-break cascade (fake clock)", async () => {
    const c = await freshCtx();
    await writeFile(c.statePath, JSON.stringify({ ts: 10_000 }));
    const clock = fakeClock(10_000);
    // Claim 1: wait 20_000 in two capped holds (proves re-looping under MAX_HOLD_MS).
    const first = await throttleDispatch({ intervalMs: 20_000, statePath: c.statePath, lockPath: c.lockPath, ...clock });
    assert.equal(first, 20_000);
    // Claim 2 joins AFTER the big slot: must wait its own full interval
    // (two more capped holds), never inherit/break anything.
    const second = await throttleDispatch({ intervalMs: 20_000, statePath: c.statePath, lockPath: c.lockPath, ...clock });
    assert.equal(second, 20_000);
    assert.deepEqual(clock.slept, [15_000, 5_000, 15_000, 5_000]);
    assert.equal(JSON.parse(await readFile(c.statePath, "utf-8")).ts, 50_000, "slot = previous slot + interval");
    assert.equal(existsSync(c.lockPath), false);
  });
});

describe("throttleZaiDispatch wiring", () => {
  it("non-zai-anthropic provider → no-op even with default interval", async () => {
    const c = await freshCtx();
    const waited = await throttleZaiDispatch("openrouter", {}, { statePath: c.statePath, lockPath: c.lockPath });
    assert.equal(waited, 0);
    assert.equal(existsSync(c.statePath), false);
  });

  it("undefined provider → no-op", async () => {
    const c = await freshCtx();
    const waited = await throttleZaiDispatch(undefined, {}, { statePath: c.statePath, lockPath: c.lockPath });
    assert.equal(waited, 0);
  });

  it("zai-anthropic provider claims a slot using env interval", async () => {
    const c = await freshCtx();
    await writeFile(c.statePath, JSON.stringify({ ts: 10_000 }));
    const waited = await throttleZaiDispatch(
      "ZAI-Anthropic", // case-insensitive, matches provider gating elsewhere
      { [MIN_INTERVAL_ENV]: "700" },
      { statePath: c.statePath, lockPath: c.lockPath },
    );
    void waited; // real timers; ts in the past → likely no wait — the assertion is that the gate RAN
    assert.ok(existsSync(c.statePath), "state written for zai-anthropic provider");
    await stat(c.statePath); // readable
    assert.equal(existsSync(c.lockPath), false);
  });
});
