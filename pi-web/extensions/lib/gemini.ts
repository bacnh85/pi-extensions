// Gemini web-tier (gemini.google.com) research backend, cookie-authed via the
// __Secure-1PSID cookie. Thin wrapper over the `gemini-reverse` npm package
// (CJS), lazily dynamic-imported so pi startup pays zero cost when unused.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { urlToHttpOptions } from "node:url";
import { findEnvValue } from "./config";
import { ensureKeepalive, loadCookieStore, resolvePsidts, saveCookieStore, type PostFn } from "./gemini-auth";
import { CHROME_UA, DeepResearchError, geminiDeepResearch, type DrHttp } from "./gemini-dr";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GeminiWebConfig {
  psid?: string;
  psidSource: string;
  psidts?: string;
  proxy?: string;
}

export function loadGeminiWebConfig(cwd = process.cwd(), includeCwdEnv = false): GeminiWebConfig {
  const psid = findEnvValue("GEMINI_WEB_SECURE_1PSID", cwd, includeCwdEnv);
  const psidts = findEnvValue("GEMINI_WEB_SECURE_1PSIDTS", cwd, includeCwdEnv);
  const proxy = findEnvValue("GEMINI_WEB_PROXY", cwd, includeCwdEnv);
  return { psid: psid.value, psidSource: psid.value ? psid.source : "not set", psidts: psidts.value, proxy: proxy.value };
}

// ---------------------------------------------------------------------------
// Minimal structural view of the gemini-reverse client (keeps tests injectable
// and decouples us from upstream type drift).
// ---------------------------------------------------------------------------

export interface GeminiOutputLike {
  text?: string | null;
  model?: string;
  candidates?: Array<{ text?: string | null }>;
}

export interface GeminiResearchLike {
  text?: string | null;
  plan?: { title?: string | null; eta_text?: string | null };
  statuses?: Array<Record<string, unknown>>;
}

export interface GeminiImageLike {
  save(opts?: { path?: string; filename?: string }): Promise<string>;
  url?: string;
  alt?: string;
}

export interface GeminiImageOutputLike {
  text?: string | null;
  model?: string;
  images?: GeminiImageLike[];
  generated_images?: GeminiImageLike[];
}

export interface GeminiClientLike {
  ask(prompt: string, opts?: Record<string, unknown>): Promise<GeminiOutputLike>;
  research(
    prompt: string,
    opts?: { wait?: boolean; pollInterval?: number; timeout?: number; onStatus?: (s: Record<string, unknown>) => void },
  ): Promise<GeminiResearchLike>;
  // Optional so pre-0.9 fake clients (ask+research only) keep compiling.
  newChat?(opts?: { model?: string }): {
    generateContent(o: { prompt: string }): Promise<GeminiImageOutputLike>;
  };
}

export type GeminiClientFactory = (
  opts: { secure_1psid?: string; secure_1psidts?: string; proxy?: string },
) => GeminiClientLike | Promise<GeminiClientLike>;

// Cached per config (psid|proxy) so a config change re-creates the client.
let cached: { key: string; client: GeminiClientLike } | null = null;

// Google ships ~25KB of response headers on every Gemini page (a 19.7KB
// content-security-policy + 3.9KB reporting-endpoints) — over Node's default
// 16KB parser cap, so the http parser rejects them (HPE_HEADER_OVERFLOW; the
// same cap exists in undici, but gemini-reverse uses axios's node http adapter).
// Node honors a per-request maxHeaderSize override, and gemini.google.com also
// gates privileged surfaces (image gen, DR, RotateCookies) on browser-grade
// client headers, which gemini-reverse never sends — so lazily patch
// http.request/https.request to inject both for gemini.google.com hosts only.
// ponytail: process-wide patch, scoped to one hostname; if it ever misbehaves,
// revert to NODE_OPTIONS=--max-http-header-size=262144 (cap) or dropping the
// UA merge (headers).

/**
 * Returns the request options to pass through with the cap + browser headers
 * injected when the target host is gemini.google.com, or null when the call
 * must pass through untouched. Normalizes all http.request input forms
 * (options object, string, URL) — string/URL forms become a fresh options
 * object.
 *
 * gemini.google.com gates privileged surfaces (image gen, Deep Research,
 * RotateCookies) on browser-grade client headers: gemini-reverse sends
 * axios's default UA, while the Chrome-UA DR client and rotation both work
 * over plain Node TLS (live-proven 2026-09-13/14). Non-browser user-agents
 * are replaced; every other key is added only when absent (never clobbered).
 *
 * @internal exported for tests
 */
export function injectGeminiRequestTweaks(options: unknown): Record<string, unknown> | null {
  let opts: Record<string, unknown>;
  if (typeof options === "string") {
    opts = urlToHttpOptions(new URL(options)) as Record<string, unknown>;
  } else if (options instanceof URL) {
    opts = urlToHttpOptions(options) as Record<string, unknown>;
  } else if (options && typeof options === "object") {
    opts = options as Record<string, unknown>;
  } else {
    return null;
  }
  const host = String(opts.hostname ?? opts.host ?? "").split(":")[0];
  if (host !== "gemini.google.com" || opts.maxHeaderSize) return null;
  opts.maxHeaderSize = 256 * 1024;
  mergeBrowserHeaders(opts);
  return opts;
}

const BROWSER_HEADERS: Record<string, string> = {
  "user-agent": CHROME_UA,
  "sec-ch-ua": '"Chromium";v="145", "Google Chrome";v="145", "Not-A.Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "accept-language": "en-US,en;q=0.9",
};

/** Absent-keys-only merge — except user-agent, which is REPLACED when the
 * current value is a non-browser UA (axios injects its own default, which
 * poisons the privileged-surface gate; that replacement is the point).
 * An existing browser UA (any transport's) is left alone. */
function mergeBrowserHeaders(opts: Record<string, unknown>): void {
  const headers = (opts.headers ??= {}) as Record<string, unknown>;
  const present = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  const uaKey = Object.keys(headers).find((k) => k.toLowerCase() === "user-agent");
  const ua = String(uaKey !== undefined ? headers[uaKey] : "");
  if (/chrome\//i.test(ua)) {
    // existing browser UA (any case) — leave exactly as-is
  } else {
    if (uaKey !== undefined) delete headers[uaKey]; // drop non-browser UA (any case) — two UA headers is worse than one
    headers["user-agent"] = CHROME_UA;
  }
  for (const [key, value] of Object.entries(BROWSER_HEADERS)) {
    if (key !== "user-agent" && !present.has(key)) headers[key] = value;
  }
}

/** @internal exported for tests — returns the http.request args to forward with the tweaks applied */
export function applyHeaderCapArgs(args: unknown[]): unknown[] {
  const [options, ...rest] = args;
  if (options && typeof options === "object" && !(options instanceof URL)) {
    injectGeminiRequestTweaks(options); // options-object form: mutate in place
    return args;
  }
  if (typeof options === "string" || options instanceof URL) {
    const parsed = urlToHttpOptions(options instanceof URL ? options : new URL(options)) as Record<string, unknown>;
    if (String(parsed.hostname ?? "").split(":")[0] === "gemini.google.com") {
      const follow = rest[0];
      if (follow && typeof follow === "object" && typeof follow !== "function") {
        // 3-arg request(url, options, cb): merge into the caller's options —
        // replacing arg1 with a plain object would misbind Node's signature
        // (the options object would be read as the callback). The follow-on
        // object legitimately lacks hostname (Node merges it from the URL).
        if (!(follow as Record<string, unknown>).maxHeaderSize) {
          (follow as Record<string, unknown>).maxHeaderSize = 256 * 1024;
          mergeBrowserHeaders(follow as Record<string, unknown>);
        }
        return args;
      }
      const opts = injectGeminiRequestTweaks(options); // 2-arg (url, cb): (optionsObj, cb) is valid
      if (opts) return [opts, ...rest];
    }
  }
  return args;
}

let headerCapPatched = false;
function patchHeaderCap(): void {
  if (headerCapPatched) return;
  headerCapPatched = true;
  for (const mod of [http, https]) {
    const real = mod.request as unknown as (...args: unknown[]) => unknown;
    const patched = function (this: unknown, ...args: unknown[]) {
      try {
        args = applyHeaderCapArgs(args);
      } catch { /* malformed input — let the real request surface the error */ }
      return real.call(this, ...args);
    } as typeof mod.request;
    mod.request = patched;
  }
}

/** @internal exported for tests — resolves the real gemini-reverse module */
export async function loadDefaultFactory(): Promise<GeminiClientFactory> {
  patchHeaderCap();
  const mod = (await import("gemini-reverse")) as unknown as Record<string, unknown>;
  // CJS interop: named export usually works, but fall back to default.Gemini.
  const Gemini = (mod.Gemini ?? (mod as { default?: Record<string, unknown> }).default?.Gemini) as
    | (new (opts: Record<string, unknown>) => GeminiClientLike)
    | undefined;
  if (typeof Gemini !== "function") {
    throw new Error("gemini-reverse: Gemini export not found (unexpected package shape)");
  }
  // ponytail: generous per-request cap (covers research); per-mode ask/research
  // timeouts are enforced by raceGuard below.
  // ponytail: Google's rotating __Secure-1PSIDTS is required for sensitive
  // surfaces (image generation refuses with "You might be signed out" when it
  // is missing); the page HTML no longer carries SNlM0e/rotations for plain
  // clients, so the user passes it explicitly and we inject it pre-init.
  return (opts) => {
    const client = new Gemini({ secure_1psid: opts.secure_1psid, proxy: opts.proxy ?? null, timeout: 1_800_000 });
    if (opts.secure_1psidts) {
      (client as unknown as { cookies: Record<string, string> }).cookies["__Secure-1PSIDTS"] = opts.secure_1psidts;
    }
    return client;
  };
}

async function getClient(config: GeminiWebConfig, factory?: GeminiClientFactory, storePath?: string): Promise<GeminiClientLike> {
  // Store-first: the keepalive keeps __Secure-1PSIDTS rotated and persisted;
  // the static env copy is only the bootstrap identity (and wins when the
  // user pastes a fresh cookie, because the store is keyed to the old psid).
  const psidts = resolvePsidts(config.psid, config.psidts, storePath);
  const key = `${config.psid ?? ""}|${psidts ?? ""}|${config.proxy ?? ""}`;
  if (cached?.key === key) return cached.client;
  const make = factory ?? (await loadDefaultFactory());
  const client = await make({ secure_1psid: config.psid, secure_1psidts: psidts, proxy: config.proxy });
  // Keepalive arms only for the real transport — fake factories (tests) get
  // no background rotation timer.
  if (!factory) ensureKeepalive(config);
  cached = { key, client };
  return client;
}

/** @internal test hook */
export function __resetGeminiClientCache(): void {
  cached = null;
}

function errorName(err: unknown): string {
  const e = err as { name?: string; constructor?: { name?: string } } | null;
  const name = e?.name;
  // Subclasses that don't set this.name inherit the generic "Error" — prefer
  // the constructor name in that case (how we detect upstream error classes).
  if (name && name !== "Error") return name;
  return e?.constructor?.name ?? name ?? "";
}

function isAuthError(err: unknown): boolean {
  return errorName(err) === "AuthError";
}

// After a successful run, persist any rotated __Secure-1PSIDTS the client
// absorbed from response Set-Cookie headers (gemini-reverse merges them into
// client.cookies). Without this, the rotated value dies with the process —
// exactly the static-snapshot decay OmniRoute #7676 describes.
// Best-effort: a store-write failure (EACCES, ENOSPC, bad path) must never
// convert a succeeded tool call into an error.
function persistRotatedTs(client: GeminiClientLike, config: GeminiWebConfig, storePath?: string): void {
  try {
    if (!config.psid) return;
    const ts = (client as unknown as { cookies?: Record<string, string> }).cookies?.["__Secure-1PSIDTS"];
    if (!ts || ts === config.psidts) return;
    const store = loadCookieStore(storePath);
    if (store?.psid === config.psid && store.psidts === ts) return;
    saveCookieStore({ psid: config.psid, psidts: ts, updatedAt: Date.now() }, storePath);
  } catch {
    /* best-effort persistence — the call already succeeded */
  }
}

// One AuthError retry: rotate the cookie via Google's RotateCookies endpoint
// (refreshGeminiAuth persists a fresh value, or clears the store when the
// server says the session is dead), then rebuild the client — re-running init
// also absorbs rotated Set-Cookies Google hands back. Only one retry: a
// second AuthError propagates.
export async function withGeminiClient<T>(
  config: GeminiWebConfig,
  run: (client: GeminiClientLike) => Promise<T>,
  factory?: GeminiClientFactory,
  auth?: { rotatePost?: PostFn; storePath?: string },
): Promise<T> {
  const attempt = async (client: GeminiClientLike): Promise<T> => {
    const result = await run(client);
    persistRotatedTs(client, config, auth?.storePath);
    return result;
  };
  let client = await getClient(config, factory, auth?.storePath);
  for (let i = 0; ; i++) {
    try {
      return await attempt(client);
    } catch (err) {
      if (!isAuthError(err) || !config.psid || i > 0) throw err;
      // rebuild + retry once: re-running init absorbs fresh Set-Cookies.
      // (Rotation is deliberately NOT auto-invoked — RotateCookies-issued TS
      // poison gemini's privileged surfaces; see lib/gemini-auth.ts.)
      cached = null;
      client = await getClient(config, factory, auth?.storePath);
    }
  }
}

// ponytail: gemini-reverse polls aren't cancellable — abort/timeout rejects the
// tool call promptly, but the underlying client poll finishes/times out in the
// background (ceiling; real cancellation needs upstream AbortSignal support).
// Shared with lib/imageapi.ts (same abort semantics for plain fetch calls).
export function raceGuard<T>(
  promise: Promise<T>,
  opts: { signal?: AbortSignal; timeoutMs?: number; label: string },
): Promise<T> {
  const { signal, timeoutMs, label } = opts;
  if (!signal && !timeoutMs) return promise;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error(`${label} aborted`);
      err.name = "AbortError";
      reject(err);
    };
    const onTimeout = () => {
      signal?.removeEventListener("abort", onAbort);
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.name = "TimeoutError";
      reject(err);
    };
    if (signal) {
      if (signal.aborted) {
        // Mark the guarded promise handled BEFORE rejecting with AbortError —
        // otherwise a later rejection of the underlying call becomes a fatal
        // process-level unhandledRejection.
        promise.catch(() => {});
        return onAbort();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs) timer = setTimeout(onTimeout, timeoutMs);
    promise.then(
      (v) => {
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Source extraction (parsed web output has no structured citations field —
// URLs are pulled from the answer/report markdown text)
// ---------------------------------------------------------------------------

const MD_LINK_RE = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s<>()\[\]{}"'`]+/g;

export function extractSources(text: string, cap = 30): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const sources: string[] = [];
  const push = (raw: string) => {
    const url = raw.replace(/[.,;:!?)\]]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      sources.push(url);
    }
  };
  for (const m of text.matchAll(MD_LINK_RE)) push(m[1]);
  for (const m of text.matchAll(BARE_URL_RE)) push(m[0]);
  return sources.slice(0, cap);
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

export function describeGeminiError(err: unknown): string {
  switch (errorName(err)) {
    case "AuthError":
      return "Gemini web session expired. Re-copy __Secure-1PSID and __Secure-1PSIDTS from a fresh incognito login to gemini.google.com (F12 → Application → Cookies) into ~/.pi/agent/.env.local, then restart pi. Important: don't use that Google session in your daily browser — an open Gemini tab supersedes the pasted cookie within minutes (verified 2026-09-14).";
    case "DeepResearchError":
      return `Deep Research transport error: ${err instanceof Error ? err.message : String(err)}. The pure-Node client follows the 2026-09-14-validated wire shapes; repeated failures usually mean the session is stale (re-paste the cookie from an incognito login) or the web protocol drifted.`;
    case "UsageLimitExceeded":
      return "Gemini web usage limit reached. Try again later or pick a different model.";
    case "TemporarilyBlocked":
      return "Gemini web temporarily blocked this IP. Wait a while or set GEMINI_WEB_PROXY (e.g. http://host:port).";
    case "ModelInvalid":
      return "Gemini model unavailable for this account. Try another model or drop the model parameter.";
    case "AbortError":
    case "TimeoutError":
      return err instanceof Error ? err.message : String(err);
    default: {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Cannot poll|research_id/.test(msg)) {
        return `Gemini web research polling failed (${msg}). The web protocol's plan/report shape has drifted from the client library — the plan step engaged but the poll could not find its research id. This is a protocol-drift limitation of the embedded gemini-reverse client, not an account-tier gate.`;
      }
      if (/Unknown API error/.test(msg)) {
        return `Gemini web rejected the request (${msg}). The 1184 code is unreliable from this client — it also fires on expired-cookie sessions (verified 2026-09-13). For research mode: Deep Research plan creation has succeeded on a free-tier account via a browser-grade client (2026-09-13), but Gemini itself has also described Deep Research as Pro/Ultra-gated, so the tier requirement is unverified. mode=ask still works.`;
      }
      return `Gemini web error: ${msg}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GeminiAskResult {
  text: string;
  model?: string;
  guest: boolean;
  sources: string[];
}

export async function geminiAsk(
  query: string,
  opts: { config: GeminiWebConfig; model?: string; timeoutMs?: number; signal?: AbortSignal; factory?: GeminiClientFactory },
): Promise<GeminiAskResult> {
  const out = await raceGuard(
    withGeminiClient(
      opts.config,
      (client) => client.ask(query, { temporary: true, ...(opts.model ? { model: opts.model } : {}) }),
      opts.factory,
    ),
    { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 120_000, label: "web_research ask" },
  );
  const text = String(out?.text ?? out?.candidates?.[0]?.text ?? "");
  return { text, model: out?.model, guest: !opts.config.psid, sources: extractSources(text) };
}

export interface GeminiResearchResult {
  text: string;
  title?: string | null;
  eta?: string | null;
  guest: boolean;
  sources: string[];
  /** Set when the cycle ran but the report could not be retrieved (stale session) — text carries the plan/confirm transcript instead. */
  partial?: string;
}

export async function geminiResearch(
  query: string,
  opts: {
    config: GeminiWebConfig;
    timeoutMs?: number;
    signal?: AbortSignal;
    onStatus?: (s: Record<string, unknown>) => void;
    factory?: GeminiClientFactory;
    /** @internal test injection — raw DR transport */
    drHttp?: DrHttp;
  },
): Promise<GeminiResearchResult> {
  if (!opts.config.psid) {
    throw new Error(
      "Deep Research requires GEMINI_WEB_SECURE_1PSID (gemini.google.com cookie) in ~/.pi/agent/.env.local — guest mode does not support it. Tier availability is unverified: free-tier plan creation has succeeded via browser-grade clients, but Gemini has also described Deep Research as Pro/Ultra-gated.",
    );
  }
  const timeoutMs = opts.timeoutMs ?? 600_000;
  // Pure-Node DR client (plan → confirm → poll) — gemini-reverse's research
  // path drifts (1184 / missing research_id, see 0.11.x history).
  const dr = await raceGuard(
    geminiDeepResearch({
      cookie: { psid: opts.config.psid, psidts: resolvePsidts(opts.config.psid, opts.config.psidts) },
      query,
      timeoutMs,
      signal: opts.signal,
      ...(opts.drHttp ? { http: opts.drHttp } : {}),
    }),
    // +5s grace so the DR client's own poll-timeout (better semantics) fires first.
    { signal: opts.signal, timeoutMs: timeoutMs + 5_000, label: "web_research research" },
  );
  return {
    title: dr.title ?? null,
    eta: null,
    text: dr.text || dr.partial || "Deep research completed but returned no report text.",
    guest: false,
    sources: dr.sources,
    partial: dr.partial,
  };
}

// ---------------------------------------------------------------------------
// Image generation (free web tier): prompt → GeneratedImage.save() paths
// ---------------------------------------------------------------------------

export interface GeminiImageResult {
  paths: string[];
  model?: string;
  guest: boolean;
  text: string;
}

export async function geminiGenerateImage(
  prompt: string,
  opts: {
    config: GeminiWebConfig;
    outDir: string;
    model?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    factory?: GeminiClientFactory;
    auth?: { rotatePost?: PostFn; storePath?: string };
  },
): Promise<GeminiImageResult> {
  // Create the dir before generating — a bad out_dir must not waste a
  // generation (same contract as the API path's mkdir).
  fs.mkdirSync(opts.outDir, { recursive: true });
  const out = await raceGuard(
    withGeminiClient(
      opts.config,
      async (client) => {
        if (typeof client.newChat !== "function") {
          throw new Error("gemini-reverse client exposes no newChat (unexpected package shape)");
        }
        const chat = client.newChat(opts.model ? { model: opts.model } : undefined);
        return chat.generateContent({ prompt });
      },
      opts.factory,
      opts.auth,
    ),
    { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 180_000, label: "web_image gemini" },
  );
  // gemini-reverse's ModelOutput always defines generated_images (defaults to
  // []), so only fall back to `images` when it is empty — not when absent.
  const images = out?.generated_images?.length ? out.generated_images : (out?.images ?? []);
  const text = String(out?.text ?? "");
  if (!images.length) {
      throw new Error(
        text
          ? `Gemini replied with text but no images: ${text.slice(0, 200)} — the Gemini web tier gates image generation on browser-grade TLS fingerprints and refuses plain-Node clients (verified 2026-09-14: identical cookie + payload generate via a chrome-impersonating transport). Use provider=zai (ZAI_API_KEY) or provider=custom; pinning provider=gemini will not change this until pi-web ships an impersonating transport.`
          : "Gemini returned no images — generation may be unavailable for this account/region (guest mode may not support it; set GEMINI_WEB_SECURE_1PSID).",
      );
  }
  const paths: string[] = [];
  for (const img of images) paths.push(await img.save({ path: opts.outDir }));
  return { paths, model: out?.model, guest: !opts.config.psid, text };
}
