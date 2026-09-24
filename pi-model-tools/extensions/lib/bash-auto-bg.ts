/**
 * bash-auto-bg.ts — auto-background long foreground bash commands.
 *
 * OMP 18.2.8 parity ("background job notifications … discourage unnecessary
 * polling"): a foreground bash call still running at the threshold returns a
 * receipt immediately; when the job settles, its output is delivered as a
 * follow-up turn via pi.sendMessage({deliverAs: "followUp", triggerTurn: true})
 * — the wake-up mechanism pi-subagent already proved. The prompt-only half
 * (anti-poll clause) lives in bashAutoBgClause(); both halves ship together so
 * the description text and the mechanism can never drift apart.
 *
 * The caller-supplied `timeout` (seconds) is passed through untouched: the
 * underlying local operations enforce it as a total-runtime kill, so a
 * backgrounded job still dies at its deadline without a second timer here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { open, rm, type FileHandle } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Config toggles ──

/** PI_MODEL_TOOLS_BASH_AUTO_BG=1 enables the auto-background mechanism (default off). */
export function autoBgEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.PI_MODEL_TOOLS_BASH_AUTO_BG ?? "");
}

/** PI_MODEL_TOOLS_BASH_AUTO_BG_SECS — foreground threshold before auto-backgrounding (default 120). */
export function autoBgThresholdSecs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.PI_MODEL_TOOLS_BASH_AUTO_BG_SECS);
  // Clamp to ≥1: "0.5" would floor to 0 → a 0 ms timer = instant-background-everything.
  return Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.floor(raw)) : 120;
}

// ── Job registry ──

const MAX_CONCURRENT_BG = 4; // ponytail: hard cap, no queue — over cap stays foreground
const LOG_TAIL_BYTES = 2048;
const LOG_MAX_BYTES = 5 * 1024 * 1024; // on-disk cap; further chunks dropped (noted in the wake-up)

interface BgJob {
  id: string;
  command: string;
  controller: AbortController;
  logPath: string;
  /** Output received after backgrounding, bounded to the last LOG_TAIL_BYTES. */
  tail: string;
  logBytes: number;
  logTruncated: boolean;
  /** Open log file handle — set asynchronously once open() resolves. */
  logFile?: FileHandle;
  /** Set by finishJob so a racing async open() knows to discard the fd. */
  finished?: boolean;
}

const jobs = new Map<string, BgJob>();
let jobSeq = 0;
// Wake-up delivery gate: session_shutdown aborts jobs and suppresses delivery
// (a dying session must not fire triggerTurn follow-ups); the next
// session_start re-enables it. Tests use the default (enabled).
let deliveryEnabled = true;

/** Enable/disable follow-up wake-up delivery (session lifecycle wiring). */
export function setBgDeliveryEnabled(enabled: boolean): void {
  deliveryEnabled = enabled;
}

/**
 * Abort every live background job and clear the registry. Pass
 * `suppressDelivery=true` from session_shutdown so the aborts do not fire
 * wake-up turns into a session that is going away.
 */
export function abortAllBgJobs(suppressDelivery = false): void {
  if (suppressDelivery) deliveryEnabled = false;
  for (const job of jobs.values()) {
    job.controller.abort();
    // Graceful shutdown: remove the log synchronously — the aborted job's
    // wake-up is suppressed, so nothing will ever read this file (async rm
    // can lose the race against process exit).
    if (!job.logTruncated) {
      try { unlinkSync(job.logPath); } catch {}
    }
  }
  jobs.clear();
}

/** Number of currently live background jobs (status panel). */
export function bgJobCount(): number {
  return jobs.size;
}

/** Log paths of currently live background jobs (status panel / tests). */
export function activeBgLogPaths(): string[] {
  return [...jobs.values()].map((j) => j.logPath);
}

// Process-death sweep: if pi dies while a job is live (SIGTERM, crash),
// finishJob never runs and the log file would leak. Sync unlink is the only
// thing allowed in an 'exit' handler. Hard SIGKILL remains uncleanable (tmp
// cleaners bound it).
let exitSweepInstalled = false;
function installExitSweep(): void {
  if (exitSweepInstalled) return;
  exitSweepInstalled = true;
  const sweep = () => {
    for (const j of jobs.values()) {
      if (j.logTruncated) continue;
      try { unlinkSync(j.logPath); } catch {}
    }
  };
  // Normal exit & fatal errors: 'exit' handlers run.
  process.on("exit", sweep);
  // SIGTERM/SIGINT: Node's default handler bypasses 'exit' handlers — sweep
  // then re-raise. (SIGKILL is uncleanable by definition; tmp cleaners bound
  // that residual.)
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    const own = () => {
      sweep();
      process.removeListener(sig, own);
      process.kill(process.pid, sig); // re-raise: now falls through to the
      // default/other handlers — external kill still terminates pi.
    };
    process.on(sig, own);
  }
}

// ── Description clause (the prompt-only half) ──

/**
 * Static bash-description clause. OFF = anti-poll guidance for unattended
 * work; ON = OMP's "you will be woken — NEVER poll" contract. Byte-stable per
 * session: env is read once at registration, so this stays in the cache-safe
 * request head (never per-turn guidance).
 */
export function bashAutoBgClause(enabled: boolean, thresholdSecs: number): string {
  if (!enabled) {
    return [
      "Long-running commands: set `timeout` generously rather than polling. NEVER wait by looping",
      "`sleep`/`ps`/`pgrep`/`top` — every poll costs a full model round. If a job must run unattended,",
      "background it once (`nohup <cmd> > /tmp/log 2>&1 &`), do other work, and read the log once when you need the result.",
    ].join(" ");
  }
  return [
    `Foreground calls longer than ~${thresholdSecs}s auto-background: you get a receipt immediately and the result`,
    "is delivered as a follow-up message when the job finishes. NEVER poll a backgrounded job (`sleep`/`ps`/`pgrep`/`top`) —",
    "do other work or end your reply and you will be woken with its output.",
    "`timeout`, if set, still applies as a total-runtime kill (measured from command start, not from backgrounding).",
  ].join(" ");
}

// ── Operations wrapper (the mechanism half) ──

export interface AutoBgDeps {
  pi: ExtensionAPI;
  /** Foreground threshold in seconds. */
  thresholdSecs: number;
  maxConcurrent?: number;
}

/**
 * Wrap BashOperations: commands still running at the threshold are detached —
 * the pending exec resolves as a receipt (exit 0 + the receipt text riding the
 * output stream, so the built-in formats it like normal output), the real exec
 * keeps running, and its outcome is delivered as a follow-up turn on
 * settlement. Fast commands pass through untouched.
 */
export function wrapWithAutoBg(local: BashOperations, deps: AutoBgDeps): BashOperations {
  const maxConcurrent = deps.maxConcurrent ?? MAX_CONCURRENT_BG;
  installExitSweep();
  return {
    exec: (command, cwd, options) =>
      new Promise((resolveBg, rejectBg) => {
        const controller = new AbortController();
        const onToolAbort = () => controller.abort();
        // Forward the tool signal ONLY during the foreground wait. Once the job
        // is backgrounded the listener is removed — turn end / abort after that
        // must NOT kill the detached job (it's nohup-like).
        options.signal?.addEventListener("abort", onToolAbort, { once: true });

        let settled = false;
        let backgrounded = false;
        let job: BgJob | undefined;
        let thresholdTimer: NodeJS.Timeout | undefined;

        const forwardedOnData = options.onData;
        // Output ALWAYS streams through to the tool consumer (live view +
        // tool-result text). After backgrounding it additionally feeds the
        // job's bounded tail + on-disk log; before it, it accumulates in
        // `preBg` so a backgrounded job's wake-up includes output the model
        // already saw. The receipt itself must NOT enter the tail/log — it is
        // forwarded after backgrounding via forward(), which skips the tee.
        let preBg = "";
        const teeOnData = (data: Buffer) => {
          forwardedOnData?.(data);
          const text = data.toString("utf8");
          if (!backgrounded) {
            preBg = (preBg + text).slice(-LOG_TAIL_BYTES);
            return;
          }
          if (!job) return;
          job.tail = (job.tail + text).slice(-LOG_TAIL_BYTES);
          if (job.logBytes >= LOG_MAX_BYTES) {
            job.logTruncated = true;
            return;
          }
          job.logBytes += data.length;
          // Chunks racing the async open() are dropped from the file (counted
          // anyway — the cap is approximate); the 2KB tail always has them.
          void job.logFile?.write(data).catch(() => {});
        };
        // Tool-result stream passthrough (never teed into the job).
        const forward = (data: Buffer) => forwardedOnData?.(data);

        // Clears foreground wiring only; the registry entry is removed by the
        // completion handlers (a backgrounded job must outlive the settle).
        const cleanup = () => {
          options.signal?.removeEventListener("abort", onToolAbort);
          if (thresholdTimer) clearTimeout(thresholdTimer);
        };
        const settle = (finish: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          finish();
        };

        const execPromise = local.exec(command, cwd, { ...options, onData: teeOnData, signal: controller.signal });
        void execPromise.then(
          (result) => {
            if (!backgrounded) return settle(() => resolveBg(result));
            const exitNote = result.exitCode === null ? "terminated without an exit code" : `exit ${result.exitCode}`;
            finishJob(deps.pi, job, [
              `Background job ${job?.id} finished (${exitNote}).`,
              `Command: ${command}`,
              job?.tail ? `Output (tail):\n${job.tail}` : "(no output)",
            ]);
          },
          (err: unknown) => {
            if (!backgrounded) return settle(() => rejectBg(err));
            const raw = err instanceof Error ? err.message : String(err);
            const reason = raw.startsWith("timeout:") ? `timed out after ${raw.split(":")[1]} seconds (deadline reached)` : raw;
            finishJob(deps.pi, job, [
              `Background job ${job?.id} failed: ${reason}.`,
              `Command: ${command}`,
              job?.tail ? `Output before failure (tail):\n${job.tail}` : "",
            ]);
          },
        );

        thresholdTimer = setTimeout(() => {
          if (settled || backgrounded) return;
          if (jobs.size >= maxConcurrent) return; // ponytail: no queue — stays foreground
          backgrounded = true;
          const id = `bg-${++jobSeq}`;
          // Random component: the sequential id is predictable, the log path
          // must not be (pre-planted symlink/file attack on shared tmp).
          const logPath = join(tmpdir(), `pi-model-tools-bg-${randomUUID()}.log`);
          // Seed tail/log with the foreground-phase output the model already
          // saw, so the wake-up is self-contained.
          const seed = preBg;
          job = { id, command, controller, logPath, tail: seed, logBytes: Buffer.byteLength(seed), logTruncated: false };
          const j = job;
          jobs.set(id, j);
          // O_CREAT|O_EXCL mode 0600: never follows a pre-planted symlink, never
          // opens an existing file, owner-only perms. Best-effort — on failure
          // (tmp unwritable) the tail still feeds the wake-up.
          void open(logPath, "wx", 0o600)
            .then((fh) => {
              if (j.finished) {
                // Job completed before the open resolved — close immediately
                // and remove (finishJob's rm raced this async open).
                void fh.close().then(() => rm(logPath, { force: true })).catch(() => {});
                return;
              }
              j.logFile = fh;
              if (seed) void fh.write(seed).catch(() => {});
            })
            .catch(() => {});
          // Receipt rides the output stream — the built-in formats it into the
          // tool result exactly like command output. Direct forward (bypasses
          // the tee) so it never pollutes the wake-up tail/log. No log path in
          // the receipt: the log is deleted at completion unless truncated
          // (the wake-up then carries the tail, or the kept path).
          forward(
            Buffer.from(
              `\n[pi-model-tools] Backgrounded as job ${id} (still running). The result arrives as a follow-up message — NEVER poll (sleep/ps/pgrep/top); do other work or end your reply and you will be woken with its output.\n`,
            ),
          );
          settle(() => resolveBg({ exitCode: 0 }));
        }, deps.thresholdSecs * 1000);
      }),
  };
}

/**
 * Settle a backgrounded job: unregister, close the log fd, deliver the
 * wake-up (gated by deliveryEnabled) with a truncation note when the on-disk
 * log hit its cap.
 */
function finishJob(pi: ExtensionAPI, job: BgJob | undefined, lines: string[]): void {
  if (!job) return;
  jobs.delete(job.id);
  job.finished = true;
  const fh = job.logFile;
  if (fh) {
    void fh.close().catch(() => {});
  }
  if (job.logTruncated) {
    // Truncated: the log is the only place the full output lives — keep it
    // and advertise the path.
    // ponytail: rare ≥5MB-output jobs leak a ≤5MB file to tmp; OS tmp
    // cleaners bound the rest. A sweep can come later if it ever matters.
    lines.push(`Full log (kept, truncated at ${Math.floor(LOG_MAX_BYTES / 1024)}KB): ${job.logPath}`);
  } else {
    // The 2KB tail above carries everything worth keeping — remove the file
    // so backgrounded jobs don't leak sensitive output into tmp forever.
    // The open() race is handled job.finished-side (see the open handler).
    void rm(job.logPath, { force: true }).catch(() => {});
  }
  deliver(pi, lines.filter(Boolean).join("\n"));
}

/** Fire-and-forget follow-up delivery (never rejects into the exec path). */
function deliver(pi: ExtensionAPI, text: string): void {
  if (!deliveryEnabled) return;
  try {
    pi.sendMessage(
      { customType: "pi-model-tools-bg", content: text, display: true },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } catch {
    // Best-effort; the job's log survives on disk either way.
  }
}
