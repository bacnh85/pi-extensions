/**
 * Persistent token→path registry: survives session restarts so an
 * [[attach:file.ts]] token pasted/referenced in a LATER session still
 * resolves to the dropped file's absolute path.
 *
 * Stored at <agentDir>/pi-attachments.json (non-secret: names + paths only),
 * capped at REGISTRY_MAX entries (oldest evicted).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const REGISTRY_MAX = 200;

export function registryPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(dir, "pi-attachments.json");
}

type Registry = Record<string, string>; // name → absolute path

function load(): Registry {
  const p = registryPath();
  if (!existsSync(p)) return {};
  try {
    const j = JSON.parse(readFileSync(p, "utf-8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function save(reg: Registry): void {
  // Evict oldest (first-inserted) entries beyond the cap.
  const keys = Object.keys(reg);
  if (keys.length > REGISTRY_MAX) {
    for (const k of keys.slice(0, keys.length - REGISTRY_MAX)) delete reg[k];
  }
  // Atomic write (tmp + rename): a crash mid-write never leaves a truncated
  // registry, and a fresh PI_CODING_AGENT_DIR gets created on first save.
  const p = registryPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify(reg, null, 2));
  renameSync(`${p}.tmp`, p);
}

export function remember(name: string, path: string): void {
  // Best-effort persistence: pi-tui invokes terminal-input listeners without
  // try/catch, so an unwritable agent dir (EACCES/ENOSPC/ENOTDIR) would crash
  // pi on a plain file drag-drop. Degrade gracefully like lookup() does.
  try {
    const reg = load();
    delete reg[name]; // re-insert at the end (most recent)
    reg[name] = path;
    save(reg);
  } catch {
    /* keep session-local tray only */
  }
}

export function lookup(name: string): string | undefined {
  return load()[name];
}
