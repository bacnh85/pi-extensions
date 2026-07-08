#!/usr/bin/env node
/**
 * bench-repair.mjs — Microbenchmark repair overhead for tool calls.
 *
 * Measures how long `repairDeepSeekToolArguments` takes for valid inputs
 * (pass-through, no repair needed) and common repair scenarios, using real
 * Pi builtin tool schemas.
 *
 * Usage:
 *   npx tsx scripts/bench-repair.mjs
 *   npx tsx scripts/bench-repair.mjs --iterations 1000
 */

import { createReadToolDefinition, createEditToolDefinition, createBashToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { repairDeepSeekToolArguments } from "../lib/tool-input-repair.ts";

const CWD = "/Volumes/Dev/agents/pi-extensions";
const TOOLS = {
	read: createReadToolDefinition(CWD),
	write: createWriteToolDefinition(CWD),
	edit: createEditToolDefinition(CWD),
	grep: createGrepToolDefinition(CWD),
	find: createFindToolDefinition(CWD),
	ls: createLsToolDefinition(CWD),
	bash: createBashToolDefinition(CWD),
};

// Parse args
const iterArg = process.argv.find((a) => a.startsWith("--iterations="));
const iterNext = process.argv.indexOf("--iterations");
const iterations = Number(
	iterArg ? iterArg.split("=")[1]
		: iterNext >= 0 && process.argv[iterNext + 1] ? process.argv[iterNext + 1]
		: 1000
);

const CASES = [
	{ name: "valid-read", tool: "read", input: { path: "README.md", limit: 10 } },
	{ name: "valid-edit", tool: "edit", input: { path: "file.ts", edits: [{ oldText: "a", newText: "b" }] } },
	{ name: "valid-bash", tool: "bash", input: { command: "npm test" } },
	{ name: "valid-grep", tool: "grep", input: { pattern: "TODO", path: "src/" } },
	{ name: "valid-find", tool: "find", input: { pattern: "*.ts", path: "src/" } },
	{ name: "repair-null-optional", tool: "read", input: { path: "README.md", offset: null, limit: 10 } },
	{ name: "repair-json-string", tool: "edit", input: { path: "README.md", edits: '[{"oldText":"a","newText":"b"}]' } },
	{ name: "repair-bare-string", tool: "edit", input: { path: "README.md", edits: "foo" } },
	{ name: "repair-markdown-autolink", tool: "read", input: { path: "[README.md](http://README.md)" } },
	{ name: "repair-empty-object", tool: "edit", input: { path: "README.md", edits: {} } },
];

function medianTime(tc, toolDef, n) {
	const times = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const t0 = process.hrtime.bigint();
		repairDeepSeekToolArguments(tc.tool, toolDef.parameters, tc.input);
		const t1 = process.hrtime.bigint();
		times[i] = Number(t1 - t0);
	}
	times.sort();
	return times[Math.floor(times.length / 2)];
}

function run() {
	console.log(`\n=== Repair Overhead Benchmark (${iterations} iterations each) ===\n`);

	const results = [];
	for (const tc of CASES) {
		const toolDef = TOOLS[tc.tool];
		if (!toolDef) {
			console.log(`  ? ${tc.name}: unknown tool ${tc.tool}`);
			continue;
		}

		// Warmup
		for (let i = 0; i < 100; i++) {
			repairDeepSeekToolArguments(tc.tool, toolDef.parameters, tc.input);
		}

		// Bench
		const start = process.hrtime.bigint();
		for (let i = 0; i < iterations; i++) {
			repairDeepSeekToolArguments(tc.tool, toolDef.parameters, tc.input);
		}
		const end = process.hrtime.bigint();

		const totalNs = Number(end - start);
		const avgNs = totalNs / iterations;
		const avgUs = (avgNs / 1000);
		const medianNs = medianTime(tc, toolDef, Math.min(iterations, 200));
		const medianUs = (medianNs / 1000);

		const resultInfo = repairDeepSeekToolArguments(tc.tool, toolDef.parameters, tc.input);
		results.push({ name: tc.name, avgUs, medianUs, repaired: resultInfo.repaired, repairs: resultInfo.repairs });
	}

	// Summary table
	console.log(`  ${"Case".padEnd(32)} ${"Avg (us)".padEnd(12)} ${"Median (us)".padEnd(12)} ${"Repair".padEnd(8)} ${"Kinds"}`);
	console.log(`  ${"-".repeat(32)} ${"-".repeat(12)} ${"-".repeat(12)} ${"-".repeat(8)} ${"-".repeat(20)}`);
	for (const r of results) {
		const kinds = r.repaired ? r.repairs.join(",") : "—";
		const repairMark = r.repaired ? "YES" : "—";
		console.log(`  ${r.name.padEnd(32)} ${r.avgUs.toFixed(2).padEnd(12)} ${r.medianUs.toFixed(2).padEnd(12)} ${repairMark.padEnd(8)} ${kinds}`);
	}

	const totalAvg = results.reduce((s, r) => s + r.avgUs, 0) / results.length;
	const maxAvg = Math.max(...results.map(r => r.avgUs));
	console.log(`\n  Average across all cases: ${totalAvg.toFixed(2)} us`);
	console.log(`  Slowest case: ${maxAvg.toFixed(2)} us`);
	console.log(`  Throughput (worst case): ${(1000 / maxAvg * 1000).toFixed(0)} calls/second\n`);
}

run();
