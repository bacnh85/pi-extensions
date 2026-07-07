#!/usr/bin/env node
/**
 * pi-fff tool benchmark script.
 *
 * Exercises each tool via the FFF native API directly (in-process, no subprocess),
 * measures per-call latency, and outputs a markdown table.
 *
 * Usage:
 *   node scripts/bench.mjs                     # run in current directory
 *   node scripts/bench.mjs /path/to/project    # run against a specific project
 *
 * Results are model-agnostic (measures fff-node engine latency).
 * To compare model-level tool-call efficiency, wrap with `hyperfine`
 * and invoke through pi with different model configs.
 */

import { FileFinder } from "@ff-labs/fff-node";

const cwd = process.argv[2] || process.cwd();
const WARMUP_MS = 3000;
const RUNS = 5;

async function createFinder() {
  const result = FileFinder.create({ basePath: cwd, aiMode: true });
  if (!result.ok) throw new Error(result.error);
  const finder = result.value;
  await finder.waitForScan(WARMUP_MS);
  return finder;
}

function time(fn) {
  const start = performance.now();
  const result = fn();
  const elapsed = performance.now() - start;
  return { elapsed, result };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

const tests = {
  fffind: [
    { name: "single term", fn: (f) => f.fileSearch("index.ts") },
    { name: "multi-word", fn: (f) => f.fileSearch("query test") },
    { name: "with path constraint", fn: (f) => f.fileSearch("/tests/ *test*") },
    { name: "empty result", fn: (f) => f.fileSearch("zzzzzznonexistent__") },
    { name: "glob pattern", fn: (f) => f.fileSearch("*.test.ts") },
  ],
  ffgrep: [
    { name: "plain literal", fn: (f) => f.grep("import", { mode: "plain", maxMatchesPerFile: 10, classifyDefinitions: true }) },
    { name: "regex", fn: (f) => f.grep("function\\s+\\w+", { mode: "regex", maxMatchesPerFile: 10, classifyDefinitions: true }) },
    { name: "with context", fn: (f) => f.grep("throw", { mode: "plain", beforeContext: 2, afterContext: 2, maxMatchesPerFile: 5, classifyDefinitions: true }) },
    { name: "definition match", fn: (f) => f.grep("export default", { mode: "plain", maxMatchesPerFile: 5, classifyDefinitions: true }) },
    { name: "fuzzy fallback", fn: (f) => f.grep("FileFinder", { mode: "plain", maxMatchesPerFile: 5, classifyDefinitions: true }) },
  ],
  fff_multi_grep: [
    { name: "2 patterns", fn: (f) => f.multiGrep({ patterns: ["fs.readFileSync", "import.*fs"], maxMatchesPerFile: 5 }) },
    { name: "3 patterns", fn: (f) => f.multiGrep({ patterns: ["create", "destroy", "ensure"], maxMatchesPerFile: 5 }) },
  ],
  resolve_file: [
    { name: "exact path", fn: (f) => f.fileSearch("package.json") },
    { name: "fuzzy name", fn: (f) => f.fileSearch("readme") },
    { name: "fuzzy deep", fn: (f) => f.fileSearch("query lib") },
  ],
  related_files: [
    { name: "by stem", fn: (f) => f.fileSearch("query") },
    { name: "by dir+stem", fn: (f) => f.fileSearch("index") },
  ],
};

async function main() {
  console.log(`# pi-fff Benchmark — ${cwd}\n`);
  console.log(`Engine: @ff-labs/fff-node (in-process, no subprocess)`);
  console.log(`Warmup: ${WARMUP_MS}ms index scan`);
  console.log(`Runs per test: ${RUNS}\n`);

  const finder = await createFinder();

  // Health check
  const health = finder.healthCheck();
  const meta = {
    files: health.ok ? health.value.filePicker.indexedFiles : "?",
    git: health.ok ? (health.value.git.repositoryFound ? "yes" : "no") : "?",
  };
  console.log(`Indexed files: ${meta.files}  |  Git repo: ${meta.git}\n`);

  // Run all tests
  const rows = [];
  for (const [tool, cases] of Object.entries(tests)) {
    for (const tc of cases) {
      const times = [];
      for (let r = 0; r < RUNS; r++) {
        const { elapsed, result } = time(() => tc.fn(finder));
        times.push(elapsed);
      }
      times.sort((a, b) => a - b);
      const min = round(times[0]);
      const max = round(times[times.length - 1]);
      const med = round(times[Math.floor(times.length / 2)]);
      const avg = round(times.reduce((s, v) => s + v, 0) / times.length);
      rows.push({ tool, name: tc.name, min, max, med, avg });
    }
  }

  // Sort by tool, then median desc
  rows.sort((a, b) => a.tool.localeCompare(b.tool) || b.med - a.med);

  // Table
  console.log("| Tool | Test | Min (ms) | Med (ms) | Avg (ms) | Max (ms) |");
  console.log("|------|------|----------|----------|----------|----------|");
  let lastTool = "";
  for (const r of rows) {
    const toolCol = r.tool === lastTool ? "" : r.tool;
    lastTool = r.tool;
    console.log(`| ${toolCol.padEnd(16)} | ${r.name.padEnd(20)} | ${String(r.min).padStart(8)} | ${String(r.med).padStart(8)} | ${String(r.avg).padStart(8)} | ${String(r.max).padStart(8)} |`);
  }

  console.log(`\n---`);
  console.log(`*Engine-only latency (fff-node native calls). Model-level tool-call overhead adds LLM reasoning time.`);
  console.log(`*To compare model efficiency across backends, wrap a pi eval call with hyperfine:`);
  console.log(`  hyperfine 'pi eval "/fffind({pattern:\\"index.ts\\"})"' --warmup 3 -N`);

  finder.destroy();
}

main().catch((e) => {
  console.error("Benchmark failed:", e.message);
  process.exit(1);
});
