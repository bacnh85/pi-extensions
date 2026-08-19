import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_MODE,
  RUNTIME_MODES,
  getDefaultMode,
  getQuietStartup,
  getHideStatus,
  normalizeMode,
  normalizePersistedMode,
  isDeactivationCommand,
  writeDefaultMode,
} = require("../hooks/ponytail-config.js");
const { getPonytailInstructions, filterSkillBodyForMode } = require("../hooks/ponytail-instructions.js");

export { filterSkillBodyForMode };
export const readDefaultMode = getDefaultMode;
export const readQuietStartup = getQuietStartup;

export function resolveSessionMode(entries, fallbackMode = DEFAULT_MODE) {
  const fallback = normalizePersistedMode(fallbackMode) || DEFAULT_MODE;
  if (!Array.isArray(entries)) return fallback;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry?.customType !== "ponytail-mode") continue;

    const mode = normalizePersistedMode(entry?.data?.mode);
    if (mode) return mode;
  }

  return fallback;
}

export function parsePonytailCommand(text, defaultMode = DEFAULT_MODE) {
  const fallback = normalizePersistedMode(defaultMode) || DEFAULT_MODE;
  const normalizedText = String(text || "").trim().toLowerCase();

  if (!normalizedText) {
    return { type: "set-mode", mode: fallback === "off" ? "full" : fallback };
  }

  const [primary, secondary] = normalizedText.split(/\s+/);

  if (primary === "status") return { type: "status" };

  if (primary === "default") {
    // ponytail: a default must be a runtime level; review is session-only (#377).
    const mode = normalizeMode(secondary);
    return mode ? { type: "set-default", mode } : { type: "invalid", reason: "invalid-default-mode" };
  }

  const mode = normalizeMode(primary);
  return mode ? { type: "set-mode", mode } : { type: "invalid", reason: "invalid-mode", mode: primary };
}

export { writeDefaultMode };

export default function ponytailExtension(pi) {
  let currentMode = DEFAULT_MODE;
  let configuredDefaultMode = getDefaultMode();
  let hideStatus = getHideStatus();
  // -- Status bar --
  function syncStatus(ctx) {
    if (hideStatus) return;
    if (!ctx?.ui?.setStatus) return;
    // ponytail: try/catch guards against pi-web theme proxy throwing before initTheme (#336).
    let theme;
    try { theme = ctx.ui.theme; if (!theme?.fg) return; } catch { return; }
    if (currentMode === "off") {
      try { ctx.ui.setStatus("ponytail", ""); } catch { return; }
      return;
    }
    const levelIcons = { lite: "🌿", full: "⚡", ultra: "🔥", review: "🔍" };
    const icon = levelIcons[currentMode] || "";
    const label = currentMode.toUpperCase();
    try { ctx.ui.setStatus("ponytail", " 🐴 " + theme.fg("muted", "ponytail: ") + theme.fg("text", icon + " " + label)); } catch { return; }
  }

  const setMode = (mode, ctx) => {
    const normalized = normalizePersistedMode(mode);
    if (!normalized) return;

    pi.appendEntry("ponytail-mode", { mode: normalized });
    currentMode = normalized;
    syncStatus(ctx);
  };

  pi.registerCommand("ponytail", {
    description: `Set mode: ${RUNTIME_MODES.join("|")}. Commands: status, default <mode>`,
    handler: async (args, ctx) => {
      const parsed = parsePonytailCommand(args, configuredDefaultMode);

      if (parsed.type === "status") {
        ctx?.ui?.notify?.(`Ponytail: current ${currentMode} • default ${configuredDefaultMode}`, "info");
        return;
      }

      if (parsed.type === "set-default") {
        try {
          const written = writeDefaultMode(parsed.mode);
          if (written) {
            configuredDefaultMode = getDefaultMode();
            const message = configuredDefaultMode === written
              ? `Default Ponytail mode set to ${written}.`
              : `Saved default ${written}, but env override keeps default at ${configuredDefaultMode}.`;
            ctx?.ui?.notify?.(message, "info");
          } else {
            ctx?.ui?.notify?.(`Invalid default mode “${parsed.mode}”. Use: lite, full, ultra, or off.`, "warning");
          }
        } catch (e) {
          ctx?.ui?.notify?.(`Failed to save default mode: ${e.message}`, "error");
        }
        return;
      }

      if (parsed.type === "set-mode") {
        setMode(parsed.mode, ctx);
        return;
      }

      if (parsed.type === "invalid") {
        const msg = parsed.reason === "invalid-default-mode"
          ? "Invalid default mode. Use: lite, full, ultra, or off."
          : `Unknown mode: ${parsed.mode}. Use: lite, full, ultra, off, status, or default <mode>.`;
        ctx?.ui?.notify?.(msg, "warning");
        return;
      }

      ctx?.ui?.notify?.("Unknown or unsupported /ponytail mode.", "warning");
    },
  });

  ["review", "audit", "gain", "debt", "help"].forEach((name) => {
    pi.registerCommand(`ponytail-${name}`, {
      description: `Run /skill:ponytail-${name}`,
      handler: () => pi.sendUserMessage(`/skill:ponytail-${name}`, { expandPromptTemplates: true }),
    });
  });

  pi.on("input", async (event, ctx) => {
    if (event?.source === "extension") return;

    const text = String(event?.text || "");
    if (currentMode !== "off" && isDeactivationCommand(text)) {
      setMode("off", ctx);
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    syncStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    syncStatus(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
    configuredDefaultMode = getDefaultMode();
    hideStatus = getHideStatus();
    currentMode = resolveSessionMode(entries, configuredDefaultMode);
    syncStatus(ctx);
    if (!getQuietStartup()) {
      ctx?.ui?.notify?.(`Ponytail loaded: ${currentMode}`, "info");
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!currentMode || currentMode === "off") return;
    // Guard null/undefined event and missing systemPrompt (#439, #440).
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}${getPonytailInstructions(currentMode)}` };
  });
}
