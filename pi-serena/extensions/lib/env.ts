// ponytail: third copy of the env-file loader (pi-web/extensions/lib/config.ts,
// pi-munin/extensions/lib/helpers.ts). Extract to a shared package when a fourth
// consumer appears.
//
// Resolution order: process.env (always wins) → <cwd>/.env.local → <cwd>/.env →
// Pi global config .env.local → .env (under $PI_CODING_AGENT_DIR or ~/.pi/agent).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function piConfigDirs(): string[] {
  return process.env.PI_CODING_AGENT_DIR
    ? [process.env.PI_CODING_AGENT_DIR]
    : [path.join(os.homedir(), ".pi", "agent")];
}

export function envFileCandidates(cwd = process.cwd(), includeCwd = true): string[] {
  return [
    ...(includeCwd ? [path.resolve(cwd, ".env.local"), path.resolve(cwd, ".env")] : []),
    ...piConfigDirs().flatMap((dir) => [path.join(dir, ".env.local"), path.join(dir, ".env")]),
  ];
}

function stripInlineComment(value: string): string {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}

function parseDotenvValue(rawValue: string): string {
  let value = stripInlineComment(rawValue).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
    return value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  }
  return value.trim();
}

function parseDotenvFile(file: string): Record<string, string> | null {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values[match[1]] = parseDotenvValue(match[2]);
  }
  return values;
}

/**
 * Load dot-file values not already present in process.env, in precedence order:
 * cwd .env.local → cwd .env → global .env.local → global .env. First file wins.
 * Values already set in process.env are never overridden.
 */
export function loadDotenvValues(cwd = process.cwd(), includeCwd = true): Record<string, string> {
  const env: Record<string, string> = {};
  for (const file of envFileCandidates(cwd, includeCwd)) {
    const parsed = parseDotenvFile(file);
    if (!parsed) continue;
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env) && !(key in env)) env[key] = value;
    }
  }
  return env;
}
