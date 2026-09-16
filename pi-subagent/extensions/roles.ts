/**
 * Role-based model routing for pi-subagent.
 *
 * A role maps a *function* (fast / coder / smart / custom) to an ordered model
 * chain in settings.json under `subagent.roles`. Agent frontmatter references
 * roles via `@role` aliases (`model: @fast`), so remapping a function is one
 * settings edit instead of N agent-file edits.
 *
 * Settings shape (`~/.pi/agent/settings.json`; repo `.pi/settings.json` is a
 * read-only overlay honored when the project is trusted):
 *
 * {
 *   "subagent": {
 *     "roles": {
 *       "fast": "nvidia/openai/gpt-oss-20b, opencode-go/deepseek-v4-flash",
 *       "coder": ["zai-coding-cn/glm-5.1", "opencode-go/deepseek-v4-flash"],
 *       "smart": "*"
 *     },
 *     "agentModels": { "reviewer": "@smart:high" }
 *   }
 * }
 *
 * - Role value: string (comma chain) or array. `*` / `@default` = parent model.
 * - `@role` entries may reference other roles (visited-set cycle guard).
 * - Unknown roles are skipped and recorded in `unresolved` for diagnostics.
 * - A trailing `:thinking` suffix (off|minimal|low|medium|high|xhigh|max) on
 *   any entry overrides the agent's frontmatter thinking for that match.
 *   Strict trailing match only — openrouter ids like `model:free` keep intact.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";

export type SubagentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Role → raw chain value (string/array, may contain `@role` and `*` refs). */
export type RoleMap = Record<string, string | string[]>;

export interface RolesConfig {
  roles: RoleMap;
  /** Per-agent model override (agent name → selector / role alias / `*`). */
  agentModels: Record<string, string>;
  /** Per-agent thinking override (agent name → level). Beats frontmatter;
   *  a matched candidate's `:level` suffix still wins. */
  agentThinking: Record<string, SubagentThinkingLevel>;
}

export interface ExpandedCandidates {
  /** Concrete candidate names in priority order (may be empty = parent fallback). */
  candidates: string[];
  /** thinking suffix per matched candidate name (name as written, without suffix). */
  thinkingByCandidate: Map<string, SubagentThinkingLevel>;
  /** Unknown role aliases encountered (for diagnostics). */
  unresolved: string[];
}

/** Today's bundled chains, as role defaults — behavior-preserving baseline. */
export const DEFAULT_ROLES: RoleMap = {
  fast: ["zai-coding-cn/glm-5-turbo", "nvidia/openai/gpt-oss-20b", "opencode-go/deepseek-v4-flash"],
  coder: [
    "zai-coding-cn/glm-5.1",
    "nvidia/mistralai/mistral-small-4-119b-2603",
    "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    "opencode-go/deepseek-v4-flash",
  ],
  smart: ["zai-coding-cn/glm-5.3", "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", "opencode-go/deepseek-v4-pro"],
};

// ---------------------------------------------------------------------------
// Settings reading
// ---------------------------------------------------------------------------

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function subagentSection(json: Record<string, unknown> | null): Record<string, unknown> {
  const section = json?.subagent;
  return section && typeof section === "object" && !Array.isArray(section)
    ? (section as Record<string, unknown>)
    : {};
}

/** Normalize a role value: comma string → array of trimmed non-empty entries. */
function normalizeChain(value: string | string[]): string[] {
  const entries = typeof value === "string" ? value.split(",") : value;
  return entries
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

/** Merge `subagent.roles` / `subagent.agentModels` from a settings JSON into cfg. */
function mergeSection(cfg: RolesConfig, json: Record<string, unknown> | null): void {
  const section = subagentSection(json);
  const roles = section.roles;
  if (roles && typeof roles === "object" && !Array.isArray(roles)) {
    for (const [name, value] of Object.entries(roles as RoleMap)) {
      if (value === null || value === undefined) continue;
      const chain = normalizeChain(value as string | string[]);
      if (chain.length > 0) cfg.roles[name] = chain;
    }
  }
  const agentModels = section.agentModels;
  if (agentModels && typeof agentModels === "object" && !Array.isArray(agentModels)) {
    for (const [name, value] of Object.entries(agentModels as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) cfg.agentModels[name] = value.trim();
    }
  }
  const agentThinking = section.agentThinking;
  if (agentThinking && typeof agentThinking === "object" && !Array.isArray(agentThinking)) {
    for (const [name, value] of Object.entries(agentThinking as Record<string, unknown>)) {
      if (typeof value === "string" && THINKING_LEVELS.includes(value)) cfg.agentThinking[name] = value as SubagentThinkingLevel;
    }
  }
}

/** Effective chain-wide default thinking for an agent: settings override
 *  beats frontmatter; a matched candidate's `:level` suffix wins over both. */
export function effectiveAgentThinking(
  agent: Pick<AgentConfig, "name" | "thinking">,
  cfg: Pick<RolesConfig, "agentThinking">,
): SubagentThinkingLevel | undefined {
  return cfg.agentThinking[agent.name] ?? agent.thinking;
}

/**
 * Read effective roles config. Precedence: global settings.json → repo
 * `.pi/settings.json` (project-trusted only) → `(ctx as any).settings` (the
 * SDK-layered view, when present). Later layers win per role/agent key.
 */
export function readSubagentRoles(ctx?: ExtensionContext): RolesConfig {
  const cfg: RolesConfig = {
    roles: structuredClone(DEFAULT_ROLES),
    agentModels: {},
    agentThinking: {},
  };
  mergeSection(cfg, readJson(join(agentDir(), "settings.json")));
  try {
    if (ctx?.isProjectTrusted?.()) {
      mergeSection(cfg, readJson(join(ctx.cwd, ".pi", "settings.json")));
    }
  } catch { /* untrusted or ctx without cwd — global only */ }
  const layered = (ctx as unknown as { settings?: Record<string, unknown> } | undefined)?.settings;
  if (layered) mergeSection(cfg, layered);
  return cfg;
}

/** Read the `subagent` section of the user's global settings.json (empty when absent). */
export function readSubagentSection(): Record<string, unknown> {
  return readSubagentSectionFrom(join(agentDir(), "settings.json"));
}

/** Read the `subagent` section of an arbitrary settings.json (empty when absent). */
export function readSubagentSectionFrom(settingsPath: string): Record<string, unknown> {
  return subagentSection(readJson(settingsPath));
}

/** Global-only variant used by the panel so a save never persists repo
 *  `.pi/settings.json` overlay values into the user's global settings. */
export function readSubagentRolesGlobal(): RolesConfig {
  const cfg: RolesConfig = {
    roles: structuredClone(DEFAULT_ROLES),
    agentModels: {},
    agentThinking: {},
  };
  mergeSection(cfg, readJson(join(agentDir(), "settings.json")));
  return cfg;
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/** Split a trailing `:thinking` suffix. Returns null when the trailing segment
 *  is not a known level (e.g. openrouter `:free`), leaving the name intact. */
export function splitThinkingSuffix(name: string): { name: string; thinking?: SubagentThinkingLevel } {
  const idx = name.lastIndexOf(":");
  if (idx <= 0 || idx >= name.length - 1) return { name };
  const suffix = name.slice(idx + 1);
  if (!THINKING_LEVELS.includes(suffix)) return { name };
  return { name: name.slice(0, idx), thinking: suffix as SubagentThinkingLevel };
}

function isParentRef(entry: string): boolean {
  return entry === "*" || entry === "@default";
}

/**
 * Expand a raw candidate list into concrete model names.
 * `@role` entries expand in place (recursively, cycle-safe); `*` / `@default`
 * resolve to an empty list (= parent fallback in resolveModel).
 */
export function expandModelCandidates(candidates: readonly string[], roles: RoleMap): ExpandedCandidates {
  const out: string[] = [];
  const thinkingByCandidate = new Map<string, SubagentThinkingLevel>();
  const unresolved: string[] = [];
  const seen = new Set<string>();

  const pushEntry = (entry: string, thinking?: SubagentThinkingLevel): void => {
    const { name, thinking: own } = splitThinkingSuffix(entry);
    if (!name) return;
    if (isParentRef(name)) return; // parent fallback: resolveModel handles the tail
    if (seen.has(name)) {
      // Earlier occurrence wins for thinking too (priority order).
      return;
    }
    seen.add(name);
    out.push(name);
    const level = own ?? thinking;
    if (level) thinkingByCandidate.set(name, level);
  };

  const walk = (entry: string, visited: Set<string>, inheritedThinking?: SubagentThinkingLevel): void => {
    const raw = entry.trim();
    if (!raw) return;
    const { name: bare, thinking: own } = splitThinkingSuffix(raw);
    if (isParentRef(bare)) return;
    if (bare.startsWith("@")) {
      const roleName = bare.slice(1);
      const value = roles[roleName];
      if (value === undefined || normalizeChain(value).length === 0) {
        if (!unresolved.includes(bare)) unresolved.push(bare);
        return;
      }
      if (visited.has(roleName)) return; // cycle guard
      const next = new Set(visited).add(roleName);
      // A suffix on the role reference ("@smart:high") applies to every model
      // the role expands to; per-entry suffixes win over the inherited one.
      const effective = own ?? inheritedThinking;
      for (const child of normalizeChain(value)) walk(child, next, effective);
      return;
    }
    pushEntry(bare, own ?? inheritedThinking);
  };

  for (const entry of candidates) walk(entry, new Set());
  return { candidates: out, thinkingByCandidate, unresolved };
}

export interface AgentModelChain {
  candidates: string[];
  thinkingByCandidate: Map<string, SubagentThinkingLevel>;
  unresolved: string[];
  /** True when `subagent.agentModels` replaced the agent's own list. */
  overridden: boolean;
}

/**
 * Effective model chain for an agent: `subagent.agentModels[name]` (if set)
 * replaces the agent's own candidates entirely, then `@role` / `:thinking`
 * entries expand. No settings → bundled defaults → today's exact chains.
 */
export function resolveAgentModelChain(
  agent: Pick<AgentConfig, "name" | "model" | "models">,
  roles: RolesConfig,
): AgentModelChain {
  const override = roles.agentModels[agent.name];
  const raw =
    override !== undefined
      ? [override]
      : [...new Set([agent.model, ...(agent.models ?? [])].filter((model): model is string => Boolean(model)))];
  const expanded = expandModelCandidates(raw, roles.roles);
  return { ...expanded, overridden: override !== undefined };
}

/** Human-readable effective chain for prompt catalog + `/subagent` details. */
export function describeAgentModels(
  agent: Pick<AgentConfig, "name" | "model" | "models">,
  roles: RolesConfig,
): string {
  const raw =
    roles.agentModels[agent.name] ??
    [...new Set([agent.model, ...(agent.models ?? [])].filter((model): model is string => Boolean(model)))].join(", ");
  const { candidates, thinkingByCandidate, unresolved } = resolveAgentModelChain(agent, roles);
  const chain = candidates.length > 0
    ? `${candidates.map((name) => (thinkingByCandidate.get(name) ? `${name}:${thinkingByCandidate.get(name)}` : name)).join(" → ")} → parent fallback`
    : "parent fallback";
  const source = roles.agentModels[agent.name] ? "override" : "frontmatter";
  const warn = unresolved.length > 0 ? ` (unresolved: ${unresolved.join(", ")})` : "";
  return `[${source}: ${raw}] ${chain}${warn}`;
}
