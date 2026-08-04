#!/usr/bin/env node
// Eval: what do the pi-model-tools 0.5.0 improvements (prompt-cache stats +
// truncated-JSON repair) bring to DeepSeek V4 on opencode-go?
//
// Part A — cache: one session, N turns (each turn = one `pi --mode json`
// invocation continuing the same --session-id). Captures turn_end usage
// (input/cacheRead/cacheWrite) — the data /model-tools-status now surfaces.
// Part B — repair: reruns the edit + tool cases with PI_MODEL_TOOLS_DEBUG=1
// and counts repair engagements + edit_mismatch errors from stderr.
//
// Usage: node extensions/scripts/eval-deepseek-improvements.mjs \
//          --provider opencode-go --model deepseek-v4-flash --thinking high \
//          --turns 4 --out /tmp/ds-eval.json
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const args = {
  provider: "opencode-go", model: "deepseek-v4-flash", thinking: "high",
  turns: 4, pi: "pi", out: "", debug: true,
  // Resolve the extension path relative to cwd first, then the monorepo root,
  // so the script runs from either the package dir or the repo root.
  extensions: (() => {
    const fromPkg = "./extensions/index.ts";
    const fromRoot = "./pi-model-tools/extensions/index.ts";
    return existsSync(resolve(fromPkg)) ? fromPkg : fromRoot;
  })(),
  sessionId: `ds-eval-${randomUUID().slice(0, 8)}`,
};
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--provider") args.provider = process.argv[++i];
  else if (a === "--model") args.model = process.argv[++i];
  else if (a === "--thinking") args.thinking = process.argv[++i];
  else if (a === "--turns") args.turns = Number(process.argv[++i]);
  else if (a === "--out") args.out = process.argv[++i];
  else if (a === "--pi") args.pi = process.argv[++i];
  else if (a === "--extensions") args.extensions = process.argv[++i];
  else if (a === "--prompts") args.prompts = process.argv[++i];
}

// Turn 1 warms the session; later turns reuse the byte-stable prefix.
// `--prompts run` selects bash/run-task prompts that fire the run-task
// first-tool hint every turn — the path most affected by multi-round
// guidance cache-stability (each turn = 2+ provider rounds).
const PROMPT_SETS = {
  default: [
    "List the files in the pi-model-tools package (not node_modules).",
    "Now read pi-model-tools/README.md and state its version.",
    "What env vars does pi-model-tools read? List them.",
    "What is the apply_patch tool's purpose in this package?",
  ],
  run: [
    "Run the pi-model-tools unit tests.",
    "Run the typecheck for pi-model-tools.",
    "Run npm test in the pi-model-tools package again.",
    "Lint pi-model-tools by running npm test.",
  ],
};
const TURN_PROMPTS = PROMPT_SETS[args.prompts ?? "default"];
if (TURN_PROMPTS.length < args.turns) {
  console.error(`[eval] warning: only ${TURN_PROMPTS.length} prompts for ${args.turns} turns; cycling.`);
}

function runTurn(turnIndex, prompt) {
  return new Promise((resolveRun) => {
    const extFlags = args.extensions.split(",").flatMap((e) => ["-e", e.trim()]);
    const cmdArgs = [
      "-ne", ...extFlags,
      "--provider", args.provider, "--model", args.model,
      "--thinking", args.thinking,
      "--mode", "json", "--session-id", args.sessionId,
      "--no-context-files", "--approve",
      "--tools", "read,bash,grep,find,ls,write,edit",
      prompt,
    ];
    const env = { ...process.env };
    if (args.debug) env.PI_MODEL_TOOLS_DEBUG = "1";
    const child = spawn(args.pi, cmdArgs, { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const turns = [], repairs = [], errors = [];
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "turn_end" && ev.message?.usage) {
            const u = ev.message.usage;
            turns.push({ turnIndex, input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, output: u.output ?? 0 });
          }
          if (ev.type === "tool_execution_end" && ev.isError) errors.push({ toolName: ev.toolName, result: String(ev.result).slice(0, 200) });
          if (ev.type === "message_end" && ev.message?.stopReason === "error") errors.push({ error: ev.message.errorMessage || "model error" });
        } catch { /* non-JSON */ }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      // pi-model-tools debug lines: "repair: <tool> <count>", "reasoning: stripped"
      for (const line of chunk.split(/\r?\n/)) {
        const m = line.match(/^repair:\s*(\S+)\s+(\d+)$/);
        if (m) repairs.push({ toolName: m[1], count: Number(m[2]) });
        else if (/reasoning: stripped/.test(line)) repairs.push({ toolName: "reasoning-strip", count: 1 });
      }
    });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 180000);
    child.on("close", (code) => { clearTimeout(timer); resolveRun({ code, turns, repairs, errors, stderr: stderr.slice(-1500) }); });
    child.on("error", (e) => { clearTimeout(timer); resolveRun({ code: -1, turns, repairs, errors, stderr: String(e) }); });
  });
}

// Part A: cache hit rate across a continuing session.
const results = [];
for (let i = 0; i < args.turns; i++) {
  const prompt = TURN_PROMPTS[i % TURN_PROMPTS.length];
  console.error(`[eval] ${args.provider}/${args.model} [${args.thinking}] turn ${i + 1}/${args.turns}`);
  const run = await runTurn(i, prompt);
  results.push({ turn: i + 1, prompt, ...run });
}

// Per turn: aggregate ALL turn_end events (JSON mode emits one per agent-loop
// iteration, including provider retries). The aggregate over every event is the
// honest total; per-turn is the per-run sum so 500-retry re-sends are visible.
const perTurn = results.map((r, i) => {
  const t = r.turns.reduce((acc, e) => {
    acc.input += e.input; acc.cacheRead += e.cacheRead; acc.cacheWrite += e.cacheWrite; acc.output += e.output;
    return acc;
  }, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  const total = t.input + t.cacheRead + t.cacheWrite;
  return { turn: i + 1, turnEndEvents: r.turns.length, errors: r.errors.length,
    ...t, hitRatePct: total > 0 ? Number(((t.cacheRead / total) * 100).toFixed(1)) : null };
});

const totals = perTurn.reduce((acc, t) => {
  acc.input += t.input; acc.cacheRead += t.cacheRead; acc.cacheWrite += t.cacheWrite; acc.output += t.output;
  return acc;
}, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const totalIn = totals.input + totals.cacheRead + totals.cacheWrite;
const hitRate = totalIn > 0 ? (totals.cacheRead / totalIn) * 100 : 0;

// Clean-turn hit rate: a turn's success is its LAST turn_end (the request that
// completed after any 500-retries). Summing just those isolates cache behavior
// from transient upstream retry noise (a 500 re-sends the prefix, inflating the
// denominator without a proportional cacheRead on the retry itself).
const cleanTurns = results
  .map((r) => r.turns.filter((e) => e.input + e.cacheRead + e.cacheWrite > 0).at(-1))
  .filter(Boolean);
const cleanTotals = cleanTurns.reduce((acc, t) => {
  acc.input += t.input; acc.cacheRead += t.cacheRead; acc.cacheWrite += t.cacheWrite;
  return acc;
}, { input: 0, cacheRead: 0, cacheWrite: 0 });
const cleanTotalIn = cleanTotals.input + cleanTotals.cacheRead + cleanTotals.cacheWrite;
const cleanHitRate = cleanTotalIn > 0 ? (cleanTotals.cacheRead / cleanTotalIn) * 100 : 0;

const allRepairs = results.flatMap((r) => r.repairs);
const repairByTool = {};
for (const r of allRepairs) repairByTool[r.toolName] = (repairByTool[r.toolName] ?? 0) + r.count;
const allErrors = results.flatMap((r) => r.errors);

const summary = {
  provider: args.provider, model: args.model, thinking: args.thinking, turns: args.turns, sessionId: args.sessionId,
  cache: {
    inputTokens: totals.input, cacheReadTokens: totals.cacheRead, cacheWriteTokens: totals.cacheWrite,
    outputTokens: totals.output, hitRatePct: Number(hitRate.toFixed(1)),
    // Hit rate over the last successful turn_end per turn — isolates cache
    // behavior from transient 500-retry re-sends that inflate the denominator.
    cleanHitRatePct: Number(cleanHitRate.toFixed(1)),
    cleanTurnsMeasured: cleanTurns.length,
    perTurn,
  },
  repairs: { total: allRepairs.length, byTool: repairByTool },
  errors: allErrors,
  perTurnRuns: results.map((r) => ({ turn: r.turn, code: r.code, turns: r.turns.length, errors: r.errors, stderrTail: r.stderr.slice(-600) })),
};
if (args.out) await writeFile(args.out, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ cache: summary.cache, repairs: summary.repairs, errors: summary.errors }, null, 2));
console.error(`[eval] cache hit ${hitRate.toFixed(1)}% aggregate | clean-turn ${cleanHitRate.toFixed(1)}% (${cleanTurns.length}/${args.turns}) | repairs ${allRepairs.length}, errors ${allErrors.length}`);
