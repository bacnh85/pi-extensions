/**
 * Discriminating tests for the hermetic scratch-dir helper (test/tmp.ts):
 * they pin both halves of the contract — ambient temp is still preferred
 * when usable (no behavior change for normal environments), and the suite
 * keeps working where ambient temp is NOT usable (the old
 * `mkdtempSync(os.tmpdir())` pattern failed there).
 */
import { assert } from "chai";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { makeTempDir, resolveTempBase, TREE_SCRATCH_ROOT } from "./tmp";

describe("hermetic test scratch dirs (test/tmp)", () => {
  // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows at call time.
  const vars = ["TMPDIR", "TEMP", "TMP"] as const;

  function withAmbientTemp(base: string, fn: () => void): void {
    const saved = vars.map((v) => [v, process.env[v]] as const);
    for (const v of vars) process.env[v] = base;
    try {
      fn();
    } finally {
      for (const [v, val] of saved) {
        if (val === undefined) delete process.env[v];
        else process.env[v] = val;
      }
    }
  }

  it("prefers the ambient temp dir when it is usable (no change where /tmp works)", () => {
    const ambient = makeTempDir("pi-a2a-ambient-");
    withAmbientTemp(ambient, () => {
      assert.equal(resolveTempBase(), ambient, "a usable ambient temp dir must be preferred over the in-tree fallback");
    });
  });

  it("falls back to the in-tree scratch root when ambient temp is unusable, and it stays writable", () => {
    // Point the ambient temp dir at a plain FILE: mkdtemp under it fails with
    // ENOTDIR on every platform and for every user — including root, which
    // would bypass a chmod-based read-only probe.
    const holder = makeTempDir("pi-a2a-holder-");
    const notADir = path.join(holder, "not-a-dir");
    writeFileSync(notADir, "x");
    withAmbientTemp(notADir, () => {
      assert.equal(resolveTempBase(), TREE_SCRATCH_ROOT, "unusable ambient temp must fall back to the test tree");
      // The whole point: scratch dirs still work without ambient temp —
      // the old mkdtempSync(os.tmpdir()) pattern throws ENOTDIR here.
      const dir = makeTempDir("pi-a2a-fallback-");
      assert.isTrue(dir.startsWith(TREE_SCRATCH_ROOT + path.sep), "scratch dir must live under the in-tree root");
      const probe = path.join(dir, "probe.txt");
      writeFileSync(probe, "writable");
      assert.equal(readFileSync(probe, "utf-8"), "writable");
    });
  });
});
