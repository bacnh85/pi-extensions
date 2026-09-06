#!/usr/bin/env node
// Live probe: does an OmniRoute/9router route actually pass image content
// upstream? pi-router gates vision on /v1/models metadata, but the router's
// flags lie in both directions (missing on passing command-code routes, true
// on stripping openrouter ones) — VISION_OVERRIDES entries in lib/client.ts
// must be transport-verified with this script. Re-run when the router image
// updates.
//
// Verdict per model:
//   PASS  = image counted (usage.image_tokens > 0, or prompt_tokens grows
//           >= 100 over the text-only baseline)
//   STRIP = HTTP 200 but the image was invisible to the model
//   ERROR = HTTP/transport failure (details printed)
//
// Usage: node extensions/scripts/probe-vision.mjs <model-id>... <image.jpg>
// Router baseUrl/key resolve from env (ROUTER_BASE_URL / ROUTER_API_KEY) or
// {settings.json,auth.json} in PI_CODING_AGENT_DIR (default ~/.pi/agent).
// Keys are never printed.
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
let settings = {};
try { settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")); } catch { /* env-only config is fine */ }
let KEY = process.env.ROUTER_API_KEY;
if (!KEY) {
  try { KEY = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).router?.key; } catch { /* env fallback already empty */ }
}
const rawBase = (process.env.ROUTER_BASE_URL || settings.router?.baseUrl || "").replace(/\/+$/, "");
if (!rawBase || !KEY) { console.error("router baseUrl/key not found (env or PI_CODING_AGENT_DIR)"); process.exit(1); }
// Same /v1 convention as fetchModels: append the segment only when missing.
const BASE = /\/v1$/.test(rawBase) ? rawBase : `${rawBase}/v1`;

const args = process.argv.slice(2);
const imgIdx = args.findIndex((a) => existsSync(a));
const imagePath = imgIdx >= 0 ? args[imgIdx] : null;
const models = args.filter((_, i) => i !== imgIdx);
if (!models.length || !imagePath) {
  console.error("usage: probe-vision.mjs <model-id>... <image.jpg>");
  process.exit(1);
}
const mime = imagePath.endsWith(".png") ? "png" : "jpeg";
const dataUrl = `data:image/${mime};base64,${readFileSync(imagePath).toString("base64")}`;
const QUESTION = "What exact text is visible in this image? If you cannot see any image, reply exactly NOIMAGE.";

async function probe(model, withImage) {
  const content = [{ type: "text", text: QUESTION }];
  if (withImage) content.push({ type: "image_url", image_url: { url: dataUrl } });
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: 4000 }),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${String(JSON.stringify(json)).slice(0, 200)}`);
  const usage = json.usage ?? {};
  return {
    prompt: usage.prompt_tokens ?? 0,
    imageTokens: usage.image_tokens ?? usage.prompt_tokens_details?.image_tokens,
    answer: String(json.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").slice(0, 160),
  };
}

for (const model of models) {
  try {
    const base = await probe(model, false);
    const img = await probe(model, true);
    const delta = img.prompt - base.prompt;
    const verdict = (img.imageTokens ?? 0) > 0 || delta >= 100 ? "PASS " : "STRIP";
    console.log(`${model}\n  ${verdict} prompt ${base.prompt} -> ${img.prompt} (delta ${delta})  image_tokens=${img.imageTokens ?? "n/a"}\n  answer: ${img.answer}`);
  } catch (e) {
    console.log(`${model}\n  ERROR ${String(e.message ?? e).slice(0, 200)}`);
  }
}
