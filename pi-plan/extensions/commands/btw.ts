import { BorderedLoader, buildSessionContext, convertToLlm, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { runIsolated } from "../lib/isolated-model";
import { loadUtilityConfig } from "../lib/utility-config";

const BTW_CONTEXT_BUDGET = 16_384; // ~4K tokens for transcript context
const BTW_ENTRY = "pi-plan-btw";
const SYSTEM = `You are a terse developer answering a "by the way" aside question. The current session transcript is provided as <transcript> context — use it to answer questions about files read, decisions made, or things discussed earlier.

Rules:
- Answer directly and concisely from the transcript when the question references session context.
- If the transcript does not contain information to answer the question, say so briefly.
- Do not use tools, read files, or execute commands.
- Do not address the user as a separate persona — just answer the question.
- No greetings, no sign-offs, no explanations beyond the answer.`;

interface BtwEntry {
	query: string;
	answer: string;
	timestamp: number;
}

type BtwResult = { answer: string } | { error: unknown } | { cancelled: true };

function isBtwEntry(value: unknown): value is BtwEntry {
	const entry = value as BtwEntry;
	return !!entry && typeof entry.query === "string" && typeof entry.answer === "string" &&
		typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp);
}

function latestBtw(ctx: ExtensionContext): BtwEntry | undefined {
	const branch = ctx.sessionManager.getBranch() as any[];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "custom" && entry.customType === BTW_ENTRY && isBtwEntry(entry.data)) return entry.data;
	}
	return undefined;
}

/**
 * Build a compact transcript snapshot from the current session branch.
 * Keeps the first entry and the most recent entries that fit within
 * BTW_CONTEXT_BUDGET bytes. Strips images, thinking, and signatures.
 */
function buildTranscript(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries() as any[];
	const leafId = ctx.sessionManager.getLeafId() as string;
	const session = buildSessionContext(entries, leafId);
	const messages = session.messages ?? [];
	if (!messages.length) return "<transcript>(empty session)</transcript>";

	const sanitized = convertToLlm(messages).map((message: any) => JSON.parse(JSON.stringify(message, (key: string, value: unknown) => {
		if (value && typeof value === "object" && (value as any).type === "image") return { type: "image", omitted: true };
		if (key === "thinking" || key === "signature") return "[omitted]";
		return value;
	})));

	// Keep the first message and as many recent ones as fit.
	const first = sanitized.slice(0, 1);
	const recent: typeof sanitized = [];
	let size = JSON.stringify(first).length;
	for (let i = sanitized.length - 1; i >= 1; i--) {
		const entry = sanitized[i];
		const next = JSON.stringify(entry).length + 1;
		if (size + next > BTW_CONTEXT_BUDGET) break;
		recent.unshift(entry);
		size += next;
	}

	const omitted = sanitized.length - first.length - recent.length;
	return `<transcript>\n${JSON.stringify({ omitted, messages: [...first, ...recent] }, null, 2)}\n</transcript>`;
}

async function askBtw(ctx: ExtensionContext, model: string | undefined, query: string, systemPrompt: string, signal?: AbortSignal): Promise<string> {
	return runIsolated(ctx, model, {
		systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: query }], timestamp: Date.now() }],
	}, undefined, signal);
}

export function registerBtw(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<BtwEntry>(BTW_ENTRY, (entry, { expanded }, theme) => {
		const data = isBtwEntry(entry.data) ? entry.data : { query: "(unavailable)", answer: "(unavailable)", timestamp: 0 };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("accent", theme.bold("BTW"))} ${theme.fg("dim", data.query)}`, 0, 0));
		box.addChild(new Markdown(data.answer, 0, 0, getMarkdownTheme()));
		if (expanded && data.timestamp) box.addChild(new Text(theme.fg("dim", new Date(data.timestamp).toLocaleString()), 0, 0));
		return box;
	});

	pi.registerCommand("btw", {
		description: "Ask a sidebar question with session context",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				const previous = latestBtw(ctx);
				if (!previous) return ctx.ui.notify("No previous BTW to recall. Use /btw <query>.", "info");
				if (ctx.mode !== "tui") return ctx.ui.notify(previous.answer, "info");
				await ctx.ui.editor(`BTW recall: ${previous.query.slice(0, 80)}`, previous.answer);
				return;
			}

			const config = await loadUtilityConfig(ctx);
			const systemPrompt = `${SYSTEM}\n\n${buildTranscript(ctx)}`;
			let result: BtwResult;
			if (ctx.mode === "tui") {
				result = await ctx.ui.custom<BtwResult>((tui, theme, _keybindings, done) => {
					const loader = new BorderedLoader(tui, theme, "Asking BTW…");
					let finished = false;
					const finish = (next: BtwResult) => {
						if (finished) return;
						finished = true;
						done(next);
					};
					loader.onAbort = () => finish({ cancelled: true });
					void askBtw(ctx, config.btw.model, query, systemPrompt, loader.signal)
						.then((answer) => finish({ answer }))
						.catch((error) => finish(loader.signal.aborted ? { cancelled: true } : { error }));
					return loader;
				}, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "60%", minWidth: 40, maxHeight: 8 } });
			} else {
				try {
					result = { answer: await askBtw(ctx, config.btw.model, query, systemPrompt) };
				} catch (error) {
					result = { error };
				}
			}

			if ("cancelled" in result) return ctx.ui.notify("BTW cancelled.", "info");
			if ("error" in result) return ctx.ui.notify(`BTW failed: ${String(result.error)}`, "error");
			pi.appendEntry<BtwEntry>(BTW_ENTRY, { query, answer: result.answer, timestamp: Date.now() });
		},
	});
}
