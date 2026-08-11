// Settings reader — reads the `evolve` key from settings.json directly.
// ponytail: the SDK ExtensionAPI has NO getSetting/config (only registerFlag/getFlag
// for boolean/string CLI flags). Structured config must be read from disk. Resolves
// <cwd>/.pi/settings.json → ~/.pi/agent/settings.json, first one wins.
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
};

/** Resolve the settings.json path: <cwd>/.pi/settings.json → ~/.pi/agent/settings.json. */
export function resolveSettingsPath(cwd = process.cwd()): string | null {
  const candidates = [
    path.join(cwd, ".pi", "settings.json"),
    ...settingsDirs().map((d) => path.join(d, "settings.json")),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function settingsDirs(): string[] {
  return process.env.PI_CODING_AGENT_DIR
    ? [process.env.PI_CODING_AGENT_DIR]
    : [path.join(os.homedir(), ".pi", "agent"), path.join(os.homedir(), ".pi", "agents")];
}

/** Read the `evolve` block from settings.json. Returns defaults when absent/unreadable. */
export function readEvolveSettings(cwd = process.cwd()): EvolveSettings {
  const file = resolveSettingsPath(cwd);
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
  };
}
