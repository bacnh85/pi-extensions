import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./provider.js";

/** Re-select the active router model so Pi picks up refreshed capability
 *  flags (e.g. reasoning after a toggle). id+provider are unchanged, so Pi's
 *  modelsAreEqual guard suppresses the model_select event — but Pi core still
 *  re-applies the global thinking default inside setModel (its guard covers
 *  only the event), which would silently reset a session-only /thinking pick.
 *  Snapshot the level and restore it if setModel clobbered it. */
export async function refreshActiveModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const active = ctx.model;
  if (active?.provider !== PROVIDER_ID || !active.id) return;
  const refreshed = ctx.modelRegistry.find(PROVIDER_ID, active.id);
  if (refreshed) {
    const level = pi.getThinkingLevel();
    try { await pi.setModel(refreshed); } catch { return; /* missing auth — ignore */ }
    if (pi.getThinkingLevel() !== level) pi.setThinkingLevel(level);
  }
}
