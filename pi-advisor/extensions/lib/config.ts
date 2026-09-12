import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface AdvisorWatchConfig {
  enabled: boolean;
  minToolCalls: number;
  immuneTurns: number;
}

export interface AdvisorConfig {
  /** Ordered fallback chain; empty = advisor off. First entry is primary. */
  models: string[];
  watch: AdvisorWatchConfig;
}

const DEFAULTS: AdvisorWatchConfig = { enabled: true, minToolCalls: 3, immuneTurns: 3 };
const KEY = "pi-advisor";
export const MIGRATION_VERSION = 1;

type Raw = Record<string, unknown>;

function agentSettingsPath(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "settings.json");
}

async function readJson(file: string): Promise<Raw> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Raw;
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

function str(raw: Raw, key: string): string | undefined {
  const item = raw[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
}

function num(raw: Raw, key: string): number | undefined {
  const item = raw[key];
  return typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : undefined;
}

function parseBlock(raw: Raw | undefined): Partial<AdvisorWatchConfig> {
  const w = raw && typeof raw === "object" ? (raw as Raw) : {};
  return {
    ...(typeof w.enabled === "boolean" ? { enabled: w.enabled } : {}),
    ...(num(w, "minToolCalls") !== undefined ? { minToolCalls: num(w, "minToolCalls") } : {}),
    ...(num(w, "immuneTurns") !== undefined ? { immuneTurns: num(w, "immuneTurns") } : {}),
  };
}

/** Normalize a chain value (array or comma string) into trimmed non-empty entries. */
function parseModels(raw: Raw): string[] {
  const value = raw.models;
  const entries = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const models = entries.map((entry) => String(entry).trim()).filter(Boolean);
  return [...new Set(models)];
}

/** Effective config: project over global, defaults for missing keys.
 *  Legacy `model` string wraps to `[model]` when `models` is absent/empty. */
export async function loadConfig(ctx: ExtensionContext): Promise<AdvisorConfig> {
  const global = await readJson(agentSettingsPath());
  const project = ctx.isProjectTrusted() ? await readJson(path.join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")) : {};
  const globalBlock = (global[KEY] ?? {}) as Raw;
  const merged = { ...globalBlock, ...((project[KEY] as Raw) ?? {}) };
  const models = parseModels(merged);
  const legacy = str(merged, "model");
  const chain = models.length > 0 ? models : legacy ? [legacy] : [];
  const watch = { ...DEFAULTS, ...parseBlock(globalBlock.watch as Raw | undefined), ...parseBlock((merged as Raw).watch as Raw | undefined) };
  return { models: chain, watch };
}

/** Read-modify-write `pi-advisor.models` into the global settings.json.
 *  An empty chain deletes the key (advisor off). The legacy `model` key is
 *  always deleted so it can never shadow an explicitly-saved chain. */
export async function saveModels(models: string[]): Promise<void> {
  const file = agentSettingsPath();
  const settings = await readJson(file);
  const block = { ...((settings[KEY] as Raw) ?? {}) };
  const chain = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  delete (block as Raw).model;
  if (chain.length > 0) block.models = chain;
  else delete block.models;
  // Stamp the versioned tombstone on every explicit user write so a later
  // legacy pi-plan file cannot resurrect a disabled advisor (see
  // migrateLegacyAdvisorModel guard). Preserve a higher existing version.
  const existing = typeof block.migrationVersion === "number" ? block.migrationVersion : 0;
  if (existing < MIGRATION_VERSION) block.migrationVersion = MIGRATION_VERSION;
  settings[KEY] = block;
  // ponytail: rename dance — atomic-ish write so a concurrent Pi process never reads a torn file
  const tmp = `${file}.tmp-${process.pid}`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
  try {
    await rename(tmp, file);
  } catch (e) {
    try { await unlink(tmp); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

export function parseModel(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/**
 * One-shot legacy migration: if pi-advisor.model is unset, adopt the old
 * pi-plan advisorModel preference so existing users keep their advisor.
 *
 * Versioned guard: pi-advisor.migrationVersion records which migration has
 * been applied. Once at or above MIGRATION_VERSION the migration never runs
 * again — so an explicit disable (model cleared) is NOT resurrected by the
 * legacy file on the next restart. Bump MIGRATION_VERSION (the exported
 * constant above) for any future migration that must run for existing users.
 */

export async function migrateLegacyAdvisorModel(): Promise<string | undefined> {
  const file = path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "pi-plan", "preferences.json");
  const settingsPath = agentSettingsPath();
  try {
    const settings = await readJson(settingsPath);
    const block = (settings[KEY] ?? {}) as Raw;
    const version = typeof block.migrationVersion === "number" ? block.migrationVersion : 0;
    // legacyMigrated:true is the pre-versioning tombstone — treat it as version 1 applied.
    if (version >= MIGRATION_VERSION || block.legacyMigrated === true) return undefined;
    const prefs = JSON.parse(await readFile(file, "utf8")) as Raw;
    const legacy = str(prefs, "advisorModel");
    if (!legacy) return undefined;
    // Persist model + migration version atomically.
    const tmp = `${settingsPath}.tmp-${process.pid}`;
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(tmp, JSON.stringify({ ...settings, [KEY]: { ...block, model: legacy, migrationVersion: MIGRATION_VERSION } }, null, 2) + "\n", "utf8");
    try {
      await rename(tmp, settingsPath);
    } catch (e) {
      try { await unlink(tmp); } catch { /* best-effort cleanup */ }
      throw e;
    }
    return legacy;
  } catch { return undefined; }
}
