// Gemini web-tier (gemini.google.com) research backend, cookie-authed via the
// __Secure-1PSID cookie. Thin wrapper over the `gemini-reverse` npm package
// (CJS), lazily dynamic-imported so pi startup pays zero cost when unused.

import http from "node:http";
import https from "node:https";
import { urlToHttpOptions } from "node:url";
import { findEnvValue } from "./config";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GeminiWebConfig {
  psid?: string;
  psidSource: string;
  proxy?: string;
}

export function loadGeminiWebConfig(cwd = process.cwd(), includeCwdEnv = false): GeminiWebConfig {
  const psid = findEnvValue("GEMINI_WEB_SECURE_1PSID", cwd, includeCwdEnv);
  const proxy = findEnvValue("GEMINI_WEB_PROXY", cwd, includeCwdEnv);
  return { psid: psid.value, psidSource: psid.value ? psid.source : "not set", proxy: proxy.value };
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

export interface GeminiClientLike {
  ask(prompt: string, opts?: Record<string, unknown>): Promise<GeminiOutputLike>;
  research(
    prompt: string,
    opts?: { wait?: boolean; pollInterval?: number; timeout?: number; onStatus?: (s: Record<string, unknown>) => void },
  ): Promise<GeminiResearchLike>;
}

export type GeminiClientFactory = (
  opts: { secure_1psid?: string; proxy?: string },
) => GeminiClientLike | Promise<GeminiClientLike>;

// Cached per config (psid|proxy) so a config change re-creates the client.
let cached: { key: string; client: GeminiClientLike } | null = null;

// Google ships ~25KB of response headers on every Gemini page (a 19.7KB
// content-security-policy + 3.9KB reporting-endpoints) — over Node's default
// 16KB parser cap, so the http parser rejects them (HPE_HEADER_OVERFLOW; the
// same cap exists in undici, but gemini-reverse uses axios's node http adapter).
// Node honors a per-request maxHeaderSize override, but axios doesn't forward
// it — so lazily patch http.request/https.request to inject it for
// gemini.google.com hosts only.
// ponytail: process-wide patch, scoped to one hostname; if it ever misbehaves,
// revert to launching pi with NODE_OPTIONS=--max-http-header-size=262144.

/**
 * Returns the request options to pass through with the cap injected when the
 * target host is gemini.google.com, or null when the call must pass through
 * untouched. Normalizes all http.request input forms (options object, string,
 * URL) — string/URL forms become a fresh options object.
 *
 * @internal exported for tests
 */
export function injectGeminiHeaderCap(options: unknown): Record<string, unknown> | null {
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
  return opts;
}

let headerCapPatched = false;
function patchHeaderCap(): void {
  if (headerCapPatched) return;
  headerCapPatched = true;
  for (const mod of [http, https]) {
    const real = mod.request as unknown as (...args: unknown[]) => unknown;
    const patched = function (this: unknown, options: unknown, ...rest: unknown[]) {
      try {
        const override = injectGeminiHeaderCap(options);
        if (override) return real.call(this, override, ...rest);
      } catch { /* malformed input — let the real request surface the error */ }
      return real.call(this, options, ...rest);
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
  return (opts) => new Gemini({ secure_1psid: opts.secure_1psid, proxy: opts.proxy ?? null, timeout: 1_800_000 });
}

async function getClient(config: GeminiWebConfig, factory?: GeminiClientFactory): Promise<GeminiClientLike> {
  const key = `${config.psid ?? ""}|${config.proxy ?? ""}`;
  if (cached?.key === key) return cached.client;
  const make = factory ?? (await loadDefaultFactory());
  const client = await make({ secure_1psid: config.psid, proxy: config.proxy });
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

// One AuthError retry: re-creating the client re-runs init, which absorbs the
// rotated Set-Cookies (incl. __Secure-1PSIDTS) Google hands back.
export async function withGeminiClient<T>(
  config: GeminiWebConfig,
  run: (client: GeminiClientLike) => Promise<T>,
  factory?: GeminiClientFactory,
): Promise<T> {
  try {
    return await run(await getClient(config, factory));
  } catch (err) {
    if (isAuthError(err) && config.psid) {
      cached = null;
      return run(await getClient(config, factory));
    }
    throw err;
  }
}

// ponytail: gemini-reverse polls aren't cancellable — abort/timeout rejects the
// tool call promptly, but the underlying client poll finishes/times out in the
// background (ceiling; real cancellation needs upstream AbortSignal support).
function raceGuard<T>(
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
      if (signal.aborted) return onAbort();
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
      return "Gemini web cookie expired or invalid. Re-copy __Secure-1PSID from gemini.google.com (F12 → Application → Cookies) into GEMINI_WEB_SECURE_1PSID in ~/.pi/agent/.env.local, then restart pi.";
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
      if (/Unknown API error/.test(msg)) {
        return `Gemini web rejected the request (${msg}). In research mode this usually means the account lacks a Gemini Advanced subscription (Deep Research is Advanced-only) or the web protocol changed. mode=ask still works.`;
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
}

export async function geminiResearch(
  query: string,
  opts: {
    config: GeminiWebConfig;
    timeoutMs?: number;
    signal?: AbortSignal;
    onStatus?: (s: Record<string, unknown>) => void;
    factory?: GeminiClientFactory;
  },
): Promise<GeminiResearchResult> {
  if (!opts.config.psid) {
    throw new Error(
      "Deep Research requires GEMINI_WEB_SECURE_1PSID (gemini.google.com cookie) in ~/.pi/agent/.env.local — guest mode does not support it. Deep Research also needs a Gemini Advanced subscription on the account.",
    );
  }
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const result = await raceGuard(
    withGeminiClient(
      opts.config,
      (client) =>
        client.research(query, {
          wait: true,
          pollInterval: 10_000,
          timeout: timeoutMs,
          ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
        }),
      opts.factory,
    ),
    // +5s grace so the client's own poll-timeout (better semantics) fires first.
    { signal: opts.signal, timeoutMs: timeoutMs + 5_000, label: "web_research research" },
  );
  const text = String(result?.text ?? "");
  return {
    text,
    title: result?.plan?.title ?? null,
    eta: result?.plan?.eta_text ?? null,
    guest: false,
    sources: extractSources(text),
  };
}
