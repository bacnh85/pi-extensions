/**
 * Regression: wrong-cwd delivery of unpinned cron fires.
 *
 * Bug (fixed in fire()): jobs.json is global to the agent dir. Any open pi
 * session sharing the agent dir runs the 30s tickOnce() scheduler, and
 * whichever session ticks first fires the job — including a session whose cwd
 * differs from job.cwd. Unpinned fires were delivered as follow-up turns into
 * THAT session (deliverFire → sendMessage), so the prompt ran under the wrong
 * cwd. job.cwd was only honored by runHeadless (pinned jobs) and `export`.
 *
 * Driven at the seam where the fix landed: the real extension's fire()
 * closure, reached via the cron tool's execute() with a foreign-session cwd.
 * Both the ctx.cwd passed here AND process.cwd() point at the foreign session
 * (pi's session cwd is process.cwd()). The scheduler tick routes through the
 * same fire() closure, so pinning execute() pins both paths.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "mocha";
import cronExtension from "./index.ts";
import { loadJobs, saveJobs } from "./lib/jobs.ts";

describe("cwd guard — unpinned fires must not run in a foreign-cwd session", () => {
  it("does NOT deliver a due job into a session whose cwd differs from job.cwd", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-cron-cwd-agent-"));
    const jobCwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-cron-cwd-job-")));
    const sessionCwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-cron-cwd-session-")));

    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    const prevCwd = process.cwd();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const sent: unknown[] = [];
    // Minimal ExtensionAPI stand-in: capture the registered cron tool + sendMessage.
    let execute!: (...args: unknown[]) => Promise<unknown>;
    const fakePi = {
      registerTool: (t: { execute: (...args: unknown[]) => Promise<unknown> }) => {
        execute = t.execute;
      },
      registerCommand: () => {},
      sendMessage: (...args: unknown[]) => {
        sent.push(args);
      },
    };

    try {
      cronExtension(fakePi as never);

      // Session A (cwd = jobCwd) adds the job; cwd is recorded from ctx.
      execute(undefined, { action: "add", name: "a", schedule: "* * * * *", prompt: "list files" }, undefined, undefined, {
        cwd: jobCwd,
      });
      const store = join(agentDir, "cron");
      assert.equal(loadJobs(store)[0]!.cwd, jobCwd, "job records the adding session's cwd");

      // Make the job due now.
      const jobs = loadJobs(store);
      jobs[0]!.nextRun = 1;
      saveJobs(store, jobs);
      assert.ok(JSON.parse(readFileSync(join(store, "jobs.json"), "utf8")).jobs.length, "store on disk");

      // Foreign session (cwd = sessionCwd) fires it — process chdir'd to match
      // pi's real shape, so both candidate fix sources (ctx.cwd, process.cwd())
      // agree this is the WRONG session for the job.
      process.chdir(sessionCwd);
      execute(undefined, { action: "run", name: "a" }, undefined, undefined, { cwd: sessionCwd });

      // THE ASSERTION: delivery into the foreign session is the bug.
      assert.deepEqual(
        sent.map((a) => ((a as unknown[])[0] as { customType?: string }).customType),
        [],
        "no follow-up turn may be injected into a session whose cwd !== job.cwd",
      );
      assert.equal(loadJobs(store)[0]!.lastStatus, "fail", "skip is visible as a failed result, not a silent drop");
    } finally {
      process.chdir(prevCwd);
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
  });
});
