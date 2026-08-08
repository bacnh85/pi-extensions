import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanProject, buildInitPrompt } from "../index.js";

function fixture(setup) {
  const dir = mkdtempSync(join(tmpdir(), "pi-init-"));
  try {
    setup(dir);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

test("scanProject detects npm + TS + scripts", () => {
  const dir = fixture((d) => {
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({
        name: "my-app",
        scripts: { test: "mocha", lint: "eslint .", build: "tsc" },
        devDependencies: { typescript: "^5.0.0", mocha: "^10.0.0" },
      }),
    );
    mkdirSync(join(d, "src"));
    mkdirSync(join(d, "test"));
  });
  try {
    const s = scanProject(dir);
    assert.equal(s.projectName, "my-app");
    assert.equal(s.packageManager, "npm");
    assert.equal(s.testCommand, "mocha");
    assert.equal(s.lintCommand, "eslint .");
    assert.equal(s.buildCommand, "tsc");
    assert.ok(s.languages.has("TypeScript"));
    assert.deepEqual(s.topDirs.sort(), ["src", "test"]);
    assert.equal(s.hasAgentsMd, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanProject detects pnpm over npm when lockfile present", () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(d, "pnpm-lock.yaml"), "lockfileVersion: '6.0'");
  });
  try {
    assert.equal(scanProject(dir).packageManager, "pnpm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanProject detects non-JS build systems (cargo, go)", () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, "Cargo.toml"), '[package]\nname = "thing"\n');
    mkdirSync(join(d, "src"));
  });
  try {
    const s = scanProject(dir);
    assert.equal(s.buildSystem, "cargo");
    assert.ok(s.languages.has("Rust"));
    assert.equal(s.packageManager, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanProject detects GitHub Actions CI", () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x" }));
    mkdirSync(join(d, ".github"), { recursive: true });
    mkdirSync(join(d, ".github", "workflows"), { recursive: true });
  });
  try {
    const s = scanProject(dir);
    assert.deepEqual(s.ci, ["GitHub Actions"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanProject detects existing AGENTS.md / CLAUDE.md", () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(d, "AGENTS.md"), "# existing");
  });
  try {
    assert.equal(scanProject(dir).hasAgentsMd, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanProject ignores noise dirs", () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x" }));
    for (const noise of ["node_modules", "dist", ".git"]) mkdirSync(join(d, noise));
    mkdirSync(join(d, "src"));
  });
  try {
    const s = scanProject(dir);
    assert.deepEqual(s.topDirs, ["src"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanProject tolerates malformed package.json", () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, "package.json"), "{ not valid json");
  });
  try {
    const s = scanProject(dir);
    assert.equal(s.packageJson, null);
    assert.equal(s.packageManager, null);
    assert.doesNotThrow(() => s.projectName);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildInitPrompt includes real commands, not invented ones", () => {
  const s = {
    projectName: "demo",
    languages: new Set(["TypeScript"]),
    packageManager: "npm",
    buildSystem: null,
    topDirs: ["src"],
    keyFiles: ["package.json"],
    ci: ["GitHub Actions"],
    testCommand: "mocha",
    lintCommand: "eslint .",
    buildCommand: "tsc",
    packageJson: { description: "a demo" },
    hasAgentsMd: false,
  };
  const prompt = buildInitPrompt(s, "");
  assert.match(prompt, /demo/);
  assert.match(prompt, /TypeScript/);
  assert.match(prompt, /`npm run test` → `mocha`/);
  assert.match(prompt, /`npm run build` → `tsc`/);
  assert.match(prompt, /GitHub Actions/);
  assert.match(prompt, /never invent them/);
  assert.match(prompt, /REPO SCAN/);
});

test("buildInitPrompt force mode says regenerate from scratch", () => {
  const s = { projectName: "x", languages: new Set(), topDirs: [], keyFiles: [], ci: [] };
  assert.match(buildInitPrompt(s, "force"), /from scratch/);
});

test("buildInitPrompt handles missing commands gracefully", () => {
  const s = {
    projectName: "bare",
    languages: new Set(["Go"]),
    packageManager: null,
    buildSystem: "go",
    topDirs: ["cmd"],
    keyFiles: ["go.mod"],
    ci: [],
    testCommand: null,
    lintCommand: null,
    buildCommand: null,
    packageJson: null,
    hasAgentsMd: false,
  };
  const prompt = buildInitPrompt(s, "");
  assert.match(prompt, /Go/);
  assert.match(prompt, /build system: go/i);
  assert.doesNotThrow(() => prompt.split("\n"));
  // No false commands injected when scripts absent
  assert.equal(prompt.includes("npm run test"), false);
});
