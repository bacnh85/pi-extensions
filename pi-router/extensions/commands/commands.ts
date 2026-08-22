import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RouterSettings } from "../lib/config.js";
import { configSummary, getSettings } from "../lib/config.js";
import { registerProvider, PROVIDER_ID } from "../lib/provider.js";
import { refreshActiveModel } from "../index.js";

function settingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

function readSettingsJson(): Record<string, unknown> {
  try {
    return existsSync(settingsPath())
      ? (JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Persist `router.enableReasoning` to settings.json (merge, never clobber). */
function writeReasoningFlag(value: boolean): void {
  const settings = readSettingsJson();
  const router = (settings.router ?? {}) as Record<string, unknown>;
  router.enableReasoning = value;
  settings.router = router;
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

export function registerCommands(pi: ExtensionAPI, _getSettings: () => RouterSettings): void {
  pi.registerCommand("router-reasoning", {
    description: "Enable/disable Pi thinking levels for router models.",
    handler: async (_args, ctx) => {
      const current = getSettings();
      if (!current.baseUrl) {
        ctx.ui.notify("router not configured — set router.baseUrl in settings.json first.", "error");
        return;
      }
      const next = !current.enableReasoning;
      writeReasoningFlag(next);
      // Re-register so refreshModels closure picks up the new flag, then force
      // a provider refresh; the offline phase re-maps persisted models and the
      // network phase re-fetches with the new reasoning flag.
      registerProvider(pi, { ...current, enableReasoning: next });
      try {
        await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] });
      } catch { /* refresh errors are surfaced by Pi elsewhere */ }
      await refreshActiveModel(pi, ctx);
      // Report the EFFECTIVE flag — env/repo precedence can shadow the persisted value.
      const effective = getSettings().enableReasoning;
      ctx.ui.notify(
        effective === next
          ? `router reasoning ${next ? "ENABLED" : "DISABLED"} — ` +
              `use Shift+Tab or model :high/:max suffixes for reasoning.`
          : `saved ${next ? "true" : "false"} to settings.json, but ROUTER_ENABLE_REASONING env or ` +
              `repo .pi/settings.json overrides it to ${effective} — remove the override.`,
        "info",
      );
    },
  });

  pi.registerCommand("router-model", {
    description: "Search and select a router model by name.",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/router-model requires interactive (TUI) mode.", "error");
        return;
      }
      const ids = ctx.modelRegistry
        .getAll()
        .filter((m) => m.provider === PROVIDER_ID)
        .map((m) => m.id);
      if (ids.length === 0) {
        ctx.ui.notify("No router models available yet — open /models or /login router to trigger discovery.", "error");
        return;
      }

      const term = (args || "").trim().toLowerCase();
      const matches = term ? ids.filter((id) => id.toLowerCase().includes(term)) : ids;

      if (matches.length === 0) {
        ctx.ui.notify(`No router models matching "${args}".`, "error");
        return;
      }

      async function trySelect(id: string): Promise<boolean> {
        const model = ctx.modelRegistry.find(PROVIDER_ID, id);
        if (!model) return false;
        try { await pi.setModel(model); return true; }
        catch { return false; }
      }

      if (matches.length === 1) {
        const ok = await trySelect(matches[0]);
        ctx.ui.notify(
          ok ? `Selected ${PROVIDER_ID}/${matches[0]}` : `Failed to select ${PROVIDER_ID}/${matches[0]}`,
          ok ? "info" : "error",
        );
        return;
      }

      const choice = await ctx.ui.select("Select router model:", matches);
      if (choice) {
        const ok = await trySelect(choice);
        ctx.ui.notify(
          ok ? `Selected ${PROVIDER_ID}/${choice}` : `Failed to select ${PROVIDER_ID}/${choice}`,
          ok ? "info" : "error",
        );
      }
    },
  });

  pi.registerCommand("router-status", {
    description: "Show router connection status and model info.",
    handler: async (_args, ctx) => {
      const settings = getSettings();
      const count = ctx.modelRegistry
        .getAll()
        .filter((m) => m.provider === PROVIDER_ID).length;
      const lines = [
        "── Router Status ──",
        configSummary(settings),
        `Models in catalog: ${count}`,
        "",
        "Commands:",
        "  /login router       Store API key (auth.json)",
        "  /router-reasoning   Toggle thinking levels",
        "  /router-model       Search and select a model",
        "  /model              Pi built-in picker (triggers refresh)",
        "",
        "URL: settings.json `router.baseUrl` or ROUTER_BASE_URL env.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
