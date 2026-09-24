import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanProject, buildInitPrompt, checkFindings, default as initExtension } from "../index.js";

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

test("scanProject framework detection uses exact dep names (no preact/react-dom/vue-router/next-themes false positives; nuxt detected)", () => {
  const dir = fixture((d) => {
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({ name: "x", dependencies: { preact: "^10.0.0", "vue-router": "^4.0.0", "next-themes": "^0.3.0" } }),
    );
  });
  try {
    const s = scanProject(dir);
    for (const lang of ["React", "Vue", "Next.js", "Nuxt", "SST"]) {
      assert.ok(!s.languages.has(lang), `unexpected ${lang} from lookalike deps`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // exact names still detected, including react-dom and the added nuxt
  for (const [dep, lang] of [
    ["react", "React"],
    ["react-dom", "React"],
    ["vue", "Vue"],
    ["nuxt", "Nuxt"],
    ["next", "Next.js"],
    ["sst", "SST"],
  ]) {
    const d2 = fixture((d) => {
      writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x", dependencies: { [dep]: "*" } }));
    });
    try {
      assert.ok(scanProject(d2).languages.has(lang), `${dep} should detect ${lang}`);
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
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
    const s = scanProject(dir);
    assert.equal(s.hasAgentsMd, true);
    assert.equal(s.agentsFile, "AGENTS.md", "reports WHICH file was found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanProject reports CLAUDE.md when only that exists", () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, "CLAUDE.md"), "# existing");
  });
  try {
    const s = scanProject(dir);
    assert.equal(s.hasAgentsMd, true);
    assert.equal(s.agentsFile, "CLAUDE.md");
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

test("buildInitPrompt targets the detected context file (CLAUDE.md), not always AGENTS.md", () => {
  const s = {
    projectName: "x",
    languages: new Set(),
    topDirs: [],
    keyFiles: [],
    ci: [],
    hasAgentsMd: true,
    agentsFile: "CLAUDE.md",
  };
  const prompt = buildInitPrompt(s, "");
  assert.match(prompt, /write` tool to `CLAUDE\.md`/);
  assert.match(prompt, /If CLAUDE\.md already exists, improve it in place/);
  assert.equal(prompt.includes("to `AGENTS.md`"), false, "write target is the detected file");
  // Force branch must also honor the detected file.
  const forcePrompt = buildInitPrompt(s, "force");
  assert.match(forcePrompt, /Regenerate this project's CLAUDE\.md from scratch/);
  assert.equal(forcePrompt.includes("to `AGENTS.md`"), false);
});

test("buildInitPrompt emits the detected package manager's run form", () => {
  const s = {
    projectName: "pnpm-app",
    languages: new Set(),
    packageManager: "pnpm",
    buildSystem: null,
    topDirs: [],
    keyFiles: ["package.json"],
    ci: [],
    testCommand: "vitest",
    lintCommand: null,
    buildCommand: "vite build",
    packageJson: null,
    hasAgentsMd: false,
  };
  const prompt = buildInitPrompt(s, "");
  assert.match(prompt, /`pnpm run test` → `vitest`/);
  assert.match(prompt, /`pnpm run build` → `vite build`/);
  assert.equal(prompt.includes("`npm run"), false, "never emits npm for a pnpm project");
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

test("check findings: non-Node repo not flagged for missing package.json", () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, "go.mod"), "module example.com/x\n\ngo 1.22\n");
  });
  try {
    const { missing } = checkFindings(scanProject(dir));
    assert.ok(!missing.includes("package.json"), `should not flag package.json, got: ${missing.join(", ")}`);
    for (const cmd of ["test command", "lint command", "build command"]) {
      assert.ok(!missing.includes(cmd), `should not flag ${cmd} on a non-Node repo, got: ${missing.join(", ")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check findings: JS repo without package.json still flagged as missing", () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, "main.js"), "console.log('hi');\n");
  });
  try {
    const scan = scanProject(dir);
    assert.ok(scan.languages.has("JavaScript"), "scan detects JS from source files");
    const { missing } = checkFindings(scan);
    assert.ok(missing.includes("package.json"), `should flag package.json, got: ${missing.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- command handler guards ----

function captureHandler() {
  const registered = {};
  const sent = [];
  initExtension({
    registerCommand: (name, opts) => {
      registered[name] = opts;
    },
    sendUserMessage: (msg) => sent.push(msg),
  });
  return { handler: registered.init.handler, sent };
}

test("command handler: invalid argument warns usage, never scans or sends", async () => {
  const { handler, sent } = captureHandler();
  const dir = fixture(() => {}); // if the guard leaked, this empty dir would get scanned + sent
  const notes = [];
  const ctx = { cwd: dir, ui: { notify: (msg, level) => notes.push([msg, level]) } };
  await handler("bogus", ctx);
  assert.deepEqual(notes, [["Usage: /init [force|check]", "warning"]]);
  assert.equal(sent.length, 0, "no prompt sent");
});

test("command handler: busy (isIdle false) warns without running", async () => {
  const { handler, sent } = captureHandler();
  const dir = fixture(() => {});
  const notes = [];
  const ctx = {
    cwd: dir,
    isIdle: () => false,
    ui: { notify: (msg, level) => notes.push([msg, level]) },
  };
  await handler("", ctx);
  assert.equal(notes.length, 1);
  assert.match(notes[0][0], /busy/i);
  assert.equal(notes[0][1], "warning");
  assert.equal(sent.length, 0, "no prompt sent while busy");
});

test("command handler: empty ctx (no ui/isIdle) falls back to process.cwd() and sends", async () => {
  const { handler, sent } = captureHandler();
  await assert.doesNotReject(() => handler("", {}));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /REPO SCAN/, "prompt built from the real cwd scan");
});
