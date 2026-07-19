import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runIsolated } from "../lib/isolated-model";
import { loadUtilityConfig } from "../lib/utility-config";

const KEY = "pi-plan-utility";
const SYSTEM = "Answer as a terse developer utility. Give direct syntax or structural help with minimal examples. No greetings, no tools, no filesystem actions.";

export function registerBtw(pi: ExtensionAPI): void {
	pi.registerCommand("btw", { description: "Ask an isolated developer sidebar", handler: async (args, ctx) => {
		const query = args.trim(); if (!query) return ctx.ui.notify("Usage: /btw <query>", "warning");
		const config = await loadUtilityConfig(ctx); let output = "";
		ctx.ui.setStatus(KEY, "BTW…");
		try {
			await runIsolated(ctx, config.btw.model, { systemPrompt: SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: query }], timestamp: Date.now() }] }, (delta) => { output += delta; ctx.ui.setWidget(KEY, [`BTW · streaming`, ...output.slice(0, 12_000).split("\n")]); });
		} catch (error) { ctx.ui.notify(`BTW failed: ${String(error)}`, "error"); }
		finally { ctx.ui.setStatus(KEY, undefined); ctx.ui.setWidget(KEY, undefined); }
		if (output && ctx.mode === "tui") await ctx.ui.editor("BTW", output);
	} });
}
