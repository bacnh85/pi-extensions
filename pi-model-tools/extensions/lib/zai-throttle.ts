/**
 * zai-throttle.ts — cross-process dispatch-rate gate for the zai-anthropic provider.
 *
 * Z.ai's coding-plan endpoint enforces a per-key REQUEST-rate limit: HTTP 429
 * `{"error":{"code":"1302","message":"[1302][Rate limit reached for requests]"}}`
 * with no retry-after in the body. Multi-agent setups (herdr panes, parallel
 * subagents, advisor) burst dispatches on one key and trip it. This gate spaces
 * DISPATCH STARTS across every Pi process on the machine; streams themselves are
 * never serialized — the mutex below is held only for the claim procedure and is
 * always released before the hook returns, never during the request.
 *
 * Two files under the Pi agent dir (default ~/.pi/agent):
 *   zai-anthropic-dispatch.json    shared state: { ts } = last claimed dispatch slot
 *   .zai-anthropic-dispatch.lock   short-lived mutex (exclusive-create, content = pid)
 *
 * Lock protocol invariants (review-hardened):
 *   - No loop path skips the deadline check / poll sleep (unremovable stale lock
 *     cannot spin forever — it throws after the deadline and dispatch fail-opens).
 *   - A single mutex hold is capped under LOCK_STALE_MS (long waits nap, release,
 *     and re-queue), so a legitimate sleeper is never stale-broken mid-claim.
 *   - release() deletes the lock only if it still contains OUR pid (a
 *     stale-breaker may have replaced it meanwhile).
 *   - The state dir is created BEFORE the lock is claimed (fresh agent dir would
 *     otherwise ENOENT the lock open and permanently silent-fail-open).
 *   - Stale-break stat→unlink is not atomic: two simultaneous breakers can
 *     over-delete; bounded to under-throttling, self-heals next claim.
 *
 * ponytail: single-machine scope — machines sharing the key (a2a) can't share
 * the lockfile; provider-level retries (retry.provider.maxRetries) cover that.
 * ponytail: retry attempts inside retryProviderRequest bypass this gate — they
 * carry their own exponential backoff.
 */

import { mkdir, open, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isZaiAnthropicProvider } from "./zai-anthropic.ts";

export const MIN_INTERVAL_ENV = "ZAI_ANTHROPIC_MIN_INTERVAL_MS";
/** ≤1 dispatch/sec/key machine-wide. Single-agent requests are naturally spaced wider. */
export const DEFAULT_MIN_INTERVAL_MS = 1000;

/** A crash mid-claim must not wedge every future dispatch — break locks this old. */
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 40;
/** Lock-acquire deadline: fixed 60s default, injectable for tests/exotic configs. Deep-but-legit
 *  queues normally resolve within it because holds nap ≤15s and re-queue — anything past it fails
 *  open by design (logged via onError). */
const LOCK_DEADLINE_MS = 60_000;
/** Cap on a single mutex hold — strictly under LOCK_STALE_MS so a napping claimant
 *  is never stale-broken by the next claimant. */
const MAX_HOLD_MS = LOCK_STALE_MS / 2;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Default 1000; explicit 0 disables; garbage falls back to default (zaiAnthropicSpeed pattern). */
export function zaiThrottleIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[MIN_INTERVAL_ENV]?.trim() ?? "";
  if (raw === "") return DEFAULT_MIN_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_MIN_INTERVAL_MS;
}

export interface ThrottlePaths {
  statePath: string;
  lockPath: string;
}

export function defaultThrottlePaths(agentDir = join(homedir(), ".pi", "agent")): ThrottlePaths {
  return {
    statePath: join(agentDir, "zai-anthropic-dispatch.json"),
    lockPath: join(agentDir, ".zai-anthropic-dispatch.lock"),
  };
}

/** Exclusive-create mutex; stale locks (crash mid-claim) are broken after LOCK_STALE_MS.
 *  Every retry path honors the deadline + poll sleep — none can spin. */
export async function acquireLock(
  lockPath: string,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  pollMs = LOCK_POLL_MS,
  deadlineMs = LOCK_DEADLINE_MS,
): Promise<{ release(): Promise<void> }> {
  const deadline = now() + deadlineMs;
  for (;;) {
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fh = await open(lockPath, "wx");
      await fh.write(`${process.pid}`);
      await fh.close();
      const myPid = `${process.pid}`;
      return {
        // Delete only OUR lock: a stale-breaker may have replaced it while we held it.
        release: async () => {
          try {
            if ((await readFile(lockPath, "utf-8")) !== myPid) return;
          } catch { return; /* gone already */ }
          await rm(lockPath, { force: true }).catch(() => {});
        },
      };
    } catch (err) {
      if (fh) { try { await fh.close(); } catch { /* already closed */ } await unlink(lockPath).catch(() => {}); }
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
    // Lock exists: try to break a crashed holder's stale lock, then ALWAYS
    // honor the deadline + poll sleep before retrying (no hot loops).
    try {
      const st = await stat(lockPath);
      if (now() - st.mtimeMs > LOCK_STALE_MS) await unlink(lockPath).catch(() => {});
    } catch { /* lock vanished — plain retry */ }
    if (now() > deadline) throw new Error(`zai-anthropic throttle: lock busy >${Math.round(deadlineMs / 1000)}s (${lockPath})`);
    await sleep(pollMs);
  }
}

/**
 * Claim the next dispatch slot: at least `intervalMs` after the last claimed one,
 * across all processes sharing `paths`. Returns ms actually slept (0 = dispatched
 * immediately). Fail-open: any internal error dispatches unthrottled (reported via
 * `onError`) — a rate limiter must never break a request.
 */
export async function throttleDispatch(opts: {
  intervalMs: number;
  statePath: string;
  lockPath: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  lockDeadlineMs?: number;
  onError?: (err: Error) => void;
}): Promise<number> {
  const { intervalMs, statePath, lockPath } = opts;
  if (intervalMs <= 0) return 0;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  let sleptMs = 0;
  try {
    // Before the lock: on a fresh agent dir the lock open would ENOENT (≠EEXIST)
    // and fail-open forever before the state mkdir below ever ran.
    await mkdir(dirname(statePath), { recursive: true });
    for (;;) {
      const lock = await acquireLock(lockPath, now, sleep, opts.pollMs, opts.lockDeadlineMs);
      let done = false;
      try {
        let lastTs = 0;
        try {
          const raw = (JSON.parse(await readFile(statePath, "utf-8")) as { ts?: unknown }).ts;
          lastTs = typeof raw === "number" && Number.isFinite(raw) ? raw : 0; // wrong-typed ts = corrupt → dispatch now
        } catch { /* first run or corrupt state → dispatch now */ }
        if (lastTs > now() + LOCK_STALE_MS) lastTs = 0; // future/corrupt ts (clock step-back) → ignore
        const wait = lastTs + intervalMs - now();
        if (wait <= 0) {
          await writeFile(statePath, JSON.stringify({ ts: now(), pid: process.pid }));
          done = true;
        } else {
          // Hold the mutex only for a bounded nap; longer waits release and
          // re-queue so this holder is never mistaken for a crashed one.
          const nap = Math.min(wait, MAX_HOLD_MS);
          await sleep(nap);
          sleptMs += nap;
        }
      } finally {
        await lock.release();
      }
      if (done) return sleptMs;
      // Re-acquire and re-evaluate: state may have advanced while we slept/released.
    }
  } catch (err) {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    return 0; // fail-open
  }
}

/** Wiring entry: gate + interval + default paths in one call (index.ts before_provider_headers). */
export async function throttleZaiDispatch(
  provider: string | undefined,
  env: Record<string, string | undefined> = process.env,
  paths: ThrottlePaths = defaultThrottlePaths(),
  hooks?: { onError?: (err: Error) => void },
): Promise<number> {
  if (!isZaiAnthropicProvider(provider)) return 0;
  return throttleDispatch({ intervalMs: zaiThrottleIntervalMs(env), ...paths, ...hooks });
}
