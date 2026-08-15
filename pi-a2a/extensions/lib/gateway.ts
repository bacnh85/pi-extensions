/**
 * Gateway upstream registration (discovery layer 2): announce this session to
 * a self-hosted agent-gateway (https://github.com/agentgateway style) so other
 * accepted peers can discover and call it via the gateway's proxy.
 *
 * Lifecycle: register on server start → re-register as heartbeat (also
 * refreshes URL if the port changed) → deregister on graceful stop. A crashed
 * session leaves a stale entry; the gateway's health prober marks it
 * unreachable, and the admin can delete it (or the next session with the same
 * name + token takes the entry over via re-registration).
 *
 * After each heartbeat the gateway peer directory (/.well-known/agent.json) is
 * fetched and merged into a read-only `gw/<name>` → Peer overlay handed to the
 * `onPeers` callback — never written to settings.json.
 */

import type { Peer } from "./config";

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
 *  match against our publicUrl (defensive — agent-gateway only exposes proxy
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
  if (!rel.startsWith("/")) return ""; // agent-gateway urls are always relative
  try {
    const resolved = new URL(rel, gatewayUrl);
    return resolved.origin === new URL(gatewayUrl).origin ? resolved.toString() : "";
  } catch {
    return "";
  }
}

/** Merge the gateway peer directory into a `gw/<name>` → Peer overlay.
 *  Auth is the gateway bearer token (the proxy swaps in the peer's own
 *  upstream token). Unhealthy peers and self are skipped. */
export function mergeGatewayPeers(opts: {
  gatewayUrl: string;
  token: string;
  selfName: string;
  selfUrl: string;
  /** Our default auto-name (`<base>-<port>`) for exact-match self-filtering. */
  selfAutoName?: string;
  entries: unknown;
  timeoutMs: number;
}): Record<string, Peer> {
  let origin: URL;
  try {
    origin = new URL(opts.gatewayUrl);
  } catch {
    return {}; // malformed gateway url — nothing routable
  }
  const out: Record<string, Peer> = {};
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
    out[`gw/${name}`] = {
      url,
      auth: { type: "bearer", token: opts.token },
      timeout: opts.timeoutMs,
      capabilities: caps,
      description: "via agent-gateway",
      viaGateway: true,
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

  constructor(
    private readonly cfg: GatewayConfig,
    /** Builds the agent-card JSON body; called on each heartbeat so the card stays fresh. */
    private readonly buildCard: () => Record<string, unknown>,
    private readonly log: (...args: unknown[]) => void = console.error,
    /** Receives each refreshed `gw/<name>` → Peer overlay ({} clears it). */
    private readonly onPeers: (peers: Record<string, Peer>) => void = () => {},
  ) {}

  private url(path: string): string {
    return this.cfg.url.replace(/\/+$/, "") + path;
  }

  private get name(): string {
    return this.cfg.name || "pi";
  }

  /** The server's default per-session auto-name (`<base>-<port>`), only
   *  meaningful when the server computed it (passed via cfg.autoName). */
  private get autoName(): string | undefined {
    return (this.cfg as { autoName?: string }).autoName;
  }

  /** Admission state of the last registration ("pending" | "accepted" | …). */
  lastState = "";

  private async post(path: string, body: unknown): Promise<Response | null> {
    try {
      return await fetch(this.url(path), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
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
    const res = await this.post("/register", body);
    if (at !== this.epoch) return false; // stop() raced us — registration is dead
    if (!res?.ok) {
      this.log(`[a2a-gateway] register failed: ${res ? res.status : "network error"}`);
      return false;
    }
    try {
      const j = (await res.clone?.().json?.().catch?.(() => null)) ?? (await res.json().catch(() => null));
      this.lastState = String(j?.state ?? "");
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
      if (!res?.ok) return;
      const json = (await res.json()) as { peers?: unknown };
      if (at !== this.epoch) return; // stop() cleared the overlay — don't refill it
      this.onPeers(
        mergeGatewayPeers({
          gatewayUrl: this.cfg.url,
          token: this.cfg.token,
          selfName: this.name,
          selfUrl: this.lastUrl,
          selfAutoName: this.autoName,
          entries: json?.peers,
          timeoutMs: this.cfg.callTimeoutMs ?? 120_000,
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
