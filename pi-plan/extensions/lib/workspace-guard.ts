/**
 * Workspace collision guard for autonomous pi-plan flows.
 *
 * Two signals, cheapest first:
 *  1. Lease registry (`<agentDir>/pi-plan_leases/<pid>.json`) — precise: a live
 *     pid on the same cwd is an open Pi session. Liveness = process.kill(pid,0)
 *     probe (pi-a2a registry pattern); dead leases are GC'd on scan.
 *  2. Session-file recency (`<agentDir>/sessions/--<encoded-cwd>--/*.jsonl`) —
 *     best effort: recent mtime means a session (possibly without pi-plan, or a
 *     headless `pi -p` run) was writing in this workspace.
 *
 * ponytail: advisory by design — mtime recency is a heuristic; the caller picks
 * block/warn/off. No locking; last writer wins per pid, stale files are GC'd.
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

export interface WorkspaceLease {
  pid: number;
  cwd: string;
  sessionFile?: string;
  startedAt: number;
}

export interface WorkspaceConflict {
  lease?: WorkspaceLease;
  sessionFile?: string;
  lastActivityMs?: number;
}

export interface WorkspaceGuardDeps {
  agentDir: string;
  /** Liveness probe seam (tests inject a fake). Default: process.kill(pid, 0). */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

/** Session-file activity older than this is treated as not-live. */
export const LEASE_TTL_MS = 10 * 60 * 1000;

function leasesDir(agentDir: string): string {
  return path.join(agentDir, "pi-plan_leases");
}

/** Canonical path for comparisons: symlinked launch paths (macOS /tmp →
 *  /private/tmp) must not defeat collision detection. Falls back to the raw
 *  resolved path when the target does not exist. */
export function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Encode a cwd into Pi's session-dir name (keep in sync with
 *  pi-coding-agent session-manager getDefaultSessionDirPath). */
export function encodeSessionDirName(cwd: string): string {
  const normalized = path.resolve(cwd);
  return `--${normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: process exists but is owned by another user — still alive.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Write this process's lease. Never throws — an unwritable agent dir must not
 *  break a session. */
export async function writeLease(lease: WorkspaceLease, agentDir: string): Promise<void> {
  try {
    const dir = leasesDir(agentDir);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${lease.pid}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  } catch { /* best effort */ }
}

export async function removeLease(pid: number, agentDir: string): Promise<void> {
  try {
    await unlink(path.join(leasesDir(agentDir), `${pid}.json`));
  } catch { /* already gone */ }
}

/** Read live leases for `cwd`, excluding `ownPid`. GCs dead entries as a side
 *  effect. Never throws. */
export async function readLiveLeases(
  cwd: string,
  ownPid: number,
  deps: WorkspaceGuardDeps,
): Promise<WorkspaceLease[]> {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const dir = leasesDir(deps.agentDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const resolved = canonicalPath(cwd);
  const live: WorkspaceLease[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let lease: WorkspaceLease;
    try {
      lease = JSON.parse(await readFile(file, "utf8")) as WorkspaceLease;
    } catch {
      continue; // unreadable/corrupt — leave the file, never guess
    }
    if (!lease || typeof lease.pid !== "number" || typeof lease.cwd !== "string") {
      try { await unlink(file); } catch { /* best effort */ }
      continue;
    }
    if (lease.pid === ownPid) continue;
    if (canonicalPath(lease.cwd) !== canonicalPath(cwd)) continue;
    if (!isAlive(lease.pid)) {
      try { await unlink(file); } catch { /* best effort */ }
      continue;
    }
    live.push(lease);
  }
  return live;
}

/** Recent session files for this cwd, excluding `ownSessionFile`. Never throws. */
export async function recentSessionFiles(
  cwd: string,
  ownSessionFile: string | undefined,
  deps: Pick<WorkspaceGuardDeps, "agentDir" | "now">,
): Promise<string[]> {
  const now = deps.now?.() ?? Date.now();
  const dir = path.join(deps.agentDir, "sessions", encodeSessionDirName(cwd));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const own = ownSessionFile ? path.resolve(ownSessionFile) : undefined;
  const recent: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    if (own && path.resolve(file) === own) continue;
    try {
      const info = await stat(file);
      if (now - info.mtimeMs <= LEASE_TTL_MS) recent.push(file);
    } catch { /* vanished — skip */ }
  }
  return recent;
}

/** Detection entry point: live leases first; session recency only when no lease
 *  conflict exists (it exists to catch sessions without pi-plan / headless runs). */
export async function detectWorkspaceConflict(
  cwd: string,
  ownPid: number,
  ownSessionFile: string | undefined,
  deps: WorkspaceGuardDeps,
): Promise<WorkspaceConflict[]> {
  const leases = await readLiveLeases(cwd, ownPid, deps);
  if (leases.length > 0) return leases.map((lease) => ({ lease }));
  const files = await recentSessionFiles(cwd, ownSessionFile, deps);
  return files.map((sessionFile) => ({ sessionFile }));
}

export function describeConflict(conflict: WorkspaceConflict): string {
  if (conflict.lease) {
    return `Pi session pid ${conflict.lease.pid} (started ${new Date(conflict.lease.startedAt).toLocaleTimeString()})`;
  }
  const file = conflict.sessionFile ?? "unknown session";
  return `recent session activity in ${path.basename(file)}`;
}
