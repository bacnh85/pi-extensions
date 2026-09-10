/**
 * pi-cron — scheduled jobs for Pi.
 *
 * Jobs live in <agentDir>/cron/jobs.json. A 30s in-process timer fires due
 * jobs by delivering a follow-up turn into the live session (the same rail
 * pi-subagent uses for background completions). Past-due jobs catch up once
 * on the next tick (Hermes semantics). `export` prints crontab lines so jobs
 * can also run via system cron while pi is closed.
 *
 * Loop guard: while a cron-fired turn is in flight, mutating actions
 * (add/remove/run) are refused — a fired job can never schedule more jobs
 * (Hermes disables cron tools in fired runs for the same reason).
 *
 * No ExtensionContext is captured across time — the timer never touches ctx,
 * so the stale-ctx crash class (pi-sub) cannot happen here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, readFileSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { nextFires, validateSchedule } from "./lib/schedule.ts";
import {
  addJob,
  dueJobs,
  findJob,
  jobsDir,
  loadJobs,
  markFired,
  removeJob,
  saveJobs,
  setJobEnabled,
  setJobResult,
  type CronJob,
} from "./lib/jobs.ts";

const DEFAULT_TICK_MS = 30_000;
const MUTATING_ACTIONS = new Set(["add", "remove", "run", "enable", "disable"]);
/** Loop guard is purely time-based: mutations are refused within this window
 * after the last armed fire. SDK events carry no turn identity (AgentSettledEvent
 * is payload-free; message_start fires at custom-message DELIVERY), so a settle-
 * correlated counter is impossible — the window self-expires, over-arming (safe)
 * rather than under-arming while cron turns are queued/running. */
const GUARD_LINGER_MS = 30_000;
export { GUARD_LINGER_MS };

// ---------------------------------------------------------------------------

export interface CronSettings {
  enabled: boolean;
  tickMs: number;
}

/** Read the `cron` settings key (cwd/.pi → PI_CODING_AGENT_DIR|~/.pi/agent → ~/.pi/agents). */
export function readCronSettings(cwd = process.cwd()): CronSettings {
  const home = os.homedir();
  const dirs = [join(cwd, ".pi"), process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), join(home, ".pi", "agents")];
  for (const dir of dirs) {
    try {
      const v = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))?.cron;
      if (v && typeof v === "object") {
        const tickMs = Number(v.tickMs);
        return {
          enabled: v.enabled !== false,
          tickMs: Math.min(Math.max(Number.isFinite(tickMs) && tickMs > 0 ? tickMs : DEFAULT_TICK_MS, 5_000), 600_000),
        };
      }
    } catch {
      // missing/unreadable settings.json — try next location
    }
  }
  return { enabled: true, tickMs: DEFAULT_TICK_MS };
}

/**
 * Loop guard: mutating actions refused within GUARD_LINGER_MS of the last
 * armed fire (lastArmAt=0 = never armed). Headless children (PI_CRON_DISABLED)
 * are refused separately at the call site.
 */
export function isMutationRefused(lastFireArmAt: number, action: string, now = Date.now()): boolean {
  return lastFireArmAt > 0 && now - lastFireArmAt < GUARD_LINGER_MS && MUTATING_ACTIONS.has(action);
}

export function fireContent(job: CronJob): string {
  return `⏰ Cron job '${job.name}' fired:\n${job.prompt}\n(cron job fired — do not create, modify, or trigger cron jobs from this turn)`;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function fmt(ms: number | undefined): string {
  return ms === undefined ? "never" : new Date(ms).toLocaleString();
}

export function isPinned(job: Pick<CronJob, "model" | "thinking">): boolean {
  return !!(job.model || job.thinking);
}

/** CLI args for a pinned (headless) run — same flags a user would type. */
export function headlessArgs(job: Pick<CronJob, "model" | "thinking">): string[] {
  const args = ["-p", "--no-session"];
  if (job.model) args.push("--model", job.model);
  if (job.thinking) args.push("--thinking", job.thinking);
  return args;
}

/** One line of `list` output. */
function renderJob(j: CronJob): string {
  const pin = isPinned(j) ? `  pin: ${[j.model, j.thinking].filter(Boolean).join(":")}` : "";
  const status = j.lastStatus === "fail" ? ` [FAIL: ${j.lastError ?? "unknown"}]` : j.lastStatus === "ok" ? " [ok]" : "";
  return `${j.name.padEnd(20)} ${j.schedule.padEnd(15)} next: ${fmt(j.nextRun).padEnd(28)} last: ${fmt(j.lastRun).padEnd(28)} ${j.enabled ? "enabled" : "DISABLED"}${status}${pin}`;
}

export function renderList(jobs: CronJob[]): string {
  if (jobs.length === 0) {
    return `No cron jobs. Add one: cron action:"add" name:"daily" schedule:"0 9 * * mon" prompt:"..."`;
  }
  return jobs.map(renderJob).join("\n");
}

/** Escape crontab's special % (newline/stdin-end) — lexical, applies inside shell quotes too. */
export function cronEscape(s: string): string {
  return s.replace(/%/g, "\\%");
}

export function renderExport(jobs: CronJob[], logsDir: string): string {
  // The logs dir must exist before an installed crontab line first fires,
  // or every run fails with "No such file or directory".
  if (jobs.some((j) => j.enabled)) mkdirSync(logsDir, { recursive: true });
  const lines = [
    "# pi-cron export — install with:  crontab -l | cat - cron.txt | crontab -",
    "# Each line runs a headless `pi -p` (pi must be on cron's PATH); output lands under:",
    `#   ${logsDir}/`,
  ];
  for (const j of jobs) {
    if (!j.enabled) continue;
    // Newlines are legal in prompts (multi-line prompts are natural) but not
    // representable in a crontab line — a raw \n would terminate the command
    // and turn the continuation into a live crontab entry. Skip, never emit.
    if ([j.prompt, j.cwd, j.model ?? ""].some((s) => /[\n\r]/.test(s))) {
      lines.push(`# job: ${j.name} skipped: prompt/cwd/model contains a newline (not representable in crontab)`);
      continue;
    }
    const pin = `${j.model ? ` --model ${cronEscape(shellQuote(j.model))}` : ""}${j.thinking ? ` --thinking ${cronEscape(shellQuote(j.thinking))}` : ""}`;
    lines.push(`# job: ${j.name}`);
    lines.push(
      `${j.schedule} cd ${cronEscape(shellQuote(j.cwd))} && pi -p --no-session${pin} ${cronEscape(shellQuote(j.prompt))} >> ${cronEscape(shellQuote(join(logsDir, `${j.name}.log`)))} 2>&1`,
    );
  }
  if (!jobs.some((j) => j.enabled)) lines.push("# (no enabled jobs)");
  return lines.join("\n");
}

/**
 * Deliver a fire as a follow-up turn. The loop guard arms ONLY on successful
 * delivery: a throwing send never starts a turn, so agent_settled would never
 * fire and the flag would stick, wedging future add/remove/run calls.
 */
export function deliverFire(
  send: (...args: Parameters<ExtensionAPI["sendMessage"]>) => void,
  state: { lastFireArmAt: number },
  job: CronJob,
): boolean {
  try {
    send(
      {
        customType: "pi-cron-fire",
        content: fireContent(job),
        display: true,
        details: { name: job.name, schedule: job.schedule, lastRun: job.lastRun },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    state.lastFireArmAt = Date.now();
    return true;
  } catch {
    // Delivery failed (e.g. session gone) — the job is already marked fired;
    // next schedule continues and the guard stays disarmed.
    return false;
  }
}

/** Env for headless children: disables the cron scheduler inside the child so
 * parent/child ticks never race on the shared jobs.json. */
export function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PI_CRON_DISABLED: "1" };
}

export interface HeadlessDeps {
  spawnFn: typeof spawn;
  send: (...args: Parameters<ExtensionAPI["sendMessage"]>) => void;
  state: { lastFireArmAt: number };
  logsDir: string;
  jobsDir: string;
  /** Hard cap for the child run. Default 10 min. */
  timeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL. Default 5s. */
  escalateMs?: number;
}

/**
 * Run a pinned job headless in its own pi process (Hermes-style fresh-session
 * run): output is logged and the result is delivered back as a follow-up.
 */
export function runHeadless(job: CronJob, deps: HeadlessDeps): void {
  const { spawnFn, send, state, logsDir, jobsDir } = deps;
  const logPath = join(logsDir, `${job.name}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  let out = "";
  let done = false;
  const finish = (code: number | null, errMsg?: string) => {
    if (done) return;
    done = true;
    clearTimeout(killer);
    if (escalate) clearTimeout(escalate);
    try {
      mkdirSync(logsDir, { recursive: true });
      appendFileSync(logPath, out + (errMsg ? `\n[error] ${errMsg}\n` : ""));
    } catch {
      // log write is best-effort
    }
    const label = `⏰ Cron job '${job.name}' (headless${job.model ? `, model ${job.model}` : ""}${job.thinking ? `, thinking ${job.thinking}` : ""})`;
    const ok = !errMsg && code === 0;
    try {
      setJobResult(jobsDir, job.name, ok ? "ok" : "fail", ok ? undefined : (errMsg ?? out.slice(-200)));
    } catch {
      // status persistence is best-effort — this runs in a deferred child
      // callback where an uncaught throw would kill the host pi process
    }
    const body = errMsg
      ? `${label} failed to start: ${errMsg}`
      : `${label} finished (exit ${code ?? "signal"}).\nOutput (tail):\n${out.slice(-4000) || "(none)"}\nLog: ${logPath}`;
    deliverFire(send, state, { ...job, prompt: body });
  };
  // ponytail: hard 10-min cap — SIGTERM, then SIGKILL after the grace window;
  // finish() is called at cap time so result/status happen even if close lags.
  const timeoutMs = deps.timeoutMs ?? 600_000;
  const escalateMs = deps.escalateMs ?? 5_000;
  let escalate: NodeJS.Timeout | undefined;
  const killer = setTimeout(
    () => {
      child?.kill("SIGTERM");
      escalate = setTimeout(() => {
        child?.kill("SIGKILL");
        finish(null, `timed out after ${timeoutMs}ms`);
      }, escalateMs);
      escalate.unref?.();
    },
    timeoutMs,
  );
  killer.unref?.();
  let child: ReturnType<typeof spawn>;
  try {
    child = spawnFn("pi", [...headlessArgs(job), job.prompt], {
      cwd: job.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv(),
    });
  } catch (err) {
    clearTimeout(killer);
    finish(null, String(err));
    return;
  }
  child.stdout?.on("data", (d: Buffer) => {
    if (out.length < 20_000) out += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    if (out.length < 20_000) out += d.toString();
  });
  child.on("error", (err: Error) => {
    clearTimeout(killer);
    finish(null, err.message);
  });
  child.on("close", (code) => {
    clearTimeout(killer);
    finish(code);
  });
}

/** Newest log file for a job, or undefined. */
export function latestLog(logsDir: string, name: string): string | undefined {
  let newest: string | undefined;
  let newestMs = -1;
  try {
  for (const f of readdirSync(logsDir)) {
    // `${name}-<ts>.log` = in-process headless runs; `${name}.log` = export-installed crontab runs
    if (f !== `${name}.log` && (!f.startsWith(`${name}-`) || !f.endsWith(".log"))) continue;
      const p = join(logsDir, f);
      const ms = statSync(p).mtimeMs;
      if (ms > newestMs) {
        newestMs = ms;
        newest = p;
      }
    }
  } catch {
    return undefined;
  }
  return newest;
}

/**
 * Run one scheduler tick: fire all due jobs exactly once. Swallows everything —
 * uncaught timer exceptions kill pi outright. Exported for tests.
 */
export function tickOnce(deps: {
  dir: string;
  enabled: boolean;
  fire: (job: CronJob) => void;
  now?: number;
}): void {
  try {
    if (!deps.enabled) return;
    const jobs = loadJobs(deps.dir);
    const now = deps.now ?? Date.now();
    const due = dueJobs(jobs, now);
    if (due.length === 0) return;
    // Mark first, deliver second — a crashed delivery never re-fires in a loop.
    for (const job of due) markFired(job, now);
    saveJobs(deps.dir, jobs);
    for (const job of due) deps.fire(job);
  } catch {
    // never escape into the timer
  }
}

export interface CronActionArgs {
  dir: string;
  state: { lastFireArmAt: number };
  childMode: boolean;
  send: (...args: Parameters<ExtensionAPI["sendMessage"]>) => void;
  fire: (job: CronJob) => void;
  params: { action: string; name?: string; schedule?: string; prompt?: string; cwd?: string; model?: string; thinking?: string; enabled?: boolean };
  cwd: string;
}

/** The cron tool's action dispatch. Exported for tests; throws on refused/failed actions. */
export function runCronAction(args: CronActionArgs): { content: { type: "text"; text: string }[]; details: unknown } {
  const { dir, state, childMode, send, fire, cwd } = args;
  const { action, name, schedule, prompt, cwd: paramCwd, model, thinking, enabled } = args.params;

  if (childMode && MUTATING_ACTIONS.has(action)) {
    throw new Error(
      `cron: "${action}" is disabled in headless cron runs (PI_CRON_DISABLED) — fired jobs cannot create, remove, or trigger jobs.`,
    );
  }
  if (isMutationRefused(state.lastFireArmAt, action)) {
    throw new Error(
      `cron: "${action}" is refused while a cron-fired turn is in progress (loop guard — fired jobs cannot create, remove, or trigger jobs).`,
    );
  }

  switch (action) {
    case "add": {
      const job = addJob(dir, { name, schedule, prompt, cwd: paramCwd ?? cwd, model, thinking, enabled }, Date.now());
      const pin = isPinned(job) ? ` Runs headless (${[job.model, job.thinking].filter(Boolean).join(", thinking ")}) — result arrives as a follow-up.` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Job '${job.name}' added (${job.schedule}). Next fire: ${fmt(job.nextRun)}.${pin} Fired turns cannot schedule further jobs. Use action:"remove" name:"${job.name}" to delete.`,
          },
        ],
        details: { action: "add", job },
      };
    }
    case "remove": {
      if (!name) throw new Error('name is required for action:"remove".');
      if (!removeJob(dir, name)) throw new Error(`No job named '${name}'.`);
      return { content: [{ type: "text" as const, text: `Job '${name}' removed.` }], details: { action: "remove", name } };
    }
    case "list": {
      const jobs = loadJobs(dir);
      return { content: [{ type: "text" as const, text: renderList(jobs) }], details: { action: "list", count: jobs.length } };
    }
    case "run": {
      if (!name) throw new Error('name is required for action:"run".');
      const jobs = loadJobs(dir);
      const job = findJob(jobs, name);
      if (!job) throw new Error(`No job named '${name}'.`);
      if (!job.enabled) throw new Error(`Job '${name}' is disabled (enable with cron action:"enable" name:"${name}").`);
      markFired(job, Date.now());
      saveJobs(dir, jobs);
      fire(job);
      return {
        content: [{ type: "text" as const, text: `Job '${job.name}' fired manually — result arrives as a follow-up turn.` }],
        details: { action: "run", name },
      };
    }
    case "enable":
    case "disable": {
      if (!name) throw new Error(`name is required for action:"${action}".`);
      const job = setJobEnabled(dir, name, action === "enable", Date.now());
      const text =
        action === "enable"
          ? `Job '${job.name}' enabled. Next fire: ${fmt(job.nextRun)}.`
          : `Job '${job.name}' disabled — schedule kept; enable to resume.`;
      return { content: [{ type: "text" as const, text }], details: { action, name, job } };
    }
    case "test": {
      if (!schedule) throw new Error('schedule is required for action:"test".');
      const err = validateSchedule(schedule);
      if (err) throw new Error(`Invalid cron schedule '${schedule}': ${err}`);
      const fires = nextFires(schedule, 5, new Date());
      return {
        content: [
          {
            type: "text" as const,
            text: fires.length ? fires.map((d) => d.toLocaleString()).join("\n") : "No upcoming fire times.",
          },
        ],
        details: { action: "test", schedule, fires: fires.map((d) => d.toISOString()) },
      };
    }
    case "logs": {
      if (!name) throw new Error('name is required for action:"logs".');
      const log = latestLog(join(dir, "logs"), name);
      if (!log) {
        return { content: [{ type: "text" as const, text: `No logs for '${name}'.` }], details: { action: "logs", name } };
      }
      const tail = readFileSync(log, "utf8").split("\n").slice(-40).join("\n");
      return {
        content: [{ type: "text" as const, text: `${log} (tail):\n${tail}` }],
        details: { action: "logs", name, log },
      };
    }
    case "export": {
      const jobs = loadJobs(dir);
      return {
        content: [{ type: "text" as const, text: renderExport(jobs, join(dir, "logs")) }],
        details: { action: "export", count: jobs.filter((j) => j.enabled).length },
      };
    }
    default:
      throw new Error(`Unknown action '${action}'.`);
  }
}

// ---------------------------------------------------------------------------

export default function cronExtension(pi: ExtensionAPI) {
  const dir = jobsDir(getAgentDir());
  const settings = readCronSettings();
  const state = { lastFireArmAt: 0 };
  // Headless cron children: scheduler off, cron mutations refused (tool-level
  // enforcement — the advisory line in fireContent is not enough there).
  const childMode = process.env.PI_CRON_DISABLED === "1";

  const send = pi.sendMessage.bind(pi);

  function fire(job: CronJob): void {
    if (isPinned(job)) {
      runHeadless(job, { spawnFn: spawn, send, state, logsDir: join(dir, "logs"), jobsDir: dir });
    } else {
      const delivered = deliverFire(send, state, job);
      setJobResult(dir, job.name, delivered ? "ok" : "fail", delivered ? undefined : "delivery failed");
    }
  }

  function tick(): void {
    tickOnce({ dir, enabled: settings.enabled, fire });
  }

  if (!childMode) {
    const timer = setInterval(tick, settings.tickMs);
    timer.unref?.();
  }

  // (No agent_settled handling — the loop guard is purely time-based.)

  pi.registerTool({
    name: "cron",
    label: "Cron",
    description:
      "Schedule recurring jobs (cron) that fire a prompt into this session while pi is running. Actions: add, remove, list, run (manual fire), enable/disable (toggle a job), test (preview fire times), logs (tail a job's newest log), export (crontab lines for 24/7).",
    promptSnippet: "Schedule cron jobs: add/remove/list/run/enable/disable/test/logs/export.",
    promptGuidelines: [
      'Convert natural-language schedules to 5-field cron and verify with action:"test" before add.',
      "Job prompts must be self-contained — fired turns have no conversation context.",
      "Fired turns cannot create, remove, or trigger jobs (loop guard).",
      'Pin model:"provider/id" and/or thinking:"high" to run a job headless in its own pi process — the result is delivered back as a follow-up.',
    ],
    parameters: Type.Object({
      action: Type.Union(
        ["add", "remove", "list", "run", "enable", "disable", "test", "logs", "export"].map((a) => Type.Literal(a)),
        { description: "Operation to perform." },
      ),
      name: Type.Optional(Type.String({ description: "Job name (add/remove/run/enable/disable)." })),
      enabled: Type.Optional(
        Type.Boolean({ description: 'Create the job disabled (add, default true). Re-enable later with action:"enable".' }),
      ),
      schedule: Type.Optional(
        Type.String({ description: '5-field cron expression (add/test), e.g. "0 9 * * mon".' }),
      ),
      prompt: Type.Optional(
        Type.String({ description: 'Self-contained prompt fired as a turn (add), e.g. "Check CI status and summarize failures".' }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Working dir recorded for export lines (add). Defaults to current dir." }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            'Model pattern for the fired run, e.g. "zai-anthropic/glm-5.3-flash" (optionally "model:high"). Set → job runs headless in its own pi process; result arrives as a follow-up (add).',
        }),
      ),
      thinking: Type.Optional(
        Type.String({ description: "Thinking level for the fired run: off|minimal|low|medium|high|xhigh|max (add). Implies headless." }),
      ),
      // logs shares `name` with remove/run
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return runCronAction({
        dir,
        state,
        childMode,
        send,
        fire,
        params: params as {
          action: string;
          name?: string;
          schedule?: string;
          prompt?: string;
          cwd?: string;
          model?: string;
          thinking?: string;
        },
        cwd: ctx.cwd,
      });
    },
  });

  pi.registerCommand("cron", {
    description: "List cron jobs",
    handler: async (_args, ctx) => {
      ctx.ui.notify(renderList(loadJobs(dir)), "info");
    },
  });
}
