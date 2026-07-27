#!/usr/bin/env node
// Tool-selection eval for pi-model-tools. Runs each case as a one-shot pi
// session (--mode json --no-session), captures the first tool call, and scores
// it against the expected first tool. Adapted from the pi-deepseek-tools eval.
//
// Usage: node pi-model-tools/extensions/scripts/eval-tool-selection.mjs \
//          --provider opencode-go --model deepseek-v4-flash --thinking high \
//          --trials 1 --out /tmp/eval.json
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_TOOLS = [
  "read", "bash", "grep", "find", "ls", "write", "edit", "web_extract",
  "serena_get_symbols_overview", "serena_find_symbol",
  "serena_find_referencing_symbols", "serena_find_declaration",
  "serena_find_implementations",
];

// All fixtures reference the CURRENT pi-model-tools package + real symbols.
const CASES = [
  { name: "source-file-outline",
    prompt: "Inspect symbols in pi-model-tools/extensions/index.ts and summarize them.",
    expect: { firstOneOf: ["serena_get_symbols_overview", "serena_find_symbol"], serenaBeforeRead: true } },
  { name: "named-symbol",
    prompt: "Find the definition of deepSeekSelectionGuidance.",
    expect: { firstOneOf: ["serena_find_symbol"] } },
  { name: "references-before-change",
    prompt: "Before changing model detection, find references to detectFamily.",
    expect: { firstOneOf: ["serena_find_referencing_symbols", "serena_find_symbol"], serenaBeforeRead: true } },
  { name: "exact-readme-search",
    prompt: "Find where README mentions PI_MODEL_TOOLS_STRICT_SERENA.",
    expect: { firstOneOf: ["grep", "read"] } },
  { name: "file-listing",
    prompt: "List files in pi-model-tools.",
    expect: { firstOneOf: ["ls"] } },
  { name: "test-file-discovery",
    prompt: "Find all test files for pi-model-tools.",
    expect: { firstOneOf: ["find"] } },
  { name: "docs-read",
    prompt: "Read the pi-model-tools README scope section.",
    expect: { firstOneOf: ["read", "find"] } },
  { name: "read-limit-only",
    prompt: "Read only the first 20 lines of pi-model-tools/README.md.",
    expect: { firstOneOf: ["read"] } },
  { name: "markdown-filename-write",
    prompt: "Create /tmp/pi-model-tools-notes.md with the single line: DeepSeek path fields are plain file paths.",
    expect: { firstOneOf: ["write"] } },
  { name: "glob-find",
    prompt: "Find TypeScript test files under pi-model-tools/extensions/test.",
    expect: { firstOneOf: ["find"] } },
  { name: "unknown-file-location",
    prompt: "Read the first 20 lines of guidance.ts under pi-model-tools.",
    expect: { firstOneOf: ["find"] } },
  { name: "github-repository-analysis",
    prompt: "Analyze the codebase at https://github.com/octocat/Hello-World and summarize its structure.",
    expect: { firstOneOf: ["bash"] } },
  { name: "legit-shell",
    prompt: "Run the pi-model-tools unit tests.",
    expect: { firstOneOf: ["bash"] } },
];

function captureInput(event) {
  const input = event.input ?? event.args ?? event.arguments;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const summary = {};
  for (const [key, val] of Object.entries(input)) {
    if (typeof val === "string") summary[key] = val.length > 120 ? val.slice(0, 120) + "..." : val;
    else if (typeof val === "number" || typeof val === "boolean" || val === null) summary[key] = val;
    else summary[key] = Array.isArray(val) ? `[${val.length} items]` : `{${Object.keys(val).length} keys}`;
  }
  return summary;
}

function parseArgs(argv) {
  const args = {
    provider: "opencode-go", model: "deepseek-v4-flash", thinking: "high",
    trials: 1, tools: DEFAULT_TOOLS.join(","), pi: "pi",
    extensions: "./pi-model-tools/extensions/index.ts,./pi-serena/extensions/index.ts",
    out: "", case: "", guidance: "on", captureArgs: false,
  };
  let providerSet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (key === "help") args.help = true;
    else if (key === "capture-args") args.captureArgs = true;
    else if (next !== undefined) { args[key] = next; if (key === "provider") providerSet = true; i += 1; }
  }
  if (/\{\{[^}]+\}\}/.test(args.model)) throw new Error(`Unexpanded --model template: ${args.model}`);
  if (!providerSet && args.model.includes("/")) [args.provider, args.model] = args.model.split(/\/(.+)/, 2);
  // 9router needs its own provider-registration extension.
  if (args.provider === "9router" && !args.extensions.includes("pi-9router")) {
    args.extensions = `./pi-9router/extensions/index.ts,${args.extensions}`;
  }
  args.trials = Number(args.trials || 1);
  return args;
}

function usage() {
  console.error(`Usage: node eval-tool-selection.mjs [options]

Options:
  --provider <id>      Provider (default: opencode-go). 9router auto-loads pi-9router.
  --model <id>         Model; also accepts provider/model (default: deepseek-v4-flash)
  --thinking <level>   Thinking level (default: high)
  --trials <n>         Repetitions per case (default: 1)
  --case <name>        Run only one case
  --guidance on|off    Disable DeepSeek selection guidance for control runs
  --capture-args       Capture tool call arguments for post-hoc analysis
  --case-timeout <s>   Per-case wall-clock kill in seconds (default: 150)
  --extensions <list>  Comma-separated -e paths (default: pi-model-tools + pi-serena)
  --out <path>         Write JSON summary
  --pi <command>       Pi executable (default: pi)
`);
}

function runPi(args, testCase) {
  return new Promise((resolveRun) => {
    const extFlags = args.extensions.split(",").flatMap((e) => ["-e", e.trim()]);
    const commandArgs = [
      "-ne", ...extFlags,
      "--provider", args.provider, "--model", args.model,
      "--thinking", args.thinking,
      "--mode", "json", "--no-session", "--no-context-files", "--approve",
      "--tools", args.tools,
      testCase.prompt,
    ];
    const env = { ...process.env };
    if (args.guidance === "off") env.PI_MODEL_TOOLS_SELECTION_GUIDANCE = "0";
    // ponytail: clear stale git-clone destinations so the github case never collides with a prior run
    for (const dir of ["/tmp/Hello-World", "/tmp/hello-world", `${process.cwd()}/Hello-World`]) {
      try { spawn("rm", ["-rf", dir]); } catch {}
    }
    const child = spawn(args.pi, commandArgs, { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const tools = [], toolCalls = [], errors = [];
    let agentEnded = false, stderr = "";
    // ponytail: per-case wall-clock kill — one slow/hung provider call must not block the whole run
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, (args.caseTimeout || 150) * 1000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "tool_execution_start") {
            tools.push(event.toolName);
            if (args.captureArgs) { const c = captureInput(event); if (c) toolCalls.push({ toolName: event.toolName, args: c }); }
          }
          if (event.type === "tool_execution_end" && event.isError) errors.push({ toolName: event.toolName, result: event.result, toolCallId: event.toolCallId });
          if (event.type === "message_end" && event.message?.stopReason === "error") errors.push({ error: event.message.errorMessage || "model error" });
          if (event.type === "agent_end") agentEnded = true;
        } catch { /* non-JSON diagnostics */ }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const finish = (result) => { clearTimeout(timer); resolveRun(result); };
    child.on("close", (code) => finish({ code, tools, firstTool: tools[0], errors, agentEnded, stderr: stderr.slice(-4000), toolCalls: toolCalls.length > 0 ? toolCalls : undefined }));
    child.on("error", (error) => finish({ code: -1, tools, firstTool: undefined, errors: [{ error: String(error) }], agentEnded, stderr: String(error) }));
  });
}

function score(testCase, run) {
  const expected = testCase.expect;
  const firstToolOk = expected.firstOneOf.includes(run.firstTool);
  const readIndex = run.tools.indexOf("read");
  const firstSerenaIndex = run.tools.findIndex((tool) => tool?.startsWith?.("serena_"));
  const serenaBeforeRead = expected.serenaBeforeRead !== true || (firstSerenaIndex >= 0 && (readIndex < 0 || firstSerenaIndex < readIndex));
  const bashSubstitution = ["file-listing", "test-file-discovery", "exact-readme-search", "docs-read", "read-limit-only", "glob-find"].includes(testCase.name) && run.firstTool === "bash";
  return { firstToolOk, serenaBeforeRead, bashSubstitution, passed: firstToolOk && serenaBeforeRead && !bashSubstitution && run.code === 0 && run.errors.length === 0 };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
const selectedCases = args.case ? CASES.filter((c) => c.name === args.case) : CASES;
if (selectedCases.length === 0) throw new Error(`Unknown case: ${args.case}`);

const results = [];
for (const testCase of selectedCases) {
  for (let trial = 1; trial <= args.trials; trial += 1) {
    console.error(`[eval] ${args.provider}/${args.model} [${args.thinking}] ${testCase.name} trial ${trial}/${args.trials}`);
    const run = await runPi(args, testCase);
    const scored = score(testCase, run);
    results.push({ case: testCase.name, trial, prompt: testCase.prompt, expected: testCase.expect, firstTool: run.firstTool, tools: run.tools, errors: run.errors, score: scored });
    console.log(JSON.stringify(results.at(-1)));
  }
}

const summary = {
  provider: args.provider, model: args.model, thinking: args.thinking, guidance: args.guidance, trials: args.trials,
  total: results.length,
  passed: results.filter((r) => r.score.passed).length,
  firstToolAccuracy: results.filter((r) => r.score.firstToolOk).length / results.length,
  bashSubstitutions: results.filter((r) => r.score.bashSubstitution).length,
  serenaBeforeReadFailures: results.filter((r) => !r.score.serenaBeforeRead).length,
  invalidToolErrors: results.flatMap((r) => r.errors).filter((e) => /Validation failed|invalid arguments|invalid_type/i.test(String(e.result ?? e.error ?? ""))).length,
  failures: results.filter((r) => !r.score.passed).map((r) => ({ case: r.case, firstTool: r.firstTool, expected: r.expected.firstOneOf, errors: r.errors })),
  results,
};
if (args.out) await writeFile(resolve(args.out), `${JSON.stringify(summary, null, 2)}\n`);
console.error(`[eval] ${args.provider}/${args.model} [${args.thinking}] guidance=${args.guidance}: passed ${summary.passed}/${summary.total}, first-tool ${(summary.firstToolAccuracy * 100).toFixed(1)}%`);
