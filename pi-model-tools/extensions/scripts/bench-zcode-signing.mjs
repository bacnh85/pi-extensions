#!/usr/bin/env node
// bench-zcode-signing.mjs — live landing-proof + benchmark for the signed ZCode ultra route.
//
// Phase "landing": N fresh ~60k-token signed requests to the ultra route, then
//   quota Δ% + model-usage Δtok. Proves traffic lands on the metered account
//   (Δtok>0 or Δ%>0 required — a 0/0 result is reported as inconclusive, per
//   the meter-lag caveat) and gives a daytime rate estimate vs the 463k/pt
//   baseline from the night run.
// Phase "bench": streamed glm-5.3-flash — signed-ultra vs unsigned-api,
//   standard vs fast. Run1 cold, runs 2-3 warm-cache (agent-realistic).
//
// Cost: landing ≈ N×60k input ≈ N×13.5 credits (flash off-peak). Rerun
// "landing" inside the campaign night window (22:00–08:00 local) for the
// zero-quota verdict: `node scripts/bench-zcode-signing.mjs landing`.
//
// Usage: node scripts/bench-zcode-signing.mjs [landing|bench|all]   (env: N, WORDS)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { ClientSigningManager, resolveZcodeIdentity, buildZcodeIdentityHeaders } from "../lib/zcode-signing.ts";

const API = "https://api.z.ai";
const ULTRA = "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages";
const MODEL = "glm-5.3-flash";
const phase = process.argv[2] || "all";

const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
const cred = auth["zai-anthropic"]?.key;
if (!cred) { console.log("no zai-anthropic credential"); process.exit(1); }

const identity = resolveZcodeIdentity();
const mgr = new ClientSigningManager({ identity });
mgr.onEvent = (m) => console.log(`  signer: ${m}`);

async function quotaPct() {
  const r = await fetch(`${API}/api/monitor/usage/quota/limit`, { headers: { Authorization: `Bearer ${cred}` } });
  const j = await r.json().catch(() => ({}));
  const w = (j?.data?.limits ?? []).find((l) => l.type === "TOKENS_LIMIT");
  return w ? { pct: w.percentage, reset: w.nextResetTime } : null;
}

async function flashTokens24h() {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  const now = new Date();
  const qs = `?startTime=${encodeURIComponent(fmt(new Date(now.getTime() - 86400000)))}&endTime=${encodeURIComponent(fmt(now))}`;
  const r = await fetch(`${API}/api/monitor/usage/model-usage${qs}`, { headers: { Authorization: `Bearer ${cred}` } });
  const j = await r.json().catch(() => ({}));
  const m = (j?.data?.totalUsage?.modelSummaryList ?? []).find((x) => /flash/i.test(x.modelName ?? ""));
  return m ? (m.totalTokens ?? 0) : null;
}

function freshPrompt(words) {
  const w = [];
  for (let i = 0; i < words; i++) w.push(randomBytes(3).toString("hex"));
  return `${w.join(" ")}\n\nIgnore the text above. Reply with the single word OK.`;
}

async function signedHeaders(session) {
  const h = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": cred,
    "x-session-id": session,
    ...buildZcodeIdentityHeaders(identity),
  };
  const ok = await mgr.sign(ULTRA, h, { credential: cred, appVersion: identity.appVersion });
  if (!ok) throw new Error("signing failed");
  return h;
}

// ── phase: landing (traffic-lands proof + daytime rate) ─────────────────────

async function landing() {
  const N = Number(process.env.N || 10);
  const WORDS = Number(process.env.WORDS || 12000);
  const signed = process.env.SIGNED !== "0";
  // Default = ultra (the proven ZCode route); ROUTE=api tests stock-0.8.0's
  // default route (api.z.ai, signed) for the default-config zero-quota claim.
  const routeUrl = process.env.ROUTE === "api" ? `${API}/api/anthropic/v1/messages` : ULTRA;
  const route = `${signed ? (routeUrl === ULTRA ? "ultra+signed" : "api+signed (stock default route)") : "api-bare (SIGNED=0 A/B control)"}`;
  const send = async (prompt) => {
    if (!signed) {
      return await fetch(`${API}/api/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": cred },
        body: JSON.stringify({ model: MODEL, max_tokens: 64, temperature: 0.2, stream: false, messages: [{ role: "user", content: prompt }] }),
      });
    }
    const h = await signedHeaders(`pi-landing-${randomUUID()}`);
    return await fetch(routeUrl, { method: "POST", headers: h, body: JSON.stringify({ model: MODEL, max_tokens: 64, temperature: 0.2, stream: false, messages: [{ role: "user", content: prompt }] }) });
  };
  const q0 = await quotaPct();
  const mu0 = await flashTokens24h();
  console.log(`landing [${route}]: quota=${q0?.pct}% flash24h=${mu0} | N=${N} × ~${Math.round((WORDS * 5) / 1000)}k tokens`);
  let inTok = 0;
  const lat = [];
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const r = await send(freshPrompt(WORDS));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.log(`  req ${i + 1}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 140)}`); break; }
    inTok += j.usage?.input_tokens ?? 0;
    lat.push(Date.now() - t0);
    console.log(`  req ${i + 1}/${N}: ${lat.at(-1)}ms in=${j.usage?.input_tokens}`);
  }
  // settle: poll model-usage until it moves (max 3 min) — rollup lags
  let mu1 = mu0;
  let waited = 0;
  while (waited < 180000) {
    await new Promise((r) => setTimeout(r, 30000));
    waited += 30000;
    mu1 = await flashTokens24h();
    if (mu1 !== null && mu0 !== null && mu1 > mu0) break;
  }
  const q1 = await quotaPct();
  const dpct = q1 && q0 ? q1.pct - q0.pct : null;
  const dtok = mu1 !== null && mu0 !== null ? mu1 - mu0 : null;
  console.log(`\nlanding result: quota ${q0?.pct}% → ${q1?.pct}% (Δ${dpct}pt) | flash24h Δtok=${dtok} (settled ${waited / 1000}s)`);
  console.log(`sent ${inTok} input tokens over ${lat.length} reqs, avg ${Math.round(lat.reduce((a, b) => a + b, 0) / Math.max(lat.length, 1))}ms/req`);
  if ((dtok ?? 0) > 0) {
    console.log(`TRAFFIC LANDED ✓ (Δtok=${dtok} ≈ sent ${inTok}) — rate ≈ ${dpct ? `${(inTok / Math.max(dpct, 1) / 1000).toFixed(0)}k tokens per quota pt` : "?"}`);
  } else if ((dpct ?? 0) > 0) {
    console.log(`TRAFFIC LANDED ✓ via quota Δ${dpct}pt → ${dpct ? `${(inTok / Math.max(dpct, 1) / 1000).toFixed(0)}k tokens per pt` : "?"} (model-usage rollup still lagging)`);
  } else {
    console.log("⚠ no meter movement yet — inconclusive (rollup lag); re-check quota/model-usage in a few minutes before concluding anything");
  }
}

// ── phase: bench (TTFT + throughput) ────────────────────────────────────────

async function bench() {
  const routes = [
    { name: "ultra+signed", url: ULTRA, signed: true },
    { name: "api-bare     ", url: `${API}/api/anthropic/v1/messages`, signed: false },
  ];
  const modes = [{ name: "std ", extra: {} }, { name: "fast", extra: { speed: "fast" } }];
  const prompt = "Write a vivid 350-word story about a lighthouse keeper's last night before the lamp is electrified.";
  console.log("\nbench: glm-5.3-flash streamed, max 600 out, 3 runs each (run1 cold, 2-3 warm cache)");
  for (const route of routes) {
    for (const mode of modes) {
      for (let run = 1; run <= 3; run++) {
        const h = route.signed
          ? await signedHeaders(`pi-bench-${randomUUID()}`)
          : { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": cred };
        if (mode.name === "fast") h["anthropic-beta"] = "fast-mode-2026-02-01";
        const t0 = Date.now();
        let res;
        try {
          res = await fetch(route.url, {
            method: "POST",
            headers: h,
            body: JSON.stringify({ model: MODEL, max_tokens: 600, temperature: 0.7, stream: true, messages: [{ role: "user", content: prompt }], ...mode.extra }),
          });
        } catch (e) { console.log(`${route.name} ${mode.name} run${run}: FETCH ERR ${e.message}`); continue; }
        if (!res.ok) { console.log(`${route.name} ${mode.name} run${run}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`); continue; }
        let ttft = null, out = 0, inB = 0, cacheRead = 0;
        // Parse the SSE stream INCREMENTALLY — ttft must be measured on arrival.
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data: ")) continue;
            const d = line.slice(6).trim();
            if (d === "[DONE]") continue;
            try {
              const j = JSON.parse(d);
              if (j.type === "message_start") { inB = j.message?.usage?.input_tokens ?? 0; cacheRead = j.message?.usage?.cache_read_input_tokens ?? 0; }
              if (j.type === "content_block_delta" && ttft === null) ttft = Date.now() - t0;
              if (j.type === "message_delta" && j.usage?.output_tokens) out = j.usage.output_tokens;
            } catch { /* keep */ }
          }
        }
        const total = Date.now() - t0;
        const gen = out > 0 && total > (ttft ?? 0) ? (out / ((total - (ttft ?? 0)) / 1000)).toFixed(1) : "?";
        console.log(`${route.name} ${mode.name} run${run}: ttft=${ttft}ms total=${total}ms out=${out} gen=${gen} tok/s (in=${inB}${cacheRead ? `, cache_read=${cacheRead}` : ""})`);
      }
    }
  }
}

// ── phase: cache (prefix-cache matrix) ─────────────────────────────────────
// Two IDENTICAL requests per config; the 2nd's cache_read_input_tokens tells
// whether the config preserves prefix caching. Isolates route vs identity vs
// signing headers as the cache-buster.

const CACHE_SYSTEM = "You are a meticulous assistant. " +
  Array.from({ length: 160 }, (_, i) => `Rule ${i}: always answer concisely and cite rule ${i} when relevant.`).join(" ");

async function cacheMatrix() {
  const identityHeaders = buildZcodeIdentityHeaders(identity);
  const mkBody = (cacheCtl) => ({
    model: MODEL,
    max_tokens: 16,
    temperature: 0,
    stream: false,
    system: cacheCtl
      ? [{ type: "text", text: CACHE_SYSTEM, cache_control: { type: "ephemeral" } }]
      : CACHE_SYSTEM,
    messages: [{ role: "user", content: "Say OK." }],
  });
  const configs = [
    { name: "api  bare      ", url: `${API}/api/anthropic/v1/messages`, hdrs: async () => ({ "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": cred }), cacheCtl: false },
    { name: "api  +identity ", url: `${API}/api/anthropic/v1/messages`, hdrs: async () => ({ "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": cred, ...identityHeaders }), cacheCtl: false },
    { name: "api  +signed   ", url: `${API}/api/anthropic/v1/messages`, hdrs: async () => await signedHeaders(`pi-cache-${randomUUID()}`), cacheCtl: false },
    { name: "ultra +signed  ", url: ULTRA, hdrs: async () => await signedHeaders(`pi-cache-${randomUUID()}`), cacheCtl: false },
    { name: "ultra +signed+cc", url: ULTRA, hdrs: async () => await signedHeaders(`pi-cache-${randomUUID()}`), cacheCtl: true },
  ];
  console.log("\ncache matrix: 2 identical requests per config; 2nd request's cache_read is the signal\n");
  for (const cfg of configs) {
    let out = cfg.name + " ";
    for (let i = 1; i <= 2; i++) {
      const h = await cfg.hdrs();
      const r = await fetch(cfg.url, { method: "POST", headers: h, body: JSON.stringify(mkBody(cfg.cacheCtl)) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { out += `| req${i}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 80)} `; break; }
      const u = j.usage ?? {};
      out += `| req${i}: in=${u.input_tokens ?? "?"} cr=${u.cache_read_input_tokens ?? 0} cc=${u.cache_creation_input_tokens ?? 0} `;
    }
    console.log(out);
  }
}

const q = await quotaPct();
if (!q) { console.log("quota read failed"); process.exit(1); }
console.log(`quota before: ${q.pct}% (5h window, resets ${new Date(q.reset).toLocaleTimeString()})`);
if (q.pct > 90 && phase !== "bench") { console.log("quota >90% — aborting landing phase"); process.exit(1); }
if (phase === "landing" || phase === "all") await landing();
if (phase === "cache") await cacheMatrix();
if (phase === "bench" || phase === "all") await bench();
