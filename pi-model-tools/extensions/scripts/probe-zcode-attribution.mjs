#!/usr/bin/env node
// Quota-attribution probe: determines how Z.ai attributes "via ZCode" for
// GLM Coding Plan billing. Runs small chat legs over the Anthropic endpoint
// with different client fingerprints and measures credit deltas on the
// quota endpoint (same shape pi-sub reads).
//
// Legs (3 fresh ~15k-token requests each, glm-5.3-flash):
//   L1  intl API key, bare headers          (self-calibration baseline)
//   L2  intl API key + ZCode identity hdrs
//   L3  ZCode JWT, bare headers
//   L4  ZCode JWT + ZCode identity hdrs
//   L5  L4 + metadata.user_id               (only if L4 discounts vs L1)
//   L6  key + zcode hdrs + V4 signing on the ultra-zai route
//       (gate-checked handshake; the "genuine ZCode" treatment test)
//   L1r L1 repeat                            (linearity / meter-liveness check)
//   L1cn CN key baseline on open.bigmodel.cn (host comparison)
//
// All verdicts are ratios vs L1 — no assumed rates. Never prints credentials.
//
// Usage:
//   node scripts/probe-zcode-attribution.mjs --dry   # creds + quota read only
//   node scripts/probe-zcode-attribution.mjs         # full run

import { createHash, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { ClientSigningManager, resolveZcodeIdentity, buildZcodeIdentityHeaders, zcodeSigningEnabled } from "../lib/zcode-signing.ts";
import { homedir, userInfo, platform } from "node:os";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DRY = process.argv.includes("--dry");
const MASK = (s) => (s ? `…${s.slice(-4)}` : "(none)");

// ── credentials ──────────────────────────────────────────────────────────────

function readAuthJsonKey(name) {
  try {
    const p = join(homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(readFileSync(p, "utf8"));
    return auth?.[name]?.key ?? null;
  } catch {
    return null;
  }
}

/** Decrypt one `enc:v1:<b64url(iv)>.<b64url(tag)>.<b64url(ct)>` value. */
function decryptEnc(raw) {
  if (typeof raw !== "string" || !raw.startsWith("enc:v1:")) return { error: "not enc:v1 format" };
  const secrets = [];
  if (process.env.ZCODE_CREDENTIAL_SECRET) secrets.push(process.env.ZCODE_CREDENTIAL_SECRET);
  secrets.push(`zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`);
  const [ivB64, tagB64, ctB64] = raw.slice(7).split(".");
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  for (const secret of secrets) {
    try {
      const key = createHash("sha256").update(secret, "utf8").digest();
      const d = createDecipheriv("aes-256-gcm", key, iv);
      d.setAuthTag(tag);
      return { plain: Buffer.concat([d.update(ct), d.final()]).toString("utf8") };
    } catch {
      /* try next key candidate */
    }
  }
  return { error: "decrypt failed (key mismatch?)" };
}

function readZcodeCreds() {
  const p = join(homedir(), ".zcode", "v2", "credentials.json");
  if (!existsSync(p)) return { error: "no ~/.zcode/v2/credentials.json" };
  try {
    const store = JSON.parse(readFileSync(p, "utf8"));
    const out = { activeProvider: null, jwt: null, userSub: null, errors: [] };
    const active = decryptEnc(store["oauth:active_provider"]);
    out.activeProvider = active.plain ?? null;
    if (!active.plain) out.errors.push(`active_provider: ${active.error}`);
    const jwt = decryptEnc(store["zcodejwttoken"]);
    out.jwt = jwt.plain ?? null;
    if (!jwt.plain) out.errors.push(`jwt: ${jwt.error}`);
    const info = decryptEnc(store["oauth:zai:user_info"]);
    if (info.plain) {
      try {
        const parsed = JSON.parse(info.plain);
        out.userSub = parsed.user_id ?? parsed.sub ?? null;
      } catch { /* user_info not JSON — fine */ }
    }
    return out;
  } catch (e) {
    return { error: `read/parse failed: ${e.message}` };
  }
}

// ── ZCode fingerprint ────────────────────────────────────────────────────────

const ZCODE_VERSION = process.env.ZCODE_PROBE_VERSION || "3.10.2"; // overridden below by the lib's resolver (env ZCODE_IDENTITY_APP_VERSION > installed)
const JWT_ONLY = process.argv.includes("--jwt"); // run only L3/L4 (JWT legs)

/** Stable-ish device id: env > cached file > fresh UUID (cached for future runs). */
function deviceMid() {
  if (process.env.ZCODE_PROBE_DEVICE_MID) return process.env.ZCODE_PROBE_DEVICE_MID;
  const p = join(homedir(), ".zcode-probe-device-mid");
  try {
    return readFileSync(p, "utf8").trim() || fresh();
  } catch {
    const id = randomUUID();
    try { writeFileSync(p, id); } catch { /* best-effort */ }
    return id;
  }
  function fresh() {
    const id = randomUUID();
    try { writeFileSync(p, id); } catch { /* best-effort */ }
    return id;
  }
}

// Production parity: exact header set/order/semantics the extension sends
// (buildZcodeIdentityHeaders), so the L6 verdict transfers to real traffic.
function zcodeIdentityHeaders() {
  return buildZcodeIdentityHeaders(resolveZcodeIdentity());
}

const BARE = { "anthropic-version": "2023-06-01" };

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function chat(url, cred, extraHeaders, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...BARE, "x-api-key": cred, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, error: json?.error?.message || JSON.stringify(json).slice(0, 160) };
  return { ok: true, usage: json.usage ?? {}, stop: json.stop_reason };
}

async function readQuota(host, cred) {
  const res = await fetch(`${host}/api/monitor/usage/quota/limit`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${cred}`, "User-Agent": "zcode-attribution-probe/0.1" },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) return { error: json?.msg || `HTTP ${res.status}` };
  const limits = (json?.data?.limits ?? []).filter((l) => l.type === "TOKENS_LIMIT");
  return { limits };
}

/** Exact per-model token totals over a sliding 24h window (integer counts). */
async function readModelUsage(host, cred) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  const now = new Date();
  const qs = `?startTime=${encodeURIComponent(fmt(new Date(now.getTime() - 86_400_000)))}&endTime=${encodeURIComponent(fmt(now))}`;
  const res = await fetch(`${host}/api/monitor/usage/model-usage${qs}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${cred}`, "User-Agent": "zcode-attribution-probe/0.1" },
  });
  const json = await res.json().catch(() => ({}));
  const list = json?.data?.totalUsage?.modelSummaryList;
  if (!Array.isArray(list)) return { error: `HTTP ${res.status}` };
  return { byModel: Object.fromEntries(list.map((m) => [m.modelName, m.totalTokens ?? 0])) };
}

// ── prompt generation (fresh ~30k tokens per request; no cache hits) ─────────
// Lite-tier 5h window is ~2k credits; quota API reports integer percentage, so
// each leg needs ≳40 credits to move it 2 points at 1x. 8 × 30k input tokens
// × 2.3/10000 ≈ 55 credits. Tune via PROBE_REQS / PROBE_WORDS.
const REQ_COUNT = Number(process.env.PROBE_REQS || 8);
const WORDS = Number(process.env.PROBE_WORDS || 12000);

function makePrompt() {
  const words = [];
  for (let i = 0; i < WORDS; i++) words.push(randomBytes(3).toString("hex")); // ~84k chars ≈ 30k tokens
  return `${words.join(" ")}\n\nIgnore the text above. Reply with the single word OK.`;
}

function makeBody(prompt, extra = {}) {
  return {
    model: MODEL_ID,
    max_tokens: 64,
    temperature: 0.2,
    stream: false,
    messages: [{ role: "user", content: prompt }],
    ...extra,
  };
}

// ── legs ─────────────────────────────────────────────────────────────────────

let MODEL_ID = process.env.ZCODE_PROBE_MODEL || "glm-5.3-flash";

async function runLeg(label, host, cred, extraHeaders, bodyExtra, reqCount = REQ_COUNT, url, signEach) {
  const before = await readQuota(host, cred);
  if (before.error) return { label, error: `quota read failed: ${before.error}` };
  const windowsBefore = before.limits.map((l) => l.nextResetTime).join(",");
  const muBefore = await readModelUsage(host, cred);

  let okCount = 0, inTok = 0, outTok = 0, lastErr = null;
  for (let i = 0; i < reqCount; i++) {
    const hdrs = signEach ? await signEach({ ...extraHeaders }) : extraHeaders;
    const r = await chat(url || `${host}/api/anthropic/v1/messages`, cred, hdrs, makeBody(makePrompt(), bodyExtra));
    if (!r.ok) {
      lastErr = `HTTP ${r.status}: ${r.error}`;
      if (r.status === 401) break; // credential dead — stop the leg
      continue;
    }
    okCount++;
    inTok += r.usage.input_tokens ?? 0;
    outTok += r.usage.output_tokens ?? 0;
  }

  // model-usage is aggregated periodically — settle briefly, retry once
  await new Promise((r) => setTimeout(r, 8_000));
  let muAfter = await readModelUsage(host, cred);
  const after = await readQuota(host, cred);
  const windowsAfter = after.limits?.map((l) => l.nextResetTime).join(",") ?? "";
  const leg = {
    label,
    okCount,
    reqCount,
    inTok,
    outTok,
    lastErr: okCount === 0 ? lastErr : null,
    invalid: windowsBefore !== windowsAfter ? "window boundary crossed mid-leg" : null,
    deltas: {},
    trafficDelta: null,
    rawLimits: after.limits,
  };
  if (!muAfter.error && !muBefore.error) {
    const f = (muAfter.byModel["GLM-5.3-Flash"] ?? 0) - (muBefore.byModel["GLM-5.3-Flash"] ?? 0);
    leg.trafficDelta = f;
  }
  if (!after.error) {
    for (let w = 0; w < after.limits.length; w++) {
      const b = before.limits[w]?.percentage, a = after.limits[w]?.percentage;
      if (typeof b === "number" && typeof a === "number") leg.deltas[`window${w}`] = +(a - b).toFixed(4);
    }
  }
  return leg;
}

// ── main ─────────────────────────────────────────────────────────────────────

const intlKey = readAuthJsonKey("zai-anthropic") || process.env.ZAI_ANTHROPIC_API_KEY || null;
const cnKey = readAuthJsonKey("zai-coding-cn");
const zc = readZcodeCreds();

console.log("== credentials ==");
console.log(`intl key (zai-anthropic): ${MASK(intlKey)}`);
console.log(`cn   key (zai-coding-cn): ${MASK(cnKey)}`);
console.log(`zcode active provider:    ${zc.activeProvider ?? "?"}`);
console.log(`zcode jwt:                ${zc.jwt ? MASK(zc.jwt) : `(unavailable: ${zc.errors?.join("; ")})`}`);
console.log(`zcode user sub:           ${zc.userSub ? MASK(zc.userSub) : "(none)"}`);
console.log(`identity headers:         ${JSON.stringify(zcodeIdentityHeaders())}\n`);

const ZAI = "https://api.z.ai";
const CN = "https://open.bigmodel.cn";

// Quota snapshot + precision check (works even in --dry).
const snap = intlKey ? await readQuota(ZAI, intlKey) : { error: "no intl key" };
if (snap.error) {
  console.log(`quota read (intl): ERROR ${snap.error}`);
} else {
console.log(`\nquota read (intl): ${snap.error ? `ERROR ${snap.error}` : `${snap.limits.length} TOKENS_LIMIT windows`}`);
if (!snap.error) console.log("raw window fields:", JSON.stringify(snap.limits.map((l) => ({ ...l })), null, 1).slice(0, 600));

// Server-controlled endpoint routing: reveals the upstream URL ZCode actually
// uses for this plan (RE: zcode.z.ai/api/v1/agent/configs, fail-open mapping).
if (zc.jwt) {
  try {
    const r = await fetch("https://zcode.z.ai/api/v1/agent/configs", { headers: { Accept: "application/json", Authorization: `Bearer ${zc.jwt}` } });
    const j = await r.json().catch(() => ({}));
    const s = JSON.stringify(j);
    console.log(`agent/configs: HTTP ${r.status}`, r.ok ? s.replace(/https?:\/\/[^"\s]*/g, (m) => m).slice(0, 700) : s.slice(0, 200));
  } catch (e) {
    console.log(`agent/configs: ERR ${e.message}`);
  }
}
}
if (DRY) process.exit(0);

const legs = [];
if (JWT_ONLY) {
  if (zc.jwt) {
    legs.push(["L3  jwt bare   ", ZAI, zc.jwt, {}, {}]);
    legs.push(["L4  jwt+zcode  ", ZAI, zc.jwt, zcodeIdentityHeaders(), {}]);
  }
} else {
  if (intlKey) {
    legs.push(["L1  key bare   ", ZAI, intlKey, {}, {}]);
    legs.push(["L2  key+zcode  ", ZAI, intlKey, zcodeIdentityHeaders(), {}]);
  }
  if (zc.jwt) {
    legs.push(["L3  jwt bare   ", ZAI, zc.jwt, {}, {}]);
    legs.push(["L4  jwt+zcode  ", ZAI, zc.jwt, zcodeIdentityHeaders(), {}]);
  }
  if (cnKey) {
    legs.push(["L1cn key bare  ", CN, cnKey, {}, {}]);
  }
}

console.log("\n== running legs ==");
const results = [];
let signEach = null, signerEvents = [];
const ULTRA = "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages";
if (intlKey && zcodeSigningEnabled({ ZAI_ANTHROPIC_SIGNING: "1" })) {
  const mgr = new ClientSigningManager({ identity: resolveZcodeIdentity() });
  mgr.onEvent = (m) => signerEvents.push(m);
  signEach = async (hdrs) => {
    const h = { ...hdrs, "x-session-id": `probe-${randomUUID()}` };
    await mgr.sign(ULTRA, h, { credential: intlKey, appVersion: resolveZcodeIdentity().appVersion });
    return h;
  };
}
for (const [label, host, cred, hdrs, bodyExtra] of legs) {
  const leg = await runLeg(label, host, cred, hdrs, bodyExtra, REQ_COUNT, undefined, null);
  results.push(leg);
  console.log(`${leg.error ? `✗ ${leg.error}` : leg.invalid ? `⚠ ${leg.invalid}` : `✓ ${leg.okCount}/${leg.reqCount} ok, in=${leg.inTok} out=${leg.outTok}, Δtok=${leg.trafficDelta ?? "?"}, Δ%=${JSON.stringify(leg.deltas)}`}  ${label}${leg.okCount < REQ_COUNT && leg.lastErr ? `  [${leg.lastErr}]` : ""}`);
  if (leg.lastErr?.startsWith("HTTP 401")) { console.log("   credential rejected — skipping remaining legs on it"); }
  if (leg.error?.includes("token expired")) { console.log("   → JWT expired: open ZCode desktop once to refresh, then re-run"); }
}

// L6: key + identity + V4-signed requests on the ultra-zai route.
if (signEach) {
  console.log("  L6: signing enabled — requests go to zcode.z.ai ultra-zai with V4 headers");
  const leg = await runLeg("L6  key+hdrs+signed", ZAI, intlKey, zcodeIdentityHeaders(), {}, REQ_COUNT, ULTRA, signEach);
  results.push(leg);
  console.log(`${leg.error ? `✗ ${leg.error}` : leg.invalid ? `⚠ ${leg.invalid}` : `✓ ${leg.okCount}/${leg.reqCount} ok, in=${leg.inTok} out=${leg.outTok}, Δtok=${leg.trafficDelta ?? "?"}, Δ%=${JSON.stringify(leg.deltas)}`}  ${leg.label}${leg.okCount < REQ_COUNT && leg.lastErr ? `  [${leg.lastErr}]` : ""}`);
  for (const ev of signerEvents.splice(0)) console.log(`  signer: ${ev}`);
} else {
  console.log("\nL6 skipped: set ZAI_ANTHROPIC_SIGNING=1 to enable the signed ultra-zai leg");
}

// L5 conditional: only meaningful if L4 exists and discounted vs L1.
const L1 = results.find((r) => r.label.startsWith("L1 ") && !r.error && !r.invalid);
const L4 = results.find((r) => r.label.startsWith("L4") && !r.error && !r.invalid);
const l1Delta = L1 ? Object.values(L1.deltas)[0] : undefined;
const l4Delta = L4 ? Object.values(L4.deltas)[0] : undefined;
if (zc.jwt && zc.userSub && typeof l1Delta === "number" && typeof l4Delta === "number" && l4Delta < 0.5 * l1Delta) {
  console.log("\nL4 discounted — running L5 (+metadata.user_id)…");
  const leg = await runLeg("L5  jwt+zcode+uid", ZAI, zc.jwt, zcodeIdentityHeaders(), { metadata: { user_id: zc.userSub } });
  results.push(leg);
  console.log(`${leg.error ? `✗ ${leg.error}` : `✓ ${leg.okCount}/${leg.reqCount} ok, Δ%=${JSON.stringify(leg.deltas)}`}  ${leg.label}`);
}

// L1 repeat (linearity / meter liveness) — only if L1 moved the meter.
if (L1 && l1Delta > 0) {
  const leg = await runLeg("L1r repeat     ", ZAI, intlKey, {}, {});
  results.push(leg);
  console.log(`${leg.error ? `✗ ${leg.error}` : `✓ ${leg.okCount}/${leg.reqCount} ok, Δ%=${JSON.stringify(leg.deltas)}`}  ${leg.label}`);
}

// ── verdict ──────────────────────────────────────────────────────────────────
console.log("\n== verdict ==");
const fmt = (v) => (typeof v === "number" ? v.toFixed(4) : "n/a");
for (const r of results) {
  const d = Object.values(r.deltas ?? {})[0];
  const factor = typeof d === "number" && typeof l1Delta === "number" && l1Delta > 0 ? (d / l1Delta).toFixed(3) : "?";
  console.log(`${r.label} Δ%=${fmt(d)} (factor ${factor})  Δtok=${r.trafficDelta ?? "?"}${r.lastErr ? `  err=${r.lastErr}` : ""}${r.invalid ? `  ⚠${r.invalid}` : ""}`);
}
console.log("\nInterpretation: factor ≈1 → treated like any agent; ≈0.4-0.7 → agent/legacy discount; 0 → ZCode zero-quota branch.");
console.log("Δtok (model-usage, exact) proves traffic landed on the account; Δ% (quota, integer) is the billing signal.");
console.log("If Δtok>0 but every Δ%=0 on BILLED legs, percentage granularity is too coarse — re-run with PROBE_REQS doubled.");
