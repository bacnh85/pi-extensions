/**
 * pi-init — guided AGENTS.md generation for Pi.
 *
 * `/init` scans the repo (package.json, build configs, CI, dir structure),
 * detects what's there, and generates or updates AGENTS.md with concise
 * project-specific guidance: build/test/lint commands, architecture, conventions.
 * Inspired by OpenCode's /init. Zero deps, plain JS (pi-budget pattern).
 *
 * Flow:
 * 1. /init (no args)  → full guided generation (preserves existing AGENTS.md)
 * 2. /init force      → regenerate from scratch
 * 3. /init check      → report what's missing without writing
 *
 * Implementation: repo introspection → build a focused prompt → delegate the
 * actual writing to the current model via pi.sendUserMessage(). The model uses
 * pi's existing read/write tools. This package only owns the scan + prompt.
 */

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";

/**
 * Discover a project's key signals from the filesystem.
 * Returns a compact, structured summary the prompt builder consumes.
 * Exported for unit testing.
 */
export function scanProject(cwd) {
  const out = {
    root: cwd,
    projectName: basename(cwd),
    packageManager: null,
    packageJson: null,
    buildSystem: null,
    ci: [],
    languages: new Set(),
    hasAgentsMd: false,
    topDirs: [],
    keyFiles: [],
    testCommand: null,
    lintCommand: null,
    buildCommand: null,
  };

  // package.json — richest single signal for JS/TS projects
  const pjPath = join(cwd, "package.json");
  if (existsSync(pjPath)) {
    out.keyFiles.push("package.json");
    try {
      const pj = JSON.parse(readFileSync(pjPath, "utf8"));
      out.packageJson = pj;
      out.projectName = pj.name || out.projectName;
      const scripts = pj.scripts || {};
      out.testCommand = scripts.test || null;
      out.lintCommand = scripts.lint || null;
      out.buildCommand = scripts.build || null;
      if (existsSync(join(cwd, "pnpm-lock.yaml"))) out.packageManager = "pnpm";
      else if (existsSync(join(cwd, "yarn.lock"))) out.packageManager = "yarn";
      else if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) out.packageManager = "bun";
      else out.packageManager = "npm";
      // language detection from deps
      const allDeps = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
      if ("typescript" in allDeps) out.languages.add("TypeScript");
      else out.languages.add("JavaScript");
      for (const dep of Object.keys(allDeps)) {
        if (dep.includes("react")) out.languages.add("React");
        if (dep.includes("vue")) out.languages.add("Vue");
        if (dep.includes("next")) out.languages.add("Next.js");
        if (dep === "sst") out.languages.add("SST");
      }
    } catch {
      out.packageJson = null; // malformed; ignore
    }
  }

  // Build systems
  for (const [file, system] of [
    ["Makefile", "make"],
    ["Cargo.toml", "cargo"],
    ["go.mod", "go"],
    ["pyproject.toml", "python"],
    ["setup.py", "python"],
    ["pom.xml", "maven"],
    ["build.gradle", "gradle"],
    ["CMakeLists.txt", "cmake"],
    ["mix.exs", "elixir"],
  ]) {
    if (existsSync(join(cwd, file))) {
      out.buildSystem = system;
      out.keyFiles.push(file);
      if (system === "cargo") out.languages.add("Rust");
      if (system === "go") out.languages.add("Go");
      if (system === "python") out.languages.add("Python");
    }
  }

  // CI configs
  const ciMap = [
    [".github/workflows", "GitHub Actions"],
    [".gitlab-ci.yml", "GitLab CI"],
    [".circleci", "CircleCI"],
    ["azure-pipelines.yml", "Azure Pipelines"],
    [".travis.yml", "Travis CI"],
  ];
  for (const [p, name] of ciMap) {
    if (existsSync(join(cwd, p))) out.ci.push(name);
  }

  // Top-level directories (architecture signal) — skip noise
  const noiseDirs = new Set([
    "node_modules", ".git", "dist", "build", ".next", ".cache",
    "coverage", ".turbo", ".output", "vendor", "target",
  ]);
  try {
    for (const entry of readdirSync(cwd)) {
      const full = join(cwd, entry);
      try {
        if (statSync(full).isDirectory() && !noiseDirs.has(entry) && !entry.startsWith(".")) {
          out.topDirs.push(entry);
        }
      } catch { /* permission: skip */ }
    }
  } catch { /* unreadable: skip */ }

  out.hasAgentsMd = existsSync(join(cwd, "AGENTS.md")) || existsSync(join(cwd, "CLAUDE.md"));
  return out;
}

/**
 * Build the instruction prompt the model executes.
 * Exported for unit testing.
 */
export function buildInitPrompt(scan, mode) {
  const lines = [];
  const force = mode === "force";

  lines.push(
    force
      ? "Regenerate this project's AGENTS.md from scratch based on the repo scan below."
      : "Create or update this project's AGENTS.md based on the repo scan below. " +
        "If AGENTS.md already exists, improve it in place — do NOT blindly replace it.",
  );
  lines.push("");
  lines.push("Write the file with the `write` tool to `AGENTS.md`. Be concise and factual.");
  lines.push("Cover exactly these sections (omit a section only if the scan gives no signal):");
  lines.push("");
  lines.push("- **Project name + one-line purpose** (infer from package.json/dir name)");
  lines.push("- **Tech stack** (languages, frameworks, build system)");
  lines.push("- **Package manager + common commands**: install, build, test, lint (from scripts)");
  lines.push("- **Repository structure** (top-level dirs and what they hold — keep brief)");
  lines.push("- **CI** (provider + what runs on push/PR)");
  lines.push("- **Conventions** (only if detectable: testing style, code style, naming)");
  lines.push("");
  lines.push("Rules:");
  lines.push("- Use real commands extracted from package.json scripts / build files, never invent them.");
  lines.push("- If a command is missing, say \"not configured\" rather than guessing.");
  lines.push("- Keep it under ~60 lines. This is a context file, not documentation.");
  lines.push("- Do NOT include secrets, API keys, or credentials.");
  lines.push("");

  lines.push("=== REPO SCAN ===");
  lines.push(`Project: ${scan.projectName}`);
  lines.push(`Languages: ${scan.languages.size ? [...scan.languages].join(", ") : "unknown"}`);
  if (scan.packageManager) lines.push(`Package manager: ${scan.packageManager}`);
  if (scan.buildSystem) lines.push(`Build system: ${scan.buildSystem}`);
  lines.push(`Top-level dirs: ${scan.topDirs.length ? scan.topDirs.join(", ") : "(none)"}`);
  lines.push(`Key files: ${scan.keyFiles.length ? scan.keyFiles.join(", ") : "(none)"}`);
  lines.push(`CI: ${scan.ci.length ? scan.ci.join(", ") : "none detected"}`);
  if (scan.testCommand) lines.push(`test script: \`npm run test\` → \`${scan.testCommand}\``);
  if (scan.lintCommand) lines.push(`lint script: \`npm run lint\` → \`${scan.lintCommand}\``);
  if (scan.buildCommand) lines.push(`build script: \`npm run build\` → \`${scan.buildCommand}\``);
  if (scan.packageJson?.description) lines.push(`Description: ${scan.packageJson.description}`);
  if (scan.packageJson?.workspaces) lines.push(`Workspaces: ${JSON.stringify(scan.packageJson.workspaces)}`);

  return lines.join("\n");
}

export default function initExtension(pi) {
  pi.registerCommand("init", {
    description: "Generate or update AGENTS.md from a repo scan",
    getArgumentCompletions(prefix) {
      const modes = ["force", "check"];
      const filtered = modes.filter((m) => m.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((m) => ({ value: m, label: m })) : null;
    },
    handler: async (args, ctx) => {
      const mode = String(args || "").trim();
      if (mode && mode !== "force" && mode !== "check") {
        ctx.ui.notify("Usage: /init [force|check]", "warning");
        return;
      }

      const scan = scanProject(ctx.cwd);

      // check mode: report without writing
      if (mode === "check") {
        const present = [];
        const missing = [];
        if (scan.packageManager) present.push(`pkg manager: ${scan.packageManager}`);
        else missing.push("package.json");
        if (scan.testCommand) present.push(`test: ${scan.testCommand}`);
        else missing.push("test command");
        if (scan.lintCommand) present.push(`lint: ${scan.lintCommand}`);
        else missing.push("lint command");
        if (scan.buildCommand) present.push(`build: ${scan.buildCommand}`);
        else missing.push("build command");
        if (scan.hasAgentsMd) present.push("AGENTS.md exists");
        else missing.push("AGENTS.md");
        if (scan.ci.length) present.push(`CI: ${scan.ci.join(", ")}`);
        else missing.push("CI config");

        const report = [
          `Project: ${scan.projectName} (${[...scan.languages].join(", ") || "unknown"})`,
          `Has: ${present.join(" | ") || "(little detected)"}`,
          `Missing: ${missing.join(" | ") || "nothing obvious"}`,
        ].join("\n");
        ctx.ui.notify(report, scan.hasAgentsMd ? "info" : "warning");
        return;
      }

      // Only run when idle — sendUserMessage triggers a turn.
      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
        ctx.ui.notify("Agent is busy; /init when idle.", "warning");
        return;
      }

      const prompt = buildInitPrompt(scan, mode);
      pi.sendUserMessage(prompt);
    },
  });
}
