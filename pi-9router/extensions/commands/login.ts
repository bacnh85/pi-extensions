import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NineRouterConfig } from "../lib/config.js";
import { saveConfig, configSummary, normalizeUrl } from "../lib/config.js";
import { fetchModels } from "../lib/client.js";
import { refreshActiveModel } from "../index.js";

export function registerLoginCommand(
  pi: ExtensionAPI,
  getConfig: () => NineRouterConfig,
  getModelIds: () => string[],
  onConfigChange: (config: NineRouterConfig) => void,
): void {
  pi.registerCommand("login-9router", {
    description: "Configure 9router connection (endpoint URL + API key).",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/login-9router requires interactive (TUI) mode.", "error");
        return;
      }

      const current = getConfig();

      // 1. Prompt for endpoint URL
      const prompt = current.baseUrl
        ? `9router Endpoint URL (current: ${current.baseUrl})`
        : "9router Endpoint URL";
      const baseUrl = await ctx.ui.input(prompt, "http://localhost:20128/v1");
      if (!baseUrl) {
        ctx.ui.notify("Cancelled — no endpoint provided.", "info");
        return;
      }

      // 2. Prompt for API key
      const keyPrompt = current.apiKey
        ? "9router API Key (already configured — leave empty to keep)"
        : "9router API Key (optional)";
      const apiKey = await ctx.ui.input(keyPrompt, "sk-...");
      if (apiKey === undefined) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      const normalized = normalizeUrl(baseUrl);
      // If user left the API key empty and there is already a configured key, keep it.
      const resolvedApiKey = apiKey.trim() || current.apiKey || undefined;
      const newConfig: NineRouterConfig = {
        baseUrl: normalized,
        apiKey: resolvedApiKey,
        enableReasoning: current.enableReasoning,
      };

      // 3. Test connection
      ctx.ui.notify("Testing connection to 9router…", "info");
      try {
        const models = await fetchModels(newConfig);
        saveConfig(newConfig);
        await onConfigChange(newConfig);
        // Refresh active model to pick up any updated capability flags
        await refreshActiveModel(pi, ctx);
        ctx.ui.notify(
          `9router connected — ${models.length} models discovered.\n${configSummary(newConfig)}`,
          "info",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Connection failed: ${msg}. Config saved but provider not active.`, "error");
        // Still save the config so the user can retry later
        saveConfig(newConfig);
        await onConfigChange(newConfig);
      }
    },
  });

  pi.registerCommand("9router-reasoning", {
    description: "Enable/disable Pi thinking levels for 9router models.",
    handler: async (_args, ctx) => {
      const current = getConfig();
      const next = !current.enableReasoning;
      const newConfig: NineRouterConfig = { ...current, enableReasoning: next };
      saveConfig(newConfig);
      await onConfigChange(newConfig);
      // Refresh active model to pick up toggled reasoning capabilities
      await refreshActiveModel(pi, ctx);
      ctx.ui.notify(
        `9router reasoning ${next ? "ENABLED" : "DISABLED"} — ` +
          `use Shift+Tab or model :high/:max suffixes for reasoning.`,
        "info",
      );
    },
  });

  pi.registerCommand("9router-model", {
    description: "Search and select a 9router model by name.",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/9router-model requires interactive (TUI) mode.", "error");
        return;
      }

      const ids = getModelIds();
      if (ids.length === 0) {
        ctx.ui.notify("No 9router models available. Run /login-9router first.", "error");
        return;
      }

      // Filter by optional search term
      const term = (args || "").trim().toLowerCase();
      const matches = term ? ids.filter((id) => id.toLowerCase().includes(term)) : ids;

      if (matches.length === 0) {
        ctx.ui.notify(`No 9router models matching "${args}".`, "error");
        return;
      }

      // Look up each matching model from the registry and select
      async function trySelect(id: string): Promise<boolean> {
        const model = ctx.modelRegistry.find("9router", id);
        if (!model) return false;
        try { await pi.setModel(model); return true; }
        catch { return false; }
      }

      if (matches.length === 1) {
        const ok = await trySelect(matches[0]);
        ctx.ui.notify(
          ok ? `Selected 9router/${matches[0]}` : `Failed to select 9router/${matches[0]}`,
          ok ? "info" : "error",
        );
        return;
      }

      // Multiple matches — let user pick
      const choice = await ctx.ui.select("Select 9router model:", matches);
      if (choice) {
        const ok = await trySelect(choice);
        ctx.ui.notify(
          ok ? `Selected 9router/${choice}` : `Failed to select 9router/${choice}`,
          ok ? "info" : "error",
        );
      }
    },
  });

  pi.registerCommand("9router-status", {
    description: "Show 9router connection status and model info.",
    handler: async (_args, ctx) => {
      const config = getConfig();
      const lines = ["── 9router Status ──", configSummary(config), ""];
      lines.push("Commands:");
      lines.push("  /login-9router     Configure connection");
      lines.push("  /9router-reasoning Toggle thinking levels");
      lines.push("  /9router-model     Search and select a model");
      lines.push("  /model             Select 9router models (Pi built-in)");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
