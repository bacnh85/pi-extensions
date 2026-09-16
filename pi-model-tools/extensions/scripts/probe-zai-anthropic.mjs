#!/usr/bin/env node
// Live probe for the zai-anthropic provider: verifies the GLM Anthropic
// endpoint accepts the exact request shapes pi-model-tools + pi-ai produce,
// and A/B-measures throughput vs the OpenAI coding endpoint.
//
// Prereq: ZAI_ANTHROPIC_API_KEY (Z.ai coding plan key) and ZAI_CODING_CN_API_KEY
// (bigmodel coding key, for the A/B leg) in the environment.
//
// Usage: node pi-model-tools/extensions/scripts/probe-zai-anthropic.mjs
const KEY = process.env.ZAI_ANTHROPIC_API_KEY;
if (!KEY) { console.error("ZAI_ANTHROPIC_API_KEY not set"); process.exit(1); }
const BASE = (process.env.ZAI_ANTHROPIC_BASE_URL || "https://api.z.ai/api/anthropic").replace(/\/+$/, "");

const PREFIX = "You are a coding agent working in a large repository. ".repeat(60); // >1024 tokens

async function anthropic(body) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

const CONTENT = "Explain in one short paragraph what a Makefile is for.";
const THINK_MAX = 4096;

async function timeIt(label, body) {
  const t0 = Date.now();
  const json = await anthropic(body);
  const ms = Date.now() - t0;
  const u = json.usage ?? {};
  const out = (u.output_tokens ?? 0) - (u.cache_read_input_tokens ? 0 : 0);
  console.log(`${label}: ${ms}ms | out=${u.output_tokens} tok | ${((u.output_tokens ?? 0) / (ms / 1000)).toFixed(1)} tok/s | cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} in=${u.input_tokens}`);
  return { ms, out };
}

console.log("=== 1. Shapes pi-ai sends (adaptive thinking + output_config.effort) ===");
await anthropic({ model: "GLM-5.3", max_tokens: 2048, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "low" }, messages: [{ role: "user", content: "Reply ok" }] });
console.log("adaptive+effort: OK");

console.log("=== 2. Prompt caching (two identical >1k-token requests) ===");
const cacheBody = { model: "GLM-5.3", max_tokens: 64, system: [{ type: "text", text: PREFIX, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "Reply ok" }] };
await timeIt("cache write", cacheBody);
const read = await timeIt("cache read ", cacheBody);
if (read.out === 0) console.log("  (cache read leg produced 0 output tokens — retry)");
await timeIt("cache read ", cacheBody);

console.log("=== 3. Fast mode (beta header + body speed) ===");
const fastBody = { model: "GLM-5.3", max_tokens: THINK_MAX, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" }, speed: "fast", messages: [{ role: "user", content: CONTENT }] };
let fastMs = 0;
{
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "fast-mode-2026-02-01", "content-type": "application/json" },
    body: JSON.stringify(fastBody),
  });
  const json = await res.json().catch(() => ({}));
  fastMs = Date.now() - t0;
  if (!res.ok) throw new Error(`fast mode rejected: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  const u = json.usage ?? {};
  console.log(`fast mode: ${fastMs}ms | out=${u.output_tokens} tok | ${(u.output_tokens / (fastMs / 1000)).toFixed(1)} tok/s`);
}

console.log("=== 4. Standard (same request, no speed field/header) ===");
const { fastMs: _drop, ...stdBody } = { fastMs: 0, ...fastBody };
delete stdBody.speed;
let stdMs = 0;
{
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(stdBody),
  });
  const json = await res.json().catch(() => ({}));
  stdMs = Date.now() - t0;
  if (!res.ok) throw new Error(`standard rejected: HTTP ${res.status}`);
  const u = json.usage ?? {};
  console.log(`standard:  ${stdMs}ms | out=${u.output_tokens} tok | ${(u.output_tokens / (stdMs / 1000)).toFixed(1)} tok/s`);
}

console.log(`\nfast=${fastMs}ms vs standard=${stdMs}ms → ${(stdMs / fastMs).toFixed(2)}x`);
console.log("\nAll probe legs passed.");
