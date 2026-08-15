/**
 * A2A config + peer registry.
 *
 * Config precedence (highest first): tool/command params → env (A2A_*) →
 * settings.json `a2a` key → cwd `.env.local` walk → defaults.
 * Mirrors the pi-munin/pi-evolve pattern.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parsePeerTokens } from "./security";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PeerTokensMap = Record<string, string>;

export interface PeerAuth {
  type: "bearer" | "apiKey" | "none";
  token?: string;
}

export interface Peer {
  url: string;
  auth: PeerAuth;
  timeout: number;
  capabilities: string[];
  description?: string;
  /** True for agent-gateway proxy peers (`gw/<name>`): the card fetch is
   *  skipped (a proxied card may advertise the peer's DIRECT url, which would
   *  bypass the gateway) and JSON-RPC is pinned to the proxy URL. */
  viaGateway?: boolean;
}

export interface A2AConfig {
  peers: Record<string, Peer>;
  /** Name THIS session presents as the caller identity (outbound). Maps to an
   *  entry in `server.peerTokens` — that token is attached to outbound calls so
   *  the receiver attributes the call to this session (not the shared token's
   *  anonymous `ip:` identity). Empty = use the shared token (anonymous caller). */
  selfIdentity: string;
  server: {
    enabled: boolean;
    port: number;
    /** If the configured port is busy (EADDRINUSE), try up to this many
     * consecutive ports before falling back to OS-assigned (0). 0 = configured
     * port only, straight to OS-assigned on conflict. */
    portFallback: number;
    host: string;
    workspace: string;
    maxConcurrent: number;
    replyTimeoutSec: number;
    agentName: string;
    publicUrl: string;
    sharedToken: string;
    peerTokens: PeerTokensMap;
    trustedPeers: string[];
    allowAllUsers: boolean;
    maxPingpongTurns: number;
    rateLimitPerMin: number;
    skills: Array<{ id: string; name: string; description: string; tags?: string[] }>;
  };
  timeouts: { send: number; async: number; stream: number };
  retryAttempts: number;
  verifySsl: boolean;
  /** Session self-declaration + local/network discovery (0.2.0). */
  discovery: {
    local: { enabled: boolean; heartbeatSec: number; ttlSec: number };
    mdns: { enabled: boolean; serviceType: string };
    /** Upstream agent-gateway registration (annex: gateway layer). */
    gateway?: {
      url: string;
      token: string;
      name?: string;
      upstreamToken?: string;
      heartbeatSec?: number;
      /** Open a reverse channel so firewalled peers receive traffic (default true). */
      channel?: boolean;
    };
    enrichCard: boolean;
  };
  /** Host-TUI presentation (0.3.0). */
  ui: {
    /** Show inbound task activity as transcript messages (default true). When
     *  false, activity is still surfaced via notify() toasts + footer status. */
    transcript: boolean;
  };
}

const DEFAULTS: A2AConfig = {
  peers: {},
  selfIdentity: "",
  server: {
    enabled: false,
    port: 9910,
    portFallback: 10,
    host: "127.0.0.1",
    workspace: "",
    maxConcurrent: 3,
    replyTimeoutSec: 300,
    agentName: "",
    publicUrl: "",
    sharedToken: "",
    peerTokens: {},
    trustedPeers: [],
    allowAllUsers: false,
    maxPingpongTurns: 5,
    rateLimitPerMin: 60,
    skills: [],
  },
  timeouts: { send: 120000, async: 30000, stream: 120000 },
  retryAttempts: 2,
  verifySsl: true,
  discovery: {
    local: { enabled: true, heartbeatSec: 15, ttlSec: 60 },
    mdns: { enabled: false, serviceType: "a2a" },
    gateway: undefined,
    enrichCard: true,
  },
  ui: { transcript: true },
};

// ---------------------------------------------------------------------------
// .env.local walk (cwd → root), like pi-munin
// ---------------------------------------------------------------------------

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function envCandidates(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  for (let i = 0; i < 12; i++) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const piGlobal = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  dirs.push(piGlobal);
  return dirs.map((d) => join(d, ".env.local")).filter(existsSync);
}

export function loadEnv(cwd: string): Record<string, string> {
  // process.env is the base (lowest precedence); .env.local files override it.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && k.startsWith("A2A_")) env[k] = v;
  }
  // global .env.local first (lowest file precedence), then cwd→root walk (highest).
  const piGlobal = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const globalPath = join(piGlobal, ".env.local");
  if (existsSync(globalPath)) {
    try {
      Object.assign(env, parseDotEnv(readFileSync(globalPath, "utf-8")));
    } catch {
      /* ignore */
    }
  }
  // Walk from filesystem root up to cwd so cwd wins.
  const paths = envCandidates(cwd).reverse();
  for (const p of paths) {
    try {
      Object.assign(env, parseDotEnv(readFileSync(p, "utf-8")));
    } catch {
      /* ignore */
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Settings.json `a2a` key reader
// ---------------------------------------------------------------------------

function readSettingsA2A(ctx: ExtensionContext | undefined, cwd: string): any {
  // Try the SDK settings infra first (object form), then on-disk settings.json.
  const fromCtx = (ctx as any)?.settings?.a2a;
  if (fromCtx && typeof fromCtx === "object" && !Array.isArray(fromCtx)) return fromCtx;
  // When PI_CODING_AGENT_DIR is set (tests use this for isolation), do NOT fall
  // back to the operator's hardcoded ~/.pi/agent path — only cwd + that dir.
  const explicit = process.env.PI_CODING_AGENT_DIR;
  const candidates = explicit
    ? [join(cwd, ".pi", "settings.json"), join(explicit, "settings.json")]
    : [
        join(cwd, ".pi", "settings.json"),
        join(homedir(), ".pi", "agent", "settings.json"),
        join(homedir(), ".pi", "agents", "settings.json"),
      ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf-8"));
      if (j?.a2a && typeof j.a2a === "object") return j.a2a;
    } catch {
      /* ignore */
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Merge settings + env into config
// ---------------------------------------------------------------------------

function num(v: any, fallback: number): number {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return Number.isFinite(n) ? n : fallback;
}

function bool(v: any, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(1|true|yes|on)$/i.test(v.trim());
  return fallback;
}

export function loadConfig(opts: {
  ctx?: ExtensionContext;
  cwd: string;
  env?: Record<string, string>;
}): A2AConfig {
  const { ctx, cwd } = opts;
  const env = opts.env ?? loadEnv(cwd);
  const s = readSettingsA2A(ctx, cwd);

  const cfg: A2AConfig = {
    peers: {},
    selfIdentity: "",
    server: { ...DEFAULTS.server },
    timeouts: { ...DEFAULTS.timeouts },
    retryAttempts: DEFAULTS.retryAttempts,
    verifySsl: DEFAULTS.verifySsl,
    discovery: {
      local: { ...DEFAULTS.discovery.local },
      mdns: { ...DEFAULTS.discovery.mdns },
      enrichCard: DEFAULTS.discovery.enrichCard,
    },
    ui: { ...DEFAULTS.ui },
  };

  // Peers from settings.json `a2a.peers`
  const peers = (s.peers && typeof s.peers === "object" ? s.peers : {}) as Record<string, any>;  for (const [name, entry] of Object.entries(peers)) {
    if (!entry || typeof entry !== "object") continue;
    cfg.peers[name] = {
      url: String(entry.url || ""),
      auth: {
        type: (entry.auth?.type as PeerAuth["type"]) || "none",
        token: entry.auth?.token,
      },
      timeout: num(entry.timeout, DEFAULTS.timeouts.send / 1000) * 1000,
      capabilities: Array.isArray(entry.capabilities) ? entry.capabilities.map(String) : [],
      description: entry.description ? String(entry.description) : undefined,
    };
  }

  // Server settings
  const srv = (s.server && typeof s.server === "object" ? s.server : {}) as Record<string, any>;
  cfg.server.enabled = bool(srv.enabled ?? env.A2A_SERVER_ENABLED, DEFAULTS.server.enabled);
  cfg.server.port = num(srv.port ?? env.A2A_PORT, DEFAULTS.server.port);
  cfg.server.portFallback = num(srv.portFallback ?? env.A2A_PORT_FALLBACK, DEFAULTS.server.portFallback);
  cfg.server.host = String(srv.host ?? env.A2A_HOST ?? DEFAULTS.server.host);
  cfg.server.workspace = String(srv.workspace ?? "");
  cfg.server.maxConcurrent = num(srv.maxConcurrent, DEFAULTS.server.maxConcurrent);
  cfg.server.replyTimeoutSec = num(srv.replyTimeoutSec ?? env.A2A_REPLY_TIMEOUT, DEFAULTS.server.replyTimeoutSec);
  cfg.server.agentName = String(srv.agentName ?? env.A2A_AGENT_NAME ?? "");
  cfg.server.publicUrl = String(srv.publicUrl ?? env.A2A_PUBLIC_URL ?? "");
  cfg.server.sharedToken = String(srv.sharedToken ?? env.A2A_BEARER_TOKEN ?? "");
  cfg.server.peerTokens = parsePeerTokens(
    typeof srv.peerTokens === "string"
      ? srv.peerTokens
      : env.A2A_PEER_TOKENS,
  );
  cfg.server.trustedPeers = Array.isArray(srv.trustedPeers)
    ? srv.trustedPeers.map(String)
    : (env.A2A_TRUSTED_PEERS || "").split(",").map((x) => x.trim()).filter(Boolean);
  cfg.server.allowAllUsers = bool(srv.allowAllUsers ?? env.A2A_ALLOW_ALL_USERS, DEFAULTS.server.allowAllUsers);
  cfg.server.maxPingpongTurns = num(srv.maxPingpongTurns ?? env.A2A_MAX_PINGPONG_TURNS, DEFAULTS.server.maxPingpongTurns);
  cfg.server.rateLimitPerMin = num(srv.rateLimitPerMin ?? env.A2A_RATE_LIMIT, DEFAULTS.server.rateLimitPerMin);
  cfg.server.skills = Array.isArray(srv.skills) ? srv.skills : [];

  // Timeouts
  const t = (s.timeouts && typeof s.timeouts === "object" ? s.timeouts : {}) as Record<string, any>;
  cfg.timeouts.send = num(t.send, DEFAULTS.timeouts.send);
  cfg.timeouts.async = num(t.async, DEFAULTS.timeouts.async);
  cfg.timeouts.stream = num(t.stream, DEFAULTS.timeouts.stream);

  cfg.retryAttempts = num(s.retryAttempts, DEFAULTS.retryAttempts);
  cfg.verifySsl = bool(s.verifySsl ?? env.A2A_VERIFY_SSL, DEFAULTS.verifySsl);

  // Discovery (0.2.0)
  const d = (s.discovery && typeof s.discovery === "object" ? s.discovery : {}) as Record<string, any>;
  const dl = (d.local && typeof d.local === "object" ? d.local : {}) as Record<string, any>;
  const dm = (d.mdns && typeof d.mdns === "object" ? d.mdns : {}) as Record<string, any>;
  cfg.discovery.local.enabled = bool(dl.enabled ?? env.A2A_DISCOVERY_LOCAL, DEFAULTS.discovery.local.enabled);
  cfg.discovery.local.heartbeatSec = num(dl.heartbeatSec ?? env.A2A_HEARTBEAT_SEC, DEFAULTS.discovery.local.heartbeatSec);
  cfg.discovery.local.ttlSec = num(dl.ttlSec ?? env.A2A_TTL_SEC, DEFAULTS.discovery.local.ttlSec);
  cfg.discovery.mdns.enabled = bool(dm.enabled ?? d.mdnsEnabled ?? env.A2A_DISCOVERY_MDNS, DEFAULTS.discovery.mdns.enabled);
  cfg.discovery.mdns.serviceType = String(dm.serviceType ?? env.A2A_MDNS_TYPE ?? DEFAULTS.discovery.mdns.serviceType);
  cfg.discovery.enrichCard = bool(d.enrichCard ?? env.A2A_ENRICH_CARD, DEFAULTS.discovery.enrichCard);

  // Upstream agent-gateway registration — active only when url+token are set.
  const dg = (d.gateway && typeof d.gateway === "object" ? d.gateway : {}) as Record<string, any>;
  const gwUrl = String(dg.url ?? env.A2A_GATEWAY_URL ?? "");
  const gwToken = String(dg.token ?? env.A2A_GATEWAY_TOKEN ?? "");
  if (gwUrl && gwToken) {
    cfg.discovery.gateway = {
      url: gwUrl,
      token: gwToken,
      name: dg.name ? String(dg.name) : undefined,
      upstreamToken: dg.upstreamToken ? String(dg.upstreamToken) : undefined,
      heartbeatSec: num(dg.heartbeatSec, 60),
      channel: dg.channel === undefined ? undefined : bool(dg.channel, true),
    };
  }

  // Outbound caller identity (0.2.0): the name THIS session presents. Must
  // match an entry in server.peerTokens so the receiver attributes the call
  // here. Empty → fall back to the shared token (anonymous caller).
  cfg.selfIdentity = String(s.selfIdentity ?? env.A2A_SELF_IDENTITY ?? "");

  // Host-TUI presentation (0.3.0)
  const ui = (s.ui && typeof s.ui === "object" ? s.ui : {}) as Record<string, any>;
  cfg.ui.transcript = bool(ui.transcript ?? env.A2A_UI_TRANSCRIPT, DEFAULTS.ui.transcript);

  // Live in-memory overrides (set by the /a2a-config panel) — highest
  // precedence, above env + settings.json, so panel edits apply immediately
  // without /reload.
  if (configOverrides) applyOverrides(cfg, configOverrides);

  return cfg;
}

// ---------------------------------------------------------------------------
// Live config overrides (0.3.0) — panel edits apply without /reload
// ---------------------------------------------------------------------------

let configOverrides: Partial<A2AConfig> | null = null;

/** Replace the live in-memory config overrides (null clears them). */
export function setConfigOverrides(patch: Partial<A2AConfig> | null): void {
  configOverrides = patch;
}

/** Merge a partial A2AConfig onto a full config (deep for known nested blocks). */
function applyOverrides(cfg: A2AConfig, patch: Partial<A2AConfig>): void {
  if (patch.peers) cfg.peers = patch.peers;
  if (patch.selfIdentity !== undefined) cfg.selfIdentity = patch.selfIdentity;
  if (patch.server) Object.assign(cfg.server, patch.server);
  if (patch.timeouts) Object.assign(cfg.timeouts, patch.timeouts);
  if (patch.retryAttempts !== undefined) cfg.retryAttempts = patch.retryAttempts;
  if (patch.verifySsl !== undefined) cfg.verifySsl = patch.verifySsl;
  if (patch.discovery) {
    if (patch.discovery.local) Object.assign(cfg.discovery.local, patch.discovery.local);
    if (patch.discovery.mdns) Object.assign(cfg.discovery.mdns, patch.discovery.mdns);
    if (patch.discovery.enrichCard !== undefined) cfg.discovery.enrichCard = patch.discovery.enrichCard;
  }
  if (patch.ui) Object.assign(cfg.ui, patch.ui);
}

// ---------------------------------------------------------------------------
// Settings.json writer (0.3.0) — the /a2a-config panel persists edits here
// ---------------------------------------------------------------------------

/**
 * Read-modify-write the `a2a` key in settings.json, preserving all other keys.
 *
 * Target resolution mirrors readSettingsA2A: the first existing file that has
 * an `a2a` key, else the global settings path (PI_CODING_AGENT_DIR, then
 * ~/.pi/agent, then ~/.pi/agents).
 *
 * ponytail: no file lock (SDK uses proper-lockfile internally, but that's a
 * dependency we don't need) — settings edits are rare human actions, and the
 * atomic rename prevents torn writes. Concurrent external edits are out of
 * scope.
 */
export function writeSettingsA2A(opts: {
  cwd: string;
  patch: (a2a: any) => any;
}): string {
  const { cwd, patch } = opts;
  const explicit = process.env.PI_CODING_AGENT_DIR;
  const candidates = explicit
    ? [join(cwd, ".pi", "settings.json"), join(explicit, "settings.json")]
    : [
        join(cwd, ".pi", "settings.json"),
        join(homedir(), ".pi", "agent", "settings.json"),
        join(homedir(), ".pi", "agents", "settings.json"),
      ];

  // Prefer the first file that already has an `a2a` key.
  let target: string | undefined;
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf-8"));
      if (j?.a2a && typeof j.a2a === "object") {
        target = p;
        break;
      }
    } catch {
      /* unreadable — try next */
    }
  }
  target ??= candidates[candidates.length - 1]!; // fall back to the last (global)

  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  let json: any = {};
  try {
    json = existsSync(target) ? JSON.parse(readFileSync(target, "utf-8")) : {};
  } catch {
    json = {}; // corrupt file → start fresh (still preserving nothing, safest)
  }
  if (!json.a2a || typeof json.a2a !== "object" || Array.isArray(json.a2a)) json.a2a = {};
  json.a2a = patch(json.a2a) ?? json.a2a;

  // Atomic write: temp file + rename.
  const tmp = target + ".tmp";
  writeFileSync(tmp, JSON.stringify(json, null, 2) + "\n", "utf-8");
  renameSync(tmp, target);
  return target;
}

// ---------------------------------------------------------------------------
// Peer registry
// ---------------------------------------------------------------------------

/** Normalize a URL for dedupe/comparison (lowercase, trailing slashes stripped). */
export function normUrl(u: string): string {
  return String(u || "").trim().replace(/\/+$/, "").toLowerCase();
}

/** Resolve a peer by configured name OR treat as a direct http(s) URL.
 *  When the direct URL is loopback AND listed in `knownLoopbackUrls` (known
 *  peers: configured peers or local-registry entries — same-machine, same
 *  user), a token is auto-attached so discovered local Pi sessions are callable
 *  without manual per-peer config. Token preference:
 *    1. THIS session's own peer token (cfg.selfIdentity → cfg.server.peerTokens)
 *       so the receiver attributes the call to this named session.
 *    2. else the shared token (anonymous caller).
 *  Arbitrary loopback URLs are NOT trusted: a prompt-injected localhost URL
 *  must never receive any credential. */
export function resolvePeer(
  cfg: A2AConfig,
  agent: string,
  opts?: { knownLoopbackUrls?: Set<string> },
): Peer | null {
  const a = String(agent || "").trim();
  if (!a) return null;
  if (/^https?:\/\//i.test(a)) {
    const url = a;
    let auth: PeerAuth = { type: "none" };
    if (isLoopbackHost(url) && opts?.knownLoopbackUrls?.has(normUrl(url))) {
      const token = outboundToken(cfg);
      if (token) auth = { type: "bearer", token };
    }
    return { url, auth, timeout: cfg.timeouts.send, capabilities: [] };
  }
  // Gateway overlay sits BEHIND static config: a configured peer with the
  // same name always wins (overlay is read-only, never overrides settings).
  return cfg.peers[a] ?? gatewayPeers[a] ?? null;
}

// ---------------------------------------------------------------------------
// Gateway peer overlay (read-only, in-memory — never persisted to settings.json)
// ---------------------------------------------------------------------------

let gatewayPeers: Record<string, Peer> = {};

/** Replace the gateway peer overlay. Keys are the callable names (`gw/<name>`),
 *  values are ready-to-route peers (proxy URL + gateway bearer token). */
export function setGatewayPeers(peers: Record<string, Peer>): void {
  gatewayPeers = peers;
}

/** Current gateway peer overlay (snapshot for listing/dedup). */
export function getGatewayPeers(): Record<string, Peer> {
  return gatewayPeers;
}

/** Pick the token to present outbound: prefer this session's own peer token
 *  (so the receiver attributes the call to us), else the shared token. */
function outboundToken(cfg: A2AConfig): string {
  if (cfg.selfIdentity && cfg.server.peerTokens[cfg.selfIdentity]) {
    return cfg.server.peerTokens[cfg.selfIdentity]!;
  }
  return cfg.server.sharedToken;
}

/** True when the URL's host is localhost / 127.0.0.1 / ::1 (brackets stripped). */
function isLoopbackHost(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

/** Auth header(s) for an outbound request. */
export function authHeaders(peer: Peer): Record<string, string> {
  const h: Record<string, string> = {};
  if (peer.auth?.type === "bearer" && peer.auth.token) {
    h.Authorization = `Bearer ${peer.auth.token}`;
  } else if (peer.auth?.type === "apiKey" && peer.auth.token) {
    h.Authorization = `ApiKey ${peer.auth.token}`;
  }
  return h;
}
