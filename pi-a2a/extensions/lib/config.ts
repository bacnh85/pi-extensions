/**
 * A2A config + peer registry.
 *
 * Config precedence (highest first): tool/command params → settings.json
 * `a2a` key → env (A2A_*) → cwd `.env.local` walk → defaults.
 * Mirrors the pi-munin/pi-evolve pattern.
 *
 * NOTE: an explicit `discovery.gateway.enabled` in settings.json overrides
 * `A2A_GATEWAY_ENABLED` (the env var only feeds the fallback when the
 * settings field is absent).
 *
 * Multiple gateways (0.6.0): the legacy single `discovery.gateway` block
 * (settings or env) coexists with the new `discovery.gateways` map. The
 * canonical runtime view is `gatewayEntries(cfg)` — legacy yields the
 * derived key `host-port` (fallback `default`), named entries yield their
 * own keys. Every consumer (server lifecycle, overlay, panel, persistence)
 * iterates that list only.
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
  /** True for a2a-switchboard proxy peers (`gw/<key>/<name>`): the card fetch is
   *  skipped (a proxied card may advertise the peer's DIRECT url, which would
   *  bypass the gateway) and JSON-RPC is pinned to the proxy URL. */
  viaGateway?: boolean;
  /** Gateway origin that published this proxied peer (set by mergeGatewayPeers).
   *  Lets the client SSRF-pin the proxy URL to the peer's own gateway even
   *  when the live config has no gateway block (overlay-first routing). */
  gatewayUrl?: string;
}

/** One upstream a2a-switchboard registration entry. */
export interface GatewayEntry {
  /** Explicit on/off. Defaults to true when url+token are both set and no
   *  explicit value is given (backward compat); explicit false disables. */
  enabled: boolean;
  url: string;
  token: string;
  name?: string;
  upstreamToken?: string;
  heartbeatSec?: number;
  /** Open a reverse channel so firewalled peers receive traffic (default true). */
  channel?: boolean;
}

/** Gateway map keys must match the peer-name charset — they land in
 *  `gw/<key>/<name>` peer keys. */
export const GATEWAY_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Derive a stable gateway key from a gateway URL (host:port). */
export function gatewayKeyFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/[^A-Za-z0-9._-]/g, "-");
    const port = u.port ? `-${u.port}` : "";
    const key = `${host}${port}`;
    return GATEWAY_KEY_RE.test(key) ? key : "default";
  } catch {
    return "default";
  }
}

/** Canonical runtime view: every configured gateway as `{ key, entry }`.
 *  Legacy `discovery.gateway` (settings/env) maps to the derived key; the
 *  `discovery.gateways` map contributes its own keys (invalid keys skipped).
 *  A map entry whose key equals the legacy derived key wins — the legacy
 *  block is skipped so each key maps to exactly one upstream. */
export function gatewayEntries(cfg: A2AConfig): Array<{ key: string; entry: GatewayEntry }> {
  const out: Array<{ key: string; entry: GatewayEntry }> = [];
  const legacyKey = cfg.discovery.gateway ? gatewayKeyFromUrl(cfg.discovery.gateway.url) : null;
  const mapKeys = new Set<string>();
  for (const [key, entry] of Object.entries(cfg.discovery.gateways ?? {})) {
    if (!GATEWAY_KEY_RE.test(key)) continue;
    mapKeys.add(key);
    out.push({ key, entry });
  }
  if (cfg.discovery.gateway && (!legacyKey || !mapKeys.has(legacyKey))) {
    out.unshift({ key: legacyKey!, entry: cfg.discovery.gateway });
  }
  return out;
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
    /** Upstream a2a-switchboard registration (annex: gateway layer). */
    gateway?: GatewayEntry;
    /** Multiple upstream a2a-switchboard gateways (0.6.0) — keyed map; keys must match
     *  `[A-Za-z0-9._-]{1,64}` (they land in `gw/<key>/<name>` peer keys). */
    gateways?: Record<string, GatewayEntry>;
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

  // Upstream a2a-switchboard registration. The block is materialized whenever
  // ANY gateway config exists (settings `dg` has fields, or url/token from
  // env) so the panel can display/edit it — including explicitly-disabled
  // gateways (enabled:false), which must stay visible or unrelated discovery
  // edits would erase them. Registration only happens when enabled AND
  // url+token are set. `enabled` defaults to true when url+token exist and
  // no explicit value (backward compat with the pre-0.5.0 implicit activation).
  const dg = (d.gateway && typeof d.gateway === "object" ? d.gateway : {}) as Record<string, any>;
  const gwUrl = String(dg.url ?? env.A2A_GATEWAY_URL ?? "");
  const gwToken = String(dg.token ?? env.A2A_GATEWAY_TOKEN ?? "");
  const hasSettingsGateway = Object.keys(dg).length > 0;
  const gwEnabled =
    dg.enabled !== undefined
      ? bool(dg.enabled, true)
      : bool(env.A2A_GATEWAY_ENABLED, Boolean(gwUrl && gwToken));
  if (hasSettingsGateway || gwUrl || gwToken) {
    cfg.discovery.gateway = {
      enabled: gwEnabled,
      url: gwUrl,
      token: gwToken,
      name: dg.name ? String(dg.name) : undefined,
      upstreamToken: dg.upstreamToken ? String(dg.upstreamToken) : undefined,
      heartbeatSec: num(dg.heartbeatSec, 60),
      channel: dg.channel === undefined ? undefined : bool(dg.channel, true),
    };
  }

  // Multiple gateways (0.6.0): the `discovery.gateways` map. Same per-entry
  // materialization as the legacy block; invalid keys are skipped (they would
  // pollute the `gw/<key>/` peer namespace).
  const dgs = (d.gateways && typeof d.gateways === "object" ? d.gateways : {}) as Record<string, any>;
  const gateways: Record<string, GatewayEntry> = {};
  for (const [key, raw] of Object.entries(dgs)) {
    if (!GATEWAY_KEY_RE.test(key)) continue;
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, any>;
    const u = String(g.url ?? "");
    const t = String(g.token ?? "");
    const enabled = g.enabled !== undefined ? bool(g.enabled, true) : Boolean(u && t);
    gateways[key] = {
      enabled,
      url: u,
      token: t,
      name: g.name ? String(g.name) : undefined,
      upstreamToken: g.upstreamToken ? String(g.upstreamToken) : undefined,
      heartbeatSec: num(g.heartbeatSec, 60),
      channel: g.channel === undefined ? undefined : bool(g.channel, true),
    };
  }
  if (Object.keys(gateways).length > 0) cfg.discovery.gateways = gateways;

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
    // Gateway block(s) — undefined (not set) leaves them alone; set replaces.
    if (patch.discovery.gateway !== undefined) cfg.discovery.gateway = patch.discovery.gateway;
    if (patch.discovery.gateways !== undefined) cfg.discovery.gateways = patch.discovery.gateways;
  }
  if (patch.ui) Object.assign(cfg.ui, patch.ui);
}

// ---------------------------------------------------------------------------
// Settings.json writer (0.3.0) — the /a2a-config panel persists edits here
// ---------------------------------------------------------------------------

/**
 * Build the settings.json patch for the /a2a-config panel (pure, testable).
 *
 * Rules:
 * - server persisted ONLY when a server field changed (env-sourced secrets
 *   like sharedToken/peerTokens must never be copied to disk by a
 *   discovery-only edit).
 * - discovery is MERGED over the existing `a2a.discovery` (a gateway block
 *   already in settings.json survives unrelated discovery edits
 *   byte-for-byte); the gateway sub-block is written only when the user
 *   actually edited a gateway field, so env-sourced secrets are not copied.
 * - When the gateway block is written, unedited rows (token / upstreamToken
 *   / name) keep the value from the EXISTING settings file (not the
 *   env-sourced working value) — a heartbeat-only edit must not copy an env
 *   token to disk, and the runtime-resolved registration name must never be
 *   pinned. `editedGatewayKeys` carries the row keys the user touched
 *   (gateway.token / gateway.upstreamToken / gateway.name).
 * - The same per-entry rules apply to the `discovery.gateways` map (0.6.0):
 *   entries keep unedited secret fields from the file; env-sourced entries
 *   (not in settings.json) are not written unless their key was edited;
 *   row keys are `gw.<key>.token` etc.
 * - peers/selfIdentity/ui persisted only when changed.
 */
export function buildA2ASettingsPatch(opts: {
  cfg: A2AConfig;
  working: A2AConfig;
  peerChanges: boolean;
  gatewayChanged: boolean;
  /** Row keys the user edited (gateway.* / gw.<key>.*). */
  editedGatewayKeys?: Set<string>;
}): (a2a: any) => any {
  const { cfg, working, peerChanges, gatewayChanged, editedGatewayKeys } = opts;
  const serverChanged = JSON.stringify(working.server) !== JSON.stringify(cfg.server);
  const discoveryChanged = JSON.stringify(working.discovery) !== JSON.stringify(cfg.discovery);
  const workingDiscovery = { ...working.discovery } as Record<string, unknown>;
  if (!gatewayChanged) delete workingDiscovery.gateway;
  if (!gatewayChanged) delete workingDiscovery.gateways;
  return (a2a: any) => {
    // The server block is persisted wholesale ONLY when a server field
    // changed — but the panel never exposes sharedToken/peerTokens/workspace/
    // publicUrl/skills, so those keep the value from the EXISTING settings
    // file (never copy env-sourced secrets to disk on a port/host edit).
    let serverPatch: Record<string, unknown> | undefined;
    if (serverChanged) {
      serverPatch = { ...working.server } as Record<string, unknown>;
      const ex = (a2a.server ?? {}) as Record<string, unknown>;
      serverPatch.sharedToken = ex.sharedToken ?? "";
      serverPatch.peerTokens = ex.peerTokens ?? {};
      serverPatch.workspace = ex.workspace ?? "";
      serverPatch.publicUrl = ex.publicUrl ?? "";
      serverPatch.skills = ex.skills ?? [];
    }
    // Merge discovery over the existing settings block; the gateway sub-block
    // (when written) keeps unedited secret fields from the file.
    const mergedDiscovery = { ...(a2a.discovery ?? {}) } as Record<string, unknown>;
    // ALWAYS merge the non-gateway working discovery (local/mdns/enrichCard)
    // over the file block — a combined gateway + discovery edit must keep
    // both. Only the gateway sub-blocks get the special unedited-secret
    // handling below.
    const { gateway: _gw, gateways: _gws, ...workingRest } = workingDiscovery;
    Object.assign(mergedDiscovery, workingRest);
    if (gatewayChanged && workingDiscovery.gateway && typeof workingDiscovery.gateway === "object") {
      const g = { ...(workingDiscovery.gateway as Record<string, unknown>) };
      const existing = (mergedDiscovery.gateway ?? {}) as Record<string, unknown>;
      if (!editedGatewayKeys?.has("gateway.token")) g.token = existing.token ?? "";
      if (!editedGatewayKeys?.has("gateway.upstreamToken")) g.upstreamToken = existing.upstreamToken;
      // The registration name is runtime-resolved (server auto-name) unless
      // the user typed it — never persist an ephemeral per-session name.
      if (!editedGatewayKeys?.has("gateway.name")) g.name = existing.name ?? "";
      mergedDiscovery.gateway = g;
    }
    // Same rules for the `gateways` map: merge per-entry over the file's
    // entries, keeping unedited secrets from the file; drop entries the user
    // removed (present in file but not in working).
    if (gatewayChanged && workingDiscovery.gateways && typeof workingDiscovery.gateways === "object") {
      const wg = workingDiscovery.gateways as Record<string, Record<string, unknown>>;
      const existing = (mergedDiscovery.gateways ?? {}) as Record<string, Record<string, unknown>>;
      const out: Record<string, Record<string, unknown>> = {};
      for (const [key, entry] of Object.entries(wg)) {
        const e = { ...entry };
        const ex = existing[key];
        if (ex) {
          // Entry already in settings.json: keep unedited secret fields from
          // the file (a heartbeat-only edit must not copy an env token, and
          // the runtime-resolved registration name must never be pinned).
          if (!editedGatewayKeys?.has(`gw.${key}.token`)) e.token = ex.token ?? "";
          if (!editedGatewayKeys?.has(`gw.${key}.upstreamToken`)) e.upstreamToken = ex.upstreamToken;
          if (!editedGatewayKeys?.has(`gw.${key}.name`)) e.name = ex.name ?? "";
        }
        // Entry absent from the file → NEW (panel-added or override-typed,
        // since discovery.gateways has no env source): persist verbatim so a
        // token typed in the add-flow is not wiped. Fall through.
        out[key] = e;
      }
      mergedDiscovery.gateways = out;
    }
    return {
      ...a2a,
      ...(serverPatch ? { server: serverPatch } : {}),
      ...(peerChanges ? { peers: working.peers } : {}),
      ...(discoveryChanged ? { discovery: mergedDiscovery } : {}),
      ...(working.selfIdentity !== cfg.selfIdentity ? { selfIdentity: working.selfIdentity } : {}),
      ...(JSON.stringify(working.ui) !== JSON.stringify(cfg.ui) ? { ui: working.ui } : {}),
    };
  };
}

/**
 * Read-modify-write the `a2a` key in settings.json, preserving all other keys.
 *
 * Target resolution mirrors readSettingsA2A: the first existing file that has
 * an `a2a` key, else the global settings path (PI_CODING_AGENT_DIR, then
 * ~/.pi/agent — the canonical Pi agent dir; never ~/.pi/agents).
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
  // Fall back to the canonical global settings file (Pi's getAgentDir()),
  // NOT the last candidate — in the non-explicit branch that is the legacy
  // ~/.pi/agents path, which Pi never reads; a fresh save there would render
  // an orphan a2a block invisible to the real settings.
  target ??= explicit
    ? candidates[candidates.length - 1]!
    : join(homedir(), ".pi", "agent", "settings.json");

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
  return cfg.peers[a] ?? getGatewayPeers()[a] ?? null;
}

// ---------------------------------------------------------------------------
// Gateway peer overlay (read-only, in-memory — never persisted to settings.json)
// ---------------------------------------------------------------------------

/** Per-gateway overlay slices, keyed by gateway key. Each GatewayUpstream
 *  instance refreshes its own slice; getGatewayPeers() flattens them. */
const gatewayOverlays: Record<string, Record<string, Peer>> = {};

/** Replace ONE gateway's overlay slice (`{}` clears just that gateway — the
 *  other gateways' peers stay visible). Keys are the callable names
 *  (`gw/<key>/<name>`), values are ready-to-route peers. */
export function updateGatewayPeers(key: string, peers: Record<string, Peer>): void {
  gatewayOverlays[key] = peers;
}

/** Alias kept for backward compat with existing tests/callers: updates the
 *  overlay slice for the legacy `default` gateway. */
export function setGatewayPeers(peers: Record<string, Peer>): void {
  gatewayOverlays.default = peers;
}

/** Current flattened gateway peer overlay (snapshot for listing/dedup). */
export function getGatewayPeers(): Record<string, Peer> {
  const out: Record<string, Peer> = {};
  for (const slice of Object.values(gatewayOverlays)) {
    Object.assign(out, slice);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gateway registration names (read-only, in-memory — never persisted)
// ---------------------------------------------------------------------------

/** Per-gateway registration names, keyed by gateway key. Set by the server at
 *  start; cleared (deleted) when that gateway's upstream stops. */
const gatewayRegistrationNames: Record<string, string> = {};

/** Publish the name this session registered under on ONE upstream gateway
 *  (set by the server at start). Session-scoped, in-memory only — NEVER
 *  persisted to settings.json. */
export function setGatewayRegistrationName(name: string | null, key = "default"): void {
  if (name === null) delete gatewayRegistrationNames[key];
  else gatewayRegistrationNames[key] = name;
}

/** The name registered under the given gateway key, or null. */
export function getGatewayCallerName(key: string): string | null {
  return gatewayRegistrationNames[key] ?? null;
}

/** Legacy single-gateway accessor: the default key's registration name. */
export function getGatewayRegistrationName(): string | null {
  return gatewayRegistrationNames.default ?? null;
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
