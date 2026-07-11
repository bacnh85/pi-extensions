#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_TOOLS = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"write",
	"edit",
	"web_extract",
	"serena_get_symbols_overview",
	"serena_find_symbol",
	"serena_find_referencing_symbols",
	"serena_find_declaration",
	"serena_find_implementations",
];

const CASES = [
	{
		name: "source-file-outline",
		prompt: "Inspect symbols in pi-deepseek-tools/extensions/index.ts and summarize them.",
		expect: { firstOneOf: ["serena_get_symbols_overview", "serena_find_symbol"], serenaBeforeRead: true },
	},
	{
		name: "named-symbol",
		prompt: "Find the definition of deepSeekSelectionGuidance.",
		expect: { firstOneOf: ["serena_find_symbol"] },
	},
	{
		name: "references-before-change",
		prompt: "Before changing model scoping, find references to isOpenCodeGoDeepSeekV4FlashModel.",
		expect: { firstOneOf: ["serena_find_referencing_symbols", "serena_find_symbol"], serenaBeforeRead: true },
	},
	{
		name: "exact-readme-search",
		prompt: "Find where README mentions PI_DEEPSEEK_TOOLS_STRICT_SERENA.",
		expect: { firstOneOf: ["grep", "read"] },
	},
	{
		name: "file-listing",
		prompt: "List files in pi-deepseek-tools.",
		expect: { firstOneOf: ["ls"] },
	},
	{
		name: "test-file-discovery",
		prompt: "Find all test files for pi-deepseek-tools.",
		expect: { firstOneOf: ["find"] },
	},
	{
		name: "docs-read",
		prompt: "Read the pi-deepseek-tools README scope section.",
		expect: { firstOneOf: ["read", "find"] },
	},
	{
		name: "read-limit-only",
		prompt: "Read only the first 20 lines of pi-deepseek-tools/README.md.",
		expect: { firstOneOf: ["read"] },
	},
	{
		name: "markdown-filename-write",
		prompt: "Create /tmp/pi-deepseek-tools-notes.md with the single line: DeepSeek path fields are plain file paths.",
		expect: { firstOneOf: ["write"] },
	},
	{
		name: "glob-find",
		prompt: "Find TypeScript test files under pi-deepseek-tools/extensions/test.",
		expect: { firstOneOf: ["find"] },
	},
	{
		name: "unknown-file-location",
		prompt: "Read the first 20 lines of deepseek-tools.ts under pi-deepseek-tools.",
		expect: { firstOneOf: ["find"] },
	},
	{
		name: "github-repository-analysis",
		prompt: "Analyze the codebase at https://github.com/octocat/Hello-World and summarize its structure.",
		expect: { firstOneOf: ["bash"] },
	},
	{
		name: "legit-shell",
		prompt: "Run the pi-deepseek-tools unit tests.",
		expect: { firstOneOf: ["bash"] },
	},
];

function captureInput(event) {
	const input = event.input ?? event.args ?? event.arguments;
	if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
	const summary = {};
	for (const [key, val] of Object.entries(input)) {
		if (typeof val === 'string') summary[key] = val.length > 120 ? val.slice(0, 120) + '...' : val;
		else if (typeof val === 'number' || typeof val === 'boolean' || val === null) summary[key] = val;
		else summary[key] = Array.isArray(val) ? `[${val.length} items]` : `{${Object.keys(val).length} keys}`;
	}
	return summary;
}

function parseArgs(argv) {
	const args = {
		provider: "opencode-go",
		model: "deepseek-v4-flash",
		thinking: "high",
		trials: 1,
		tools: DEFAULT_TOOLS.join(","),
		pi: "pi",
		extension: "./pi-deepseek-tools/extensions/index.ts",
		out: "",
		case: "",
		guidance: "on",
		captureArgs: false,
	};
	let providerSet = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (key === "help") {
			args.help = true;
		} else if (key === "capture-args") {
			args.captureArgs = true;
		} else if (next !== undefined) {
			args[key] = next;
			if (key === "provider") providerSet = true;
			i += 1;
		}
	}
	if (/\{\{[^}]+\}\}/.test(args.model)) throw new Error(`Unexpanded --model template: ${args.model}`);
	if (!providerSet && args.model.includes("/")) [args.provider, args.model] = args.model.split(/\/(.+)/, 2);
	args.trials = Number(args.trials || 1);
	return args;
}

function usage() {
	console.log(`Usage: node pi-deepseek-tools/extensions/scripts/eval-tool-selection.mjs [options]

Options:
  --provider <id>     Provider to test (default: opencode-go)
  --model <id>        Model to test; also accepts provider/model (default: deepseek-v4-flash)
  --thinking <level>  Thinking level (default: high)
  --trials <n>        Repetitions per case (default: 1)
  --case <name>       Run only one case
  --guidance on|off   Disable extension guidance for control runs
  --capture-args      Capture tool call input arguments for post-hoc analysis
  --out <path>        Write JSON summary
  --pi <command>      Pi executable (default: pi)
`);
}

function runPi(args, testCase) {
	return new Promise((resolveRun) => {
		const commandArgs = [
			"-e",
			args.extension,
			"--provider",
			args.provider,
			"--model",
			args.model,
			"--thinking",
			args.thinking,
			"--mode",
			"json",
			"--no-session",
			"--no-context-files",
			"--approve",
			"--tools",
			args.tools,
			testCase.prompt,
		];
		const env = { ...process.env };
		if (args.guidance === "off") env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE = "0";

		const child = spawn(args.pi, commandArgs, { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
		const tools = [];
		const toolCalls = [];
		const errors = [];
		let agentEnded = false;
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			for (const line of chunk.split(/\r?\n/)) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (event.type === "tool_execution_start") {
						tools.push(event.toolName);
						if (args.captureArgs) {
							const captured = captureInput(event);
							if (captured) toolCalls.push({ toolName: event.toolName, args: captured });
						}
					}
					if (event.type === "tool_execution_end" && event.isError) errors.push({ toolName: event.toolName, result: event.result, toolCallId: event.toolCallId });
					if (event.type === "message_end" && event.message?.stopReason === "error") errors.push({ error: event.message.errorMessage || "model error" });
					if (event.type === "agent_end") agentEnded = true;
				} catch {
					// Ignore non-JSON diagnostics.
				}
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("close", (code) => {
			resolveRun({ code, tools, firstTool: tools[0], errors, agentEnded, stderr: stderr.slice(-4000), toolCalls: toolCalls.length > 0 ? toolCalls : undefined });
		});
		child.on("error", (error) => {
			resolveRun({ code: -1, tools, firstTool: undefined, errors: [{ error: String(error) }], agentEnded, stderr: String(error) });
		});
	});
}

function score(testCase, run) {
	const expected = testCase.expect;
	const firstToolOk = expected.firstOneOf.includes(run.firstTool);
	const readIndex = run.tools.indexOf("read");
	const firstSerenaIndex = run.tools.findIndex((tool) => tool?.startsWith?.("serena_"));
	const serenaBeforeRead = expected.serenaBeforeRead !== true || (firstSerenaIndex >= 0 && (readIndex < 0 || firstSerenaIndex < readIndex));
	const bashSubstitution = ["file-listing", "test-file-discovery", "exact-readme-search", "docs-read", "read-limit-only", "glob-find"].includes(testCase.name) && run.firstTool === "bash";
	return {
		firstToolOk,
		serenaBeforeRead,
		bashSubstitution,
		passed: firstToolOk && serenaBeforeRead && !bashSubstitution && run.code === 0 && run.errors.length === 0,
	};
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	usage();
	process.exit(0);
}

const selectedCases = args.case ? CASES.filter((testCase) => testCase.name === args.case) : CASES;
if (selectedCases.length === 0) throw new Error(`Unknown case: ${args.case}`);

const results = [];
for (const testCase of selectedCases) {
	for (let trial = 1; trial <= args.trials; trial += 1) {
		console.error(`[eval] ${args.provider}/${args.model} ${testCase.name} trial ${trial}/${args.trials}`);
		const run = await runPi(args, testCase);
		const scored = score(testCase, run);
		results.push({ case: testCase.name, trial, prompt: testCase.prompt, expected: testCase.expect, ...run, score: scored });
		console.log(JSON.stringify(results.at(-1)));
	}
}

const summary = {
	provider: args.provider,
	model: args.model,
	guidance: args.guidance,
	trials: args.trials,
	total: results.length,
	passed: results.filter((result) => result.score.passed).length,
	firstToolAccuracy: results.filter((result) => result.score.firstToolOk).length / results.length,
	bashSubstitutions: results.filter((result) => result.score.bashSubstitution).length,
	serenaBeforeReadFailures: results.filter((result) => !result.score.serenaBeforeRead).length,
	invalidToolErrors: results.flatMap((result) => result.errors).filter((error) => /Validation failed|invalid arguments|invalid_type/i.test(String(error.result ?? error.error ?? ""))).length,
	results,
};

if (args.out) await writeFile(resolve(args.out), `${JSON.stringify(summary, null, 2)}\n`);
console.error(`[eval] passed ${summary.passed}/${summary.total}, first-tool accuracy ${(summary.firstToolAccuracy * 100).toFixed(1)}%`);
