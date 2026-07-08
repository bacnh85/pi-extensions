#!/usr/bin/env node
/**
 * eval-ponytail-munin.mjs — Validate ponytail optimization & munin pickup
 * with DeepSeek models on opencode-go.
 *
 * Usage:
 *   node eval-ponytail-munin.mjs [--trials 3] [--model deepseek-v4-flash] [--model deepseek-v4-pro]
 *
 * Tests:
 *   - munin-before-bugfix: model should search Munin before fixing a known bug
 *   - munin-before-arch-change: model should search Munin before architecture change
 *   - ponytail-read-before-edit: model reads before editing
 *   - ponytail-stdlib-over-dep: model reaches for stdlib, not a new dependency
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PI_EXTENSIONS_DIR = resolve(import.meta.dirname, "../../../");

// Extensions to load
const EXTENSIONS = [
  resolve(import.meta.dirname, "../../extensions/index.ts"),  // deepseek-tools
  resolve(PI_EXTENSIONS_DIR, "pi-ponytail/extensions/index.js"),
  resolve(PI_EXTENSIONS_DIR, "pi-munin/extensions/index.ts"),
];

const AVAILABLE_TOOLS = [
  "read", "bash", "grep", "find", "ls", "write", "edit",
  "serena_get_symbols_overview", "serena_find_symbol",
  "serena_find_referencing_symbols", "serena_find_declaration",
  "serena_find_implementations",
  "munin_search", "munin_get", "munin_store",
  "munin_list", "munin_recent", "munin_delete",
  "munin_capabilities", "munin_share",
];

const CASES = [
  {
    name: "munin-before-bugfix",
    prompt: "There's an auth token refresh bug in the codebase. Before starting, check if there's any relevant past context about auth issues.",
    expect: { muninFirst: true },
    weight: "high",
  },
  {
    name: "munin-before-arch",
    prompt: "We need to change the caching strategy for API responses. First, find any past decisions about caching.",
    expect: { muninFirst: true },
    weight: "high",
  },
  {
    name: "ponytail-read-before-edit",
    prompt: "Simplify the index.ts in pi-deepseek-tools/extensions/. Read it first, then refactor it — keep changes minimal, use stdlib, no unnecessary abstractions.",
    expect: { readBeforeEdit: true },
    weight: "medium",
  },
  {
    name: "ponytail-stdlib-first",
    prompt: "Add a simple cache for the getMuninConfig function. Use the laziest approach that works.",
    expect: { productiveFirst: true },
    weight: "medium",
  },
];

function parseArgs(argv) {
  const args = {
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    thinking: "high",
    trials: 1,
    pi: "pi",
    out: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (key === "help") { args.help = true; return args; }
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    }
  }
  args.trials = Number(args.trials || 1);
  return args;
}

function buildPiArgs(args, testCase) {
  const extArgs = EXTENSIONS.flatMap((e) => ["-e", e]);
  const piArgs = [
    ...extArgs,
    "--provider", args.provider,
    "--model", args.model,
    "--thinking", args.thinking,
    "--mode", "json",
    "--no-session",
    "--no-context-files",
    "--approve",
    "--tools", AVAILABLE_TOOLS.join(","),
    testCase.prompt,
  ];
  return piArgs;
}

function score(testCase, tools) {
  // Check if munin_search was called by the model
  const muninCalled = tools.some((t) => t && typeof t === "string" && t.startsWith("munin_"));
  const firstTool = tools[0];
  const readIndex = tools.indexOf("read");
  const editIndex = tools.indexOf("edit");
  const writeIndex = tools.indexOf("write");
  const editOrWriteIndex = editIndex >= 0 ? (writeIndex >= 0 ? Math.min(editIndex, writeIndex) : editIndex) : writeIndex;

  // munin-first: first tool is munin_search
  const muninFirst = firstTool === "munin_search";

  // read-before-edit: read appears before any edit/write
  const readBeforeEdit = editOrWriteIndex < 0 || (readIndex >= 0 && readIndex < editOrWriteIndex);

  // ponytail-stdlib-first: first tool is productive (read/edit/write/serena/munin),
  // not bash for add-dep or npm install
  const productiveFirst = firstTool && ["read","edit","write","grep","find","ls",
    "serena_find_symbol","serena_get_symbols_overview","serena_find_referencing_symbols",
    "serena_find_declaration","serena_find_implementations",
    "munin_search","munin_get","munin_store","munin_list","munin_recent"
  ].includes(firstTool) ? true : false;

  const results = {};
  if (testCase.expect.muninFirst) results.muninFirst = muninFirst;
  if (testCase.expect.readBeforeEdit) results.readBeforeEdit = readBeforeEdit;
  if (testCase.expect.productiveFirst) results.productiveFirst = productiveFirst;

  // Overall pass: all expected criteria met
  const expectedKeys = Object.keys(testCase.expect);
  const allMet = expectedKeys.every((key) => results[key] === true);
  const overall = {
    muninCalled,
    firstTool,
    readBeforeEdit,
    ...results,
    passed: allMet,
  };
  return overall;
}

function usage() {
  console.log(`Usage: node eval-ponytail-munin.mjs [options]

Options:
  --provider <id>   Provider (default: opencode-go)
  --model <id>      Model (default: deepseek-v4-flash)
  --thinking <level> Thinking level (default: high)
  --trials <n>      Repetitions per case (default: 1)
  --out <path>      Write JSON summary
  --pi <command>    Pi executable (default: pi)
`);
}

function runPi(args, testCase) {
  return new Promise((resolveRun) => {
    const piArgs = buildPiArgs(args, testCase);
    const env = { ...process.env };
    const child = spawn(args.pi, piArgs, { env, cwd: PI_EXTENSIONS_DIR, stdio: ["ignore", "pipe", "pipe"] });
    const tools = [];
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "tool_execution_start") {
            tools.push(event.toolName);
          }
        } catch { /* non-JSON diagnostics */ }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      resolveRun({ code, tools, firstTool: tools[0], stderr: stderr.slice(-2000) });
    });
    child.on("error", (error) => {
      resolveRun({ code: -1, tools, firstTool: undefined, stderr: String(error) });
    });
    // Timeout after 60s
    setTimeout(() => {
      child.kill();
      resolveRun({ code: -1, tools, firstTool: tools[0], stderr: stderr.slice(-2000) + "\n[TIMEOUT]" });
    }, 30000);
  });
}

// Main
const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }

async function main() {
  console.error(`[eval] Provider: ${args.provider}, Model: ${args.model}, Trials: ${args.trials}`);
  console.error(`[eval] Extensions: ${EXTENSIONS.map(e => e.split("/").slice(-2).join("/"))}`);
  console.error("");

  const allResults = [];

  for (const testCase of CASES) {
    for (let t = 1; t <= args.trials; t += 1) {
      console.error(`[eval] ${testCase.name} trial ${t}/${args.trials}`);
      const result = await runPi(args, testCase);
      const scoreResult = score(testCase, result.tools);
      const entry = {
        case: testCase.name,
        trial: t,
        model: `${args.provider}/${args.model}`,
        ...result,
        score: scoreResult,
      };
      allResults.push(entry);
      console.log(JSON.stringify(entry));
    }
  }

  // Summary
  const total = allResults.length;
  const passed = allResults.filter((r) => r.score.passed).length;
  const muninFirst = allResults.filter((r) => r.case.startsWith("munin-") && r.score.muninFirst).length;
  const muninTotal = allResults.filter((r) => r.case.startsWith("munin-")).length;
  const muninCalled = allResults.filter((r) => r.case.startsWith("munin-") && r.score.muninCalled).length;
  const readBeforeEdit = allResults.filter((r) => r.case === "ponytail-read-before-edit" && r.score.readBeforeEdit).length;
  const peTotal = allResults.filter((r) => r.case === "ponytail-read-before-edit").length;
  const productiveFirst = allResults.filter((r) => r.case === "ponytail-stdlib-first" && r.score.productiveFirst).length;
  const sfTotal = allResults.filter((r) => r.case === "ponytail-stdlib-first").length;

  console.error("");
  console.error("=".repeat(50));
  console.error(`Summary: ${passed}/${total} cases passed`);
  console.error(`  Munin first (any munin case): ${muninFirst}/${muninTotal}`);
  console.error(`  Munin called at all: ${muninCalled}/${muninTotal}`);
  console.error(`  Ponytail read-before-edit: ${readBeforeEdit}/${peTotal}`);
  console.error(`  Ponytail stdlib-first: ${productiveFirst}/${sfTotal}`);
  console.error("=".repeat(50));

  if (args.out) {
    const summary = {
      provider: args.provider,
      model: args.model,
      trials: args.trials,
      total,
      passed,
      muninFirst,
      muninTotal,
      muninCalled,
      readBeforeEdit,
      peTotal,
      productiveFirst,
      sfTotal,
      results: allResults,
    };
    await writeFile(resolve(args.out), JSON.stringify(summary, null, 2) + "\n");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
