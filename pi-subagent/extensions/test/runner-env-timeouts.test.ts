/**
 * Tests for the env-var timeout parsing at module load in runner.ts:
 *   PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS / PI_SUBAGENT_HARD_TIMEOUT_MINS
 * The values are read once when runner.ts is imported, so each case sets the
 * env vars and re-imports the module (query string cache-bust) to re-evaluate
 * the module-load-time constants.
 */
import assert from "node:assert/strict";

const INACTIVITY_ENV = "PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS";
const HARD_ENV = "PI_SUBAGENT_HARD_TIMEOUT_MINS";

let loadCounter = 0;
async function loadRunner() {
  // ponytail: query string forces a fresh module instance so the
  // module-load-time env reads re-run with the current process.env.
  return import(`../runner.ts?envtimeouts=${++loadCounter}`);
}

/** Run `fn` with the given env-var values in place, restoring afterwards. */
async function withEnv(
  env: { inactivity?: string; hard?: string },
  fn: (mod: typeof import("../runner.js")) => void,
) {
  const saved = {
    inactivity: process.env[INACTIVITY_ENV],
    hard: process.env[HARD_ENV],
  };
  try {
    if (env.inactivity === undefined) delete process.env[INACTIVITY_ENV];
    else process.env[INACTIVITY_ENV] = env.inactivity;
    if (env.hard === undefined) delete process.env[HARD_ENV];
    else process.env[HARD_ENV] = env.hard;
    fn(await loadRunner());
  } finally {
    if (saved.inactivity === undefined) delete process.env[INACTIVITY_ENV];
    else process.env[INACTIVITY_ENV] = saved.inactivity;
    if (saved.hard === undefined) delete process.env[HARD_ENV];
    else process.env[HARD_ENV] = saved.hard;
  }
}

describe("runner.ts env-var timeout defaults", () => {
  it("uses 3 / 20 minute defaults when env vars are missing", () =>
    withEnv({}, (mod) => {
      assert.equal(mod.DEFAULT_INACTIVITY_TIMEOUT_MS, 3 * 60 * 1000);
      assert.equal(mod.HARD_TIMEOUT_MS, 20 * 60 * 1000);
    }));

  it("uses defaults when env vars are empty strings", () =>
    withEnv({ inactivity: "", hard: "" }, (mod) => {
      assert.equal(mod.DEFAULT_INACTIVITY_TIMEOUT_MS, 3 * 60 * 1000);
      assert.equal(mod.HARD_TIMEOUT_MS, 20 * 60 * 1000);
    }));

  it("uses defaults when env vars are not numbers", () =>
    withEnv({ inactivity: "abc", hard: "lunch" }, (mod) => {
      assert.equal(mod.DEFAULT_INACTIVITY_TIMEOUT_MS, 3 * 60 * 1000);
      assert.equal(mod.HARD_TIMEOUT_MS, 20 * 60 * 1000);
    }));

  it("uses the configured minutes when env vars are numbers", () =>
    withEnv({ inactivity: "7", hard: "45" }, (mod) => {
      assert.equal(mod.DEFAULT_INACTIVITY_TIMEOUT_MS, 7 * 60 * 1000);
      assert.equal(mod.HARD_TIMEOUT_MS, 45 * 60 * 1000);
    }));

  it("falls back per-var: bad inactivity + valid hard keeps the hard value", () =>
    withEnv({ inactivity: "???", hard: "12" }, (mod) => {
      assert.equal(mod.DEFAULT_INACTIVITY_TIMEOUT_MS, 3 * 60 * 1000);
      assert.equal(mod.HARD_TIMEOUT_MS, 12 * 60 * 1000);
    }));
});
