#!/usr/bin/env node
/**
 * Tool-input repair evaluation.
 * Exercises repairDeepSeekToolArguments against real Pi builtin tool schemas
 * with crafted inputs that match actual DeepSeek V4 tool-calling degeneracies.
 *
 * Usage:
 *   node pi-deepseek-tools/extensions/scripts/eval-tool-input-repair.mjs
 *   node pi-deepseek-tools/extensions/scripts/eval-tool-input-repair.mjs --out /tmp/repair-report.json
 */

import { writeFileSync } from "node:fs";
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
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

// ---- Test Cases ----

const CASES = [
	// --- read ---
	{
		name: "read-valid-pass-through",
		tool: "read",
		input: { path: "README.md", limit: 10 },
		expect: { repaired: false, repairs: [] },
	},
	{
		name: "read-markdown-autolink-path",
		tool: "read",
		input: { path: "[README.md](http://README.md)", limit: 10 },
		expect: { repaired: true, repairsContains: ["path-markdown-autolink"] },
		expectPath: "README.md",
	},
	{
		name: "read-null-optional-offset",
		tool: "read",
		input: { path: "README.md", offset: null, limit: 10 },
		expect: { repaired: true, repairsContains: ["optional-null"] },
		expectFields: { offset: undefined, limit: 10 },
	},
	{
		name: "read-null-optional-limit",
		tool: "read",
		input: { path: "README.md", offset: 1, limit: null },
		expect: { repaired: true, repairsContains: ["optional-null"] },
		expectFields: { offset: 1, limit: undefined },
	},
	{
		name: "read-both-present-no-repair",
		tool: "read",
		input: { path: "README.md", offset: 1, limit: 5 },
		expect: { repaired: false, repairs: [] },
	},

	// --- write ---
	{
		name: "write-valid-pass-through",
		tool: "write",
		input: { path: "/tmp/notes.md", content: "hello" },
		expect: { repaired: false, repairs: [] },
	},
	{
		name: "write-markdown-autolink-path",
		tool: "write",
		input: {
			// URL http://tmp/notes.md normalizes to host=tmp, path=/notes.md
			// which genuinely differs from text /tmp/notes.md. Heuristic correctly declines.
			path: "[/tmp/notes.md](http://tmp/notes.md)", content: "hello"
		},
		expect: { repaired: false },
		expectPath: "[/tmp/notes.md](http://tmp/notes.md)",
	},

	// --- edit ---
	{
		name: "edit-valid-pass-through",
		tool: "edit",
		input: { path: "README.md", edits: [{ oldText: "x", newText: "y" }] },
		expect: { repaired: false, repairs: [] },
	},
	{
		name: "edit-bare-string-edits",
		tool: "edit",
		input: {
			// Stringified JSON object where array expected → wrap parsed object in array
			path: "README.md", edits: '{"oldText":"x","newText":"y"}'
		},
		expect: { repaired: true, repairsContains: ["json-object-wrapped-array"] },
	},
	{
		name: "edit-empty-object-edits",
		tool: "edit",
		input: { path: "README.md", edits: {} },
		expect: { repaired: true, repairsContains: ["empty-object-array"] },
	},
	{
		name: "edit-stringified-array-edits",
		tool: "edit",
		input: { path: "README.md", edits: '[{"oldText":"a","newText":"b"}]' },
		expect: { repaired: true, repairsContains: ["json-string"] },
	},
	{
		name: "edit-multiple-stringified-array-edits",
		tool: "edit",
		input: { path: "README.md", edits: '[{"oldText":"a","newText":"b"},{"oldText":"c","newText":"d"}]' },
		expect: { repaired: true, repairsContains: ["json-string"] },
	},
	{
		name: "edit-bare-string-in-array-field",
		tool: "edit",
		input: { path: "README.md", edits: "oldText" },
		expect: { repaired: true, repairsContains: ["bare-string-array"] },
	},

	// --- grep ---
	{
		name: "grep-valid-pass-through",
		tool: "grep",
		input: { pattern: "TODO", path: "src/" },
		expect: { repaired: false, repairs: [] },
	},
	{
		name: "grep-null-optional-context",
		tool: "grep",
		input: { pattern: "TODO", context: null },
		expect: { repaired: true, repairsContains: ["optional-null"] },
	},

	// --- find ---
	{
		name: "find-valid-pass-through",
		tool: "find",
		input: { pattern: "*.ts", path: "src/" },
		expect: { repaired: false, repairs: [] },
	},
	{
		name: "find-markdown-autolink-path",
		tool: "find",
		input: { pattern: "*.ts", path: "[src/](http://src/)" },
		expect: { repaired: true, repairsContains: ["path-markdown-autolink"] },
		expectPath: "src/",
	},

	// --- ls ---
	{
		name: "ls-valid-pass-through",
		tool: "ls",
		input: { path: "src/" },
		expect: { repaired: false, repairs: [] },
	},
	{
		name: "ls-null-optional-depth",
		tool: "ls",
		input: {
			// depth is NOT a field in the ls schema (only path and limit). No repair possible.
			path: "src/", depth: null
		},
		expect: { repaired: false },
	},

	// --- bash ---
	{
		name: "bash-valid-pass-through",
		tool: "bash",
		input: { command: "npm test" },
		expect: { repaired: false, repairs: [] },
	},
	{
		name: "bash-null-optional-timeout",
		tool: "bash",
		input: { command: "npm test", timeout: null },
		expect: { repaired: true, repairsContains: ["optional-null"] },
	},

	// --- Degenerate cross-tool patterns ---
	{
		name: "nested-path-in-object-array",
		tool: "edit",
		input: {
			path: "README.md",
			edits: [{ oldText: "[link](http://link)", newText: "text" }],
		},
		expect: { repaired: false, repairs: [] },
	},
	{
		name: "path-field-in-nested-object-cleaned",
		tool: "edit",
		input: {
			// cleanPathFields recurses into nested objects and cleans all 'path' keys
			path: "README.md",
			edits: [{ oldText: "x", newText: "y", path: "[nested.md](http://nested.md)" }],
		},
		expect: { repaired: true, repairsContains: ["path-markdown-autolink"] },
	},

	// --- Autolink matching edge cases ---
	{
		name: "autolink-simple-filename",
		tool: "read",
		input: { path: "[README.md](http://README.md)" },
		expect: { repaired: true, repairsContains: ["path-markdown-autolink"] },
		expectPath: "README.md",
	},
	{
		name: "autolink-with-dir-prefix",
		tool: "read",
		input: { path: "[src/index.ts](http://src/index.ts)" },
		expect: { repaired: true, repairsContains: ["path-markdown-autolink"] },
		expectPath: "src/index.ts",
	},
	{
		name: "autolink-prefix-mismatch",
		tool: "read",
		input: {
			// Fixed: endsWith check now requires degenerate prefix — real URL paths
			// like github.com/project/nested.md are NOT unwrapped.
			path: "[nested.md](http://github.com/project/nested.md)"
		},
		expect: { repaired: false },
		expectPath: "[nested.md](http://github.com/project/nested.md)",
	},
	{
		name: "autolink-with-leading-slash-matches",
		tool: "read",
		input: { path: "[./README.md](http://./README.md)" },
		expect: { repaired: true, repairsContains: ["path-markdown-autolink"] },
		expectPath: "./README.md",
	},
	{
		name: "autolink-with-whitespace-in-url",
		tool: "read",
		input: { path: "[notes.md](http://notes. md)" },
		expect: { repaired: true, repairsContains: ["path-markdown-autolink"] },
		expectPath: "notes.md",
	},

	// --- Edge cases ---
	{
		name: "empty-args",
		tool: "read",
		input: {},
		expect: { repaired: false },
	},
	{
		name: "null-input",
		tool: "read",
		input: null,
		expect: { repaired: false },
	},
	{
		name: "non-object-input",
		tool: "read",
		input: "just a string",
		expect: { repaired: false },
	},
	{
		name: "markdown-autolink-unrelated-field",
		tool: "read",
		input: { path: "README.md", content: "[x](http://y)" },
		expect: { repaired: false },
	},
];

// ---- Runner ----

function run() {
	const results = [];
	const stats = { total: 0, passed: 0, failed: 0, repaired: 0, notRepaired: 0 };
	const repairTypeCounts = {};

	for (const tc of CASES) {
		stats.total += 1;
		const toolDef = TOOLS[tc.tool];
		if (!toolDef) {
			results.push({ ...tc, ok: false, error: `Unknown tool: ${tc.tool}` });
			stats.failed += 1;
			continue;
		}

		let output;
		try {
			output = repairDeepSeekToolArguments(tc.tool, toolDef.parameters, tc.input);
		} catch (err) {
			results.push({ ...tc, ok: false, error: `Exception: ${err.message}` });
			stats.failed += 1;
			continue;
		}

		if (output.repaired) stats.repaired += 1;
		else stats.notRepaired += 1;

		const expectedContains = tc.expect.repairsContains ?? [];
		let ok = true;
		const failures = [];

		if (output.repaired !== tc.expect.repaired) {
			ok = false;
			failures.push(`repaired=${output.repaired}, expected=${tc.expect.repaired}`);
		}

		if (tc.expect.repairs && JSON.stringify(output.repairs.sort()) !== JSON.stringify(tc.expect.repairs.sort())) {
			ok = false;
			failures.push(`repairs=${JSON.stringify(output.repairs)}, expected=${JSON.stringify(tc.expect.repairs)}`);
		}

		for (const expectedRepair of expectedContains) {
			if (!output.repairs.includes(expectedRepair)) {
				ok = false;
				failures.push(`missing repair kind: ${expectedRepair}`);
			}
		}

		if (tc.expectPath !== undefined) {
			const gotPath = typeof output.args === "object" && output.args !== null ? output.args.path : undefined;
			if (gotPath !== tc.expectPath) {
				ok = false;
				failures.push(`path="${gotPath}", expected="${tc.expectPath}"`);
			}
		}

		if (tc.expectFields) {
			for (const [key, val] of Object.entries(tc.expectFields)) {
				const got = typeof output.args === "object" && output.args !== null ? output.args[key] : undefined;
				if (got !== val) {
					ok = false;
					failures.push(`${key}=${JSON.stringify(got)}, expected=${JSON.stringify(val)}`);
				}
			}
		}

		const snapshot = output.repaired ? { before: tc.input, after: output.args } : undefined;

		if (ok) stats.passed += 1;
		else stats.failed += 1;

		for (const r of output.repairs) {
			repairTypeCounts[r] = (repairTypeCounts[r] || 0) + 1;
		}

		results.push({
			name: tc.name,
			tool: tc.tool,
			ok,
			failures: failures.length > 0 ? failures : undefined,
			repairs: output.repairs,
			repaired: output.repaired,
			snapshot,
		});
	}

	return { stats, repairTypeCounts, results };
}

const output = run();

// Report
console.log(`\n=== Tool-Input Repair Evaluation ===`);
console.log(`Tests: ${output.stats.total}`);
console.log(`Passed: ${output.stats.passed}/${output.stats.total} (${(output.stats.passed / output.stats.total * 100).toFixed(1)}%)`);
console.log(`Failed: ${output.stats.failed}`);
console.log(`Repairs triggered: ${output.stats.repaired}/${output.stats.total}`);
console.log(`No repair needed: ${output.stats.notRepaired}`);
console.log(`\nRepair-type breakdown:`);
for (const [kind, count] of Object.entries(output.repairTypeCounts).sort((a, b) => b[1] - a[1])) {
	console.log(`  ${kind}: ${count}`);
}

const failures = output.results.filter(r => !r.ok);
if (failures.length > 0) {
	console.log(`\nFailures:`);
	for (const f of failures) {
		console.log(`  ${f.name}: ${f.failures?.join(", ") || "?"}`);
		if (f.snapshot) console.log(`    before: ${JSON.stringify(f.snapshot.before).slice(0, 200)}`);
		if (f.snapshot) console.log(`    after:  ${JSON.stringify(f.snapshot.after).slice(0, 200)}`);
	}
}

console.log(`\n--- Per-case detail ---`);
for (const r of output.results) {
	const status = r.ok ? "✅ PASS" : "❌ FAIL";
	const repairInfo = r.repaired ? ` repaired=[${r.repairs.join(",")}]` : "";
	console.log(`  ${status} ${r.name} (${r.tool})${repairInfo}`);
}

if (process.argv.includes("--out")) {
	const outPath = process.argv[process.argv.indexOf("--out") + 1];
	writeFileSync(outPath, JSON.stringify(output, null, 2));
	console.log(`\nFull report written to ${outPath}`);
}
