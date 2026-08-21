/**
 * Tests for env-var timeout parsing in security.ts (the single source of truth
 * for both timeouts):
 *   PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS -> DEFAULT_TIMEOUT_MS
 *   PI_SUBAGENT_HARD_TIMEOUT_MINS       -> HARD_TIMEOUT_MS
 *
 * Both are read once at module load via getNumericEnvVar, which warns on
 * invalid/out-of-range values and falls back to a default. The hard cap is also
 * clamped up to the inactivity window.
 *
 * - Module-load constants use a per-call query-string cache-bust so each case
 *   re-evaluates the env reads for THIS module only. Every case pins BOTH env
 *   vars (undefined deletes) so tests are isolated from leaked values.
 * - getNumericEnvVar is unit-tested directly (stderr spy) for the warn rules.
 *
 * runner.ts only re-exports these values, so it has no env timeouts of its own
 * to test.
 */
import assert from "node:assert/strict";
import { getNumericEnvVar } from "../security.ts";

const INACTIVITY_ENV = "PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS";
const HARD_ENV = "PI_SUBAGENT_HARD_TIMEOUT_MINS";

let counter = 0;
async function loadSecurity() {
  // ponytail: unique query string forces a fresh module instance so the
  // module-load-time env reads re-run with the current process.env.
  return import(`../security.ts?envtimeouts=${counter++}`);
}

type Env = Record<string, string | undefined>;

/** Set env vars (undefined deletes); restore originals afterwards. */
async function withEnv(
  env: Env,
  fn: (mod: typeof import("../security.js")) => void | Promise<void>,
) {
  const saved: Env = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  const origWrite = process.stderr.write.bind(process.stderr);
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Module-load warnings are asserted via getNumericEnvVar directly; silence
    // them here so the constant tests stay quiet.
    process.stderr.write = (() => true) as unknown as typeof process.stderr.write;
    await fn(await loadSecurity());
  } finally {
    process.stderr.write = origWrite;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Run `fn`, capturing anything written to stderr (for warning assertions). */
function captureStderr(fn: () => void): string[] {
  const msgs: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown) => {
    msgs.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return msgs;
}

/** Set env vars for a synchronous call; restore originals afterwards. */
function withEnvSync(env: Env, fn: () => void) {
  const saved: Env = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("getNumericEnvVar", () => {
  it("returns default when unset, no warning", () => {
    let got = 0;
    const msgs = captureStderr(() => {
      withEnvSync({ [INACTIVITY_ENV]: undefined }, () => {
        got = getNumericEnvVar(INACTIVITY_ENV, 3, 1, 60);
      });
    });
    assert.equal(got, 3);
    assert.equal(msgs.length, 0);
  });

  it("returns default on empty string, no warning", () => {
    let got = 0;
    const msgs = captureStderr(() => {
      withEnvSync({ [INACTIVITY_ENV]: "" }, () => {
        got = getNumericEnvVar(INACTIVITY_ENV, 3, 1, 60);
      });
    });
    assert.equal(got, 3);
    assert.equal(msgs.length, 0);
  });

  it("returns default + warns on non-number", () => {
    let got = 0;
    const msgs = captureStderr(() => {
      withEnvSync({ [INACTIVITY_ENV]: "abc" }, () => {
        got = getNumericEnvVar(INACTIVITY_ENV, 3, 1, 60);
      });
    });
    assert.equal(got, 3);
    assert.ok(msgs.some((m) => /not a number/.test(m)));
  });

  it("clamps to min + warns when below minimum", () => {
    let got = 0;
    const msgs = captureStderr(() => {
      withEnvSync({ [INACTIVITY_ENV]: "0" }, () => {
        got = getNumericEnvVar(INACTIVITY_ENV, 3, 1, 60);
      });
    });
    assert.equal(got, 1);
    assert.ok(msgs.some((m) => /below the minimum/.test(m)));
  });

  it("clamps to max + warns when above maximum", () => {
    let got = 0;
    const msgs = captureStderr(() => {
      withEnvSync({ [INACTIVITY_ENV]: "70" }, () => {
        got = getNumericEnvVar(INACTIVITY_ENV, 3, 1, 60);
      });
    });
    assert.equal(got, 60);
    assert.ok(msgs.some((m) => /above the maximum/.test(m)));
  });

  it("returns the value with no warning when in range", () => {
    let got = 0;
    const msgs = captureStderr(() => {
      withEnvSync({ [INACTIVITY_ENV]: "7" }, () => {
        got = getNumericEnvVar(INACTIVITY_ENV, 3, 1, 60);
      });
    });
    assert.equal(got, 7);
    assert.equal(msgs.length, 0);
  });
});

describe("security.ts module-load timeout constants", () => {
  const UNSET = { [INACTIVITY_ENV]: undefined, [HARD_ENV]: undefined };

  it("inactivity: uses 3-minute default when env var is missing", () =>
    withEnv(UNSET, (mod) => {
      assert.equal(mod.DEFAULT_TIMEOUT_MS, 3 * 60 * 1_000);
    }));

  it("inactivity: uses default when env var is empty string", () =>
    withEnv({ [INACTIVITY_ENV]: "", [HARD_ENV]: undefined }, (mod) => {
      assert.equal(mod.DEFAULT_TIMEOUT_MS, 3 * 60 * 1_000);
    }));

  it("inactivity: uses default when env var is not a number", () =>
    withEnv({ [INACTIVITY_ENV]: "abc", [HARD_ENV]: undefined }, (mod) => {
      assert.equal(mod.DEFAULT_TIMEOUT_MS, 3 * 60 * 1_000);
    }));

  it("inactivity: env var 7 -> configured minutes 7", () =>
    withEnv({ [INACTIVITY_ENV]: "7", [HARD_ENV]: undefined }, (mod) => {
      assert.equal(mod.DEFAULT_TIMEOUT_MS, 7 * 60 * 1_000);
    }));

  it("inactivity: env var 20 -> configured minutes 20", () =>
    withEnv({ [INACTIVITY_ENV]: "20", [HARD_ENV]: undefined }, (mod) => {
      assert.equal(mod.DEFAULT_TIMEOUT_MS, 20 * 60 * 1_000);
    }));

  it("inactivity: floors values below 1 at the 1-minute minimum", () =>
    withEnv({ [INACTIVITY_ENV]: "0", [HARD_ENV]: undefined }, (mod) => {
      assert.equal(mod.DEFAULT_TIMEOUT_MS, 1 * 60 * 1_000);
    }));

  it("hard: uses the 20-minute default when env var is missing", () =>
    withEnv(UNSET, (mod) => {
      assert.equal(mod.HARD_TIMEOUT_MS, 20 * 60 * 1_000);
    }));

  it("hard: uses default when env var is not a number", () =>
    withEnv({ [INACTIVITY_ENV]: undefined, [HARD_ENV]: "lunch" }, (mod) => {
      assert.equal(mod.HARD_TIMEOUT_MS, 20 * 60 * 1_000);
    }));

  it("hard: uses the configured minutes when env var is a number", () =>
    withEnv({ [INACTIVITY_ENV]: undefined, [HARD_ENV]: "45" }, (mod) => {
      assert.equal(mod.HARD_TIMEOUT_MS, 45 * 60 * 1_000);
    }));

  it("hard: clamps up to the inactivity window when set below it", () =>
    withEnv({ [INACTIVITY_ENV]: "7", [HARD_ENV]: "1" }, (mod) => {
      assert.equal(mod.HARD_TIMEOUT_MS, 7 * 60 * 1_000);
    }));
});
