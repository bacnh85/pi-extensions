import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChatGptWebConfig } from "../lib/config.js";
import { saveConfig, saveCodexConfig, configSummary, normalizeUrl } from "../lib/config.js";
import { fetchModels, fetchAccountPool } from "../lib/client.js";
import { PROVIDER_ID, CODEX_PROVIDER_ID } from "../lib/provider.js";
import { refreshActiveModel } from "../index.js";

type ConfigChange = (config: ChatGptWebConfig) => void;

/** Register one provider's command trio (login/model/status). The two
 *  providers are wired identically apart from names and defaults. */
function registerTrio(
  pi: ExtensionAPI,
  opts: {
    providerId: string;
    label: string;               // human name, e.g. "chatgpt-web"
    loginCmd: string;
    modelCmd: string;
    statusCmd: string;
    defaultUrl: string;
    getConfig: () => ChatGptWebConfig;
    getModelIds: () => string[];
    onConfigChange: ConfigChange;
    save: (config: ChatGptWebConfig) => void;
    /** Bridge exposes the chatgpt2api pool monitor (/api/accounts). */
    checkAccountPool: boolean;
  },
): void {
  pi.registerCommand(opts.loginCmd, {
    description: `Configure the ${opts.label} connection (endpoint URL + auth key).`,
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`/${opts.loginCmd} requires interactive (TUI) mode.`, "error");
        return;
      }

      const current = opts.getConfig();

      const prompt = current.baseUrl
        ? `Bridge URL incl. /v1 (current: ${current.baseUrl})`
        : `Bridge URL incl. /v1 (e.g. ${opts.defaultUrl})`;
      const baseUrl = await ctx.ui.input(prompt, opts.defaultUrl);
      if (!baseUrl) {
        ctx.ui.notify("Cancelled — no endpoint provided.", "info");
        return;
      }

      const keyPrompt = current.authKey
        ? "Bridge auth key (already configured — leave empty to keep)"
        : "Bridge auth key";
      const authKey = await ctx.ui.input(keyPrompt, "");
      if (authKey === undefined) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      const newConfig: ChatGptWebConfig = {
        baseUrl: normalizeUrl(baseUrl),
        authKey: authKey.trim() || current.authKey || undefined,
      };

      ctx.ui.notify("Testing bridge connection…", "info");
      try {
        const models = await fetchModels(newConfig);
        opts.save(newConfig);
        await opts.onConfigChange(newConfig);
        await refreshActiveModel(pi, ctx);
        ctx.ui.notify(
          `${opts.label} bridge connected — ${models.length} models discovered.\n${configSummary(newConfig)}`,
          "info",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Connection failed: ${msg}. Config saved but check the bridge.`, "error");
        opts.save(newConfig);
        await opts.onConfigChange(newConfig);
      }
    },
  });

  pi.registerCommand(opts.modelCmd, {
    description: `Search and select a ${opts.label} model by name.`,
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`/${opts.modelCmd} requires interactive (TUI) mode.`, "error");
        return;
      }

      const ids = opts.getModelIds();
      if (ids.length === 0) {
        ctx.ui.notify(`No ${opts.label} models available. Run /${opts.loginCmd} first.`, "error");
        return;
      }

      const term = (args || "").trim().toLowerCase();
      const matches = term ? ids.filter((id) => id.toLowerCase().includes(term)) : ids;
      if (matches.length === 0) {
        ctx.ui.notify(`No ${opts.label} models matching "${args}".`, "error");
        return;
      }

      async function trySelect(id: string): Promise<boolean> {
        const model = ctx.modelRegistry.find(opts.providerId, id);
        if (!model) return false;
        try { await pi.setModel(model); return true; }
        catch { return false; }
      }

      if (matches.length === 1) {
        const ok = await trySelect(matches[0]);
        ctx.ui.notify(
          ok ? `Selected ${opts.providerId}/${matches[0]}` : `Failed to select ${opts.providerId}/${matches[0]}`,
          ok ? "info" : "error",
        );
        return;
      }

      const choice = await ctx.ui.select(`Select ${opts.label} model:`, matches);
      if (choice) {
        const ok = await trySelect(choice);
        ctx.ui.notify(
          ok ? `Selected ${opts.providerId}/${choice}` : `Failed to select ${opts.providerId}/${choice}`,
          ok ? "info" : "error",
        );
      }
    },
  });

  pi.registerCommand(opts.statusCmd, {
    description: `Show ${opts.label} connection status and models.`,
    handler: async (_args, ctx) => {
      const config = opts.getConfig();
      const ids = opts.getModelIds();
      const lines = [`── ${opts.label} Status ──`, configSummary(config), ""];

      try {
        const models = await fetchModels(config);
        if (models.length === 0) {
          lines.push("⚠ Model list is EMPTY — no account logged into the proxy (chatgpt-web: add a web account; codex-web: complete the OAuth login in the proxy panel).");
        } else {
          lines.push(`Models: ${models.length} (${ids.join(", ").slice(0, 200)})`);
        }
      } catch (err) {
        lines.push(`Bridge unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (opts.checkAccountPool) {
        try {
          const pool = await fetchAccountPool(config);
          lines.push(pool.total > 0
            ? `Account pool: ${pool.total} account(s) available.`
            : "⚠ Account pool is EMPTY — add a web account in the bridge admin panel.");
        } catch {
          lines.push("Account pool: unavailable.");
        }
      }

      lines.push("", "Commands:");
      lines.push(`  /${opts.loginCmd}   Configure connection`);
      lines.push(`  /${opts.modelCmd}   Search and select a model`);
      lines.push("  /model               Select models (Pi built-in)");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

export function registerCommands(
  pi: ExtensionAPI,
  getChatConfig: () => ChatGptWebConfig,
  getChatModelIds: () => string[],
  onChatConfigChange: ConfigChange,
  getCodexConfig: () => ChatGptWebConfig,
  getCodexModelIds: () => string[],
  onCodexConfigChange: ConfigChange,
): void {
  registerTrio(pi, {
    providerId: PROVIDER_ID,
    label: "chatgpt-web",
    loginCmd: "login-chatgpt-web",
    modelCmd: "chatgpt-web-model",
    statusCmd: "chatgpt-web-status",
    defaultUrl: "http://172.30.55.22:3001/v1",
    getConfig: getChatConfig,
    getModelIds: getChatModelIds,
    onConfigChange: onChatConfigChange,
    save: saveConfig,
    checkAccountPool: true,
  });

  registerTrio(pi, {
    providerId: CODEX_PROVIDER_ID,
    label: "codex-web",
    loginCmd: "login-codex-web",
    modelCmd: "codex-web-model",
    statusCmd: "codex-web-status",
    defaultUrl: "http://172.30.55.22:8086/v1",
    getConfig: getCodexConfig,
    getModelIds: getCodexModelIds,
    onConfigChange: onCodexConfigChange,
    save: saveCodexConfig,
    checkAccountPool: false,
  });
}
