// Job store: <agentDir>/cron/jobs.json. Atomic writes (tmp+rename), corrupt
// files quarantined (never crash), all mutators take a `now` for testability.
// Layout follows Hermes' proven ~/.hermes/cron/jobs.json pattern.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextFire, validateSchedule } from "./schedule.ts";

export interface CronJob {
  name: string;
  schedule: string; // 5-field cron expression
  prompt: string; // fired as a follow-up turn
  cwd: string; // recorded working dir (used by `export`)
  enabled: boolean;
  nextRun: number; // epoch ms
  lastRun?: number; // epoch ms
  /** pi --model pattern ("provider/id", optionally "id:level"). Set → job runs headless. */
  model?: string;
  /** Thinking level pin: off|minimal|low|medium|high|xhigh|max. */
  thinking?: string;
  /** Outcome of the most recent pinned run (unpinned: "ok" = delivered). */
  lastStatus?: "ok" | "fail";
  /** Failure reason (truncated) when lastStatus is "fail". */
  lastError?: string;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const MAX_JOBS = 20;
const NAME_RE = /^[\w.-]{1,64}$/;

export function jobsDir(agentDir: string): string {
  return join(agentDir, "cron");
}

function jobsPath(dir: string): string {
  return join(dir, "jobs.json");
}

function isJob(v: unknown): v is CronJob {
  const j = v as CronJob;
  if (
    !j ||
    typeof j.name !== "string" ||
    typeof j.schedule !== "string" ||
    typeof j.prompt !== "string" ||
    typeof j.cwd !== "string" ||
    typeof j.enabled !== "boolean" ||
    typeof j.nextRun !== "number"
  ) {
    return false;
  }
  // Hand-edited/corrupt files must not smuggle shell metachars into crontab
  // export lines: schedule (unquoted) AND name (export comment + log filename)
  // are name/charset-validated; pins must be strings when present.
  if (!NAME_RE.test(j.name)) return false;
  const fields = j.schedule.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((f) => !/^[\dA-Za-z\*\/\,\-]+$/.test(f))) return false;
  if (j.model !== undefined && (typeof j.model !== "string" || j.model.trim() === "")) return false;
  if (j.thinking !== undefined && (typeof j.thinking !== "string" || !THINKING_LEVELS.includes(j.thinking as (typeof THINKING_LEVELS)[number]))) return false;
  if (j.lastStatus !== undefined && j.lastStatus !== "ok" && j.lastStatus !== "fail") return false;
  return true;
}

export function loadJobs(dir: string): CronJob[] {
  let raw: string;
  try {
    raw = readFileSync(jobsPath(dir), "utf8");
  } catch {
    return []; // missing file = no jobs
  }
  try {
    const parsed = JSON.parse(raw) as { jobs?: unknown };
    if (!Array.isArray(parsed?.jobs)) throw new Error("bad shape");
    return parsed.jobs.filter(isJob);
  } catch {
    // Quarantine and start empty — a corrupt file must never wedge the agent.
    try {
      renameSync(jobsPath(dir), join(dir, `jobs.corrupt-${Date.now()}.json`));
    } catch {
      // rename race — next tick re-detects
    }
    return [];
  }
}

export function saveJobs(dir: string, jobs: CronJob[]): void {
  // ponytail: no cross-process lock — single session per agentDir assumed;
  // concurrent sessions can lose edits/double-fire (documented in README).
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.jobs.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify({ jobs }, null, 2) + "\n");
  renameSync(tmp, jobsPath(dir));
}

export function findJob(jobs: CronJob[], name: string): CronJob | undefined {
  return jobs.find((j) => j.name === name);
}

export function addJob(
  dir: string,
  input: { name?: string; schedule?: string; prompt?: string; cwd?: string; enabled?: boolean; model?: string; thinking?: string },
  now: number,
): CronJob {
  const name = (input.name ?? "").trim();
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid job name ${JSON.stringify(input.name ?? "")} — allowed: letters, digits, _ . - (max 64 chars).`);
  }
  const jobs = loadJobs(dir);
  if (jobs.some((j) => j.name === name)) {
    throw new Error(`Job '${name}' already exists — remove it first (cron action:"remove" name:"${name}").`);
  }
  if (jobs.length >= MAX_JOBS) {
    throw new Error(`Job cap reached (${MAX_JOBS}) — remove one first.`);
  }
  const schedule = (input.schedule ?? "").trim();
  const schedErr = validateSchedule(schedule);
  if (schedErr) throw new Error(`Invalid cron schedule '${schedule}': ${schedErr}`);
  const prompt = (input.prompt ?? "").trim();
  if (!prompt) throw new Error("Prompt is required — it becomes the fired turn.");
  const nf = nextFire(schedule, new Date(now));
  if (!nf) throw new Error(`Schedule '${schedule}' has no future fire time.`);
  const model = input.model?.trim();
  if (input.model !== undefined && !model) throw new Error("Model pin must be a non-empty pattern (e.g. 'zai-anthropic/glm-5.3-flash').");
  const thinking = input.thinking?.trim().toLowerCase();
  if (thinking && !THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number])) {
    throw new Error(`Invalid thinking level '${input.thinking}' — allowed: ${THINKING_LEVELS.join(", ")}.`);
  }
  const job: CronJob = {
    name,
    schedule,
    prompt,
    cwd: input.cwd ?? process.cwd(),
    enabled: input.enabled !== false,
    nextRun: nf.getTime(),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
  jobs.push(job);
  saveJobs(dir, jobs);
  return job;
}

export function removeJob(dir: string, name: string): boolean {
  const jobs = loadJobs(dir);
  const next = jobs.filter((j) => j.name !== name);
  if (next.length === jobs.length) return false;
  saveJobs(dir, next);
  return true;
}

export function dueJobs(jobs: CronJob[], now: number): CronJob[] {
  return jobs.filter((j) => j.enabled && now >= j.nextRun);
}

/**
 * Enable/disable a job (reload-modify-save). Enabling recomputes nextRun from
 * now: a parked job (markFired sets nextRun=MAX_SAFE_INTEGER) would otherwise
 * never fire again, and a long-disabled job would catch-up-fire once on the
 * next tick instead of resuming at its next future occurrence.
 */
export function setJobEnabled(dir: string, name: string, enabled: boolean, now: number): CronJob {
  const jobs = loadJobs(dir);
  const job = findJob(jobs, name);
  if (!job) throw new Error(`No job named '${name}'.`);
  if (enabled && !job.enabled) {
    const nf = nextFire(job.schedule, new Date(now));
    if (!nf) {
      throw new Error(`Job '${name}' cannot be enabled — schedule '${job.schedule}' has no future fire time.`);
    }
    job.nextRun = nf.getTime();
  }
  job.enabled = enabled;
  saveJobs(dir, jobs);
  return job;
}

/** Persist the outcome of a job's most recent fire (reload-modify-save). */
export function setJobResult(dir: string, name: string, status: "ok" | "fail", error?: string): void {
  const jobs = loadJobs(dir);
  const job = findJob(jobs, name);
  if (!job) return;
  job.lastStatus = status;
  if (error) job.lastError = error.slice(0, 200);
  else delete job.lastError;
  saveJobs(dir, jobs);
}

/**
 * Record a fire: lastRun=now, nextRun advances past `now` (skipping missed
 * intermediates). A schedule with no future fire is parked disabled.
 */
export function markFired(job: CronJob, now: number): void {
  job.lastRun = now;
  const nf = nextFire(job.schedule, new Date(now));
  if (nf) {
    job.nextRun = nf.getTime();
  } else {
    job.enabled = false;
    job.nextRun = Number.MAX_SAFE_INTEGER;
  }
}
