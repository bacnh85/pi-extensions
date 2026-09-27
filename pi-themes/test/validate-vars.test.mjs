// Regression: the validator must check vars VALUES, not just var names —
// {"vars":{"accent":"red"}} or out-of-range numbers previously passed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function runValidator(fixtureDir) {
  try {
    execFileSync(process.execPath, [join(root, "scripts", "validate-themes.mjs"), fixtureDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stderr: e.stderr ?? "" };
  }
}

function fixtureWithVars(vars) {
  const dir = mkdtempSync(join(tmpdir(), "pi-themes-test-"));
  const reference = JSON.parse(readFileSync(join(root, "themes", "dark.json"), "utf8"));
  const theme = { name: "fixture", colors: reference.colors, export: reference.export, vars };
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(theme));
  return dir;
}

test("bad var value (named color) fails validation naming the var", () => {
  const dir = fixtureWithVars({ accent: "red" });
  try {
    const r = runValidator(dir);
    assert.equal(r.code, 1, "validator must reject non-color var values");
    assert.match(r.stderr, /vars\.accent/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("out-of-range number var fails validation", () => {
  const dir = fixtureWithVars({ accent: 999 });
  try {
    const r = runValidator(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /vars\.accent/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("valid var values still pass", () => {
  const reference = JSON.parse(readFileSync(join(root, "themes", "dark.json"), "utf8"));
  const dir = fixtureWithVars(reference.vars);
  try {
    const r = runValidator(dir);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
