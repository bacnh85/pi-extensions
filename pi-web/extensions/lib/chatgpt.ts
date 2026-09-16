// Direct ChatGPT web-tier client — chat + image generation via the Codex
// backend surface (POST https://chatgpt.com/backend-api/codex/responses), the
// same endpoint pi's openai-codex provider and the Codex CLI use on a ChatGPT
// subscription. The literal web UI (chatgpt.com + /images/) is Cloudflare-
// Turnstile-gated and unreachable headless; this surface is plain Bearer-
// tokened SSE (pi's own provider proves the minimal headers: Authorization +
// chatgpt-account-id; originator/UA are free-form). Image generation uses the
// `image_generation` Responses tool — the same gpt-image family as the Images
// UI — and bills the metered Codex-usage bucket.
//
// Auth: CHATGPT_WEB_AUTH_KEY (the OAuth JSON written by `codex login`, or a
// bare access-token JWT), then CHATGPT_WEB_CODEX_AUTH / ~/.codex/auth.json,
// then Pi auth.json `openai-codex`. Expired tokens auto-refresh via
// auth.openai.com and persist back to the source file (codex file) or the
// pi-web store (env/pi-sourced).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { findEnvValue } from "./config";
import { raceGuard } from "./gemini";
import { writeImageFile } from "./imageapi";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Codex CLI's published public client id (chatgpt-imagegen reference; pi uses
// the same OAuth flow server-side).
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const CHATGPT_CHAT_DEFAULT_MODEL = "gpt-5.5";
// Fast/affordable image driver — burning a frontier coding model on the
// driver turn wastes the metered bucket (chatgpt-imagegen 0.25 rationale).
export const CHATGPT_IMAGE_DRIVER_DEFAULT_MODEL = "gpt-5.6-luna";
export const CHATGPT_MODEL_FALLBACK = "gpt-5.5";
// Image runs take 2-3 min and the stream can sit silent ~66s mid-generation.
const DEFAULT_STALL_MS = 120_000;

const IMAGE_INSTRUCTION = "You are an image generation assistant.";
const CHAT_INSTRUCTION_FALLBACK = "You are a helpful assistant.";

// ---------------------------------------------------------------------------
// Auth credential
// ---------------------------------------------------------------------------

export interface ChatGptAuth {
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  /** epoch ms, from the JWT `exp` claim when present */
  expiresAt?: number;
  /** plan/email parsed from JWT claims — for web_status only */
  plan?: string;
  email?: string;
  source: string;
  /** how to persist a rotated refresh token */
  sourceKind: "env" | "codex-file" | "pi";
}

export interface ChatGptAuthResolution {
  auth: ChatGptAuth | null;
  /** set when CHATGPT_WEB_AUTH_KEY is present but unusable */
  problem?: string;
}

function persistRefreshed(refreshed: ChatGptAuth, storePath: string, prevRefreshToken?: string): void {
  // Best-effort: a failed persist must not waste the freshly-refreshed token
  // (the in-flight call still succeeds; the next session re-authenticates).
  try {
    if (refreshed.sourceKind === "codex-file") {
      // codex-login file: rewrite in place, preserving unrelated fields.
      const original = JSON.parse(fs.readFileSync(refreshed.source, "utf8")) as Record<string, any>;
      const tokens = (original.tokens = (original.tokens && typeof original.tokens === "object" ? original.tokens : {}) as Record<string, any>);
      tokens.access_token = refreshed.accessToken;
      if (refreshed.refreshToken) tokens.refresh_token = refreshed.refreshToken;
      if (refreshed.accountId) tokens.account_id = refreshed.accountId;
      original.last_refresh = new Date().toISOString();
      fs.mkdirSync(path.dirname(refreshed.source), { recursive: true });
      const tmp = `${refreshed.source}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(original, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, refreshed.source);
      fs.chmodSync(refreshed.source, 0o600);
    } else {
      saveAuthStore(
        {
          refreshKey: refreshKey(refreshed.refreshToken!),
          // the caller's pre-rotation token — the next session's env/pi source
          // still holds it, and the store must be findable from it
          ...(prevRefreshToken ? { prevRefreshKey: refreshKey(prevRefreshToken) } : {}),
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken!,
          ...(refreshed.accountId ? { accountId: refreshed.accountId } : {}),
          ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
          updatedAt: Date.now(),
        },
        storePath,
      );
    }
  } catch {
    /* persist is an optimization — see header comment */
  }
}

function decodeJwtPayload(token: string): Record<string, any> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, any>;
  } catch {
    return undefined;
  }
}

function claimsToAuth(accessToken: string): Pick<ChatGptAuth, "accountId" | "expiresAt" | "plan" | "email"> {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return {};
  const authClaim = claims["https://api.openai.com/auth"] ?? {};
  const profile = claims["https://api.openai.com/profile"] ?? {};
  return {
    ...(typeof authClaim.chatgpt_account_id === "string" ? { accountId: authClaim.chatgpt_account_id } : {}),
    ...(typeof claims.exp === "number" ? { expiresAt: claims.exp * 1000 } : {}),
    ...(typeof authClaim.chatgpt_plan_type === "string" ? { plan: authClaim.chatgpt_plan_type } : {}),
    ...(typeof profile.email === "string" ? { email: profile.email } : {}),
  };
}

type RawCreds = { accessToken?: string; refreshToken?: string; accountId?: string };

function fromRaw(creds: RawCreds, source: string, sourceKind: ChatGptAuth["sourceKind"]): ChatGptAuth | null {
  if (!creds.accessToken) return null;
  const claims = claimsToAuth(creds.accessToken);
  return {
    accessToken: creds.accessToken,
    source,
    sourceKind,
    ...claims,
    ...(creds.refreshToken ? { refreshToken: creds.refreshToken } : {}),
    ...(creds.accountId && !claims.accountId ? { accountId: creds.accountId } : {}),
  };
}

/** CHATGPT_WEB_AUTH_KEY value: OAuth JSON (codex-login `tokens` block or flat)
 *  or a bare JWT. Bridge-era opaque hex keys parse as null — reported, not fatal. */
function parseAuthValue(value: string): RawCreds | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, any>;
      const tokens = (parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : parsed) as Record<string, any>;
      const accessToken = tokens.access_token ?? tokens.accessToken ?? tokens.access;
      if (typeof accessToken === "string" && accessToken) {
        return {
          accessToken,
          refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : typeof tokens.refresh === "string" ? tokens.refresh : undefined,
          accountId: typeof tokens.account_id === "string" ? tokens.account_id : typeof tokens.accountId === "string" ? tokens.accountId : undefined,
        };
      }
    } catch {
      /* fall through */
    }
    return null;
  }
  if (trimmed.startsWith("eyJ")) return { accessToken: trimmed };
  return null;
}

function readCodexAuthFile(file: string): RawCreds | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    const tokens = parsed.tokens;
    if (tokens && typeof tokens === "object") {
      const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : undefined;
      if (accessToken) {
        return {
          accessToken,
          refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined,
          accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
        };
      }
    }
  } catch {
    /* missing/corrupt → treated as absent */
  }
  return null;
}

function readPiAuthEntry(piAuthPath: string): RawCreds | null {
  // Pi stores the openai-codex OAuth login as {type, access, refresh, expires,
  // accountId} (pi-sub reads the same shape). Read-only — pi owns this file.
  try {
    const parsed = JSON.parse(fs.readFileSync(piAuthPath, "utf8")) as Record<string, any>;
    const entry = parsed["openai-codex"];
    if (entry && typeof entry === "object" && typeof entry.access === "string") {
      return {
        accessToken: entry.access,
        refreshToken: typeof entry.refresh === "string" ? entry.refresh : undefined,
        accountId: typeof entry.accountId === "string" ? entry.accountId : undefined,
      };
    }
  } catch {
    /* missing → treated as absent */
  }
  return null;
}

export interface LoadChatGptAuthOptions {
  codexAuthPath?: string;
  piAuthPath?: string;
  storePath?: string;
}

function piAuthDefaultPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(dir, "auth.json");
}

export function loadChatGptAuth(cwd = process.cwd(), includeCwdEnv = false, opts: LoadChatGptAuthOptions = {}): ChatGptAuthResolution {
  const env = findEnvValue("CHATGPT_WEB_AUTH_KEY", cwd, includeCwdEnv);
  let auth: ChatGptAuth | null = null;
  let problem: string | undefined;
  if (env.value) {
    const parsed = parseAuthValue(env.value);
    if (parsed) {
      auth = fromRaw(parsed, env.source, "env");
    } else {
      problem = "CHATGPT_WEB_AUTH_KEY is set but is not an OpenAI OAuth token (expected the JSON from `codex login` ~/.codex/auth.json, or a bare eyJ… access-token JWT) — opaque bridge/API keys are rejected by chatgpt.com";
    }
  }
  if (!auth) {
    const codexPath = opts.codexAuthPath ?? findEnvValue("CHATGPT_WEB_CODEX_AUTH", cwd, includeCwdEnv).value ?? path.join(os.homedir(), ".codex", "auth.json");
    auth = fromRaw(readCodexAuthFile(codexPath) ?? {}, codexPath, "codex-file");
  }
  if (!auth) {
    const piPath = opts.piAuthPath ?? piAuthDefaultPath();
    auth = fromRaw(readPiAuthEntry(piPath) ?? {}, `${piPath} (openai-codex)`, "pi");
  }
  if (!auth) {
    return { auth: null, ...(problem ? { problem } : {}) };
  }
  // A rotated refresh may live in our store when the loaded access token is
  // stale (env/paste sources can't be rewritten in place). Match the current
  // refresh token OR the pre-rotation one the store replaced.
  if (auth.refreshToken || auth.accountId) {
    const stored = loadAuthStore(opts.storePath);
    const key = auth.refreshToken ? refreshKey(auth.refreshToken) : undefined;
    const match = stored && ((key !== undefined && (stored.refreshKey === key || stored.prevRefreshKey === key)) || (!auth.refreshToken && auth.accountId && stored.accountId === auth.accountId));
    if (match && stored && (!auth.expiresAt || auth.expiresAt <= Date.now() + 30_000) && stored.expiresAt && stored.expiresAt > Date.now() + 30_000) {
      return { auth: { ...auth, accessToken: stored.accessToken, refreshToken: stored.refreshToken, expiresAt: stored.expiresAt } };
    }
  }
  return { auth };
}

// ---------------------------------------------------------------------------
// Token store (env/pi-sourced refreshes can't be written back in place) —
// single 0600 JSON file, gemini-web-cookie-store pattern.
// ---------------------------------------------------------------------------

interface AuthStoreEntry {
  refreshKey: string;
  /** hash of the PRE-rotation refresh token — the next session still holds
   *  the old token in its env/pi source, so matching must accept it too */
  prevRefreshKey?: string;
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  expiresAt?: number;
  updatedAt: number;
}

export function defaultChatGptAuthStorePath(): string {
  // This path decides where a rotated OAuth refresh token (a full account
  // credential) is written — an untrusted project's .env.local must never
  // influence it. cwd env files are excluded; process.env + pi-global
  // .env.local still apply (findEnvValue with includeCwd=false).
  return findEnvValue("CHATGPT_WEB_AUTH_STORE", process.cwd(), false).value || path.join(os.homedir(), ".pi", "agent", "chatgpt-web-auth.json");
}

const refreshKey = (refreshToken: string) => createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);

function loadAuthStore(storePath = defaultChatGptAuthStorePath()): AuthStoreEntry | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<AuthStoreEntry>;
    if (parsed.refreshKey && parsed.accessToken && parsed.refreshToken) return parsed as AuthStoreEntry;
  } catch {
    /* absent/corrupt */
  }
  return null;
}

function saveAuthStore(entry: AuthStoreEntry, storePath: string): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  // write-then-rename so concurrent readers never see a partial store.
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath);
  fs.chmodSync(storePath, 0o600);
}

// ---------------------------------------------------------------------------
// Refresh (single-flight per refresh token)
// ---------------------------------------------------------------------------

export class ChatGptAuthError extends Error {}
export class ChatGptApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let inFlightRefresh: { key: string; promise: Promise<ChatGptAuth> } | null = null;

/** @internal test hook — clears module-level single-flight state */
export function __resetChatGptAuthState(): void {
  inFlightRefresh = null;
}

const expired = (auth: ChatGptAuth) => auth.expiresAt !== undefined && auth.expiresAt <= Date.now() + 30_000;

async function defaultRefreshFetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { status: res.status, text: await res.text() };
}

/** Refresh the access token via auth.openai.com. Persisted: back to the codex
 *  auth file when that's the source (tokens are rotated — the old refresh
 *  token dies), to the pi-web store for env/pi sources (pi's auth.json is
 *  never written by us — pi owns it). */
export async function refreshChatGptAuth(
  auth: ChatGptAuth,
  opts: { storePath?: string; refreshFetch?: typeof defaultRefreshFetch } = {},
): Promise<ChatGptAuth> {
  if (!auth.refreshToken) {
    throw new ChatGptAuthError(
      "ChatGPT access token expired and no refresh token is available — run `codex login` and either rely on ~/.codex/auth.json or paste its tokens JSON into CHATGPT_WEB_AUTH_KEY",
    );
  }
  const key = refreshKey(auth.refreshToken);
  if (inFlightRefresh?.key === key) return inFlightRefresh.promise;
  const promise = (async (): Promise<ChatGptAuth> => {
    const refreshFetch = opts.refreshFetch ?? defaultRefreshFetch;
    const res = await refreshFetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, grant_type: "refresh_token", refresh_token: auth.refreshToken!, scope: "openid profile email" }).toString(),
    });
    let payload: Record<string, any> | null = null;
    try {
      payload = JSON.parse(res.text) as Record<string, any>;
    } catch {
      /* non-JSON error body */
    }
    if (res.status !== 200 || typeof payload?.access_token !== "string") {
      const oauthErr = typeof payload?.error === "string" ? payload.error : "";
      if (oauthErr === "invalid_grant") {
        throw new ChatGptAuthError("ChatGPT refresh token was rejected (invalid_grant) — run `codex login` again (or re-paste a fresh CHATGPT_WEB_AUTH_KEY)");
      }
      throw new ChatGptApiError(res.status, `ChatGPT token refresh failed (HTTP ${res.status}${oauthErr ? ` ${oauthErr}` : ""})`);
    }
    const refreshed: ChatGptAuth = {
      accessToken: payload.access_token,
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : auth.refreshToken,
      source: auth.source,
      sourceKind: auth.sourceKind,
      ...claimsToAuth(payload.access_token),
      ...(auth.accountId && !claimsToAuth(payload.access_token).accountId ? { accountId: auth.accountId } : {}),
      ...(auth.plan && !claimsToAuth(payload.access_token).plan ? { plan: auth.plan } : {}),
    };
    persistRefreshed(refreshed, opts.storePath ?? defaultChatGptAuthStorePath(), auth.refreshToken);
    return refreshed;
  })();
  inFlightRefresh = { key, promise };
  try {
    return await promise;
  } finally {
    if (inFlightRefresh?.key === key) inFlightRefresh = null;
  }
}

// ---------------------------------------------------------------------------
// SSE client
// ---------------------------------------------------------------------------

export interface SSEFetchLike {
  (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<{
    ok: boolean;
    status: number;
    statusText?: string;
    json?(): Promise<unknown>;
    text?(): Promise<string>;
    body?: AsyncIterable<Uint8Array> | null;
  }>;
}

export interface ChatGptUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface SseResult {
  text: string;
  images: string[];
  usage?: ChatGptUsage;
  effectiveImageTool?: Record<string, unknown>;
  failureDetail?: string;
  eventTypes: Record<string, number>;
}

function buildHeaders(auth: ChatGptAuth): Record<string, string> {
  const sid = randomUUID();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    // pi's own openai-codex provider proves originator/UA are free-form.
    originator: "pi-web",
    "User-Agent": "pi-web (@bacnh85/pi-web)",
    "session-id": sid,
    "x-client-request-id": sid,
    ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
  };
}

async function postResponses(opts: {
  auth: ChatGptAuth;
  body: Record<string, unknown>;
  timeoutMs: number;
  stallMs?: number;
  signal?: AbortSignal;
  fetchImpl?: SSEFetchLike;
  /** image calls: phrase the no-output error around the missing image */
  imageMode?: boolean;
}): Promise<SseResult> {
  const fetchImpl = opts.fetchImpl ?? (fetch as SSEFetchLike);
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const deadline = Date.now() + opts.timeoutMs;

  // Activity-reset watchdog: aborts on SSE silence (a live generation can sit
  // quiet ~66s) and on the total budget. The caller's abort signal wins too.
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  let lastChunkAt = Date.now();
  let abortReason: "stall" | "deadline" | "outer" | null = opts.signal?.aborted ? "outer" : null;
  const watchdog = setInterval(() => {
    if (abortReason) return;
    if (opts.signal?.aborted) abortReason = "outer";
    else if (Date.now() > deadline) abortReason = "deadline";
    else if (Date.now() - lastChunkAt > stallMs) abortReason = "stall";
    if (abortReason) controller.abort();
  }, 1_000);

  const result: SseResult = { text: "", images: [], eventTypes: {} };
  let dataBuf: string[] = [];
  const dispatch = (payload: string): boolean => {
    // returns false on [DONE]
    if (payload === "[DONE]") return false;
    let evt: Record<string, any>;
    try {
      evt = JSON.parse(payload) as Record<string, any>;
    } catch {
      return true; // malformed event — skip, keep the stream alive
    }
    const type = typeof evt.type === "string" ? evt.type : "?";
    result.eventTypes[type] = (result.eventTypes[type] ?? 0) + 1;
    if (type === "response.output_text.delta" && typeof evt.delta === "string") {
      result.text += evt.delta;
    } else if (type === "response.output_item.done" && evt.item && typeof evt.item === "object") {
      const item = evt.item as Record<string, any>;
      if (item.type === "image_generation_call" && typeof item.result === "string") result.images.push(item.result);
    } else if (type === "response.created" || type === "response.completed") {
      const resp = evt.response as Record<string, any> | undefined;
      if (resp && typeof resp === "object") {
        const usage = resp.usage as Record<string, any> | undefined;
        if (usage && typeof usage === "object") {
          result.usage = {
            ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
            ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
            ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
          };
        }
        const tools = Array.isArray(resp.tools) ? resp.tools : [];
        const imgTool = tools.find((t: any) => t && typeof t === "object" && t.type === "image_generation");
        if (imgTool) result.effectiveImageTool = imgTool as Record<string, unknown>;
        if (!result.text && Array.isArray(resp.output)) {
          // completed-output fallback when no deltas arrived
          for (const out of resp.output) {
            if (out && typeof out === "object" && (out as any).type === "message") {
              for (const part of (out as any).content ?? []) {
                if (part && typeof part === "object" && part.type === "output_text" && typeof part.text === "string") result.text += part.text;
              }
            }
          }
        }
      }
    } else if (type === "error" || type === "response.failed") {
      const detail =
        (evt.response && typeof evt.response === "object" && evt.response.error && typeof evt.response.error === "object" && (evt.response.error.message ?? evt.response.error.code)) ??
        (evt.error && typeof evt.error === "object" ? evt.error.message : undefined) ??
        (typeof evt.error === "string" ? evt.error : undefined) ??
        evt.message ??
        evt.code;
      if (detail !== undefined && detail !== null) result.failureDetail = String(detail);
    }
    return true;
  };

  try {
    const res = await raceGuard(
      fetchImpl(CODEX_RESPONSES_URL, { method: "POST", headers: buildHeaders(opts.auth), body: JSON.stringify(opts.body), signal: controller.signal }),
      { signal: opts.signal, timeoutMs: Math.min(30_000, opts.timeoutMs), label: "web_chatgpt connect" },
    );
    if (!res.ok) {
      const text = res.text ? await res.text().catch(() => "") : "";
      let msg = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as Record<string, any>;
        msg = String(parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? msg);
      } catch {
        /* non-JSON body */
      }
      throw new ChatGptApiError(res.status, msg || res.statusText || `HTTP ${res.status}`);
    }
    if (!res.body) throw new ChatGptApiError(res.status ?? 0, "chatgpt.com returned no response stream");
    try {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        if (abortReason === "outer") break;
        lastChunkAt = Date.now();
        buf += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            dataBuf.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
          } else if (line === "") {
            if (dataBuf.length) {
              const payload = dataBuf.join("\n");
              dataBuf = [];
              if (!dispatch(payload)) {
                buf = "";
                abortReason = "outer"; // [DONE] — stop reading
                break;
              }
            }
          } // comments / event:/id:/retry: ignored — the payload carries "type"
        }
        if (abortReason === "outer" && result.eventTypes["response.completed"]) break;
      }
    } catch (err) {
      if (opts.signal?.aborted || abortReason === "outer") {
        if (opts.signal?.aborted) throw err; // genuine cancellation — preserve
        // [DONE]-initiated stop lands here on some fakes — ignore
        if (!result.eventTypes["response.completed"] && !result.images.length && !result.text && !result.failureDetail) throw err;
      } else if (abortReason === "stall") {
        throw new ChatGptApiError(0, `chatgpt.com sent no SSE data for ~${Math.round(stallMs / 1000)}s — the run stalled (image generation can take 2-3 min; retry or raise the timeout)`);
      } else if (abortReason === "deadline") {
        throw new ChatGptApiError(0, `chatgpt.com stream exceeded the ${Math.round(opts.timeoutMs / 1000)}s total budget`);
      } else {
        throw err;
      }
    }
  } finally {
    clearInterval(watchdog);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }

  if (!result.images.length && !result.text) {
    const seen = Object.keys(result.eventTypes).sort().join(", ") || "(none)";
    if (opts.imageMode) {
      throw new ChatGptApiError(502, `no image returned${result.failureDetail ? ` — ${result.failureDetail}` : ""} (events: ${seen})`);
    }
    if (result.failureDetail) throw new ChatGptApiError(502, `chatgpt.com failed mid-generation: ${result.failureDetail} (events: ${seen})`);
    throw new ChatGptApiError(502, `chatgpt.com returned no usable output (events: ${seen})`);
  }
  return result;
}

/** One API call with the standard expired-token + 401/403 refresh-retry-once. */
async function withAuthRetry<T>(
  auth: ChatGptAuth,
  opts: { storePath?: string; refreshFetch?: typeof defaultRefreshFetch },
  fn: (a: ChatGptAuth) => Promise<T>,
): Promise<T> {
  let current = auth;
  if (expired(current) && current.refreshToken) current = await refreshChatGptAuth(current, opts);
  try {
    return await fn(current);
  } catch (err) {
    if (err instanceof ChatGptApiError && (err.status === 401 || err.status === 403)) {
      if (!current.refreshToken) {
        throw new ChatGptAuthError(
          `chatgpt.com rejected the access token (HTTP ${err.status}) and no refresh token is available — run \`codex login\` and let pi-web read ~/.codex/auth.json (or paste its tokens JSON into CHATGPT_WEB_AUTH_KEY)`,
        );
      }
      const fresh = await refreshChatGptAuth(current, opts);
      return fn(fresh);
    }
    throw err;
  }
}

export function describeChatGptError(err: unknown): string {
  if (err instanceof ChatGptAuthError) return err.message;
  if (err instanceof ChatGptApiError) {
    if (err.status === 401 || err.status === 403) return `chatgpt.com rejected the OAuth token (HTTP ${err.status}): ${err.message} — run \`codex login\` (or re-paste CHATGPT_WEB_AUTH_KEY)`;
    if (err.status === 404 && /codex/i.test(err.message)) return `chatgpt.com has no Codex backend access for this account (HTTP 404) — the codex/responses surface needs a Codex-enabled ChatGPT account: ${err.message}`;
    if (err.status === 429) return `ChatGPT usage limit reached (HTTP 429): ${err.message}`;
    if (err.status >= 500) return `chatgpt.com server error (HTTP ${err.status}): ${err.message}`;
    return `chatgpt.com error (HTTP ${err.status}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Chat (one-off completion)
// ---------------------------------------------------------------------------

export interface ChatGptChatOptions {
  auth: ChatGptAuth;
  prompt: string;
  system?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: SSEFetchLike;
  /** project-cwd env gating for CHATGPT_WEB_MODEL (from index.ts ctx) */
  cwd?: string;
  includeCwdEnv?: boolean;
  /** @internal test hooks */
  storePath?: string;
  refreshFetch?: typeof defaultRefreshFetch;
}

export interface ChatGptChatResult {
  text: string;
  model?: string;
  usage?: ChatGptUsage;
}

function chatBody(opts: ChatGptChatOptions, model: string): Record<string, unknown> {
  return {
    model,
    store: false,
    stream: true,
    // pi's openai-codex provider sends its full system prompt here — arbitrary
    // instructions are accepted (the "allowlist" applies to image runs).
    instructions: opts.system?.trim() || CHAT_INSTRUCTION_FALLBACK,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: opts.prompt }] }],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "low", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
  };
}

async function chatOnce(auth: ChatGptAuth, opts: ChatGptChatOptions, model: string): Promise<ChatGptChatResult> {
  const result = await postResponses({ auth, body: chatBody(opts, model), timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal, fetchImpl: opts.fetchImpl });
  if (!result.text.trim()) throw new ChatGptApiError(502, `chatgpt.com returned an empty completion (model ${model})`);
  return { text: result.text, model, ...(result.usage ? { usage: result.usage } : {}) };
}

export async function chatgptWebChat(opts: ChatGptChatOptions): Promise<ChatGptChatResult> {
  // The model override is not secret-bearing but follows the same trust
  // gating as every other env lookup — untrusted project cwd stays out.
  const model = opts.model?.trim() || findEnvValue("CHATGPT_WEB_MODEL", opts.cwd, opts.includeCwdEnv ?? false).value?.trim() || CHATGPT_CHAT_DEFAULT_MODEL;
  return withAuthRetry(opts.auth, opts, async (auth) => {
    try {
      return await chatOnce(auth, opts, model);
    } catch (err) {
      const unknownModel = err instanceof ChatGptApiError && /unknown model|invalid model|does not exist|not a valid model/i.test(err.message);
      if (unknownModel && model !== CHATGPT_MODEL_FALLBACK) return chatOnce(auth, opts, CHATGPT_MODEL_FALLBACK);
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// Image generation (image_generation tool → base64 PNG)
// ---------------------------------------------------------------------------

export interface ChatGptImageOptions {
  auth: ChatGptAuth;
  prompt: string;
  size?: string;
  /** driver model — keep cheap; the image model itself is server-side */
  model?: string;
  outDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: SSEFetchLike;
  /** @internal test hooks */
  storePath?: string;
  refreshFetch?: typeof defaultRefreshFetch;
}

export interface ChatGptImageResult {
  paths: string[];
  model?: string;
  usage?: ChatGptUsage;
  /** set when the server rewrote the requested image knobs */
  note?: string;
}

function imageBody(opts: ChatGptImageOptions, model: string): Record<string, unknown> {
  const size = opts.size?.trim() && opts.size.trim() !== "auto" ? opts.size.trim() : undefined;
  const text =
    `Use the image_generation tool to render the following. Request: ${opts.prompt}. Output format: png.` +
    (size ? ` Size: ${size}.` : "") +
    " Do not include explanatory text — produce only the image.";
  return {
    model,
    store: false,
    stream: true,
    instructions: IMAGE_INSTRUCTION,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
    tools: [{ type: "image_generation", output_format: "png", ...(size ? { size } : {}) }],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "low", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
  };
}

function imageNote(result: SseResult, requested: { model: string; size?: string }): string | undefined {
  const tool = result.effectiveImageTool;
  if (!tool) return undefined;
  const diffs: string[] = [];
  if (typeof tool.model === "string" && tool.model && tool.model !== requested.model) diffs.push(`model→${tool.model}`);
  if (typeof tool.size === "string" && tool.size && requested.size && tool.size !== requested.size) diffs.push(`size→${tool.size}`);
  return diffs.length ? `chatgpt.com rewrote image params: ${diffs.join(", ")}` : undefined;
}

export async function chatgptWebGenerateImage(opts: ChatGptImageOptions): Promise<ChatGptImageResult> {
  const model = opts.model?.trim() || CHATGPT_IMAGE_DRIVER_DEFAULT_MODEL;
  return withAuthRetry(opts.auth, opts, async (auth) => {
    const run = async (driverModel: string): Promise<ChatGptImageResult> => {
      const result = await postResponses({ auth, body: imageBody(opts, driverModel), timeoutMs: opts.timeoutMs ?? 300_000, stallMs: DEFAULT_STALL_MS, signal: opts.signal, fetchImpl: opts.fetchImpl, imageMode: true });
      fs.mkdirSync(opts.outDir, { recursive: true });
      const paths = result.images.map((b64, i) => writeImageFile(opts.outDir, Buffer.from(b64, "base64"), i));
      const note = imageNote(result, { model: driverModel, size: opts.size });
      return {
        paths,
        model: driverModel,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(note ? { note } : {}),
      };
    };
    try {
      return await run(model);
    } catch (err) {
      const unknownModel = err instanceof ChatGptApiError && /unknown model|invalid model|does not exist|not a valid model/i.test(err.message);
      if (unknownModel && model !== CHATGPT_MODEL_FALLBACK) return run(CHATGPT_MODEL_FALLBACK);
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// Status snapshot (never includes secret values)
// ---------------------------------------------------------------------------

export function chatgptAuthSnapshot(resolution: ChatGptAuthResolution): Record<string, unknown> {
  const auth = resolution.auth;
  return {
    configured: Boolean(auth),
    ...(resolution.problem ? { problem: resolution.problem } : {}),
    ...(auth
      ? {
          source: auth.source,
          account: auth.email ?? auth.accountId ?? "unknown",
          ...(auth.plan ? { plan: auth.plan } : {}),
          ...(auth.expiresAt ? { tokenExpiresAt: new Date(auth.expiresAt).toISOString(), tokenExpired: auth.expiresAt <= Date.now() } : {}),
          refreshAvailable: Boolean(auth.refreshToken),
        }
      : {}),
  };
}
