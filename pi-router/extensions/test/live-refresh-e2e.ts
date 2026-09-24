// One-shot E2E: verify automatic catalog pull (1.2.0) against the live endpoint.
// Run: cd pi-router && PI_CODING_AGENT_DIR=$(mktemp -d) npx tsx extensions/test/live-refresh-e2e.ts
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scratch agent dir so the user's live models-store.json is untouched.
const scratchDir = mkdtempSync(join(tmpdir(), "pi-router-e2e-"));
process.env.PI_CODING_AGENT_DIR = scratchDir;

// Copy the live baseUrl into the scratch settings (tests the real config path).
const liveSettings = JSON.parse(readFileSync(join(process.env.HOME!, ".pi/agent", "settings.json"), "utf8"));
writeFileSync(join(scratchDir, "settings.json"), JSON.stringify({ router: { baseUrl: liveSettings.router.baseUrl } }));

const { registerProvider, maybeRefreshCatalog, catalogAgeMs, PROVIDER_ID } = await import("../lib/provider.js");
const { getSettings } = await import("../lib/config.js");

// Read the live credential from the REAL auth.json (scratch dir has none).
const realAuth = JSON.parse(readFileSync(join(process.env.HOME!, ".pi/agent", "auth.json"), "utf8"));
const apiKey = realAuth.router?.key as string;
if (!apiKey) { console.error("FAIL: no router key in live auth.json"); process.exit(1); }

let results = 0, failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  results++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// Fake ExtensionAPI: capture the provider config (refreshModels callback).
let refreshModels!: (ctx: unknown) => Promise<unknown>;
const fakePi = {
  registerProvider: (_n: string, config: { refreshModels: (ctx: unknown) => Promise<unknown> }) => { refreshModels = config.refreshModels; },
  events: { emit: () => {} },
} as never as Parameters<typeof registerProvider>[0];
registerProvider(fakePi, getSettings());

const signal = new AbortController().signal;

// Phase 1 — NETWORK (session-start equivalent): fresh scratch store, live fetch.
const t0 = Date.now();
const models = (await refreshModels({
  stored: undefined, allowNetwork: true, signal, credential: { type: "api_key", key: apiKey },
  publish: async (pub: { persist?: { models: unknown[]; checkedAt?: number } }) => {
    check("persist payload has checkedAt", typeof pub.persist?.checkedAt === "number", `checkedAt=${pub.persist?.checkedAt}`);
  },
})) as { id: string }[];
const fetchMs = Date.now() - t0;
check("network phase returned live catalog", models.length >= 80, `${models.length} models in ${fetchMs}ms`);
check("freshness tracked in-memory", catalogAgeMs() !== undefined && catalogAgeMs()! < 5000, `ageMs=${catalogAgeMs()}`);

// Phase 2 — maybeRefreshCatalog TTL gate with a fake registry (would be a no-op
// in a real session because freshness is now known + recent).
let refreshCalls = 0;
const fakeCtx = { modelRegistry: { refresh: async () => { refreshCalls++; return { aborted: false, errors: new Map() }; } } };
await maybeRefreshCatalog(fakeCtx as never);
check("TTL gate: fresh catalog skips registry refresh", refreshCalls === 0, `calls=${refreshCalls}`);

// Phase 3 — OFFLINE restore from a simulated persisted entry (round-trips the
// exact payload phase 1 published), backfilling freshness.
const storedEntry = { models, checkedAt: Date.now() };
const restored = (await refreshModels({
  stored: storedEntry, allowNetwork: false, signal,
})) as { id: string; reasoning: boolean }[];
check("offline phase restores full catalog", restored.length === models.length, `${restored.length} models`);

// Phase 4 — PI_OFFLINE blocks the network pull entirely.
const realFetch = globalThis.fetch;
let fetchAttempts = 0;
globalThis.fetch = (async () => { fetchAttempts++; throw new Error("should not fetch"); }) as typeof fetch;
process.env.PI_OFFLINE = "1";
try {
  await maybeRefreshCatalog(fakeCtx as never, { force: true });
  check("PI_OFFLINE: no registry refresh", refreshCalls === 0, `calls=${refreshCalls}`);
} finally {
  delete process.env.PI_OFFLINE;
  globalThis.fetch = realFetch;
}

console.log(`\n${results - failures}/${results} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
