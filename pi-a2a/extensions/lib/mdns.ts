/**
 * mDNS / DNS-SD broadcast + discovery (optional).
 *
 * Dynamic-imports `bonjour-service` (RFC 6762/6763 in pure TS, no native
 * bindings). If the package isn't installed → graceful no-op degrade; the file
 * registry + enriched Agent Card still serve discovery. mDNS is the *network*
 * layer; the file registry is the fast *local* one.
 *
 * Service type: `_a2a._tcp` (interoperable with non-Pi A2A peers on the LAN).
 * TXT record carries url/cwd/model so peers can screen without a card fetch.
 *
 * Security/conflict note: bonjour-service defaults the announced host to
 * `os.hostname()`, publishing A/AAAA records that CLAIM the OS local hostname
 * (e.g. `MBP-Sao.local`). On macOS that fights mDNSResponder's ownership of
 * the name and the OS renames the machine ("local hostname already in use").
 * So we always announce a unique, non-OS name: `<hostname>-a2a-<pid>.local`.
 * The instance name gets a pid suffix too, so multiple Pi sessions on one
 * machine don't probe-collide on the same `<name>._a2a._tcp.local` fqdn.
 */

import { hostname } from "node:os";

export interface MdnsPeer {
  name: string;
  host: string;
  port: number;
  txt: Record<string, string>;
}

export interface MdnsHandle {
  /** Stop broadcast + discovery, release the multicast socket. */
  stop(): Promise<void>;
}

interface BonjourLike {
  publish(opts: any): { start(cb?: (e?: Error) => void): void; stop(cb?: (e?: Error) => void): void };
  find(opts: any, onUp?: (svc: any) => void): { on(ev: "up" | "down", cb: (svc: any) => void): void; stop(): void };
  destroy(): Promise<void> | void;
}

const NOOP_HANDLE: MdnsHandle = { stop: async () => {} };

// Type shim for the optional dep lives in extensions/types/bonjour-service.d.ts
// (ambient module declaration) so tsc passes without the package installed.

/** Resolves to a started bonjour instance, or null if the package is absent. */
async function loadBonjour(): Promise<BonjourLike | null> {
  try {
    const mod: any = await import("bonjour-service");
    const Bonjour = mod.Bonjour ?? mod.default?.Bonjour ?? mod.default;
    if (typeof Bonjour !== "function") return null;
    // Pass an errorCallback: bonjour's default rethrows from an async dgram
    // send callback (outside our try/catch) — a transient multicast error
    // (interface flap, ENETUNREACH) would otherwise crash the host process.
    return new Bonjour({}, () => {}) as unknown as BonjourLike;
  } catch {
    return null; // optional dep not installed
  }
}

/**
 * Broadcast this session over mDNS. Returns a handle whose stop() is always
 * safe to call (no-op if the package is absent).
 */
export async function startBroadcast(opts: {
  serviceType: string;
  name: string;
  port: number;
  txt: Record<string, string>;
}): Promise<MdnsHandle> {
  const bonjour = await loadBonjour();
  if (!bonjour) return NOOP_HANDLE;
  try {
    const svc = bonjour.publish({
      type: opts.serviceType,
      name: mdnsInstanceName(opts.name, process.pid),
      host: mdnsInstanceHost(hostname(), process.pid),
      port: opts.port,
      txt: opts.txt,
    });
    return {
      stop: async () => {
        try {
          await new Promise<void>((r) => svc.stop(() => r()));
        } catch {
          /* ignore */
        }
        try {
          await bonjour.destroy();
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    try {
      await bonjour.destroy();
    } catch {
      /* ignore */
    }
    return NOOP_HANDLE;
  }
}

/**
 * Listen for peers advertising the A2A service type. `onUp` fires per peer.
 * Returns a handle whose stop() is always safe.
 */
export async function startDiscovery(opts: {
  serviceType: string;
  onUp: (peer: MdnsPeer) => void;
  /** Fired when a peer disappears (so callers can remove it from their list). */
  onDown?: (peer: { name: string; host: string; port: number }) => void;
}): Promise<MdnsHandle> {
  const bonjour = await loadBonjour();
  if (!bonjour) return NOOP_HANDLE;
  try {
    const browser = bonjour.find({ type: opts.serviceType });
    browser.on("up", (svc: any) => {
      const peer: MdnsPeer = {
        name: String(svc.name ?? ""),
        host: String(svc.host ?? svc.referer?.address ?? ""),
        port: Number(svc.port ?? 0),
        txt: (svc.txt ?? {}) as Record<string, string>,
      };
      try {
        opts.onUp(peer);
      } catch {
        /* listener best-effort */
      }
    });
    if (opts.onDown) {
      browser.on("down", (svc: any) => {
        try {
          opts.onDown!({
            name: String(svc.name ?? ""),
            host: String(svc.host ?? svc.referer?.address ?? ""),
            port: Number(svc.port ?? 0),
          });
        } catch {
          /* listener best-effort */
        }
      });
    }
    return {
      stop: async () => {
        try {
          browser.stop();
        } catch {
          /* ignore */
        }
        try {
          await bonjour.destroy();
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    try {
      await bonjour.destroy();
    } catch {
      /* ignore */
    }
    return NOOP_HANDLE;
  }
}

/** RFC 6762-safe DNS label: lowercase, [a-z0-9-] only, ≤63 octets. */
function label(s: string, fallback: string): string {
  const out = String(s ?? "")
    .toLowerCase()
    .replace(/\./g, "-") // dots split labels — flatten
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  return out || fallback;
}

/** Unique per-session service instance name (`<agent>-<pid>`). Two Pi sessions
 *  on one machine (same agentName/hostname) would otherwise probe-collide on
 *  the same `<name>._a2a._tcp.local` fqdn — the second never advertises.
 *  Whole fqdn label must fit 63 octets: cap the base before adding the suffix
 *  (a long `agentName` — user/env-controlled, config.ts) would otherwise emit
 *  malformed DNS labels that peers/mDNSResponder silently reject). */
export function mdnsInstanceName(agentName: string, pid: number): string {
  const suffix = `-${pid}`;
  return `${label(agentName, "pi").slice(0, 63 - suffix.length).replace(/-+$/g, "") || "pi"}${suffix}`;
}

/** The hostname this broadcast CLAIMS in A/AAAA records. Deliberately never
 *  equals `os.hostname()` — claiming the OS local hostname makes macOS
 *  mDNSResponder rename the machine ("local hostname already in use"). Peers
 *  don't need it: discovery resolves the SRV target (unique name → LAN IPs)
 *  and a2a_peers uses the TXT `url` anyway. */
export function mdnsInstanceHost(host: string, pid: number): string {
  // Whole fqdn label must fit 63 octets: cap the base before adding the suffix.
  const suffix = `-a2a-${pid}.local`;
  return `${label(host, "pi").slice(0, 63 - suffix.length).replace(/-+$/g, "") || "pi"}${suffix}`;
}

/** Stable dedup key for a discovered peer (URL, else name:host:port composite). */
export function mdnsPeerKey(p: { name: string; host: string; port: number; txt?: Record<string, string> }): string {
  if (p.txt?.url) return String(p.txt.url).trim().replace(/\/+$/, "").toLowerCase();
  return `${p.name}:${p.host}:${p.port}`;
}

/** Build the TXT record from session essentials. Each value is capped at 255
 *  bytes: RFC 1035 character-strings are max 255 bytes, and dns-packet writes
 *  the length into a single byte — a longer value (deep cwd, long publicUrl)
 *  would silently corrupt the whole TXT record peers receive. */
export function txtRecord(opts: {
  url: string;
  cwd: string;
  model: string;
}): Record<string, string> {
  return { url: txtValue(opts.url), cwd: txtValue(opts.cwd), model: txtValue(opts.model) };
}

/** Truncate to ≤255 UTF-8 bytes on a char boundary (values are tiny — O(n) fine). */
function txtValue(v: string): string {
  let s = String(v ?? "");
  while (Buffer.byteLength(s, "utf-8") > 255) s = s.slice(0, -1);
  return s;
}
