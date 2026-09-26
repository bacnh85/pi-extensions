// Settings reader — reads the `evolve` key from settings.json directly.
// ponytail: the SDK ExtensionAPI has NO getSetting/config (only registerFlag/getFlag
// for boolean/string CLI flags). Structured config must be read from disk.
// Resolution (project-trust gated, mirrors pi-selfskills' settingsCandidates — an
// untrusted repo must not be able to re-enable evolve or set store:"local" to
// steer learning writes into itself):
//   trusted:   <cwd>/.pi/settings.json → <agentDir>/settings.json
//   untrusted: <agentDir>/settings.json
// agentDir = $PI_CODING_AGENT_DIR or ~/.pi/agent (falls back to ~/.pi/agents);
// malformed JSON → defaults.
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface EvolveSettings {
  enabled: boolean;
  autoInject: boolean;
  injectMode: string; // "recent" | "similar" | "both" (v0.2)
  maxInject: number;
  store: string; // "munin" | "local" | "auto"
  bufferCap: number;
  localCap: number;
  autoReflect: boolean; // v0.2: nudge at agent_end when recovery detected
  errorTriage: boolean; // v0.3: master switch for error hints + recall + escalation
  recallStoredFixes: boolean; // v0.3: search stored learnings by error text (Layer 2)
}

const DEFAULTS: EvolveSettings = {
  enabled: true,
  autoInject: true,
  injectMode: "both",
  maxInject: 3,
  store: "auto",
  bufferCap: 200,
  localCap: 500,
  autoReflect: true,
  errorTriage: true,
  recallStoredFixes: true,
};

function settingsDirs(): string[] {
  return process.env.PI_CODING_AGENT_DIR
    ? [process.env.PI_CODING_AGENT_DIR]
    : [path.join(os.homedir(), ".pi", "agent"), path.join(os.homedir(), ".pi", "agents")];
}

/** Settings candidates in resolution order. <cwd>/.pi/settings.json is only
 *  eligible when the project is trusted (fail closed). Assumes
 *  ctx.isProjectTrusted exists (every supported pi version has it); a host
 *  without the API would silently fall through to agent-dir settings/defaults. */
function settingsCandidates(cwd: string, trusted: boolean): string[] {
  return [
    ...(trusted ? [path.join(cwd, ".pi", "settings.json")] : []),
    ...settingsDirs().map((d) => path.join(d, "settings.json")),
  ];
}

/** Resolve the settings.json path (first existing candidate wins). */
export function resolveSettingsPath(cwd = process.cwd(), trusted = false): string | null {
  for (const c of settingsCandidates(cwd, trusted)) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Read the `evolve` block from settings.json. Returns defaults when absent/unreadable.
 *  Untrusted projects: only the agent-dir settings are consulted. */
export function readEvolveSettings(cwd = process.cwd(), trusted = false): EvolveSettings {
  const file = resolveSettingsPath(cwd, trusted);
  if (!file) return { ...DEFAULTS };
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ...DEFAULTS };
  }
  const raw = (parsed?.evolve ?? {}) as Record<string, unknown>;
  const num = (v: unknown, dflt: number) => (typeof v === "number" && v > 0 ? v : dflt);
  const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
  const str = (v: unknown, allowed: string[], dflt: string) =>
    typeof v === "string" && allowed.includes(v) ? v : dflt;
  return {
    enabled: bool(raw.enabled, DEFAULTS.enabled),
    autoInject: bool(raw.autoInject, DEFAULTS.autoInject),
    injectMode: str(raw.injectMode, ["recent", "similar", "both"], DEFAULTS.injectMode),
    maxInject: num(raw.maxInject, DEFAULTS.maxInject),
    store: str(raw.store, ["munin", "local", "auto"], DEFAULTS.store),
    bufferCap: num(raw.bufferCap, DEFAULTS.bufferCap),
    localCap: num(raw.localCap, DEFAULTS.localCap),
    autoReflect: bool(raw.autoReflect, DEFAULTS.autoReflect),
    errorTriage: bool(raw.errorTriage, DEFAULTS.errorTriage),
    recallStoredFixes: bool(raw.recallStoredFixes, DEFAULTS.recallStoredFixes),
  };
}
