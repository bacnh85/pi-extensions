/**
 * `/advisor models` panel (kernel lives in @bacnh85/pi-config-panel).
 *
 * Per slot: a model-ref row plus a thinking row (blank = provider default).
 * A pinned level serializes into the chain entry as `provider/id:level`
 * (strict trailing match; openrouter `:free` ids stay intact), so the saved
 * `pi-advisor.models` shape stays a plain string array. Plus "Add model slot"
 * / "Remove last" action rows. Saving writes to the GLOBAL
 * `~/.pi/agent/settings.json` via saveModels (merge + atomic rename).
 */

import { row } from "@bacnh85/pi-config-panel";
import type { PanelGroup, PanelAction } from "@bacnh85/pi-config-panel";
import { splitThinkingSuffix, THINKING_LEVELS } from "./config";

/** Completion sources for the panel's model rows (lazy — resolved per keypress). */
export interface ModelsPanelOptions {
  /** Available model refs (`provider/id`), sorted; may be empty before registry sync. */
  models: () => string[];
}

export interface ModelsPanelCfg {
  /** Working copy: ordered slots; blank ref = removed slot. */
  models: { ref: string; thinking: string }[];
}

/** Seed a working config from the current effective chain (`ref:level` entries parsed). */
export function buildModelsPanelCfg(models: readonly string[]): ModelsPanelCfg {
  return {
    models: models.map((entry) => {
      const { name, thinking } = splitThinkingSuffix(String(entry ?? "").trim());
      return { ref: name, thinking: thinking ?? "" };
    }),
  };
}

/** Build panel groups: per-slot model + thinking rows + add/remove actions.
 *  `options` adds inline model completions (optional so unit tests and
 *  non-TUI callers stay unchanged). */
export function buildRows(cfg: ModelsPanelCfg, options?: ModelsPanelOptions, actions: Record<string, PanelAction> = {}): PanelGroup[] {
  const modelItems = (): { value: string }[] =>
    (options?.models() ?? []).sort().map((ref) => ({ value: ref }));
  const withCompletions = options ? { completions: modelItems } : {};
  const levelItems = () => THINKING_LEVELS.filter((l) => l !== "off").map((level) => ({ value: level }));
  const rows = cfg.models.flatMap((slot, index) => {
    const modelRow = row(`model.${index}`, `#${index + 1}${index === 0 ? " (primary)" : ""}`, "string", slot.ref, (v) => {
      slot.ref = String(v ?? "").trim();
    }, withCompletions);
    const thinkingRow = row(`model.${index}.thinking`, `#${index + 1} thinking (blank = model default)`, "string", slot.thinking, (v) => {
      slot.thinking = String(v ?? "").trim();
    }, { completions: levelItems } as unknown as { mask?: boolean });
    return [modelRow, thinkingRow];
  });
  const actionRows = Object.entries(actions).map(([key, action]) => ({ key, label: action.label, kind: "action" as const, value: "", set: action.run as unknown as (v: unknown) => void }));
  return [{ key: "models", label: "Model chain (ordered fallback, first = primary)", rows: [...rows, ...actionRows] }];
}

/** Slot indexes whose thinking value is non-blank but not a valid level
 *  (typo guard — cfgToModels drops them). Empty when all values are OK. */
export function invalidThinkingSlots(cfg: ModelsPanelCfg): number[] {
  const out: number[] = [];
  cfg.models.forEach((slot, index) => {
    const t = slot.thinking.trim();
    if (t && !THINKING_LEVELS.includes(t)) out.push(index);
  });
  return out;
}

/** Convert a working config back to the saved chain: `ref:level` when a valid
 *  level is pinned; blank refs and invalid levels dropped. */
export function cfgToModels(cfg: ModelsPanelCfg): string[] {
  const out: string[] = [];
  for (const slot of cfg.models) {
    const ref = slot.ref.trim();
    if (!ref) continue;
    const thinking = slot.thinking.trim();
    out.push(thinking && THINKING_LEVELS.includes(thinking) && thinking !== "off" ? `${ref}:${thinking}` : ref);
  }
  return out;
}
