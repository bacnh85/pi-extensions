import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One-shot migration: pi-9router's `9router-config.json` →
 *  settings.json (`router.baseUrl`, `router.enableReasoning`) + auth.json
 *  (`router.api_key` credential, for `/login router` semantics).
 *  Runs only when the legacy file exists; never overwrites existing router
 *  entries; renames the legacy file to `.migrated` when done. */

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}
const legacyConfigPath = () => join(agentDir(), "9router-config.json");
const settingsPath = () => join(agentDir(), "settings.json");
const authPath = () => join(agentDir(), "auth.json");

interface LegacyConfig {
  baseUrl?: string;
  apiKey?: string;
  enableReasoning?: boolean;
}

/** Returns true when a migration happened (or the legacy file was consumed). */
export function migrateLegacyConfig(): boolean {
  const LEGACY_CONFIG_PATH = legacyConfigPath();
  if (!existsSync(LEGACY_CONFIG_PATH)) return false;

  let legacy: LegacyConfig = {};
  try {
    legacy = JSON.parse(readFileSync(LEGACY_CONFIG_PATH, "utf8")) as LegacyConfig;
  } catch {
    // Unreadable legacy config — rename out of the way so we never retry.
    safeRename(LEGACY_CONFIG_PATH);
    return false;
  }

  // settings.json: merge `router` section without clobbering existing keys.
  const settings = readFileJson(settingsPath());
  if (settings === null) return false; // unparseable settings.json — don't wipe it; retry next load
  const router = (settings.router ?? {}) as Record<string, unknown>;
  if (legacy.baseUrl && router.baseUrl === undefined) router.baseUrl = legacy.baseUrl;
  if (legacy.enableReasoning !== undefined && router.enableReasoning === undefined) {
    router.enableReasoning = legacy.enableReasoning;
  }
  if (Object.keys(router).length > 0) {
    settings.router = router;
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  }

  // auth.json: add `router` credential if absent and legacy key exists.
  if (legacy.apiKey) {
    const auth = readFileJson(authPath());
    if (auth !== null && !auth.router) { // unparseable auth.json — never overwrite
      auth.router = { type: "api_key", key: legacy.apiKey };
      writeFileSync(authPath(), JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
    }
  }

  safeRename(LEGACY_CONFIG_PATH);
  return true;
}

/** Rename the legacy file out of the way; tolerate losing a race with
 *  another Pi session that migrated first (ENOENT/EPERM) and read-only dirs. */
function safeRename(from: string): void {
  try {
    renameSync(from, from + ".migrated");
  } catch { /* already migrated elsewhere or unwritable — non-fatal */ }
}

function readFileJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // Exists but unparseable — signal "don't touch" so the caller never
    // overwrite-wipes the user's settings/auth with a fresh {}.
    return null;
  }
}
