// Gemini web cookie auto-refresh — keeps a one-time-pasted session alive.
//
// Google rotates __Secure-1PSIDTS on authenticated visits, so a pasted static
// copy dies within minutes-to-hours. Google also ships the rotation endpoint
// Chrome itself calls: POST https://accounts.google.com/RotateCookies issues a
// fresh __Secure-1PSIDTS for the cookie session (works for DBSC-bound and
// unbound sessions today; 401 = session dead server-side). We rotate on a
// 10-min keepalive (Google's declared cadence) and persist the rotated value
// to a 0600 store file so later pi sessions reuse it.
// Sources: HanaokaYuzu/Gemini-API utils/rotate_1psidts.py + constants.py;
// empirical validation in teng-lin/notebooklm-py#345 (+#312).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findEnvValue } from "./config";

const ROTATE_URL = "https://accounts.google.com/RotateCookies";
// jspb sentinel body from Gemini-API — send raw so axios doesn't re-serialize
// (JSON.stringify would rewrite [000,...] to [0,...]).
const ROTATE_BODY = '[000,"-0000000000000000000"]';
// Google declares the next rotation interval as 600s in the response body
// (["identity.hfcr",600]) — used as the default keepalive cadence.
const DEFAULT_ROTATE_INTERVAL_MS = 600_000;
// HanaokaYuzu's anti-429 guard: never rotate more often than once a minute.
const MIN_ROTATE_GAP_MS = 60_000;

export interface CookieStoreEntry {
  psid: string;
  psidts: string;
  updatedAt: number;
}

export interface RotateResult {
  ok: boolean;
  psidts?: string;
  reason?: string;
  /** true when the server itself rejected/returned nothing — the session is dead (store should be cleared). false on transport errors (keep the store). */
  stale?: boolean;
}

export type PostFn = (
  url: string,
  opts: { headers: Record<string, string>; body: string; proxy?: string; timeoutMs: number },
) => Promise<{ status: number; setCookie: string[] }>;

// ---------------------------------------------------------------------------
// Cookie store: single 0600 JSON file, one active session.
// The env-pasted PSID is the session identity; the store only carries freshness.
// ---------------------------------------------------------------------------

export function defaultStorePath(): string {
  return process.env.GEMINI_WEB_COOKIE_STORE || path.join(os.homedir(), ".pi", "agent", "gemini-web-cookies.json");
}

export function loadCookieStore(storePath: string = defaultStorePath()): CookieStoreEntry | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<CookieStoreEntry>;
    if (parsed.psid && parsed.psidts) {
      return { psid: parsed.psid, psidts: parsed.psidts, updatedAt: Number(parsed.updatedAt) || 0 };
    }
  } catch {
    /* missing or corrupt → treated as absent */
  }
  return null;
}

export function saveCookieStore(entry: CookieStoreEntry, storePath: string = defaultStorePath()): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(entry, null, 2));
  fs.chmodSync(storePath, 0o600);
}

export function clearCookieStore(storePath: string = defaultStorePath()): void {
  try {
    fs.unlinkSync(storePath);
  } catch {
    /* already absent */
  }
}

/** Store freshness for web_status — never includes cookie values. */
export function cookieStoreSnapshot(storePath: string = defaultStorePath()): { present: boolean; ageSeconds?: number; path: string } {
  const store = loadCookieStore(storePath);
  return store
    ? { present: true, ageSeconds: Math.max(0, Math.round((Date.now() - store.updatedAt) / 1000)), path: storePath }
    : { present: false, path: storePath };
}

/**
 * The PSIDTS to use: the store's value when it belongs to the same session
 * (psid match), else the env value. A store keyed to an older paste is
 * ignored, so pasting a fresh cookie always wins.
 */
export function resolvePsidts(psid: string | undefined, envPsidts: string | undefined, storePath: string = defaultStorePath()): string | undefined {
  if (!psid) return envPsidts;
  const store = loadCookieStore(storePath);
  return store && store.psid === psid && store.psidts ? store.psidts : envPsidts;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

function parseProxy(str: string): { protocol: string; host: string; port: number } | undefined {
  try {
    const u = new URL(str);
    return { protocol: u.protocol.replace(":", ""), host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) };
  } catch {
    return undefined;
  }
}

async function defaultPost(
  url: string,
  opts: { headers: Record<string, string>; body: string; proxy?: string; timeoutMs: number },
): Promise<{ status: number; setCookie: string[] }> {
  const axios = (await import("axios")).default;
  const res = await axios.post(url, opts.body, {
    headers: opts.headers,
    // Read Set-Cookie off the first response — following redirects drops it
    // (axios only surfaces final-response headers).
    maxRedirects: 0,
    // 401 is a signal to map, not an exception.
    validateStatus: () => true,
    timeout: opts.timeoutMs,
    ...(opts.proxy ? { proxy: parseProxy(opts.proxy) } : {}),
  });
  const raw = res.headers["set-cookie"];
  return { status: res.status, setCookie: Array.isArray(raw) ? raw : raw ? [raw] : [] };
}

function extractSetCookie(setCookie: string[], name: string): string | undefined {
  for (const line of setCookie) {
    const pair = line.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

export async function rotateCookies(opts: {
  psid: string;
  psidts?: string;
  proxy?: string;
  timeoutMs?: number;
  post?: PostFn;
}): Promise<RotateResult> {
  const post = opts.post ?? defaultPost;
  const cookie = opts.psidts ? `__Secure-1PSID=${opts.psid}; __Secure-1PSIDTS=${opts.psidts}` : `__Secure-1PSID=${opts.psid}`;
  try {
    const res = await post(ROTATE_URL, {
      headers: { "Content-Type": "application/json", Origin: "https://accounts.google.com", Cookie: cookie },
      body: ROTATE_BODY,
      proxy: opts.proxy,
      timeoutMs: opts.timeoutMs ?? 15_000,
    });
    const fresh = extractSetCookie(res.setCookie, "__Secure-1PSIDTS");
    if (fresh) return { ok: true, psidts: fresh };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, stale: true, reason: `unauthorized (${res.status}) — session expired server-side` };
    }
    return { ok: false, stale: true, reason: `no new __Secure-1PSIDTS in response (status ${res.status})` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Rotate once with store-first resolution and persist the outcome.
 * Clears the store only when the server itself says the session is dead,
 * so a stale store never shadows a future fresh paste (and a transient
 * network error never wipes a good one).
 */
export async function refreshGeminiAuth(
  cfg: { psid?: string; psidts?: string; proxy?: string },
  opts: { post?: PostFn; storePath?: string } = {},
): Promise<RotateResult & { store: string }> {
  const storePath = opts.storePath ?? defaultStorePath();
  if (!cfg.psid) return { ok: false, reason: "GEMINI_WEB_SECURE_1PSID not set — nothing to rotate", store: storePath };
  const result = await rotateCookies({ psid: cfg.psid, psidts: resolvePsidts(cfg.psid, cfg.psidts, storePath), proxy: cfg.proxy, post: opts.post });
  if (result.ok && result.psidts) {
    saveCookieStore({ psid: cfg.psid, psidts: result.psidts, updatedAt: Date.now() }, storePath);
  } else if (result.stale) {
    // Clear only our own dead entry — never another session's store.
    const store = loadCookieStore(storePath);
    if (!store || store.psid === cfg.psid) clearCookieStore(storePath);
  }
  return { ...result, store: storePath };
}

// ---------------------------------------------------------------------------
// Keepalive: one rotation tick + the lazy background timer.
// ---------------------------------------------------------------------------

/** One tick: skip when the store is fresh, else rotate+persist. Returns store freshness. */
export async function keepaliveOnce(
  cfg: { psid?: string; psidts?: string; proxy?: string },
  opts: { post?: PostFn; storePath?: string } = {},
): Promise<boolean> {
  if (!cfg.psid) return false;
  const storePath = opts.storePath ?? defaultStorePath();
  const store = loadCookieStore(storePath);
  if (store && Date.now() - store.updatedAt < MIN_ROTATE_GAP_MS) return true;
  return (await refreshGeminiAuth(cfg, opts)).ok;
}

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let keepalivePsid: string | undefined;

/** Arms the background rotation timer (10-min cadence). No-op for guest mode, when disabled, or when already armed for this session. */
export function ensureKeepalive(cfg: { psid?: string; psidts?: string; proxy?: string }): void {
  if (!cfg.psid) return;
  if (keepaliveTimer && keepalivePsid === cfg.psid) return;
  stopKeepalive();
  if (findEnvValue("GEMINI_WEB_KEEPALIVE").value === "0") return;
  const parsed = Number(findEnvValue("GEMINI_WEB_ROTATE_INTERVAL_MS").value);
  const intervalMs = Number.isFinite(parsed) && parsed >= MIN_ROTATE_GAP_MS ? parsed : DEFAULT_ROTATE_INTERVAL_MS;
  keepalivePsid = cfg.psid;
  keepaliveTimer = setInterval(() => {
    void keepaliveOnce(cfg).catch(() => {});
  }, intervalMs);
  keepaliveTimer.unref?.();
}

export function stopKeepalive(): void {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
  keepalivePsid = undefined;
}
