/**
 * Secret references in settings.json (#50).
 *
 * Port of pi core's `resolveConfigValue` (core/resolve-config-value.ts), the
 * resolver behind `apiKey` in models.json and `key` in auth.json. It is not
 * exported from the package root, so the semantics are mirrored here:
 *
 * - `"!command"` runs the rest as a shell command and uses its trimmed
 *   stdout. Results (failures included) are cached per value for the process
 *   lifetime. Empty output, a nonzero exit, or the 10s timeout leave the
 *   value unset.
 * - `"$NAME"` / `"${NAME}"` interpolate environment variables. If any
 *   referenced variable is unset, the whole value is unset.
 * - `"$$"` escapes a literal `$`, `"$!"` a literal `!`.
 * - Anything else is a literal.
 *
 * ponytail: pi core runs `!` commands through its configured shell on
 * Windows (getShellConfig, not exported); this port always uses the default
 * shell, which is what pi core does on every other platform.
 */

import { execSync } from "node:child_process";

type Part = { type: "literal"; value: string } | { type: "env"; name: string };

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

const commandResultCache = new Map<string, string | undefined>();

/** Clear the `!command` result cache. Exported for tests. */
export function clearConfigValueCache(): void {
  commandResultCache.clear();
}

function appendLiteral(parts: Part[], value: string): void {
  if (!value) return;
  const prev = parts[parts.length - 1];
  if (prev?.type === "literal") prev.value += value;
  else parts.push({ type: "literal", value });
}

function parseTemplate(config: string): Part[] {
  const parts: Part[] = [];
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf("$", index);
    if (dollar < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }
    appendLiteral(parts, config.slice(index, dollar));
    const next = config[dollar + 1];
    if (next === "$" || next === "!") {
      appendLiteral(parts, next);
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = config.indexOf("}", dollar + 2);
      if (end < 0) {
        appendLiteral(parts, "$");
        index = dollar + 1;
        continue;
      }
      const name = config.slice(dollar + 2, end);
      if (ENV_VAR_NAME_RE.test(name)) parts.push({ type: "env", name });
      else appendLiteral(parts, config.slice(dollar, end + 1));
      index = end + 1;
      continue;
    }
    const match = config.slice(dollar + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollar + 1 + match[0].length;
      continue;
    }
    appendLiteral(parts, "$");
    index = dollar + 1;
  }
  return parts;
}

function resolveTemplate(parts: Part[]): string | undefined {
  let out = "";
  for (const part of parts) {
    if (part.type === "literal") {
      out += part.value;
      continue;
    }
    const value = process.env[part.name] || undefined;
    if (value === undefined) return undefined;
    out += value;
  }
  return out;
}

function executeCommand(config: string): string | undefined {
  if (commandResultCache.has(config)) return commandResultCache.get(config);
  let value: string | undefined;
  try {
    value =
      execSync(config.slice(1), { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() ||
      undefined;
  } catch {
    value = undefined;
  }
  commandResultCache.set(config, value);
  return value;
}

/** Resolve one config value with pi core's `!command` / `$VAR` semantics. */
export function resolveConfigValue(config: string): string | undefined {
  return config.startsWith("!") ? executeCommand(config) : resolveTemplate(parseTemplate(config));
}

/**
 * Resolve a credential field read from settings.json. Non-strings pass through.
 *
 * Values from a repo-controlled `.pi/settings.json` are returned literally,
 * never resolved: opening a repo must not run a command it ships, and must
 * not interpolate an operator env var (e.g. `"$GITHUB_TOKEN"`) into a token
 * sent to a peer URL the same repo chose.
 */
export function resolveSettingsValue<T>(raw: T, fromRepo: boolean): T | string | undefined {
  if (typeof raw !== "string" || fromRepo) return raw;
  return resolveConfigValue(raw);
}
