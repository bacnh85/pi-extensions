/**
 * Local session registry — zero-dep, filesystem-based.
 *
 * Each inbound A2A server writes `<piDir>/a2a_registry/<pid>.json` describing
 * itself (url, port, cwd, model, tools). Other sessions read the directory to
 * discover peers without port-scanning. The proven pattern (VS Code server,
 * Emacs `server`, tmux, Docker) — inspectable, cross-process, self-healing.
 *
 * Stale-entry GC is dual: mtime TTL (cheap) + `process.kill(pid,0)` liveness
 * probe (authoritative). Dead files are swept on every list().
 * All FS ops are best-effort — discovery is non-critical, never throws to caller.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { AgentSkill } from "./protocol";

/** What one Pi session declares about itself. */
export interface SessionDescriptor {
  pid: number; // also the filename key → cleanup target
  url: string; // actual bound URL (after port fallback)
  port: number; // actual bound port
  host: string; // bind host
  cwd: string; // working folder
  model: { provider: string; id: string; name?: string } | null;
  agentName: string; // display name (hostname fallback)
  sessionName?: string; // pi.getSessionName()
  /** Outbound caller identity (matches a key in server.peerTokens). Other
   *  sessions present this name's token when calling THIS session. */
  selfIdentity?: string;
  tools: string[]; // active tools — the "abilities"
  skills: AgentSkill[]; // configured inbound skills
  startedAt: string; // ISO
  mtime: number; // epoch ms — heartbeat freshness (Date.now())
}

function dir(piDir: string): string {
  return join(piDir, "a2a_registry");
}

function fileFor(piDir: string, pid: number): string {
  return join(dir(piDir), `${pid}.json`);
}

function isAlive(pid: number): boolean {
  // ponytail: process.kill(pid,0) is the cheap cross-platform liveness probe
  // (throws ESRCH if the process is gone). Wrapped — it never throws to caller.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function register(desc: SessionDescriptor, piDir: string): void {
  try {
    const p = fileFor(piDir, desc.pid);
    mkdirSync(dir(piDir), { recursive: true });
    writeFileSync(p, JSON.stringify(desc, null, 2), { encoding: "utf-8" });
  } catch {
    /* best-effort */
  }
}

/** Refresh a descriptor in place (updates mtime + any patched fields). */
export function heartbeat(desc: SessionDescriptor, piDir: string): void {
  desc.mtime = Date.now();
  register(desc, piDir);
}

export function unregister(pid: number, piDir: string): void {
  try {
    unlinkSync(fileFor(piDir, pid));
  } catch {
    /* ignore ENOENT — idempotent */
  }
}

export interface ListOpts {
  piDir: string;
  ttlSec?: number;
  /** Skip the process-kill probe (tests: probe can't work for fake pids). */
  aliveProbe?: (pid: number) => boolean;
}

/**
 * List live session descriptors. Sweeps stale entries (expired mtime OR dead
 * pid) so the registry self-heals after ungraceful exits.
 */
export function list(opts: ListOpts): SessionDescriptor[] {
  const d = dir(opts.piDir);
  const ttlMs = (opts.ttlSec ?? 60) * 1000;
  const probe = opts.aliveProbe ?? isAlive;
  let files: string[];
  try {
    files = readdirSync(d).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const now = Date.now();
  const out: SessionDescriptor[] = [];
  for (const f of files) {
    try {
      const path = join(d, f);
      const raw = readJson(path);
      if (!raw) continue;
      const desc = raw as SessionDescriptor;
      const stale = now - desc.mtime > ttlMs;
      const dead = !probe(desc.pid);
      if (stale || dead) {
        // Self-heal: remove stale/dead entry.
        try {
          unlinkSync(path);
        } catch {
          /* race with another sweeper — fine */
        }
        continue;
      }
      out.push(desc);
    } catch {
      /* corrupt file — skip */
    }
  }
  return out;
}

function readJson(p: string): unknown | null {
  try {
    const s: Stats = statSync(p);
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    if (parsed && typeof parsed === "object") {
      // Prefer the authoritative filesystem mtime over the in-JSON field
      // (guards against a clock-skewed writer).
      parsed.mtime = s.mtimeMs;
    }
    return parsed;
  } catch {
    return null;
  }
}
