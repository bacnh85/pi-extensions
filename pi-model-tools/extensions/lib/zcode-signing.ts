/**
 * zcode-signing.ts — ZCode Client Request Signing V4, embedded.
 *
 * Ported from TriDefender/zcode-api (MIT), src/proxy/client-signing.ts
 * (blob cba566b9) + src/proxy/identity.ts (blob 3b80aa60), so Pi's
 * `zai-anthropic` provider is protocol-identical to the ZCode desktop client:
 * identity headers + X-Session-Id + per-request Ed25519 signatures + PoW,
 * gated server-side by agent/configs `codingPlanSignature.enable`.
 *
 * Fail-open everywhere, matching the real client: gate off/unreachable →
 * unsigned; handshake failure → unsigned; credential without
 * `{apiKeyId}.{apiKeySecret}` → unsigned; consecutive 401s → bypass.
 * All crypto is Node/WebCrypto stdlib — zero dependencies.
 *
 * Deviation from upstream (documented): Pi's `after_provider_response` hook
 * exposes status + headers but not the body, so VERIFY_* 401s are detected
 * status-only: any 401 right after a signed request invalidates the handshake
 * key; two consecutive → permanent bypass for the process.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform, arch as osArch, release as osRelease } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_ORIGIN = "https://zcode.z.ai";
/** Handshake plane. Live-verified 2026-09-06: /api/paas/* 404s on zcode.z.ai;
 *  the get_sign_key endpoint answers on the api.z.ai origin. */
const HANDSHAKE_ORIGIN = "https://api.z.ai";
const GATE_PATH = "/api/v1/agent/configs";
const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
const APP_ID = "zcode";
const POW_BITS = 8;
const NONCE_BYTES = 16;
const POW_NONCE_BYTES = 12;
const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const KDF_INFO_HMAC = "getSignKey_hmac";
const KDF_INFO_ED25519 = "ed25519_priv";
const HANDSHAKE_METHOD = "get_sign_key";
const GATE_TTL_MS = 3_600_000;
const GATE_FAILURE_COOLDOWN_MS = 60_000;
const GATE_UNAVAILABLE_COOLDOWN_MS = 30_000;
const GATE_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Consecutive 401s after signed requests before we bypass for the process. */
const BYPASS_AFTER_401S = 2;

/** Paths the client never signs (decoded, trailing-slash-stripped). */
const ZAI_ORIGINS = new Set(["https://zcode.z.ai", "https://api.z.ai"]);
/** Handshake failure backoff — bounds worst-case per-request latency. */
const HANDSHAKE_NEG_COOLDOWN_MS = 60_000;
const UNSIGNED_PATHS = new Set([
  "/api/v1/zcode-plan/anthropic/v1/messages",
  "/api/v1/zcode-plan/chat/completions",
  "/api/v1/off-peak/anthropic/v1/messages",
]);

const SIGNING_HEADER_NAMES = new Set([
  "x-client-ts",
  "x-client-version",
  "x-client-sig",
  "x-client-nonce",
  "x-app-id",
  "x-client-pow",
  "x-client-sign-verified",
]);

const ZCODE_APP_VERSION_FALLBACK = "3.10.2"; // matches the installed desktop app
const DEVICE_MID_CACHE = join(homedir(), ".zcode-probe-device-mid");

export interface ZcodeIdentity {
  appVersion: string;
  sourceTitle: string;
  refererOrigin: string;
  deviceMid?: string;
}

export interface SigningCredential {
  credential: string;
  appVersion: string;
}

interface ParsedCredential {
  apiKeyId: string;
  apiKeySecret: string;
}

interface SignerState {
  gateEnabled: boolean;
  gateExpiresAt: number;
  gateNegUntil: number;
  handshakeNegUntil: number;
  gatePromise?: Promise<boolean>;
  privKey?: CryptoKey;
  handshake?: Promise<CryptoKey>;
  epoch: number;
  bypass: boolean;
  consecutive401s: number;
}

// ── bytes / encoding helpers ─────────────────────────────────────────────────

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteCount: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("invalid base64");
  }
  const buf = Buffer.from(value, "base64");
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

async function hkdfBytes(secret: string, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: encoder.encode(KDF_SALT), info: encoder.encode(info) },
      key,
      256,
    ),
  );
}

// ── signing credential ───────────────────────────────────────────────────────

/** Keys sign only in two-part `{apiKeyId}.{apiKeySecret}` form (exactly one dot). */
export function parseSigningCredential(credential: string): ParsedCredential | undefined {
  const dot = credential.indexOf(".");
  if (dot <= 0 || dot !== credential.lastIndexOf(".")) return undefined;
  const apiKeyId = credential.slice(0, dot);
  const apiKeySecret = credential.slice(dot + 1);
  if (!apiKeyId.trim() || !apiKeySecret.trim()) return undefined;
  return { apiKeyId, apiKeySecret };
}

// ── crypto core ──────────────────────────────────────────────────────────────

async function handshakeSignature(secret: string, message: string): Promise<string> {
  const bits = await hkdfBytes(secret, KDF_INFO_HMAC);
  try {
    const key = await crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
    try {
      return Buffer.from(mac).toString("base64");
    } finally {
      mac.fill(0);
    }
  } finally {
    bits.fill(0);
  }
}

async function decryptSigningPrivateKey(apiKeyId: string, secret: string, privateCipher: string): Promise<CryptoKey> {
  const cipher = base64ToBytes(privateCipher);
  if (cipher.byteLength <= 12 + 16) throw new Error("privateCipher is too short");
  const aesKeyBits = await hkdfBytes(secret, KDF_INFO_ED25519);
  try {
    const aesKey = await crypto.subtle.importKey("raw", aesKeyBits, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: cipher.slice(0, 12), additionalData: encoder.encode(apiKeyId), tagLength: 128 },
        aesKey,
        cipher.slice(12),
      ),
    );
    try {
      // The plaintext is a BASE64 STRING of the PKCS8 key (not raw DER).
      // Upstream decodes the AES plaintext as UTF-8 text, then base64-decodes it.
      const pkcs8Text = new TextDecoder().decode(plain);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(pkcs8Text)) throw new Error("privateCipher payload is not base64 text");
      const pkcs8 = base64ToBytes(pkcs8Text);
      return await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519" as AlgorithmIdentifier, false, ["sign"]);
    } finally {
      plain.fill(0);
    }
  } finally {
    aesKeyBits.fill(0);
  }
}

async function signBusinessMessage(privateKey: CryptoKey, message: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(message)));
  try {
    return Buffer.from(sig).toString("base64");
  } finally {
    sig.fill(0);
  }
}

function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== 0) return false;
  }
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = (255 << (8 - remainder)) & 255;
  return ((bytes[fullBytes] ?? 255) & mask) === 0;
}

/** 8-bit PoW ≈ 256 SHA-256 iterations — sub-5ms. Exported for tests. */
export async function createProofOfWork(apiKeyId: string, sessionId: string, ts: string): Promise<string> {
  const seedDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(`${apiKeyId}\n${APP_ID}\n${sessionId}\n${ts}`)),
  );
  const seed = bytesToHex(seedDigest).slice(0, 32);
  const nonce = randomHex(POW_NONCE_BYTES);
  for (let counter = 0; counter <= 4_294_967_295; counter++) {
    const candidate = `${nonce}${counter.toString(16).padStart(8, "0")}`;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${seed}\n${candidate}`)));
    if (hasLeadingZeroBits(digest, POW_BITS)) return candidate;
  }
  throw new Error("Unable to solve client request proof of work");
}

// ── identity headers (port of identity.ts) ───────────────────────────────────

const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;

function printable(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v.length > 0 && ASCII_PRINTABLE.test(v) ? v : undefined;
}

function osCategory(p: string): string {
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  return "linux";
}

/**
 * Build the ZCode desktop client's identity headers — exact set and
 * conditional semantics of the bundle's `pio` helper.
 */
export function buildZcodeIdentityHeaders(id: ZcodeIdentity): Record<string, string> {
  const n = printable(id.appVersion);
  const plat = printable(process.env.ZCODE_IDENTITY_PLATFORM ?? osPlatform());
  const arch = printable(process.env.ZCODE_IDENTITY_ARCH ?? osArch());
  const release = printable(process.env.ZCODE_IDENTITY_RELEASE ?? osRelease());
  const platForCategory = printable(process.env.ZCODE_IDENTITY_PLATFORM ?? osPlatform()) ?? osPlatform();
  const releaseChannel =
    printable(process.env.ZCODE_IDENTITY_RELEASE_CHANNEL) ??
    (process.env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production");
  let clientLanguage = printable(process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE);
  if (!clientLanguage) {
    try {
      clientLanguage = Intl.DateTimeFormat().resolvedOptions().locale || undefined;
    } catch {
      /* Intl unavailable — omit */
    }
  }
  let clientTimezone = printable(process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE);
  if (!clientTimezone) {
    try {
      clientTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
      /* Intl unavailable — omit */
    }
  }
  const deviceMid = printable(process.env.ZCODE_IDENTITY_DEVICE_MID) ?? printable(id.deviceMid);

  return {
    "HTTP-Referer": id.refererOrigin,
    "User-Agent": `ZCode/${n ?? "unknown"}`,
    ...(n ? { "X-ZCode-App-Version": n } : {}),
    "X-Title": `Z Code@${id.sourceTitle}`,
    "X-ZCode-Agent": "glm",
    ...(plat && arch ? { "X-Platform": `${plat}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    ...(clientLanguage ? { "X-Client-Language": clientLanguage } : {}),
    ...(clientTimezone ? { "X-Client-Timezone": clientTimezone } : {}),
    ...(plat ? { "X-Os-Category": osCategory(platForCategory) } : {}),
    ...(release ? { "X-Os-Version": release } : {}),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}

/**
 * Resolve this machine's ZCode identity: appVersion (env → installed-app
 * fallback) and deviceMid (ZCode's own telemetry id → probe cache → fresh
 * UUID persisted once). Never reads credential material.
 */
export function resolveZcodeIdentity(): ZcodeIdentity {
  const appVersion = printable(process.env.ZCODE_IDENTITY_APP_VERSION) ?? ZCODE_APP_VERSION_FALLBACK;
  return {
    appVersion,
    sourceTitle: "electron",
    refererOrigin: DEFAULT_ORIGIN,
    deviceMid: resolveDeviceMid(),
  };
}

function resolveDeviceMid(): string {
  // memoized — process-static, avoids per-request sync file IO
  if (cachedDeviceMid) return cachedDeviceMid;
  try {
    const t = JSON.parse(readFileSync(join(homedir(), ".zcode", "v2", "telemetry-state.json"), "utf8")) as {
      deviceMid?: string;
    };
    if (typeof t.deviceMid === "string" && t.deviceMid.trim()) return (cachedDeviceMid = t.deviceMid.trim());
  } catch {
    /* no ZCode install — fall through */
  }
  try {
    const cached = readFileSync(DEVICE_MID_CACHE, "utf8").trim();
    if (cached) return (cachedDeviceMid = cached);
  } catch {
    /* not cached yet */
  }
  const id = randomUUID();
  try {
    writeFileSync(DEVICE_MID_CACHE, id);
  } catch {
    /* best-effort cache */
  }
  return (cachedDeviceMid = id);
}
let cachedDeviceMid: string | undefined;

// ── header helpers (Pi headers are Record<string, string>) ──────────────────

/** Pi's ProviderHeaders: a null value deletes the header. */
export type MutableHeaders = Record<string, string | null | undefined>;

function findHeader(headers: MutableHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value?.trim()) return value;
  }
  return undefined;
}

function hasHeader(headers: MutableHeaders, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function deleteHeader(headers: MutableHeaders, name: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}

// ── the signing manager ──────────────────────────────────────────────────────

export class ClientSigningManager {
  private readonly gateUrl: string;
  private readonly identity: ZcodeIdentity;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly states = new Map<string, SignerState>();
  private readonly noted = new Set<string>();
  /** State key of the most recent successfully signed request (401 ladder). */
  private lastSignedKey = "";
  onEvent?: (message: string) => void;

  constructor(opts: { identity: ZcodeIdentity; origin?: string; fetchImpl?: typeof fetch; now?: () => number }) {
    this.gateUrl = `${(opts.origin?.trim() || DEFAULT_ORIGIN).replace(/\/+$/u, "")}${GATE_PATH}`;
    this.identity = opts.identity;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Add V4 signing headers to `headers` in place. Returns true only when the
   * request was actually signed. Never throws; every ineligible path leaves
   * the headers untouched (fail-open, matching the client).
   */
  async sign(url: string, headers: MutableHeaders, cred: SigningCredential): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:") return false;
    // Credential-egress guard: gate/handshake carry the full two-part key to
    // fixed z.ai origins — never sign (or probe) for any other base URL
    // (open.bigmodel.cn, corporate proxies, …). Fail open, zero fetches.
    if (!ZAI_ORIGINS.has(parsed.origin)) return false;
    if (isUnsignedPath(parsed.pathname)) return false;
    if (hasHeader(headers, "x-client-sig")) return false; // already signed upstream

    const stateKey = `${parsed.origin}\n${cred.credential}`;
    const state = this.stateFor(stateKey);
    if (state.bypass) return false;

    const parsedCred = parseSigningCredential(cred.credential);
    if (!parsedCred) {
      this.noteOnce(stateKey, "credential has no {apiKeyId}.{apiKeySecret} separator — signing skipped");
      return false;
    }

    const sessionId = findHeader(headers, "x-session-id")?.trim();
    if (!sessionId) {
      this.noteOnce(stateKey, "request has no x-session-id — signing skipped");
      return false;
    }

    if (!(await this.gateEnabled(state, cred))) return false;
    if (state.handshakeNegUntil > this.now()) return false;

    let privateKey: CryptoKey;
    try {
      privateKey = await this.ensurePrivateKey(state, parsedCred, parsed.origin);
    } catch {
      this.noteOnce(stateKey, "signing handshake failed — sending unsigned");
      this.invalidateState(stateKey);
      state.handshakeNegUntil = this.now() + HANDSHAKE_NEG_COOLDOWN_MS;
      return false;
    }
    return await this.buildSignedHeaders(stateKey, headers, privateKey, parsedCred, sessionId, cred.appVersion, state);
  }

  /** Called on a 401 after a signed request (status-only VERIFY approximation). */
  noteResponse401(): void {
    if (!this.lastSignedKey) return;
    const state = this.states.get(this.lastSignedKey);
    if (!state) return;
    state.consecutive401s += 1;
    this.invalidateState(this.lastSignedKey);
    if (state.consecutive401s >= BYPASS_AFTER_401S) {
      state.bypass = true;
      this.onEvent?.("client-signing: repeated 401 after signed requests — bypassing signing for this credential");
    }
    this.lastSignedKey = "";
  }

  /** Called on any non-401 response: a success between 401s keeps them from counting as consecutive. */
  noteResponseOk(): void {
    const state = this.states.get(this.lastSignedKey);
    if (state) state.consecutive401s = 0;
  }

  private async buildSignedHeaders(
    stateKey: string,
    headers: MutableHeaders,
    privateKey: CryptoKey,
    parsedCred: ParsedCredential,
    sessionId: string,
    appVersion: string,
    state: SignerState,
  ): Promise<boolean> {
    const ts = String(Date.now());
    const nonce = randomHex(NONCE_BYTES);
    let pow: string;
    let sig: string;
    try {
      pow = await createProofOfWork(parsedCred.apiKeyId, sessionId, ts);
      sig = await signBusinessMessage(
        privateKey,
        `${parsedCred.apiKeyId}\n${ts}\n${appVersion}\n${sessionId}\n${nonce}`,
      );
    } catch (err) {
      this.noteOnce(stateKey, `signing failed (${(err as Error).message}) — sending unsigned`);
      return false;
    }
    // Drop stale copies (any casing), then set the canonical header set.
    for (const name of SIGNING_HEADER_NAMES) deleteHeader(headers, name);
    deleteHeader(headers, "x-session-id");
    headers["X-Client-Ts"] = ts;
    headers["X-Client-Version"] = appVersion;
    headers["X-Client-Sig"] = sig;
    headers["X-Session-Id"] = sessionId;
    headers["X-Client-Nonce"] = nonce;
    headers["X-App-Id"] = APP_ID;
    headers["X-Client-Pow"] = pow;
    // NOTE: no reset of consecutive401s here — a sign followed by a 401 is a
    // consecutive rejection; only a process restart clears the bypass.
    this.lastSignedKey = stateKey;
    return true;
  }

  private invalidateState(stateKey: string): void {
    const state = this.states.get(stateKey);
    if (!state) return;
    state.epoch += 1;
    state.privKey = undefined;
    state.handshake = undefined;
  }

  private stateFor(stateKey: string): SignerState {
    let state = this.states.get(stateKey);
    if (!state) {
      state = { gateEnabled: false, gateExpiresAt: 0, gateNegUntil: 0, handshakeNegUntil: 0, epoch: 0, bypass: false, consecutive401s: 0 };
      this.states.set(stateKey, state);
    }
    return state;
  }

  private async gateEnabled(state: SignerState, cred: SigningCredential): Promise<boolean> {
    const now = this.now();
    if (state.gateExpiresAt > now) return state.gateEnabled;
    if (state.gateNegUntil > now) return false;
    if (state.gatePromise) return state.gatePromise;
    const promise = this.probeGate(state, cred).finally(() => {
      if (state.gatePromise === promise) state.gatePromise = undefined;
    });
    state.gatePromise = promise;
    return promise;
  }

  private async probeGate(state: SignerState, cred: SigningCredential): Promise<boolean> {
    const now = this.now();
    let outcome: "enabled" | "disabled" | "unavailable";
    try {
      outcome = await this.fetchGate(cred);
    } catch {
      state.gateNegUntil = now + GATE_FAILURE_COOLDOWN_MS;
      return false;
    }
    state.gateEnabled = outcome === "enabled";
    if (outcome === "unavailable") {
      state.gateNegUntil = now + GATE_UNAVAILABLE_COOLDOWN_MS;
    } else {
      state.gateExpiresAt = now + GATE_TTL_MS;
      state.gateNegUntil = 0;
    }
    if (state.gateEnabled) this.onEvent?.("client-signing: server enabled codingPlanSignature — signing requests");
    return state.gateEnabled;
  }

  private async fetchGate(cred: SigningCredential): Promise<"enabled" | "disabled" | "unavailable"> {
    // The client's gate fetch carries identity headers WITHOUT X-ZCode-Agent
    // and X-Device-Mid, plus x-api-key, no Accept header.
    const identityHeaders = buildZcodeIdentityHeaders(this.identity);
    delete identityHeaders["X-ZCode-Agent"];
    delete identityHeaders["X-Device-Mid"];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS);
    try {
      const resp = await this.fetchImpl(this.gateUrl, {
        method: "GET",
        headers: { ...identityHeaders, "x-api-key": cred.credential },
        redirect: "manual",
        signal: controller.signal,
      });
      if (!resp.ok) return "unavailable";
      const parsed = (await resp.json()) as Record<string, unknown>;
      if (!parsed || parsed.code !== 0) return "unavailable";
      const data = parsed.data as Record<string, unknown> | undefined;
      if (!data || !Object.prototype.hasOwnProperty.call(data, "codingPlanSignature")) return "disabled";
      const signature = data.codingPlanSignature as Record<string, unknown> | undefined;
      return signature?.enable === true ? "enabled" : "disabled";
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensurePrivateKey(
    state: SignerState,
    parsedCred: ParsedCredential,
    origin: string,
  ): Promise<CryptoKey> {
    if (state.privKey) return state.privKey;
    if (state.handshake) return state.handshake;
    const epoch = state.epoch;
    const handshake = this.performHandshake(parsedCred, origin).then((key) => {
      if (state.epoch !== epoch) throw new Error("signing key changed during handshake");
      state.privKey = key;
      return key;
    });
    const clear = () => {
      if (state.handshake === handshake) state.handshake = undefined;
    };
    handshake.then(clear, clear);
    state.handshake = handshake;
    return handshake;
  }

  private async performHandshake(parsedCred: ParsedCredential, origin: string): Promise<CryptoKey> {
    const ts = String(Date.now());
    const nonce = randomHex(NONCE_BYTES);
    const sig = await handshakeSignature(
      parsedCred.apiKeySecret,
      `${HANDSHAKE_METHOD}\n${parsedCred.apiKeyId}\n${ts}\n${nonce}`,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
      const resp = await this.fetchImpl(`${HANDSHAKE_ORIGIN}${HANDSHAKE_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `${parsedCred.apiKeyId}.${parsedCred.apiKeySecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiKey: `${parsedCred.apiKeyId}.${parsedCred.apiKeySecret}`, nonce, sig, ts }),
        redirect: "manual",
        signal: controller.signal,
      });
      if (resp.status !== 200) throw new Error(`handshake_http_${resp.status}`);
      const envelope = (await resp.json()) as { code?: unknown; msg?: unknown; data?: { privateCipher?: unknown } };
      if (envelope.code === 500) throw new Error("handshake_server_500");
      if (envelope.code !== 200) throw new Error(`handshake_rejected: ${String(envelope.msg)}`);
      const cipher = envelope.data?.privateCipher;
      if (typeof cipher !== "string" || !cipher) throw new Error("handshake_omitted_privateCipher");
      return await decryptSigningPrivateKey(parsedCred.apiKeyId, parsedCred.apiKeySecret, cipher);
    } finally {
      clearTimeout(timer);
    }
  }

  private noteOnce(stateKey: string, message: string): void {
    const key = `${stateKey}#${message}`;
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.onEvent?.(`client-signing: ${message}`);
  }
}

function isUnsignedPath(pathname: string): boolean {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    /* keep raw path */
  }
  path = path.replace(/\/+$/u, "");
  return UNSIGNED_PATHS.has(path);
}

// ── wiring-level helpers (used by extensions/index.ts) ──────────────────────

/** ZCode signing ON by default (owner decision 2026-09-06 — parity with the
 *  desktop client for every zai-anthropic session); opt out with
 *  ZAI_ANTHROPIC_SIGNING=0. Fail-open on every failure path. */
export function zcodeSigningEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.ZAI_ANTHROPIC_SIGNING ?? "");
}

let sharedManager: ClientSigningManager | undefined;

/** Process-wide manager, constructed lazily. */
export function getZcodeSigningManager(): ClientSigningManager {
  if (!sharedManager) {
    sharedManager = new ClientSigningManager({ identity: resolveZcodeIdentity() });
    sharedManager.onEvent = (message) => {
      // Lazy import avoidance: keep the lib dependency-free; the wiring passes
      // debugLog via onEvent if it wants richer logging.
      if (process.env.PI_MODEL_TOOLS_DEBUG) console.error(`[zcode-signing] ${message}`);
    };
  }
  return sharedManager;
}

/** Test seam: replace the process-wide manager. */
export function setZcodeSigningManager(manager: ClientSigningManager | undefined): void {
  sharedManager = manager;
}

/**
 * Credential resolution order for signing: request header (what's actually
 * being sent) → env (ZAI_ANTHROPIC_API_KEY, mirrors provider registration) →
 * auth.json lookup (lazy — only touched when the faster sources miss).
 * Returns undefined when nothing resolves; never logs the value.
 */
export function pickZcodeCredential(
  headers: MutableHeaders,
  env: Record<string, string | undefined>,
  lookupStored: () => string | undefined,
): string | undefined {
  const fromHeader = findHeader(headers, "x-api-key");
  if (fromHeader) return fromHeader;
  const fromEnv = printable(env.ZAI_ANTHROPIC_API_KEY);
  if (fromEnv) return fromEnv;
  return lookupStored() || undefined;
}

/**
 * High-level hook body: mutate `headers` in place for zai-anthropic requests.
 * Signing is ON by default (opt out: ZAI_ANTHROPIC_SIGNING=0). Fails open on
 * every missing precondition. `baseUrl` is the provider base (no trailing
 * slash); the only URL ever requested is `${baseUrl}/v1/messages`.
 */
export async function applyZcodeSigningHeaders(
  headers: MutableHeaders,
  opts: {
    provider?: string;
    baseUrl: string;
    sessionId?: string;
    credential?: string;
    env?: Record<string, string | undefined>;
  },
): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (!zcodeSigningEnabled(env)) return false;
  if ((opts.provider ?? "").toLowerCase() !== "zai-anthropic") return false;
  if (!hasHeader(headers, "x-session-id") && opts.sessionId) headers["x-session-id"] = opts.sessionId;
  // Identity headers ride along on every request (the client sends them on
  // everything; billing-inert on the plain route, required-looking on ultra).
  const resolved = resolveZcodeIdentity(); // single resolution per request
  for (const [k, v] of Object.entries(buildZcodeIdentityHeaders(resolved))) headers[k] = v;
  const credential = opts.credential ?? "";
  if (!credential) return false;
  const url = `${opts.baseUrl.replace(/\/+$/u, "")}/v1/messages`;
  return await getZcodeSigningManager().sign(url, headers, {
    credential,
    appVersion: resolved.appVersion,
  });
}
