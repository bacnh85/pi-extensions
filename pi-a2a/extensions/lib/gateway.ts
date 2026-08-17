/**
 * Gateway upstream registration (discovery layer 2): announce this session to
 * a self-hosted a2a-switchboard gateway (https://github.com/bacnh85/a2a-switchboard)
 * so other accepted peers can discover and call it via the gateway's proxy.
 *
 * Lifecycle: register (POST) on server start → PATCH /register heartbeats
 * once the per-peer caller_token is known (POST mints it; the token is
 * persisted so restarts skip the mint) → deregister on graceful stop. A crashed
 * session leaves a stale entry; the gateway's health prober marks it
 * unreachable, and the admin can delete it (or the next session with the same
 * name + token takes the entry over via re-registration).
 *
 * After each heartbeat the gateway peer directory (/.well-known/agent.json) is
 * fetched and merged into a read-only `gw/<key>/<name>` → Peer overlay handed to
 * the `onPeers` callback — never written to settings.json.
 */

import type { Peer } from "./config";
import * as fs from "node:fs";
import { dirname, join } from "node:path";

export interface GatewayConfig {
  /** Gateway base URL, e.g. http://127.0.0.1:9920 */
  url: string;
  /** Gateway API token (pending queue) or bootstrap token (auto-accept). */
  token: string;
  /** Peer name to register as. Default: agentName or "pi". */
  name?: string;
  /** Optional token the gateway should present when proxying TO us. */
  upstreamToken?: string;
  /** Re-registration interval in seconds. Default 60. */
  heartbeatSec?: number;
  /** Outbound call timeout for gw/<name> peers (ms). Default 120000 —
   *  decoupled from heartbeatSec: long agent tasks must not be truncated by
   *  the directory-refresh cadence. */
  callTimeoutMs?: number;
  /** Open a reverse channel (SSE) so firewalled peers still receive proxied
   *  requests — all connections stay peer-initiated. Default true. */
  channel?: boolean;
  /** Local server base URL the channel dispatcher forwards envelopes to.
   *  Default: the URL passed to start(). */
  localBase?: string;
  /** Token the LOCAL inbound server accepts (server.sharedToken or the
   *  upstreamToken registered with the gateway). Injected on dispatch —
   *  the gateway strips caller auth, so the local server needs its own. */
  localToken?: string;
  /** Gateway key (0.6.0) — namespaces the peer overlay as `gw/<key>/<name>`.
   *  Default "default". */
  key?: string;
  /** Directory for persisted gateway state (the minted caller_token — the
   *  gateway only discloses it at mint, so it must survive restarts).
   *  Injected by the server; unset = stateless. */
  piDir?: string;
}

const DEREG_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Peer directory merge (pure — no I/O, no global state)
// ---------------------------------------------------------------------------

/** One `peers[]` entry of the gateway's /.well-known/agent.json directory. */
export interface GatewayDirectoryEntry {
  name?: unknown;
  url?: unknown;
  healthy?: unknown;
  capabilities?: unknown;
  skills?: unknown;
}

/** Gateway peer names are constrained to [A-Za-z0-9._-] by the gateway's
 *  register endpoint; re-check so a hostile/buggy gateway can't smuggle a
 *  name that breaks the `gw/<name>` namespace or URL semantics. */
const GATEWAY_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function normUrl(u: string): string {
  return u.trim().replace(/\/+$/, "").toLowerCase();
}

/** Port of a URL string, or "" when absent/defaulted. */
function portOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).port || "";
  } catch {
    return "";
  }
}

/** Single-line, length-capped string from untrusted directory fields. */
function sanitize(v: unknown): string {
  return String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function sanitizeList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(sanitize).filter(Boolean).slice(0, 50) : [];
}

/** True when a directory entry is THIS session (never call yourself through
 *  the proxy): exact registered-name match, `-<port>` suffix match against the
 *  port we serve on (the default auto-name is `<base>-<port>`), or absolute-URL
 *  match against our publicUrl (defensive — a2a-switchboard only exposes proxy
 *  URLs today). */
export function isSelfEntry(
  entry: { name: string; url: string },
  self: { name: string; url: string; autoName?: string },
): boolean {
  if (entry.name === self.name) return true;
  // Our own default auto-name (`<base>-<port>`) — NOT any `-<port>` suffix:
  // another machine's peer may coincidentally bind the same port.
  if (self.autoName && entry.name === self.autoName) return true;
  if (
    entry.url &&
    /^https?:\/\//i.test(entry.url) &&
    normUrl(entry.url) === normUrl(self.url)
  ) {
    return true;
  }
  return false;
}

/** Resolve a gateway-relative peer URL (e.g. /peer/<name>/) against the
 *  gateway origin. Only same-origin results pass: the merged peers carry the
 *  gateway bearer token, so a crafted absolute URL must never redirect a call
 *  to a third-party host. */
function proxyUrl(gatewayUrl: string, rel: string): string {
  if (!rel.startsWith("/")) return ""; // a2a-switchboard urls are always relative
  try {
    const resolved = new URL(rel, gatewayUrl);
    return resolved.origin === new URL(gatewayUrl).origin ? resolved.toString() : "";
  } catch {
    return "";
  }
}

/** Merge the gateway peer directory into a `gw/<key>/<name>` → Peer overlay.
 *  Auth is the gateway bearer token (the proxy swaps in the peer's own
 *  upstream token). Unhealthy peers and self are skipped. `key` (0.6.0)
 *  namespaces the overlay per gateway — always prefixed, even for a single
 *  gateway (uniform naming). */
export function mergeGatewayPeers(opts: {
  gatewayUrl: string;
  token: string;
  selfName: string;
  selfUrl: string;
  /** Our default auto-name (`<base>-<port>`) for exact-match self-filtering. */
  selfAutoName?: string;
  entries: unknown;
  timeoutMs: number;
  /** Gateway key — emitted as `gw/<key>/<name>`. Default "default". */
  key?: string;
}): Record<string, Peer> {
  let origin: URL;
  try {
    origin = new URL(opts.gatewayUrl);
  } catch {
    return {}; // malformed gateway url — nothing routable
  }
  const out: Record<string, Peer> = {};
  const key = opts.key || "default";
  if (!Array.isArray(opts.entries)) return out;
  for (const raw of opts.entries) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as GatewayDirectoryEntry;
    const name = sanitize(e.name);
    if (!GATEWAY_NAME_RE.test(name)) continue;
    if (e.healthy === false) continue; // gateway prober marked it unreachable
    if (
      isSelfEntry(
        { name, url: String(e.url ?? "") },
        { name: opts.selfName, url: opts.selfUrl, autoName: opts.selfAutoName },
      )
    ) {
      continue;
    }
    const url = proxyUrl(origin.toString(), String(e.url ?? ""));
    if (!url) continue;
    // Directory capabilities is either a string array or an A2A card object
    // ({streaming, pushNotifications}); skills carry [{id,name}]. Surface
    // skill names so capability-based peer selection works either way.
    const caps = sanitizeList(e.capabilities).length
      ? sanitizeList(e.capabilities)
      : sanitizeList(Array.isArray(e.skills) ? e.skills.map((sk: any) => sk?.name ?? sk?.id) : []);
    out[`gw/${key}/${name}`] = {
      url,
      auth: { type: "bearer", token: opts.token },
      timeout: opts.timeoutMs,
      capabilities: caps,
      description: "via a2a-switchboard",
      viaGateway: true,
      gatewayUrl: opts.gatewayUrl,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upstream registration + heartbeat
// ---------------------------------------------------------------------------

export class GatewayUpstream {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Bumped on stop(): in-flight register() calls check it after each await
   *  and bail instead of resurrecting the registration/overlay. */
  private epoch = 0;
  private lastUrl = "";
  /** Shared epoch holder the ChannelClient also watches (stop() kills both). */
  private epochRef = { value: 0 };
  private channel: ChannelClient | null = null;

  private url(path: string): string {
    return this.cfg.url.replace(/\/+$/, "") + path;
  }

  private get name(): string {
    return this.cfg.name || "pi";
  }

  /** Gateway key (default "default") — prefixes the `gw/<key>/<name>` overlay. */
  private get key(): string {
    return this.cfg.key || "default";
  }

  /** Human-readable gateway label for messages: `<key>@<host>` (no token, no path). */
  private get label(): string {
    try {
      return `${this.key}@${new URL(this.cfg.url).host}`;
    } catch {
      return this.key;
    }
  }

  /** The server's default per-session auto-name (`<base>-<port>`), only
   *  meaningful when the server computed it (passed via cfg.autoName). */
  private get autoName(): string | undefined {
    return (this.cfg as { autoName?: string }).autoName;
  }

  /** Admission state of the last registration ("pending" | "accepted" | …). */
  lastState = "";

  /** Per-peer caller token issued by the gateway at registration. Used as the
   *  caller identity for outbound `/peer/*` calls so the gateway's dashboard
   *  shows THIS peer's name (not a shared-token fingerprint), and as the
   *  auth for PATCH /register heartbeats. Loaded from disk at construction,
   *  re-persisted on every mint. */
  private callerToken: string | null;
  /** Sticky false after a 405 (old switchboard without PATCH) — POST-only for
   *  the rest of the session to avoid flapping. */
  private patchSupported = true;
  /** Last directory-fetch status (0 = none yet). Only a CHANGED failing
   *  status is logged — repeated identical failures stay quiet. */
  private lastDirStatus = 0;
  /** `<piDir>/a2a_gateways/<key>.json` — null when cfg.piDir is unset. */
  private readonly stateFile: string | null;
  // ponytail: one state file per gateway key; concurrent same-machine sessions
  // sharing a key overwrite each other (name-guarded at load) — per-name files if that ever matters.

  constructor(
    private readonly cfg: GatewayConfig,
    /** Builds the agent-card JSON body; called on each heartbeat so the card stays fresh. */
    private readonly buildCard: () => Record<string, unknown>,
    private readonly log: (msg: string) => void = console.error,
    /** Receives each refreshed `gw/<name>` → Peer overlay ({} clears it). */
    private readonly onPeers: (peers: Record<string, Peer>) => void = () => {},
    /** Host-TUI status line (transcript) for lifecycle events like the
     *  reverse channel opening — surfaced like the registration message. */
    private readonly onStatus: ((msg: string) => void) | undefined = undefined,
  ) {
    this.stateFile = cfg.piDir
      ? join(cfg.piDir, "a2a_gateways", `${this.key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`)
      : null;
    this.callerToken = this.loadPersistedToken();
  }

  /** Load the persisted caller_token. A foreign entry name (concurrent
   *  session under the same key) is ignored — the gateway binds the token to
   * the peer name, another name's token would only 401. */
  private loadPersistedToken(): string | null {
    if (!this.stateFile) return null;
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return j?.name === this.name && typeof j.callerToken === "string" && j.callerToken
        ? j.callerToken
        : null;
    } catch {
      return null;
    }
  }

  private persistToken(): void {
    if (!this.stateFile || !this.callerToken) return;
    try {
      fs.mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.stateFile, JSON.stringify({ name: this.name, callerToken: this.callerToken }), { mode: 0o600 });
    } catch {
      /* state file is an optimization — heartbeat still works via fallback */
    }
  }

  private async send(
    method: "POST" | "PATCH",
    path: string,
    token: string,
    body: unknown,
  ): Promise<Response | null> {
    try {
      return await fetch(this.url(path), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null; // gateway down / network error — heartbeat will retry
    }
  }

  /** POST /register with our current card. Idempotent: gateway updates in place.
   *  After each (re-)registration, refresh the peer-directory overlay. */
  async register(url: string): Promise<boolean> {
    const at = this.epoch;
    const body: Record<string, unknown> = { name: this.name, url, card: this.buildCard() };
    if (this.cfg.upstreamToken) body.upstream_token = this.cfg.upstreamToken;
    // Steady-state heartbeats PATCH with the per-peer caller_token (full card
    // refresh; url re-send covers IP changes). POST is the mint path and the
    // fallback when PATCH can't work (405 old gateway, 401 stale token,
    // 404 deleted entry).
    let res: Response | null = null;
    if (this.callerToken && this.patchSupported) {
      res = await this.send("PATCH", "/register", this.callerToken, body);
      if (at !== this.epoch) return false; // stop() raced us — registration is dead
      if (!res) {
        this.log(`[a2a-gateway:${this.label}] register failed: network error`);
        return false;
      }
      if (res.status === 405) {
        this.patchSupported = false; // old switchboard — POST-only this session
        res = null; // fall through to POST
      } else if (!res.ok) {
        // 401 (rejected caller_token) / 404 (entry deleted): the token is
        // known-dead — clear it so the overlay falls back to the shared token
        // until a POST re-mints (a POST response carrying no mint leaves it null).
        if (res.status === 401 || res.status === 404) {
          this.callerToken = null;
          res = null; // fall through to POST
        } else {
          // 403 (revoked peer) / 409 etc.: a shared-token POST is not a valid
          // rescue for this admission state — fail the beat.
          this.log(`[a2a-gateway:${this.label}] register failed: ${res.status}`);
          return false;
        }
      }
    }
    if (!res) res = await this.send("POST", "/register", this.cfg.token, body);
    if (at !== this.epoch) return false; // stop() raced us — registration is dead
    if (!res?.ok) {
      this.log(`[a2a-gateway:${this.label}] register failed: ${res ? res.status : "network error"}`);
      return false;
    }
    try {
      const j = (await res.clone?.().json?.().catch?.(() => null)) ?? (await res.json().catch(() => null));
      this.lastState = String(j?.state ?? "");
      if (typeof j?.caller_token === "string" && j.caller_token) {
        this.callerToken = j.caller_token;
        this.persistToken();
      }
    } catch {
      this.lastState = "";
    }
    this.lastUrl = url;
    this.stopped = false;
    await this.refreshPeers();
    return true;
  }

  /** GET /.well-known/agent.json → merged overlay via onPeers. Failures keep
   *  the last known overlay (a blip between heartbeats shouldn't evaporate
   *  peers). */
  private async refreshPeers(): Promise<void> {
    const at = this.epoch;
    try {
      const res = await fetch(this.url("/.well-known/agent.json"), {
        headers: { authorization: `Bearer ${this.cfg.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res?.ok) {
        // Log only when the failing status CHANGES — a directory down for N
        // beats shouldn't emit one log line per heartbeat.
        const status = res?.status ?? 0;
        if (status !== this.lastDirStatus) {
          this.log(`[a2a-gateway:${this.label}] peer directory refresh failed: ${status}`);
        }
        this.lastDirStatus = status;
        return;
      }
      this.lastDirStatus = res.status;
      const json = (await res.json()) as { peers?: unknown };
      if (at !== this.epoch) return; // stop() cleared the overlay — don't refill it
      this.onPeers(
        mergeGatewayPeers({
          gatewayUrl: this.cfg.url,
          token: this.callerToken ?? this.cfg.token,
          selfName: this.name,
          selfUrl: this.lastUrl,
          selfAutoName: this.autoName,
          entries: json?.peers,
          timeoutMs: this.cfg.callTimeoutMs ?? 120_000,
          key: this.key,
        }),
      );
    } catch {
      /* best-effort — next heartbeat retries */
    }
  }

  /** Register + start the heartbeat loop. Each beat re-registers and
   *  refreshes the peer overlay. A failed fresh start clears any stale
   *  overlay from a previous upstream instance. */
  async start(url: string): Promise<boolean> {
    this.onPeers({});
    const ok = await this.register(url);
    if (!ok) return false;
    // Reverse channel (default on): firewalled peers still receive proxied
    // requests — everything rides connections WE initiated.
    if (this.cfg.channel !== false) {
      this.channel = new ChannelClient(
        { ...this.cfg, localToken: this.cfg.localToken ?? this.cfg.upstreamToken },
        this.cfg.localBase ?? url,
        this.log,
        this.epochRef,
        this.onStatus,
      );
      void this.channel.start();
    }
    const intervalMs = Math.max(15, this.cfg.heartbeatSec ?? 60) * 1000;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      void this.register(url);
    }, intervalMs);
    this.timer.unref?.();
    return true;
  }

  /** DELETE /register?name=... Best-effort; no throw. Clears the overlay. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.epoch += 1; // in-flight register()/refreshPeers() must not resurrect us
    this.epochRef.value = this.epoch; // channel reconnect loops die too
    this.channel?.stop();
    this.channel = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await fetch(this.url(`/register?name=${encodeURIComponent(this.name)}`), {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.cfg.token}` },
        signal: AbortSignal.timeout(DEREG_TIMEOUT_MS),
      });
    } catch {
      /* best-effort — stale entry decays via gateway health probing */
    }
    this.onPeers({});
  }
}

// ---------------------------------------------------------------------------
// Reverse channel client — receive proxied requests over our own SSE stream
// ---------------------------------------------------------------------------

/** One request envelope pushed down /channel (mirrors gateway Envelope). */
interface ChannelEnvelope {
  id: number;
  method: string;
  path: string;
  query?: string | null;
  headers: Record<string, string>;
  body_b64: string;
  /** Per-connection secret from the gateway `hello` event — echoed in the
   *  response so a shared-token peer can't answer foreign requests. */
  chan_secret?: string;
}

interface ChannelRespEnvelope {
  id: number;
  status: number;
  headers: Record<string, string>;
  body_b64: string;
  chan_secret?: string;
}

/** Max channel body (matches gateway MAX_CHANNEL_BODY — 4 MiB). */
const MAX_CHANNEL_BODY = 4 * 1024 * 1024;
const MAX_B64 = Math.floor((MAX_CHANNEL_BODY * 4) / 3) + 4;

/** Opens GET /channel and dispatches each `request` event to the local A2A
 *  server, posting the answer to /channel/response/{id}. Reconnects with
 *  capped backoff; aborts cleanly on stop() (epoch-guarded like register). */
export class ChannelClient {
  private controller: AbortController | null = null;
  private stopped = false;
  private epoch = 0;
  /** Per-connection secret from the gateway hello event. */
  private chanSecret = "";
  /** In-flight dispatches — stop() waits for them (bounded). */
  private inflight = new Set<Promise<void>>();

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly localBase: string,
    private readonly log: (msg: string) => void = console.error,
    /** Bumped by GatewayUpstream.stop() to stop reconnect loops. */
    private readonly sharedEpoch: { value: number },
    /** Host-TUI status line (transcript) for lifecycle events — the channel
     *  opening is surfaced like the registration message instead of raw
     *  console output. Falls back to `log` when absent. */
    private readonly onStatus: ((msg: string) => void) | undefined = undefined,
  ) {}

  /** Human-readable gateway label for messages: `<key>@<host>`. */
  private get label(): string {
    try {
      return `${this.cfg.key || "default"}@${new URL(this.cfg.url).host}`;
    } catch {
      return this.cfg.key || "default";
    }
  }

  /** Route a lifecycle line to the transcript (onStatus) when available,
   *  else to the diagnostic log. Never throws. */
  private status(msg: string): void {
    if (this.onStatus) {
      try {
        this.onStatus(msg);
        return;
      } catch {
        /* fall back to log */
      }
    }
    this.log(msg);
  }

  private url(path: string): string {
    return this.cfg.url.replace(/\/+$/, "") + path;
  }

  /** Open the stream; resolves true once connected (reading continues in
   *  the background until stop()). Never throws. */
  async start(): Promise<boolean> {
    this.stopped = false;
    return this.connect(0);
  }

  private connect(attempt: number): Promise<boolean> {
    if (this.stopped || this.sharedEpoch.value !== this.epoch) return Promise.resolve(false);
    const ctrl = new AbortController();
    this.controller = ctrl;
    return fetch(this.url(`/channel?name=${encodeURIComponent(this.cfg.name || "pi")}`), {
      headers: { authorization: `Bearer ${this.cfg.token}` },
      signal: ctrl.signal,
    })
      .then((res) => {
        if (!res.ok || !res.body) throw new Error(`channel open failed: HTTP ${res.status}`);
        if (attempt === 0) this.status(`[a2a] gateway channel open: ${this.label} (firewall-safe receive)`);
        const connected = attempt === 0;
        // readStream never resolves while healthy — keep it detached.
        void this.readStream(res.body!)
          .then(() => this.reconnect(attempt))
          .catch((e: unknown) => {
            if (!ctrl.signal.aborted) void this.reconnect(attempt, e);
          });
        return connected;
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return false; // stop()
        return this.reconnect(attempt, e);
      });
  }

  private async reconnect(attempt: number, why?: unknown): Promise<boolean> {
    if (this.stopped || this.sharedEpoch.value !== this.epoch) return false;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    if (attempt === 0 && why) this.log(`[a2a-gateway:${this.label}] channel dropped, reconnecting: ${String(why)}`);
    await new Promise((r) => setTimeout(r, delay));
    return this.connect(attempt + 1);
  }

  /** Minimal SSE reader: CRLF/LF-tolerant, ignores comments, captures the
   *  `hello` secret, dispatches `request` envelopes with a size guard. */
  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      // Normalize CRLF → LF so \n\n framing works for both line endings.
      buf = buf.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this.handleFrame(frame);
      }
    }
  }

  private handleFrame(frame: string): void {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      const l = line.replace(/\r$/, "");
      if (!l || l.startsWith(":")) continue; // blank + comments
      if (l.startsWith("event:")) event = l.slice(6).trim();
      else if (l.startsWith("data:")) dataLines.push(l.slice(5).trimStart());
    }
    const data = dataLines.join("\n");
    if (event === "hello") {
      this.chanSecret = data.trim();
      return;
    }
    if (event !== "request") return; // ping/lagged ignored
    let env: ChannelEnvelope;
    try {
      env = JSON.parse(data);
    } catch {
      return; // malformed envelope — drop
    }
    // Oversized envelope guard BEFORE decode (OOM protection).
    if (env.body_b64.length > MAX_B64) {
      this.log(`[a2a-gateway:${this.label}] dropped oversized envelope (${env.body_b64.length} b64 chars)`);
      return;
    }
    const p = this.dispatch(env);
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** Forward one envelope to the local server and post the answer back. */
  private async dispatch(env: ChannelEnvelope): Promise<void> {
    // Path must stay inside the local origin — reject traversal outright.
    if (!env.path.startsWith("/") || env.path.includes("..")) {
      this.log(`[a2a-gateway:${this.label}] dropped envelope with unsafe path: ${env.path}`);
      return;
    }
    const binary = Uint8Array.from(atob(env.body_b64), (c) => c.charCodeAt(0));
    const qs = env.query ? `?${env.query}` : "";
    const headers: Record<string, string> = { ...env.headers };
    if (this.cfg.localToken) headers.authorization = `Bearer ${this.cfg.localToken}`;
    try {
      const res = await fetch(this.localBase.replace(/\/+$/, "") + env.path + qs, {
        method: env.method,
        headers,
        body: ["GET", "HEAD"].includes(env.method) ? undefined : binary,
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > MAX_CHANNEL_BODY) {
        this.log(`[a2a-gateway:${this.label}] local reply too large (${buf.length}B) — not posted`);
        return;
      }
      let b64 = "";
      for (let i = 0; i < buf.length; i += 0x8000) {
        b64 += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (!["transfer-encoding", "content-length", "connection"].includes(k.toLowerCase())) outHeaders[k] = v;
      });
      await this.postResponse({
        id: env.id,
        status: res.status,
        headers: outHeaders,
        body_b64: btoa(b64),
        chan_secret: this.chanSecret,
      });
    } catch (e) {
      this.log(`[a2a-gateway:${this.label}] channel dispatch failed: ${String(e)}`);
    }
  }

  private async postResponse(resp: ChannelRespEnvelope): Promise<void> {
    try {
      await fetch(this.url(`/channel/response/${resp.id}?name=${encodeURIComponent(this.cfg.name || "pi")}`), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(resp),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      /* id may already be expired — nothing to do */
    }
  }

  stop(): void {
    this.stopped = true;
    this.epoch += 1; // kill in-flight connect/reconnect
    this.controller?.abort();
    this.controller = null;
    // Wait (bounded) for in-flight dispatches so no response is posted
    // after the session shut down.
    const pending = [...this.inflight];
    void Promise.allSettled(pending).then(() => {
      const t = setTimeout(() => undefined, 5000);
      t.unref?.();
    });
  }
}
