/**
 * Command Code settings (non-secret config only).
 *
 * Placement convention (repo-wide):
 * - `commandcode.baseUrl` lives in settings.json — precedence:
 *   env COMMAND_CODE_BASE_URL > repo `.pi/settings.json` (non-secret, same
 *   trust model as pi-router) > global `~/.pi/agent/settings.json` > default.
 * - The API key NEVER lives here — it's auth.json via `/login commandcode`
 *   (provider registers `apiKey: "$COMMAND_CODE_API_KEY"`), or the env var.
 *
 * Writes go to the GLOBAL settings file only (never a repo-controlled
 * `.pi/settings.json`) — mirrors pi-a2a's writeSettingsA2A target rule.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_BASE_URL } from "./client.js";

export interface CommandCodeSettings {
  /** Base URL of the OpenAI-compatible Provider API. */
  baseUrl: string;
}

// ── Read ─────────────────────────────────────────────────────────────────────

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return {};
    const j = JSON.parse(readFileSync(path, "utf8"));
    return typeof j === "object" && j !== null ? (j as Record<string, unknown>) : null;
  } catch {
    return null; // exists but unparseable — signal "don't touch"
  }
}

/** Non-secret fields only from a settings file's `commandcode` section. */
function readSection(path: string): { baseUrl?: string } {
  const j = readJson(path);
  const s = j?.commandcode;
  if (typeof s !== "object" || s === null) return {};
  const r = s as Record<string, unknown>;
  const out: { baseUrl?: string } = {};
  if (typeof r.baseUrl === "string" && r.baseUrl.trim()) out.baseUrl = r.baseUrl.trim().replace(/\/+$/, "");
  return out;
}

/** Read `commandcode` settings. Precedence: env > repo `.pi/settings.json` >
 *  global `~/.pi/agent/settings.json` > DEFAULT_BASE_URL. */
export function getSettings(cwd = process.cwd()): CommandCodeSettings {
  const repo = readSection(join(cwd, ".pi", "settings.json"));
  const saved = readSection(join(agentDir(), "settings.json"));
  const env = process.env.COMMAND_CODE_BASE_URL?.trim().replace(/\/+$/, "");
  return { baseUrl: env || repo.baseUrl || saved.baseUrl || DEFAULT_BASE_URL };
}

/** True when baseUrl differs from DEFAULT_BASE_URL (i.e. a custom endpoint). */
export function isCustomEndpoint(s: CommandCodeSettings): boolean {
  return s.baseUrl.replace(/\/+$/, "") !== DEFAULT_BASE_URL;
}

// ── Write ────────────────────────────────────────────────────────────────────

/** Read-modify-write `commandcode.baseUrl` into the GLOBAL settings.json,
 *  preserving all other keys. Atomic (temp file + rename). Never targets a
 *  repo-controlled file. Returns the path written. */
export function writeBaseUrl(baseUrl: string): string {
  const target = join(agentDir(), "settings.json");
  const j = readJson(target);
  if (j === null) {
    // Corrupt settings.json — bail instead of overwrite-wiping the user's
    // other sections (pi-router migrate.ts pattern). Fix the file first.
    throw new Error(`${target} is not valid JSON — fix or remove it before saving.`);
  }
  const section = (typeof j.commandcode === "object" && j.commandcode !== null)
    ? (j.commandcode as Record<string, unknown>)
    : {};
  section.baseUrl = baseUrl.trim().replace(/\/+$/, "");
  j.commandcode = section;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, target);
  return target;
}
