#!/usr/bin/env node
/**
 * bench-deepseek-speed.mjs — measure TTFT / decode tok/s / cache-hit % for a
 * DeepSeek chat-completions route (streaming), replicating pi's wire shape.
 *
 * Purpose: adjudicate the "deepseek-v4.1-flash >300 tok/s via DSH" claim and
 * compare routes (direct deepseek, opencode-go, commandcode, 9router).
 * Decode tok/s is server-side; cache hits move TTFT, not decode rate.
 *
 * Usage:
 *   node bench-deepseek-speed.mjs --provider deepseek --model deepseek-flash \
 *        [--thinking high|max] [--turns 3] [--max-tokens 700] [--ctx 4000]
 *
 * --ctx pads the system prompt to ~N tokens with a deterministic filler block
 * (byte-stable across turns) — cache behavior is only visible on realistic
 * multi-K prompts; at 64-token prompts every request is already fast.
 *
 * Credentials: ~/.pi/agent/auth.json (literal or "$ENV" values), then env.
 * Router baseUrl comes from settings.json `router.baseUrl`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROVIDERS = {
  deepseek: { defaultModel: "deepseek-flash", authKey: "deepseek", env: "DEEPSEEK_API_KEY", style: "deepseek", defaultBase: "https://api.deepseek.com" },
  "opencode-go": { defaultModel: "deepseek-v4.1-flash", authKey: "opencode-go", env: "OPENCODE_API_KEY", style: "deepseek", defaultBase: "https://opencode.ai/zen/go/v1" },
  commandcode: { defaultModel: "deepseek/deepseek-v4.1-flash", authKey: "commandcode", env: "COMMAND_CODE_API_KEY", style: "openai", defaultBase: "https://api.commandcode.ai/provider/v1", settingKey: "commandcode", envBaseUrl: "COMMAND_CODE_BASE_URL" },
  router: { defaultModel: "ds/deepseek-flash", authKey: "router", env: null, style: "openai", defaultBase: null }, // baseUrl from settings.json
};

const PI_DIR = join(homedir(), ".pi", "agent");
const TURN_PROMPTS = [
  "Write a TypeScript function `slugify(s: string): string` that converts a title into a URL slug. Return only code.",
  "Add JSDoc comments to that function and return the updated code only.",
  "Rewrite the same function in Python. Return only code.",
];

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function resolveCredential(provider) {
  const auth = readJson(join(PI_DIR, "auth.json"));
  const entry = auth?.[provider.authKey];
  let key = typeof entry?.key === "string" ? entry.key : undefined;
  if (key?.startsWith("$")) key = process.env[key.slice(1)];
  if (!key && provider.env) key = process.env[provider.env];
  if (!key) throw new Error(`no credential for "${provider.authKey}" (auth.json or $${provider.env ?? "?"})`);
  return key;
}

function resolveBaseUrl(provider) {
  if (provider.defaultBase) {
    // pi-commandcode precedence: env > repo/global settings.json > default.
    if (provider.envBaseUrl && process.env[provider.envBaseUrl]?.trim()) {
      return process.env[provider.envBaseUrl].trim().replace(/\/+$/, "");
    }
    // Section override where the owning extension supports one (pi-commandcode
    // reads commandcode.baseUrl): nearest repo .pi/settings.json (walking up
    // from cwd, so the documented scripts-dir invocation finds the repo root)
    // beats global; else default.
    const repoPaths = [];
    for (let dir = process.cwd(); ; dir = dirname(dir)) {
      repoPaths.push(join(dir, ".pi", "settings.json"));
      if (dirname(dir) === dir) break;
    }
    for (const settingsPath of [...repoPaths, join(PI_DIR, "settings.json")]) {
      const override = readJson(settingsPath)?.[provider.settingKey]?.baseUrl;
      if (typeof override === "string" && override.trim()) return override.trim().replace(/\/+$/, "");
    }
    return provider.defaultBase;
  }
  const settings = readJson(join(PI_DIR, "settings.json"));
  const url = settings?.router?.baseUrl;
  if (!url) throw new Error("router.baseUrl not set in ~/.pi/agent/settings.json");
  return url.replace(/\/+$/, "");
}

function parseArgs(argv) {
  const args = { turns: 3, maxTokens: 700, ctx: 4000, thinking: null, provider: null, model: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--provider") args.provider = argv[++i];
    else if (k === "--model") args.model = argv[++i];
    else if (k === "--thinking") args.thinking = argv[++i];
    else if (k === "--turns") args.turns = parseInt(argv[++i], 10);
    else if (k === "--max-tokens") args.maxTokens = parseInt(argv[++i], 10);
    else if (k === "--ctx") args.ctx = parseInt(argv[++i], 10);
    else throw new Error(`unknown arg ${k}`);
  }
  if (!args.provider || !PROVIDERS[args.provider]) {
    throw new Error(`--provider required: one of ${Object.keys(PROVIDERS).join(", ")}`);
  }
  if (!Number.isFinite(args.turns) || args.turns < 1) throw new Error("--turns must be a positive integer");
  if (!Number.isFinite(args.maxTokens) || args.maxTokens < 1) throw new Error("--max-tokens must be a positive integer");
  if (!Number.isFinite(args.ctx) || args.ctx < 0) throw new Error("--ctx must be a non-negative integer");
  if (args.thinking && !["high", "max"].includes(args.thinking)) {
    throw new Error("--thinking must be high|max (DeepSeek native effort levels)");
  }
  return args;
}

function buildBody(style, model, messages, thinking, maxTokens) {
  const body = { model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens };
  if (style === "deepseek") {
    body.thinking = { type: thinking ? "enabled" : "disabled" };
    if (thinking) body.reasoning_effort = thinking;
  } else if (thinking) {
    body.reasoning_effort = thinking;
  }
  return body;
}

/** Deterministic ~ctxTokens-token filler (≈4 chars/token); byte-stable across
 *  turns so turns 2+ exercise DeepSeek's 64-token-block prefix cache. */
function systemPrompt(ctxTokens) {
  const base = "You are a helpful coding assistant.";
  if (ctxTokens <= 0) return base;
  const filler = [
    "// --- reference module (stable context for cache measurement) ---",
    "export interface Task { id: string; title: string; done: boolean; assignee?: string; tags: string[] }",
    "export function summarize(tasks: Task[]): Record<string, number> {",
    "  const byAssignee: Record<string, number> = {};",
    "  for (const t of tasks) { if (t.done) continue; byAssignee[t.assignee ?? 'unassigned'] = (byAssignee[t.assignee ?? 'unassigned'] ?? 0) + 1; }",
    "  return byAssignee;",
    "}",
    "export const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'] as const;",
    "export type Priority = typeof PRIORITY_ORDER[number];",
    "export function sort(tasks: Task[], priorities: Record<string, Priority>): Task[] {",
    "  return [...tasks].sort((a, b) => PRIORITY_ORDER.indexOf(priorities[a.id] ?? 'normal') - PRIORITY_ORDER.indexOf(priorities[b.id] ?? 'normal'));",
    "}",
  ].join("\n");
  let ctx = "";
  while (ctx.length < ctxTokens * 4) ctx += filler + "\n";
  return `${base}\n${ctx}`;
}

/** Stream one request; returns {ttftMs, decodeMs, wallMs, usage, chunks}. */
async function benchTurn(baseUrl, apiKey, body, extraHeaders = {}) {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  if (!res.body) throw new Error("no response body stream");

  const decoder = new TextDecoder();
  let buf = "";
  let ttftMs = null;
  let tLast = t0;
  let usage = null;
  let deltaChunks = 0;

  const handleLine = (line) => {
    const data = line.startsWith("data: ") ? line.slice(6).trim() : null;
    if (!data || data === "[DONE]") return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    if (payload.usage) usage = payload.usage;
    if (payload.choices?.length) {
      deltaChunks++;
      // TTFT = first generated token (reasoning counts as output), not
      // role-only bookkeeping deltas — keeps effort levels comparable.
      const delta = payload.choices[0]?.delta;
      if (ttftMs === null && (delta?.content || delta?.reasoning_content || delta?.reasoning)) ttftMs = performance.now() - t0;
      tLast = performance.now();
    }
  };

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  buf += decoder.decode(); // flush the decoder's tail
  if (buf.trim()) handleLine(buf.trim()); // final line without trailing newline still counts
  // No content-bearing delta ever arrived → decode window unmeasurable; NaN
  // renders as "?" instead of silently counting the full wait as "decode".
  return { ttftMs, decodeMs: ttftMs === null ? NaN : tLast - t0 - ttftMs, wallMs: performance.now() - t0, usage, deltaChunks };
}

/** Normalize cache reporting. `reported=false` means the route surfaced no
 *  cache fields at all (common on OpenAI-compat proxies) — shown as "n/a",
 *  NOT as 0%, so cross-route tables don't misread as "no caching". */
function cacheTokens(usage = {}) {
  const deepseekHit = usage.prompt_cache_hit_tokens;
  const openaiHit = usage.prompt_tokens_details?.cached_tokens;
  const reported =
    typeof deepseekHit === "number" ||
    typeof openaiHit === "number" ||
    typeof usage.prompt_cache_miss_tokens === "number";
  const hit = deepseekHit ?? openaiHit ?? 0;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  return { hit, miss: usage.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit), prompt, reported };
}

function fmt(n, d = 1) { return Number.isFinite(n) ? n.toFixed(d) : "?"; }

async function main() {
  const args = parseArgs(process.argv);
  const provider = PROVIDERS[args.provider];
  const model = args.model ?? provider.defaultModel;
  const baseUrl = resolveBaseUrl(provider);
  const apiKey = resolveCredential(provider);
  // OpenCode Go routes requests by session header (400 MissingSessionID without
  // it); pi sends the same pair. One stable id per bench run = one routing lane.
  const extraHeaders = args.provider === "opencode-go"
    ? { "x-opencode-session": `bench-${Date.now()}`, "x-opencode-client": "pi" }
    : {};

  console.log(`provider=${args.provider} model=${model} base=${baseUrl} thinking=${args.thinking ?? "server-default"} turns=${args.turns} max_tokens=${args.maxTokens}`);
  const messages = [{ role: "system", content: systemPrompt(args.ctx) }];
  const results = [];

  for (let turn = 0; turn < args.turns; turn++) {
    messages.push({ role: "user", content: TURN_PROMPTS[turn % TURN_PROMPTS.length] });
    const body = buildBody(provider.style, model, messages, args.thinking, args.maxTokens);
    let r;
    try {
      r = await benchTurn(baseUrl, apiKey, body, extraHeaders);
    } catch (err) {
      console.error(`turn ${turn + 1} FAILED: ${err.message}`);
      process.exit(1);
    }
    const cache = cacheTokens(r.usage);
    const out = r.usage?.completion_tokens ?? 0;
    const decodeTps = out / (r.decodeMs / 1000);
    const wallTps = out / (r.wallMs / 1000);
    results.push({ out, decodeTps, wallTps, ttftMs: r.ttftMs, cache, reasoning: r.usage?.completion_tokens_details?.reasoning_tokens, deltaChunks: r.deltaChunks });
    const cacheStr = !cache.reported
      ? "n/a (route reports no cache fields)"
      : !cache.prompt
        ? `n/a (hits ${cache.hit} but no prompt total reported)`
        : `hit ${cache.hit}/${cache.prompt} (${fmt((100 * cache.hit) / cache.prompt, 0)}%)`;
    console.log(
      `turn ${turn + 1}: ttft ${fmt(r.ttftMs, 0)}ms | decode ${out} tok in ${fmt(r.decodeMs / 1000, 2)}s = ${fmt(decodeTps)} tok/s | wall ${fmt(r.wallMs / 1000, 2)}s = ${fmt(wallTps)} tok/s` +
      ` | cache ${cacheStr}` +
      ` | reasoning ${results[turn].reasoning ?? "?"} tok | ${r.deltaChunks} delta chunks`,
    );
    messages.push({ role: "assistant", content: "(done)" });
  }

  const decodes = results.map((r) => r.decodeTps).filter(Number.isFinite).sort((a, b) => a - b);
  const reported = results.filter((r) => r.cache.reported && r.cache.prompt > 0);
  const totalHit = reported.reduce((s, r) => s + r.cache.hit, 0);
  const totalPrompt = reported.reduce((s, r) => s + r.cache.prompt, 0);
  console.log("---");
  const mid = Math.floor(decodes.length / 2);
  const median = decodes.length % 2 ? decodes[mid] : (decodes[mid - 1] + decodes[mid]) / 2;
  console.log(decodes.length
    ? `decode tok/s  min=${fmt(decodes[0])} median=${fmt(median)} max=${fmt(decodes[decodes.length - 1])}`
    : "decode tok/s  n/a (no token-level stream observed)");
  console.log(reported.length
    ? `overall cache hit ${totalHit}/${totalPrompt} (${fmt(totalPrompt ? (100 * totalHit) / totalPrompt : 0, 0)}%) — climbs on turns 2+ when the prefix is byte-stable`
    : "overall cache hit n/a — route reported no usable cache totals (decode tok/s still valid)");
}

main();
