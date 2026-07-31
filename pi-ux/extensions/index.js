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
} = require("../hooks/ux-config.js");
const { getUxInstructions } = require("../hooks/ux-instructions.js");
const { audit } = require("../hooks/ux-audit.js");

export const readDefaultMode = getDefaultMode;
export const readQuietStartup = getQuietStartup;

export function resolveSessionMode(entries, fallbackMode = DEFAULT_MODE) {
  const fallback = normalizePersistedMode(fallbackMode) || DEFAULT_MODE;
  if (!Array.isArray(entries)) return fallback;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry?.customType !== "ux-mode") continue;

    const mode = normalizePersistedMode(entry?.data?.mode);
    if (mode) return mode;
  }

  return fallback;
}

export function parseUxCommand(text, defaultMode = DEFAULT_MODE) {
  const fallback = normalizePersistedMode(defaultMode) || DEFAULT_MODE;
  const normalizedText = String(text || "").trim().toLowerCase();

  if (!normalizedText) {
    return { type: "set-mode", mode: fallback === "off" ? "strict" : fallback };
  }

  const [primary, secondary] = normalizedText.split(/\s+/);

  if (primary === "status") return { type: "status" };

  if (primary === "default") {
    // ponytail: a default must be a runtime level, not a session-only mode.
    const mode = normalizeMode(secondary);
    return mode ? { type: "set-default", mode } : { type: "invalid", reason: "invalid-default-mode" };
  }

  const mode = normalizeMode(primary);
  return mode ? { type: "set-mode", mode } : { type: "invalid", reason: "invalid-mode", mode: primary };
}

export { writeDefaultMode };

// ponytail: plain JSON-schema object, not TypeBox — at runtime the symbols are
// stripped on JSON.stringify anyway, and we keep zero deps. Shape matches what
// Type.Object produces for the LLM tool spec.
function auditParametersSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      css: {
        type: "string",
        description: "CSS stylesheet content to audit (inline stylesheets, styled-components output, or a concatenated .css file).",
      },
      pairs: {
        type: "array",
        description: "Foreground/background colour pairs to check for WCAG contrast (fg + bg as #hex, a label, and a min ratio defaulting to 4.5).",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            fg: { type: "string", description: "Foreground colour, e.g. '#111111'." },
            bg: { type: "string", description: "Background colour, e.g. '#ffffff'." },
            label: { type: "string", description: "Human label for this text style (e.g. 'body')." },
            min: { type: "number", description: "Minimum contrast ratio. 4.5 for body, 3.0 for large/UI. Defaults to 4.5." },
          },
          required: ["fg", "bg"],
        },
      },
    },
  };
}

function formatAuditResult(result) {
  const lines = [];
  lines.push(result.pass ? "✅ UX AUDIT PASSED" : "❌ UX AUDIT FAILED");
  lines.push("");

  const c = result.gates.contrast;
  lines.push(c.pass ? "✓ Contrast" : "✗ Contrast");
  for (const r of c.results) {
    const ratio = r.ratio === null ? "n/a" : `${r.ratio.toFixed(2)}:1`;
    lines.push(`  ${r.pass ? "✓" : "✗"} ${r.label || `${r.fg}/${r.bg}`}: ${ratio} (min ${r.min ?? 4.5})`);
  }

  const t = result.gates.tokens;
  lines.push(t.pass ? "✓ Tokens" : "✗ Tokens");
  for (const h of t.hardcodedHex) lines.push(`  ✗ hardcoded hex: ${h}`);
  for (const s of t.adhocShadow) lines.push(`  ✗ ad-hoc box-shadow: ${s}`);

  const s = result.gates.states;
  lines.push(s.pass ? "✓ States" : "✗ States");
  for (const m of s.missingFocusVisible) lines.push(`  ✗ ${m}`);
  for (const m of s.missingDisabled) lines.push(`  ✗ ${m}`);

  return lines.join("\n");
}

export default function uxExtension(pi) {
  let currentMode = DEFAULT_MODE;
  let configuredDefaultMode = getDefaultMode();
  let hideStatus = getHideStatus();

  function syncStatus(ctx) {
    if (hideStatus) return;
    if (!ctx?.ui?.setStatus) return;
    // ponytail: try/catch guards against theme proxy throwing before init.
    let theme;
    try { theme = ctx.ui.theme; if (!theme?.fg) return; } catch { return; }
    if (currentMode === "off") {
      try { ctx.ui.setStatus("ux", ""); } catch { return; }
      return;
    }
    const levelIcons = { lite: "🎨", strict: "📐" };
    const icon = levelIcons[currentMode] || "";
    const label = currentMode.toUpperCase();
    try {
      ctx.ui.setStatus("ux", " 🎨 " + theme.fg("muted", "ux: ") + theme.fg("text", icon + " " + label));
    } catch { return; }
  }

  const setMode = (mode, ctx) => {
    const normalized = normalizePersistedMode(mode);
    if (!normalized) return;

    pi.appendEntry("ux-mode", { mode: normalized });
    currentMode = normalized;
    syncStatus(ctx);
  };

  pi.registerTool({
    name: "ux_audit",
    label: "UX Slop Audit",
    description:
      "Run deterministic slop-audit gates on CSS: WCAG contrast, off-system token values (hardcoded hex / ad-hoc shadows), and missing interaction states (:focus-visible / :disabled). No model needed — all gates are computable. In strict mode, block handoff until this passes.",
    promptSnippet: "Run deterministic UX slop-audit (contrast + tokens + states)",
    promptGuidelines: [
      "Contrast and token-coverage are computable, not judgement — use this tool instead of eyeballing.",
      "Pass fg/bg colour pairs to check WCAG AA contrast (4.5:1 body, 3:1 large/UI).",
      "Pass the CSS string to scan for hardcoded hex and ad-hoc box-shadow not built from var() tokens.",
      "State coverage flags interactive elements (button/a/input/...) missing :focus-visible or :disabled rules.",
    ],
    parameters: auditParametersSchema(),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const css = typeof params.css === "string" ? params.css : "";
      const pairs = Array.isArray(params.pairs) ? params.pairs : [];
      const result = audit({ css, pairs });
      return {
        content: [{ type: "text", text: formatAuditResult(result) }],
        details: result,
      };
    },
  });

  pi.registerCommand("ux", {
    description: `Anti-slop UI/UX discipline. Modes: ${RUNTIME_MODES.join("|")}. Commands: status, default <mode>`,
    handler: async (args, ctx) => {
      const parsed = parseUxCommand(args, configuredDefaultMode);

      if (parsed.type === "status") {
        ctx?.ui?.notify?.(`UX: current ${currentMode} • default ${configuredDefaultMode}`, "info");
        return;
      }

      if (parsed.type === "set-default") {
        try {
          const written = writeDefaultMode(parsed.mode);
          if (written) {
            configuredDefaultMode = getDefaultMode();
            const message = configuredDefaultMode === written
              ? `Default UX mode set to ${written}.`
              : `Saved default ${written}, but env override keeps default at ${configuredDefaultMode}.`;
            ctx?.ui?.notify?.(message, "info");
          } else {
            ctx?.ui?.notify?.(`Invalid default mode. Use: lite, strict, or off.`, "warning");
          }
        } catch (e) {
          ctx?.ui?.notify?.(`Failed to save default mode: ${e.message}`, "error");
        }
        return;
      }

      if (parsed.type === "set-mode") {
        setMode(parsed.mode, ctx);
        ctx?.ui?.notify?.(`UX discipline: ${parsed.mode}`, "info");
        return;
      }

      if (parsed.type === "invalid") {
        const msg = parsed.reason === "invalid-default-mode"
          ? "Invalid default mode. Use: lite, strict, or off."
          : `Unknown mode: ${parsed.mode}. Use: lite, strict, off, status, or default <mode>.`;
        ctx?.ui?.notify?.(msg, "warning");
        return;
      }

      ctx?.ui?.notify?.("Unknown or unsupported /ux mode.", "warning");
    },
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
      ctx?.ui?.notify?.(`pi-ux loaded: ${currentMode}`, "info");
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!currentMode || currentMode === "off") return;
    // Guard null/undefined event and missing systemPrompt.
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}${getUxInstructions(currentMode)}` };
  });
}
