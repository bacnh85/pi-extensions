/**
 * `/subagent roles` panel (kernel lives in @bacnh85/pi-config-panel).
 *
 * Row model for role-based model routing: one string row per role (comma
 * chain, blank = reset to default) and one string row per discovered agent
 * (`subagent.agentModels` override, blank = inherit agent file settings).
 * Saving writes both maps to the GLOBAL `~/.pi/agent/settings.json` under
 * `subagent.roles` / `subagent.agentModels` (merge + atomic rename), then
 * invalidates the agent cache.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { row } from "@bacnh85/pi-config-panel";
import type { PanelAction, PanelGroup, PanelRow } from "@bacnh85/pi-config-panel";

// ponytail: local structural type — the kernel only reads value/label/
// description, so this stays compatible with the published 0.1.0 range while
// completion support ships in 0.1.1 (no static import of new kernel symbols).
interface CompletionItem {
  value: string;
  label?: string;
  description?: string;
}
import type { AgentConfig } from "./agents.ts";
import { getModelCandidates } from "./agents.ts";
import { DEFAULT_ROLES, readSubagentRoles, resolveAgentModelChain, THINKING_LEVELS, type RoleMap, type RolesConfig, type SubagentThinkingLevel } from "./roles.ts";

// ---------------------------------------------------------------------------
// Settings persistence (global only — repo .pi/settings.json is read-only)
// ---------------------------------------------------------------------------

function settingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

/** Read the GLOBAL settings.json. Returns null only when the file is missing;
 *  throws when the file exists but is not valid JSON (so a corrupt file can
 *  never be silently overwritten by a panel save). */
function readSettingsJson(): Record<string, unknown> | null {
  const path = settingsPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`settings.json root is not a JSON object (${path})`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.message.includes("not a JSON object")) throw err;
    throw new Error(`settings.json is not valid JSON (${path})`);
  }
}

/** Read-modify-write the `subagent` section of the GLOBAL settings.json.
 *  Writes a temp file then renames (atomic); never touches other keys.
 *  Throws if the existing settings.json is corrupt (the file is left intact).
 *  Returns false when nothing changes. */
export function writeSubagentSection(patch: { roles?: RolesConfig["roles"]; agentModels?: RolesConfig["agentModels"]; agentThinking?: RolesConfig["agentThinking"] }): boolean {
  const settings = readSettingsJson() ?? {};
  const existing = (settings.subagent ?? {}) as Record<string, unknown>;
  const subagent = { ...existing };
  if (patch.roles !== undefined) subagent.roles = patch.roles;
  if (patch.agentModels !== undefined) subagent.agentModels = patch.agentModels;
  if (patch.agentThinking !== undefined) subagent.agentThinking = patch.agentThinking;
  if (JSON.stringify(subagent) === JSON.stringify(existing)) return false;
  const rolesEmpty = subagent.roles === undefined || (typeof subagent.roles === "object" && Object.keys(subagent.roles as object).length === 0);
  const modelsEmpty = subagent.agentModels === undefined || (typeof subagent.agentModels === "object" && Object.keys(subagent.agentModels as object).length === 0);
  const thinkingEmpty = subagent.agentThinking === undefined || (typeof subagent.agentThinking === "object" && Object.keys(subagent.agentThinking as object).length === 0);
  if (rolesEmpty) delete subagent.roles;
  if (modelsEmpty) delete subagent.agentModels;
  if (thinkingEmpty) delete subagent.agentThinking;
  // Preserve any unrelated subagent.* keys (forward compat); drop the section
  // only when roles/agentModels were the only content.
  if (Object.keys(subagent).length === 0) delete settings.subagent;
  else settings.subagent = subagent;
  const target = settingsPath();
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, target);
  return true;
}

// ---------------------------------------------------------------------------
// Row model — unit-testable without a TUI
// ---------------------------------------------------------------------------

export interface RolesPanelCfg {
  /** Working copy: role name → comma chain ("" = use default). */
  roles: Record<string, string>;
  /** Working copy: agent name → override selector ("" = inherit). */
  agentModels: Record<string, string>;
  /** Working copy: agent name → thinking level ("" = agent file default). */
  agentThinking: Record<string, string>;
}

/** Completion sources for the panel's model rows (lazy — resolved per keypress). */
export interface RolesPanelOptions {
  /** Available model refs (`provider/id`), sorted; may be empty before registry sync. */
  models: () => string[];
  /** Known role names (defaults + configured), offered as `@role` on agent rows. */
  roles: () => string[];
  /** Effective role chains used to render each agent's default (falls back to
   *  DEFAULT_ROLES). Pass the working copy's roles so labels track live edits. */
  effectiveRoles?: RoleMap;
}

/** Seed a working config from current effective settings + bundled agents. */
export function buildRolesPanelCfg(agents: AgentConfig[], current: RolesConfig): RolesPanelCfg {
  const roleNames = new Set([...Object.keys(DEFAULT_ROLES), ...Object.keys(current.roles)]);
  const cfg: RolesPanelCfg = { roles: {}, agentModels: {}, agentThinking: {} };
  for (const name of roleNames) {
    // Only show explicitly-configured values; defaults render blank (= default).
    const explicit = (current.roles[name] !== undefined && JSON.stringify(current.roles[name]) !== JSON.stringify(DEFAULT_ROLES[name]))
      ? (Array.isArray(current.roles[name]) ? current.roles[name].join(", ") : String(current.roles[name]))
      : "";
    cfg.roles[name] = explicit;
  }
  for (const agent of agents) cfg.agentModels[agent.name] = current.agentModels[agent.name] ?? "";
  for (const agent of agents) cfg.agentThinking[agent.name] = current.agentThinking[agent.name] ?? "";
  return cfg;
}

/** Human-readable default (no-override) chain for an agent's panel row label. */
export function defaultChainLabel(
  agent: Pick<AgentConfig, "name" | "model" | "models">,
  roles: RoleMap,
): string {
  const raw = getModelCandidates(agent);
  const alias = raw.filter((m) => m.startsWith("@")).join(", ");
  const { candidates } = resolveAgentModelChain(agent, { roles, agentModels: {}, agentThinking: {} });
  const chain = candidates.length > 0 ? candidates.join(", ") : "parent fallback";
  // alias is @-prefixed, candidates are expanded model ids — never equal.
  return alias ? `default: ${alias} → ${chain}` : `default: ${chain}`;
}

/** Build panel groups. Role rows first, then one override row per agent.
 *  `options` adds inline model/@role completions when provided (optional so
 *  existing unit tests and non-TUI callers stay unchanged). `actions` appends
 *  the + Add role / − Remove role action rows when provided. */
export function buildRows(
  cfg: RolesPanelCfg,
  agents: AgentConfig[],
  options?: RolesPanelOptions,
  actions?: Record<string, PanelAction>,
): PanelGroup[] {
  const defaultChain = (name: string) => Array.isArray(DEFAULT_ROLES[name]) ? (DEFAULT_ROLES[name] as string[]).join(", ") : String(DEFAULT_ROLES[name] ?? "");
  const modelItems = (): CompletionItem[] =>
    (options?.models() ?? []).sort().map((ref) => ({ value: ref }));
  const roleItems = (): CompletionItem[] =>
    (options?.roles() ?? []).map((name) => ({ value: `@${name}`, description: "role chain" }));
  // ponytail: opts spread keeps this compilable against kernel 0.1.0 (whose
  // row() opts type lacks `completions`); the runtime contract is additive and
  // 0.1.1+ consumes the field. Drop the cast when the dep floor moves to 0.1.1.
  const withCompletions = (completions: () => CompletionItem[]) =>
    ({ completions }) as unknown as { mask?: boolean };
  const roleRows = Object.keys(cfg.roles).sort().map((name) => {
    // Label shows the default chain so blank is meaningful.
    return row(`role.${name}`, `@${name}  (default: ${defaultChain(name) || "none"})`, "string", cfg.roles[name], (v) => {
      cfg.roles[name] = String(v ?? "").trim();
    }, withCompletions(modelItems));
  });
  const effective = options?.effectiveRoles ?? DEFAULT_ROLES;
  const agentRows = agents.map((agent) =>
    row(`agent.${agent.name}`, `${agent.name}  (${defaultChainLabel(agent, effective)})`, "string", cfg.agentModels[agent.name] ?? "", (v) => {
      const value = String(v ?? "").trim();
      if (value) cfg.agentModels[agent.name] = value;
      else delete cfg.agentModels[agent.name];
    }, withCompletions(() => [...modelItems(), ...roleItems()])),
  );
  const actionRows: PanelRow[] = [];
  if (actions?.addRole) {
    actionRows.push({ key: "action.addRole", label: "+ Add role", kind: "action", value: undefined, set: (p) => actions.addRole!.run(p as never) });
  }
  if (actions?.removeRole) {
    actionRows.push({ key: "action.removeRole", label: "− Remove role", kind: "action", value: undefined, set: (p) => actions.removeRole!.run(p as never) });
  }
  return [
    { key: "roles", label: "Model roles (entry may end :level; blank = default)", rows: [...roleRows, ...actionRows] },
    { key: "agents", label: "Per-agent overrides (blank = inherit)", rows: agentRows },
    {
      key: "agentThinking",
      label: "Per-agent thinking (blank = file default)",
      rows: agents.map((agent) =>
        row(`agentThinking.${agent.name}`, agent.name, "string", cfg.agentThinking[agent.name] ?? "", (v) => {
          const value = String(v ?? "").trim();
          if (value) cfg.agentThinking[agent.name] = value;
          else delete cfg.agentThinking[agent.name];
        }, withCompletions(() => THINKING_LEVELS.map((level) => ({ value: level })))),
      ),
    },
  ];
}

/** Convert a working config back to a settings patch. Blank values drop keys
 *  (role falls back to default; agent override is removed). Invalid thinking
 *  values are dropped too — `invalidAgentThinking` reports them for the save
 *  notification. */
export function cfgToPatch(cfg: RolesPanelCfg): { roles: RolesConfig["roles"]; agentModels: RolesConfig["agentModels"]; agentThinking: RolesConfig["agentThinking"] } {
  const roles: RolesConfig["roles"] = {};
  for (const [name, chain] of Object.entries(cfg.roles)) {
    const trimmed = chain.trim();
    if (!trimmed) continue;
    roles[name] = trimmed.includes(",") ? trimmed.split(",").map((s) => s.trim()).filter(Boolean) : trimmed;
  }
  const agentModels: RolesConfig["agentModels"] = {};
  for (const [name, value] of Object.entries(cfg.agentModels)) {
    const trimmed = value.trim();
    if (trimmed) agentModels[name] = trimmed;
  }
  const agentThinking: RolesConfig["agentThinking"] = {};
  for (const [name, value] of Object.entries(cfg.agentThinking)) {
    const trimmed = value.trim();
    if (THINKING_LEVELS.includes(trimmed)) agentThinking[name] = trimmed as SubagentThinkingLevel;
  }
  return { roles, agentModels, agentThinking };
}

/** Agent names whose working-copy thinking value is non-blank but not a valid
 *  level (typo guard — cfgToPatch drops them). Empty when all values are OK. */
export function invalidAgentThinking(cfg: RolesPanelCfg): string[] {
  return Object.entries(cfg.agentThinking)
    .filter(([, value]) => {
      const trimmed = value.trim();
      return trimmed !== "" && !THINKING_LEVELS.includes(trimmed);
    })
    .map(([name]) => name);
}

/** Validate a new role name; returns an error message or null when OK. */
export function validateNewRoleName(name: string, known: readonly string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Role name is empty.";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) {
    return `Invalid role name "${trimmed}" — use letters, digits, dot, dash, underscore (max 64).`;
  }
  const clash = known.find((k) => k.toLowerCase() === trimmed.toLowerCase());
  if (clash) return `Role @${clash} already exists.`;
  return null;
}

/** Apply a role removal to the working config. Built-in roles (DEFAULT_ROLES)
 *  can only be reset to their bundled chain (blank); custom roles are deleted
 *  (row disappears on rebuild, key dropped by cfgToPatch). Unknown → null. */
export function removeRoleFromCfg(cfg: RolesPanelCfg, name: string): "reset" | "deleted" | null {
  const key = Object.keys(cfg.roles).find((k) => k.toLowerCase() === name.trim().toLowerCase());
  if (!key) return null;
  if (DEFAULT_ROLES[key] !== undefined) {
    cfg.roles[key] = "";
    return "reset";
  }
  delete cfg.roles[key];
  return "deleted";
}

export interface RoleActionOpts {
  /** User feedback (defaults to no-op so tests stay quiet). */
  notify?: (message: string, kind?: "info" | "warning" | "error") => void;
}

/** "+ Add role" panel action: prompt name → validate → prompt chain → mutate
 *  the working config (kernel rebuilds rows + marks dirty after the action). */
export function makeAddRoleAction(cfg: RolesPanelCfg, opts: RoleActionOpts = {}): PanelAction {
  return {
    label: "Add role",
    run: (prompt) => new Promise<void>((resolve) => {
      prompt("Role name (e.g. writer)", (name) => {
        const trimmed = (name ?? "").trim();
        if (!trimmed) return resolve();
        const err = validateNewRoleName(trimmed, Object.keys(cfg.roles));
        if (err) {
          opts.notify?.(err, "warning");
          return resolve();
        }
        prompt("Model chain (comma-separated; @role or * allowed)", (chain) => {
          const value = (chain ?? "").trim();
          if (!value) {
            opts.notify?.("Chain required — role not added.", "warning");
            return resolve();
          }
          cfg.roles[trimmed] = value;
          resolve();
        });
      });
    }),
  };
}

/** "− Remove role" panel action: prompt pick from known roles, then reset
 *  (built-in) or delete (custom) via removeRoleFromCfg. */
export function makeRemoveRoleAction(cfg: RolesPanelCfg, opts: RoleActionOpts = {}): PanelAction {
  return {
    label: "Remove role",
    run: (prompt) => new Promise<void>((resolve) => {
      const names = Object.keys(cfg.roles).sort();
      if (names.length === 0) {
        opts.notify?.("No roles to remove.", "warning");
        return resolve();
      }
      prompt(`Remove role (${names.join(", ")})`, (pick) => {
        if (!pick) return resolve();
        const result = removeRoleFromCfg(cfg, pick);
        if (result === "reset") opts.notify?.(`@${pick.trim()} reset to bundled default`, "info");
        else if (result === "deleted") opts.notify?.(`@${pick.trim()} removed`, "info");
        else opts.notify?.(`No role named "${pick.trim()}".`, "warning");
        resolve();
      });
    }),
  };
}

/** Keep overrides for agents NOT shown in the panel (e.g. overrides for
 *  project-local agents saved globally from another project) so a panel save
 *  doesn't wipe them. Discovered-agent entries always follow the panel.
 *  Generic over the value type so it also preserves `agentThinking`. */
export function preserveUnknownAgentModels<T extends Record<string, string>>(
  patch: T,
  discoveredNames: readonly string[],
  existing: T | undefined,
): T {
  if (!existing) return patch;
  const out: Record<string, string> = { ...patch };
  for (const [name, value] of Object.entries(existing)) {
    if (!discoveredNames.includes(name) && out[name] === undefined) out[name] = value;
  }
  return out as T;
}
