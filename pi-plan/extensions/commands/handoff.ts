/**
 * Handoff — transfer context to a new focused Pi session.
 *
 * `/handoff <goal>` summarizes the current session, lets the user review/edit
 * the generated prompt, and spawns a new Pi session linked to the parent. This
 * hands off to Pi itself (a new session), not to another coding agent.
 *
 * Modeled on commands/btw.ts: same transcript → isolated-model → loader stack.
 */
import {
	BorderedLoader,
	buildSessionContext,
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runIsolated } from "../lib/isolated-model";

const SYSTEM = `You are a context transfer assistant. Given a conversation history, the active plan/workflow state, and the user's goal for a new thread, generate a focused, self-contained prompt that:
1. Summarizes relevant context (decisions made, approaches taken, key findings).
2. Lists relevant files that were discussed or modified.
3. Notes the active plan (path/status) and workflow phase if any.
4. Clearly states the next task based on the user's goal.
5. Is self-contained — the new thread should be able to proceed without the old conversation.
Output only the prompt, no preamble like "Here's the prompt". Use this format:

## Context
...
## Files
- path/to/file
## Task
<what to do next based on the user's goal>`;

interface HandoffState {
	/** Short multi-line preamble of active plan/workflow state, or "" if none. */
	getPlanContext(cwd: string): string;
}

type HandoffResult = { prompt: string } | { error: unknown } | { cancelled: true };

/** Prepend a parent-session reference so the new agent can query the old session. */
export function buildFinalPrompt(body: string, sessionFile: string | undefined): string {
	if (!sessionFile) return body;
	return `**Parent session:** \`${sessionFile}\`\nQuery the parent session if you need earlier detail.\n\n${body}`;
}

async function generateHandoff(
	ctx: ExtensionContext,
	conversationText: string,
	goal: string,
	planContext: string,
	signal: AbortSignal,
): Promise<string> {
	const userText = [
		planContext ? `## Active pi-plan state\n${planContext}\n` : "",
		`## Conversation history\n\n${conversationText}\n`,
		`## Goal for new thread\n\n${goal}`,
	].filter(Boolean).join("\n");
	// ponytail: undefined modelId → runIsolated uses the active model
	return runIsolated(ctx, undefined, {
		systemPrompt: SYSTEM,
		messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
	}, undefined, signal);
}

export function registerHandoff(pi: ExtensionAPI, state: HandoffState): void {
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused Pi session: /handoff <goal>",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("Handoff requires interactive mode.", "error");
			const goal = args.trim();
			if (!goal) return ctx.ui.notify("Usage: /handoff <goal for new thread>", "warning");

			const session = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
			const conversationText = serializeConversation(convertToLlm(session.messages ?? []));
			if (!conversationText.trim()) return ctx.ui.notify("No conversation to hand off.", "warning");

			const planContext = state.getPlanContext(ctx.cwd);
			const currentSessionFile = ctx.sessionManager.getSessionFile();

			const result = await ctx.ui.custom<HandoffResult>((tui, theme, _keybindings, done) => {
				const loader = new BorderedLoader(tui, theme, "Generating handoff prompt…");
				let finished = false;
				const finish = (next: HandoffResult) => { if (!finished) { finished = true; done(next); } };
				loader.onAbort = () => finish({ cancelled: true });
				void generateHandoff(ctx, conversationText, goal, planContext, loader.signal)
					.then((prompt) => finish({ prompt }))
					.catch((error) => finish(loader.signal.aborted ? { cancelled: true } : { error }));
				return loader;
			}, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "60%", minWidth: 40, maxHeight: 8 } });

			if ("cancelled" in result) return ctx.ui.notify("Handoff cancelled.", "info");
			if ("error" in result) return ctx.ui.notify(`Handoff generation failed: ${String(result.error)}`, "error");

			const edited = await ctx.ui.editor("Edit handoff prompt", result.prompt);
			if (edited === undefined) return ctx.ui.notify("Handoff cancelled.", "info");

			const finalPrompt = buildFinalPrompt(edited.trim(), currentSessionFile);
			const outcome = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacement) => {
					replacement.ui.setEditorText(finalPrompt);
					replacement.ui.notify("Handoff ready. Submit when ready.", "info");
				},
			});
			if (outcome.cancelled) ctx.ui.notify("New session cancelled.", "info");
		},
	});
}
