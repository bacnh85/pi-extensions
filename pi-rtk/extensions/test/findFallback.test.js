import assert from "node:assert/strict";
import test from "node:test";
import { hasUnsupportedRtkFind } from "../findFallback.js";
import { parseSemver, supportsFindPassthrough } from "../version-gate.js";
test("always rejects mutating/consumer find predicates (any rtk version)", () => {
  assert.equal(hasUnsupportedRtkFind('rtk find . -type f -name "*.ts" -exec wc -l {} \\;'), true);
  assert.equal(hasUnsupportedRtkFind('rtk find . -name "*.js" -execdir rm {} \\;'), true);
  assert.equal(hasUnsupportedRtkFind("rtk find . -name '*.ts' -delete"), true);
  assert.equal(hasUnsupportedRtkFind('rtk find . -name "*.ts" -print0 | head -20'), true);
  assert.equal(hasUnsupportedRtkFind("rtk find . -name '*.ts' -regex '.+\\.ts'"), true);
});

test("rejects predicate tokens on rtk <0.46", () => {
  assert.equal(hasUnsupportedRtkFind('rtk find . -type f -name "*.ts" -o -name "*.tsx"', false), true);
  assert.equal(hasUnsupportedRtkFind("rtk find . -name '*.ts' -mtime -7", false), true);
  assert.equal(hasUnsupportedRtkFind("rtk find . -type f '(' -name '*.ts' ')'", false), true);
  assert.equal(hasUnsupportedRtkFind("rtk find . -newer x -type f", false), true);
  assert.equal(hasUnsupportedRtkFind("rtk find . -size +1k", false), true);
});

test("allows predicate tokens on rtk >=0.46 (passthrough verified)", () => {
  assert.equal(hasUnsupportedRtkFind('rtk find . -type f -name "*.ts" -o -name "*.tsx"', true), false);
  assert.equal(hasUnsupportedRtkFind("rtk find . -name '*.ts' -mtime -7", true), false);
  assert.equal(hasUnsupportedRtkFind("rtk find . -newer x -type f -perm 600 -empty", true), false);
  // mutating tokens still rejected even with passthrough
  assert.equal(hasUnsupportedRtkFind('rtk find . -name "*.ts" -exec rm {} \\;', true), true);
});

test("default (no version arg) keeps legacy strict behavior", () => {
  assert.equal(hasUnsupportedRtkFind("rtk find . -name '*.ts' -mtime -7"), true);
  assert.equal(hasUnsupportedRtkFind('rtk find . -name "*.ts" -type f'), false);
});

test("allows simple rtk find and non-find rewrites", () => {
  assert.equal(hasUnsupportedRtkFind('rtk find . -name "*.ts" -type f', true), false);
  assert.equal(hasUnsupportedRtkFind('rtk grep foo .', true), false);
  assert.equal(hasUnsupportedRtkFind('rtk find . -name "*.ts" | head -20', true), false);
});

test("parseSemver handles version strings", () => {
  assert.deepEqual(parseSemver("rtk 0.46.0"), [0, 46, 0]);
  assert.deepEqual(parseSemver("0.45.9"), [0, 45, 9]);
  assert.equal(parseSemver("garbage"), null);
  assert.equal(parseSemver(""), null);
});

test("supportsFindPassthrough gates on rtk >= 0.46.0", () => {
  assert.equal(supportsFindPassthrough("rtk 0.46.0"), true);
  assert.equal(supportsFindPassthrough("rtk 0.47.1"), true);
  assert.equal(supportsFindPassthrough("rtk 0.45.9"), false);
  assert.equal(supportsFindPassthrough("rtk 0.23.0"), false);
  assert.equal(supportsFindPassthrough("garbage"), false);
  assert.equal(supportsFindPassthrough(""), false);
});

test("sibling module export surfaces are frozen (jiti reload staleness)", async () => {
  // pi's jiti loader pairs a reloaded index.ts with stale cached copies of
  // existing sibling modules, so a NEW export on these files crashes /reload
  // in sessions that cached the older shape (0.2.1 regression). Freeze both.
  const vg = await import("../version-gate.js");
  assert.deepEqual(Object.keys(vg).sort(), ["RTK_FIND_PASSTHROUGH_VERSION", "parseSemver", "supportsFindPassthrough"]);
  const ff = await import("../findFallback.js");
  assert.deepEqual(Object.keys(ff), ["hasUnsupportedRtkFind"]);
  const sr = await import("../safe-rewrite.js");
  assert.deepEqual(Object.keys(sr).sort(), ["isEvalCommand", "isSafeRewrite"]);
});
