/**
 * A2A config + peer registry.
 *
 * Config precedence (highest first): tool/command params → env (A2A_*) →
 * settings.json `a2a` key → cwd `.env.local` walk → defaults.
 * Mirrors the pi-munin/pi-evolve pattern.
 */

import { existsSync, readFileSync } from "node:fs";
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
}

export interface A2AConfig {
  peers: Record<string, Peer>;
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
}

const DEFAULTS: A2AConfig = {
  peers: {},
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
    server: { ...DEFAULTS.server },
    timeouts: { ...DEFAULTS.timeouts },
    retryAttempts: DEFAULTS.retryAttempts,
    verifySsl: DEFAULTS.verifySsl,
  };

  // Peers from settings.json `a2a.peers`
  const peers = (s.peers && typeof s.peers === "object" ? s.peers : {}) as Record<string, any>;
  for (const [name, entry] of Object.entries(peers)) {
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

  return cfg;
}

// ---------------------------------------------------------------------------
// Peer registry
// ---------------------------------------------------------------------------

/** Resolve a peer by configured name OR treat as a direct http(s) URL. */
export function resolvePeer(cfg: A2AConfig, agent: string): Peer | null {
  const a = String(agent || "").trim();
  if (!a) return null;
  if (/^https?:\/\//i.test(a)) {
    return { url: a, auth: { type: "none" }, timeout: cfg.timeouts.send, capabilities: [] };
  }
  return cfg.peers[a] ?? null;
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
