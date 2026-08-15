/**
 * Unified discovery — merges three peer sources into one ranked list.
 *
 * 1. Local file registry (live entries, highest fidelity: cwd/model/tools).
 * 2. mDNS peers (network, metadata from TXT record).
 * 3. Configured peers (static `a2a.peers` in settings.json).
 *
 * Merge dedupes by URL (normalized) and tags each with its source so the
 * model/user can pick the right peer (by cwd/model fit) before a2a_call.
 */

import type { A2AConfig, Peer } from "./config";
import { list as listRegistry, type SessionDescriptor } from "./registry";
import type { MdnsPeer } from "./mdns";

export type PeerSource = "local" | "mdns" | "config" | "gateway";

export interface DiscoveredPeer {
  name: string;
  url: string;
  source: PeerSource;
  cwd?: string;
  model?: { provider: string; id: string; name?: string } | null;
  tools?: string[];
  /** True for local + config peers; mDNS peers are live but unverified at list time. */
  alive: boolean;
}

function normUrl(u: string): string {
  return String(u || "").trim().replace(/\/+$/, "").toLowerCase();
}

/** Merge local-registry, mDNS, configured, and gateway-proxy peers; dedupe
 *  by URL. `selfUrl` (if provided) excludes the caller's own entry so a session
 *  doesn't see itself as a delegation target. Gateway peers are a read-only
 *  overlay (`gw/<name>` keys, refreshed after each gateway heartbeat). */
export function listPeers(opts: {
  cfg: A2AConfig;
  piDir: string;
  mdnsPeers?: MdnsPeer[];
  /** Skip this URL (the caller's own inbound URL) from the result. */
  selfUrl?: string;
  /** Gateway proxy overlay (`gw/<name>` → peer) — appended last, never overrides. */
  gatewayPeers?: Record<string, Peer>;
}): DiscoveredPeer[] {
  const byUrl = new Map<string, DiscoveredPeer>();
  const selfKey = opts.selfUrl ? normUrl(opts.selfUrl) : "";

  // 1. Local file registry (live, swept).
  const local: SessionDescriptor[] = listRegistry({
    piDir: opts.piDir,
    ttlSec: opts.cfg.discovery.local.ttlSec,
  });
  for (const d of local) {
    const key = normUrl(d.url);
    if (!key || key === selfKey) continue;
    byUrl.set(key, {
      name: d.agentName || d.sessionName || `pi:${d.pid}`,
      url: d.url,
      source: "local",
      cwd: d.cwd,
      model: d.model,
      tools: d.tools,
      alive: true,
    });
  }

  // 2. mDNS peers (network). Don't clobber a local entry (same URL = same host).
  for (const m of opts.mdnsPeers ?? []) {
    const url = m.txt?.url || (m.host ? `http://${m.host}:${m.port}/` : "");
    const key = normUrl(url);
    if (!key || key === selfKey || byUrl.has(key)) continue;
    byUrl.set(key, {
      name: m.name,
      url,
      source: "mdns",
      cwd: m.txt?.cwd,
      model: m.txt?.model ? parseModel(m.txt.model) : undefined,
      alive: true,
    });
  }

  // 3. Configured peers (static).
  for (const [name, peer] of Object.entries(opts.cfg.peers ?? {})) {
    const key = normUrl(peer.url);
    if (!key || key === selfKey || byUrl.has(key)) continue;
    byUrl.set(key, {
      name,
      url: peer.url,
      source: "config",
      alive: true,
    });
  }

  // 4. Gateway proxy peers (read-only overlay; last so it never shadows
  //    same-URL local/config entries).
  for (const [name, peer] of Object.entries(opts.gatewayPeers ?? {})) {
    const key = normUrl(peer.url);
    if (!key || key === selfKey || byUrl.has(key)) continue;
    byUrl.set(key, {
      name,
      url: peer.url,
      source: "gateway",
      alive: true,
    });
  }

  return [...byUrl.values()];
}

function parseModel(s: string): { provider: string; id: string } | undefined {
  const i = s.indexOf("/");
  if (i <= 0) return undefined;
  return { provider: s.slice(0, i), id: s.slice(i + 1) };
}

/** Human-readable rendering for the a2a_peers tool / /a2a-peers command.
 *  Fields are sanitized (single-line, length-capped) because they originate
 *  from untrusted sources (mDNS TXT, world-readable registry files). */
export function formatPeers(peers: DiscoveredPeer[]): string {
  if (peers.length === 0) {
    return "No peers discovered. Enable a2a.server.enabled on other Pi sessions, or configure a2a.peers.";
  }
  const lines: string[] = [`Discovered peers (${peers.length}):`];
  for (const p of peers) {
    const parts = [`  - ${clean(p.name)}`, clean(p.url), `[${p.source}]`];
    if (p.cwd) parts.push(`cwd=${clean(p.cwd)}`);
    if (p.model) parts.push(`model=${clean(p.model.provider)}/${clean(p.model.id)}`);
    if (p.tools && p.tools.length) parts.push(`tools=${p.tools.slice(0, 8).map(clean).join(",")}`);
    lines.push(parts.join("  "));
  }
  return lines.join("\n");
}

/** Collapse whitespace and cap length — defends against prompt injection via
 *  newlines/control chars in untrusted peer fields (mDNS TXT, registry files). */
export function clean(s: unknown): string {
  return String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
