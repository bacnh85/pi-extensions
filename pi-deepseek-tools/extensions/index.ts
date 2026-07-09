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
	checkDangerousCommand,
	maxErrorHistory,
	thinkingBudget,
	autoBlockAfterReminders,
	blockDangerousEnabled,
	type ErrorInfo,
	type ErrorCategory,
} from "./lib/deepseek-tools";
import { repairDeepSeekToolArguments, type RepairKind } from "./lib/tool-input-repair";
import { stripReasoningContent, cleanLeakedContentFromMessages } from "./lib/reasoning-content";
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
	checkDangerousCommand,
	maxErrorHistory,
	thinkingBudget,
	autoBlockAfterReminders,
	blockDangerousEnabled,
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

function recordError(toolName: string, category: ErrorCategory) {
	errorHistory.set(toolName, { count: (errorHistory.get(toolName)?.count ?? 0) + 1, lastCategory: category });
	while (errorHistory.size > maxErrorHistory()) errorHistory.delete(errorHistory.keys().next().value!);
}

export default function (pi: ExtensionAPI) {
	let remindedThisTurn = false;
	let repairThisTurn = false;
	let hasErrorThisTurn = false;
	let lastErrorInfo: ErrorInfo | null = null;

	const repairCounts = new Map<string, number>();
	const reminderCounts = new Map<string, number>(); // per-tool reminder count for auto-block escalation

	// ── Config helpers: imported from deepseek-tools.ts ────
	// autoBlockAfterReminders(), blockDangerousEnabled(), thinkingBudget()
	// are now exported from ./lib/deepseek-tools.ts and imported above.

	// ── /deepseek-tools-status ──────────────────────────────
	pi.registerCommand("deepseek-tools-status", {
		description: "Show pi-deepseek-tools configuration and statistics.",
		handler: async (_args, cmdCtx) => {
			const logFormat = process.env.PI_DEEPSEEK_TOOLS_LOG_FORMAT === "json" ? "json" : "plain";
			const thinkingBudgetVal = thinkingBudget() ?? "unset";
			const autoBlockAfter = autoBlockAfterReminders();
			const dangerousBlockOn = blockDangerousEnabled();
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
				`  Debug: ${process.env.PI_DEEPSEEK_TOOLS_DEBUG ? "on" : "off"}`,
				`  Log format: ${logFormat}`,
				`  Error history cap: ${maxErrorHistory()}`,
				`  Thinking budget: ${thinkingBudgetVal}`,
				`  Auto block after reminders: ${autoBlockAfter > 0 ? autoBlockAfter : "off"}`,
				`  Dangerous command guard: ${dangerousBlockOn ? "on" : "off"}`,
				"",
				`**Leaked content cleaning:** always on for DeepSeek V4`,
				`**Auto thinking adjustment:** on`,
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
			if (reminderCounts.size > 0) {
				status.push(`**Reminders (auto-block after ${autoBlockAfterReminders()}):**`);
				for (const [key, count] of [...reminderCounts.entries()].sort((a, b) => b[1] - a[1])) {
					status.push(`  ${key}: ${count}`);
				}
			}
			cmdCtx.ui.notify(status.join("\n"), "info");
		},
	});

	// ── session_start: register wrapped tools ───────────────
	pi.on("session_start", (_event, ctx) => {
		debugLog("session_start:", ctx.model?.provider, ctx.model?.id);
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

	// ── before_provider_request: clean payload, inject thinking budget ───
	pi.on("before_provider_request", (event, ctx) => {
		if (!isDeepSeekV4ModelByModel(ctx.model)) return;

		// 1. Leaked content cleaning — always on for V4 (low-risk, pure cleanup)
		let payload = cleanLeakedContentFromMessages(event.payload);

		// 2. Fix leaked template model IDs from older OpenCode Go paths.
		if (isRecord(payload) && payload.model === "{{model}}") {
			payload = { ...payload, model: ctx.model?.id };
			debugLog("model: replaced {{model}} with", ctx.model?.id);
		}

		// 3. Reasoning stripping — opt-in (can cause 401s with OpenCode Go)
		if (reasoningStripEnabled()) {
			const reasoningCleaned = stripReasoningContent(payload);
			if (reasoningCleaned !== payload) {
				debugLog("reasoning: stripped from provider request");
				payload = reasoningCleaned;
			}
		} else {
			debugLog("reasoning: skip strip (disabled by env)");
		}

		// 4. ponytail: single flat thinking budget — always same value when set
		const budget = thinkingBudget();
		if (budget !== undefined && isRecord(payload)) {
			// Clone if payload is still the original reference so the mutation is returned.
			if (payload === event.payload) {
				payload = { ...payload };
			}
			(payload as Record<string, unknown>).thinking = { type: "budget_tokens", budget_tokens: budget };
			debugLog("thinking: budget", budget);
		}

		if (payload !== event.payload) {
			return payload;
		}
	});

	// ── tool_execution_end: categorize errors ───────────────
	pi.on("tool_execution_end", (event, _ctx) => {
		if (!event.isError) return;
		hasErrorThisTurn = true;
		const info = categorizeToolError(event.toolName, event.result);
		lastErrorInfo = info;
		recordError(event.toolName, info.category);
		logWarn(event.toolName, event.toolCallId, info.category,
			event.result ? String(event.result).slice(0, 200) : "no result");
		debugLog(event.toolName, "error:", info.category, "repeat:", errorHistory.get(event.toolName)?.count);
	});

	// ── before_agent_start: snapshot tool counts, inject guidance + error hints ───
	pi.on("before_agent_start", (event, ctx) => {
		const isDeepSeekV4 = isDeepSeekV4ModelByModel(ctx.model);
		if (isDeepSeekV4) debugLog("model match:", ctx.model?.provider, ctx.model?.id);
		// ponytail: thinking budget is flat, handled in before_provider_request. No per-turn logic.

		remindedThisTurn = false;
		repairThisTurn = isDeepSeekV4 && repairEnabled();
		if (!selectionGuidanceEnabled() || !isDeepSeekV4) {
			debugLog("guidance: skipped (disabled or not V4)");
			return;
		}

		let systemPrompt = event.systemPrompt;

		// Context-aware error-recovery hint — adapts for repeated failures
		if (hasErrorThisTurn) {
			const repeatCount = errorHistory.get(lastErrorInfo!.toolName)?.count ?? 0;
			let hint = lastErrorInfo!.hint;
			if (repeatCount >= 2) {
				hint += ` You have had ${repeatCount} failures on ${lastErrorInfo!.toolName}. Try the simplest possible inputs — shorter paths, fewer options, explicit required fields only.`;
			}
			debugLog("error hint:", lastErrorInfo!.toolName, repeatCount, "repeats, cat:", lastErrorInfo!.category);
			systemPrompt = `${systemPrompt}\n\nNote: ${hint}`;
			hasErrorThisTurn = false;
			lastErrorInfo = null;
		}

		const activeTools = event.systemPromptOptions?.selectedTools ?? [];
		if (!hasAnyTool(activeTools, ["serena_get_symbols_overview", "serena_find_symbol", "serena_find_referencing_symbols", "serena_find_declaration", "serena_find_implementations", "ls", "grep", "find", "read", "edit", "bash"])) {
			debugLog("guidance: skipped (no relevant tools)");
			return;
		}

		debugLog("guidance: injected for", activeTools.length, "tools");
		// ponytail: prepend guidance so DeepSeek sees it first, before tool definitions.
		return { systemPrompt: `${deepSeekSelectionGuidance(activeTools)}\n\n---\n\n${systemPrompt}` };
	});

	// ── agent_end: reset repair flag ────────────────────────
	pi.on("agent_end", () => {
		repairThisTurn = false;
		debugLog("agent_end: repair flag reset");
		// hasErrorThisTurn intentionally NOT reset here — it's consumed in
		// the next before_agent_start so the model gets the error-recovery hint.
	});

	// ── tool_call: count tools, intercept misuses, check dangerous commands ──
	pi.on("tool_call", (event, ctx) => {
		if (!isDeepSeekV4ModelByModel(ctx.model)) return;

		debugLog("tool_call:", event.toolName);

		// ── Safety guardrail: block dangerous bash commands ───────────────
		if (event.toolName === "bash" && blockDangerousEnabled()) {
			const command = isRecord(event.input) ? event.input.command : undefined;
			const danger = typeof command === "string" ? checkDangerousCommand(command) : undefined;
			if (danger) {
				logWarn("DANGEROUS COMMAND BLOCKED:", danger);
				return { block: true, reason: `Safety guardrail: blocked dangerous command — ${danger}.` };
			}
		}

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
			? "For DeepSeek V4, use Serena semantic tools before read/bash for code-symbol, declaration, reference, implementation, or refactor work. Do NOT use read for code files."
			: dedicatedTool
				? `For DeepSeek V4, use the dedicated ${dedicatedTool} tool instead of bash for this simple file operation.`
				: `For DeepSeek V4, use ${misuseTool} instead of find when the file path is known or the action is to run a command.`;

		// ── Semantic miss (read code file without Serena) → always block ──
		if (semanticMiss) {
			debugLog("blocked: read code file without Serena");
			return { block: true, reason: `${reason} Use read only for docs, config, logs, or after Serena identifies the code region.` };
		}

		// ── Find misuse → always block (unambiguous) ───────
		if (misuseTool) {
			debugLog("blocked: find misuse");
			return { block: true, reason };
		}

		// ── Dedicated tool miss (bash ls/grep/cat/find) → adaptive escalation ──
		const missKey = `bash→${dedicatedTool}`;
		const threshold = autoBlockAfterReminders();
		if (threshold > 0) {
			const count = (reminderCounts.get(missKey) ?? 0) + 1;
			reminderCounts.set(missKey, count);
			debugLog("reminder:", missKey, "count:", count, "/", threshold);
			if (count >= threshold) {
				debugLog("auto-blocked:", missKey, "after", count, "reminders");
				return { block: true, reason: `${reason} (auto-blocked after ${count} reminders on this pattern)` };
			}
		}

		// Strict Serena mode → block dedicated tool misses too
		if (strictSerenaEnabled()) {
			debugLog("blocked: dedicated tool miss (strict)");
			return { block: true, reason };
		}

		// Once-per-turn steer reminder
		if (remindedThisTurn) return;
		remindedThisTurn = true;
		pi.sendMessage(
			{
				customType: "deepseek-v4-tool-selection-reminder",
				content: `${reason} Use bash only for real shell commands such as tests, builds, git, package-manager, or process execution.`,
				display: true,
			},
			{ deliverAs: "steer" },
		);
	});
}
