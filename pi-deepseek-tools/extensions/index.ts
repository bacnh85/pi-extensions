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
	deepSeekSelectionGuidance,
	hasAnyTool,
	isOpenCodeGoDeepSeekV4FlashModel,
	isSemanticMissToolCall,
	missedDedicatedTool,
	selectionGuidanceEnabled,
	strictSerenaEnabled,
} from "./lib/deepseek-tools";
import { repairDeepSeekToolArguments, type RepairKind } from "./lib/tool-input-repair";

export {
	deepSeekSelectionGuidance,
	isOpenCodeGoDeepSeekV4FlashModel,
	isSemanticMissToolCall,
	missedDedicatedTool,
	selectionGuidanceEnabled,
	strictSerenaEnabled,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addReadDefaults(args: unknown): unknown {
	if (!isRecord(args)) return args;
	const hasOffset = args.offset !== undefined;
	const hasLimit = args.limit !== undefined;
	if (hasLimit && !hasOffset) {
		return {
			...args,
			offset: 1,
			__deepseekReadNote: "Note: offset was not provided; defaulted to 1. To read a different range, retry with both offset and limit.",
		};
	}
	if (hasOffset && !hasLimit) {
		return {
			...args,
			limit: 2000,
			__deepseekReadNote: "Note: limit was not provided; defaulted to 2000 lines. To read a different range, retry with both offset and limit.",
		};
	}
	return args;
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

export default function (pi: ExtensionAPI) {
	let remindedThisTurn = false;
	let repairThisTurn = false;
	const repairCounts = new Map<string, number>();

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
			}));
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		remindedThisTurn = false;
		repairThisTurn = isOpenCodeGoDeepSeekV4FlashModel(ctx.model);
		if (!selectionGuidanceEnabled()) return;
		if (!repairThisTurn) return;

		const activeTools = event.systemPromptOptions?.selectedTools ?? [];
		if (!hasAnyTool(activeTools, ["serena_get_symbols_overview", "serena_find_symbol", "serena_find_referencing_symbols", "serena_find_declaration", "serena_find_implementations", "ls", "grep", "find", "read", "edit", "bash"])) return;

		return { systemPrompt: `${event.systemPrompt}\n\n${deepSeekSelectionGuidance(activeTools)}` };
	});

	pi.on("agent_end", () => {
		repairThisTurn = false;
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isOpenCodeGoDeepSeekV4FlashModel(ctx.model)) return;

		if (event.toolName.startsWith("serena_")) {
			remindedThisTurn = false;
			return;
		}

		const activeTools = pi.getActiveTools();
		const serenaActive = activeTools.some((tool) => tool.startsWith("serena_"));
		const semanticMiss = serenaActive && isSemanticMissToolCall(event.toolName, event.input);
		const dedicatedTool = missedDedicatedTool(event.toolName, event.input, activeTools);
		if (!semanticMiss && !dedicatedTool) return;

		const reason = semanticMiss
			? "For OpenCode Go DeepSeek V4 Flash, use Serena semantic tools before read/bash for code-symbol, declaration, reference, implementation, or refactor work."
			: `For OpenCode Go DeepSeek V4 Flash, use the dedicated ${dedicatedTool} tool instead of bash for this simple file operation.`;

		if (strictSerenaEnabled()) return { block: true, reason };
		if (remindedThisTurn) return;

		remindedThisTurn = true;
		pi.sendMessage(
			{
				customType: "deepseek-flash-tool-selection-reminder",
				content: semanticMiss
					? `${reason} Use read for docs/config/non-code files or after Serena identifies the relevant code region.`
					: `${reason} Use bash only for real shell commands such as tests, builds, git, package-manager, or process execution.`,
				display: true,
			},
			{ deliverAs: "steer" },
		);
	});
}
