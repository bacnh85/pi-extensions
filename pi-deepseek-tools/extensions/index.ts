import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	isRecord,
	deepSeekSelectionGuidance,
	findMisuseSuggestion,
	hasAnyTool,
	isOpenCodeGoDeepSeekV4FlashModel,
	isOpenCodeGoDeepSeekV4Model,
	isOpenCodeGoDeepSeekV4ProModel,
	DEEPSEEK_V4_PRO_MODEL,
	isSemanticMissToolCall,
	missedDedicatedTool,
	selectionGuidanceEnabled,
	strictSerenaEnabled,
	reasoningStripEnabled,
	repairEnabled,
	isDeepSeekV4ModelByModel,
	DEEPSEEK_V4_FLASH_MODEL,
	categorizeToolError,
	directDeepSeekEnabled,
	type ErrorInfo,
	type ErrorCategory,
} from "./lib/deepseek-tools";
import { repairDeepSeekToolArguments, type RepairKind } from "./lib/tool-input-repair";
import { stripReasoningContent } from "./lib/reasoning-content";
import { debugLog, logWarn } from "./lib/logger";

export {
	DEEPSEEK_V4_PRO_MODEL,
	DEEPSEEK_V4_FLASH_MODEL,
	deepSeekSelectionGuidance,
	findMisuseSuggestion,
	isOpenCodeGoDeepSeekV4FlashModel,
	isOpenCodeGoDeepSeekV4Model,
	isOpenCodeGoDeepSeekV4ProModel,
	isSemanticMissToolCall,
	missedDedicatedTool,
	selectionGuidanceEnabled,
	strictSerenaEnabled,
};

export {
	categorizeToolError,
	type ErrorInfo,
	type ErrorCategory,
} from "./lib/deepseek-tools";

function addReadDefaults(args: unknown): unknown {
	if (!isRecord(args)) return args;
	// Return as-is when both or neither are provided
	if ((args.offset !== undefined) === (args.limit !== undefined)) return args;
	// Exactly one is missing — supply the default for the missing one
	const defaults = args.limit !== undefined ? { offset: 1 } : { limit: 2000 };
	const note = args.limit !== undefined
		? "Note: offset was not provided; defaulted to 1. To read a different range, retry with both offset and limit."
		: "Note: limit was not provided; defaulted to 2000 lines. To read a different range, retry with both offset and limit.";
	return { ...args, ...defaults, __deepseekReadNote: note };
}

function appendReadNote(result: any, note: unknown) {
	if (typeof note !== "string" || !note) return result;
	return {
		...result,
		content: [...(Array.isArray(result?.content) ? result.content : []), { type: "text", text: note }],
	};
}

function wrapToolDefinition(base: any, shouldRepair: () => boolean, onRepair: (toolName: string, repairs: readonly RepairKind[]) => void): any {
	return {
		...base,
		prepareArguments(args: unknown) {
			let prepared = base.prepareArguments ? base.prepareArguments(args as never) : args;
			if (!shouldRepair()) return prepared;

			const repaired = repairDeepSeekToolArguments(base.name, base.parameters, prepared);
			if (repaired.repaired) {
				onRepair(base.name, repaired.repairs);
				prepared = repaired.args;
			}
			return base.name === "read" ? addReadDefaults(prepared) : prepared;
		},
		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			const readNote = base.name === "read" && isRecord(params) ? params.__deepseekReadNote : undefined;
			if (isRecord(params)) delete params.__deepseekReadNote;
			const result = await base.execute(toolCallId, params, signal, onUpdate, ctx);
			return base.name === "read" ? appendReadNote(result, readNote) : result;
		},
	};
}

// ────────────────────────────────────────────────────────
// Adaptive error tracking — per-tool count + last category
// ────────────────────────────────────────────────────────
const errorHistory = new Map<string, { count: number; lastCategory: ErrorCategory }>();

export default function (pi: ExtensionAPI) {
	let remindedThisTurn = false;
	let repairThisTurn = false;
	let hasErrorThisTurn = false;
	let lastErrorInfo: ErrorInfo | null = null;
	const repairCounts = new Map<string, number>();

	// ── /deepseek-tools-status ──────────────────────────────
	pi.registerCommand("deepseek-tools-status", {
		description: "Show pi-deepseek-tools configuration and statistics.",
		handler: async (_args, cmdCtx) => {
			const status = [
				"## pi-deepseek-tools status",
				"",
				"**Configuration:**",
				`  Selection guidance: ${selectionGuidanceEnabled() ? "on" : "off"}`,
				`  Strict Serena mode: ${strictSerenaEnabled() ? "on" : "off"}`,
				`  Reasoning strip: ${reasoningStripEnabled() ? "on" : "off"}`,
				`  Reasoning max tokens: ${process.env.PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS || "unlimited"}`,
				`  Tool-input repair: ${repairEnabled() ? "on" : "off"}`,
				`  Direct DeepSeek: ${directDeepSeekEnabled() ? "on" : "off"}`,
				`  Debug logging: ${process.env.PI_DEEPSEEK_TOOLS_DEBUG ? "on" : "off"}`,
				"",
				`**Repairs:** ${[...repairCounts.values()].reduce((a, b) => a + b, 0)} total`,
			];
			for (const [tool, count] of [...repairCounts.entries()].sort((a, b) => b[1] - a[1])) {
				status.push(`  ${tool}: ${count}`);
			}
			const totalErrors = [...errorHistory.values()].reduce((s, e) => s + e.count, 0);
			status.push(`**Errors:** ${totalErrors} total${lastErrorInfo ? `, last: ${lastErrorInfo.category} on ${lastErrorInfo.toolName}` : ""}`);
			for (const [tool, info] of [...errorHistory.entries()].sort((a, b) => b[1].count - a[1].count)) {
				status.push(`  ${tool}: ${info.count} (last: ${info.lastCategory})`);
			}
			cmdCtx.ui.notify(status.join("\n"), "info");
		},
	});

	// ── session_start: register wrapped tools ───────────────
	pi.on("session_start", (_event, ctx) => {
		const builtins = [
			createReadToolDefinition(ctx.cwd),
			createWriteToolDefinition(ctx.cwd),
			createEditToolDefinition(ctx.cwd),
			createGrepToolDefinition(ctx.cwd),
			createFindToolDefinition(ctx.cwd),
			createLsToolDefinition(ctx.cwd),
			createBashToolDefinition(ctx.cwd),
		];
		for (const tool of builtins) {
			pi.registerTool(wrapToolDefinition(tool, () => repairThisTurn, (toolName) => {
				repairCounts.set(toolName, (repairCounts.get(toolName) ?? 0) + 1);
				debugLog("repair:", toolName, repairCounts.get(toolName), "total repairs");
			}));
		}
	});

	// ── before_provider_request: strip reasoning content ────
	pi.on("before_provider_request", (event, ctx) => {
		if (!isDeepSeekV4ModelByModel(ctx.model)) return;
		if (!reasoningStripEnabled()) {
			debugLog("reasoning: skip strip (disabled by env)");
			return;
		}
		const cleaned = stripReasoningContent(event.payload);
		if (cleaned !== event.payload) {
			debugLog("reasoning: stripped from provider request");
			return { payload: cleaned };
		}
	});

	// ── tool_execution_end: categorize errors ───────────────
	pi.on("tool_execution_end", (event, _ctx) => {
		if (!event.isError) return;
		hasErrorThisTurn = true;
		const info = categorizeToolError(event.toolName, event.result);
		lastErrorInfo = info;
		errorHistory.set(event.toolName, {
			count: (errorHistory.get(event.toolName)?.count ?? 0) + 1,
			lastCategory: info.category,
		});
		logWarn(event.toolName, event.toolCallId, info.category,
			event.result ? String(event.result).slice(0, 200) : "no result");
	});

	// ── before_agent_start: inject guidance + error hints ───
	pi.on("before_agent_start", (event, ctx) => {
		const isDeepSeekV4 = isDeepSeekV4ModelByModel(ctx.model);
		if (isDeepSeekV4) debugLog("model match:", ctx.model?.provider, ctx.model?.id);
		remindedThisTurn = false;
		repairThisTurn = isDeepSeekV4 && repairEnabled();
		if (!selectionGuidanceEnabled() || !isDeepSeekV4) return;

		let systemPrompt = event.systemPrompt;

		// Context-aware error-recovery hint — adapts for repeated failures
		if (hasErrorThisTurn) {
			const repeatCount = errorHistory.get(lastErrorInfo!.toolName)?.count ?? 0;
			let hint = lastErrorInfo!.hint;
			if (repeatCount >= 2) {
				hint += ` You have had ${repeatCount} failures on ${lastErrorInfo!.toolName}. Try the simplest possible inputs — shorter paths, fewer options, explicit required fields only.`;
			}
			systemPrompt = `${systemPrompt}\n\nNote: ${hint}`;
			hasErrorThisTurn = false;
			lastErrorInfo = null;
		}

		const activeTools = event.systemPromptOptions?.selectedTools ?? [];
		if (!hasAnyTool(activeTools, ["serena_get_symbols_overview", "serena_find_symbol", "serena_find_referencing_symbols", "serena_find_declaration", "serena_find_implementations", "ls", "grep", "find", "read", "edit", "bash"])) return;

		debugLog("guidance: injected for tools:", activeTools);
		return { systemPrompt: `${systemPrompt}\n\n${deepSeekSelectionGuidance(activeTools)}` };
	});

	// ── agent_end: reset repair flag ────────────────────────
	pi.on("agent_end", () => {
		repairThisTurn = false;
		// hasErrorThisTurn intentionally NOT reset here — it's consumed in
		// the next before_agent_start so the model gets the error-recovery hint.
	});

	// ── tool_call: intercept misuses ────────────────────────
	pi.on("tool_call", (event, ctx) => {
		if (!isDeepSeekV4ModelByModel(ctx.model)) return;

		if (event.toolName.startsWith("serena_")) {
			remindedThisTurn = false;
			return;
		}

		const activeTools = pi.getActiveTools();
		const serenaActive = activeTools.some((tool) => tool.startsWith("serena_"));
		const semanticMiss = serenaActive && isSemanticMissToolCall(event.toolName, event.input);
		const dedicatedTool = missedDedicatedTool(event.toolName, event.input, activeTools);
		const misuseTool = findMisuseSuggestion(event.toolName, event.input);
		if (!semanticMiss && !dedicatedTool && !misuseTool) return;

		const reason = semanticMiss
			? "For DeepSeek V4, use Serena semantic tools before read/bash for code-symbol, declaration, reference, implementation, or refactor work."
			: dedicatedTool
				? `For DeepSeek V4, use the dedicated ${dedicatedTool} tool instead of bash for this simple file operation.`
				: `For DeepSeek V4, use ${misuseTool} instead of find when the file path is known or the action is to run a command.`;

		// Block unambiguous cases (find misuse) or strict serena mode
		if (misuseTool || strictSerenaEnabled()) {
			debugLog("blocked:", event.toolName, reason);
			return { block: true, reason };
		}
		if (remindedThisTurn) return;

		remindedThisTurn = true;
		pi.sendMessage(
			{
				customType: "deepseek-v4-tool-selection-reminder",
				content: semanticMiss
					? `${reason} Use read for docs/config/non-code files or after Serena identifies the relevant code region.`
					: misuseTool
						? `${reason}`
						: `${reason} Use bash only for real shell commands such as tests, builds, git, package-manager, or process execution.`,
				display: true,
			},
			{ deliverAs: "steer" },
		);
	});
}
