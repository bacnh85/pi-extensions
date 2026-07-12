import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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
	superPowerModeEnabled,
	superPowerPromptContent,
	SUPER_POWER_BASE_PROMPT,
	SERENA_CODE_TOOLS,
	bashReadCommandPath,
	suggestBestSerenaCommand,
	looksLikeCodePath,
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
	superPowerModeEnabled,
	superPowerPromptContent,
	SUPER_POWER_BASE_PROMPT,
	SERENA_CODE_TOOLS,
	bashReadCommandPath,
	suggestBestSerenaCommand,
	looksLikeCodePath,
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

function wrapToolDefinition(base: any, factory: (cwd: string) => any, shouldRepair: () => boolean, onRepair: (toolName: string, repairs: readonly RepairKind[]) => void): any {
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
			// ponytail: resolve cwd from execution context — SDK sessions and
			// session switches may supply a different ctx.cwd than process.cwd().
			const cwd = ctx?.cwd || process.cwd();
			const freshDef = factory(cwd);
			const readNote = base.name === "read" && isRecord(params) ? params.__deepseekReadNote : undefined;
			if (isRecord(params)) delete params.__deepseekReadNote;
			const result = await freshDef.execute(toolCallId, params, signal, onUpdate, ctx);
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
	let turnCounter = 0; // Super Power Mode per-turn reinforcement counter
	// ── Config helpers: imported from deepseek-tools.ts ────
	// autoBlockAfterReminders(), blockDangerousEnabled(), thinkingBudget()
	// are now exported from ./lib/deepseek-tools.ts and imported above.

	// ── Register wrapped built-in tools at load time (not in session_start)
	// ponytail: avoids potential registry rebuild race during session_start
	// that could drop extension-registered tools like serena_*.
	// Each tool factory takes (cwd) and creates a tool definition bound to that
	// directory. We store the factory and resolve cwd from ctx at execution time
	// so SDK sessions and session switches get the correct directory.
	const toolFactories: Record<string, (cwd: string) => any> = {
		read: createReadToolDefinition,
		write: createWriteToolDefinition,
		edit: createEditToolDefinition,
		grep: createGrepToolDefinition,
		find: createFindToolDefinition,
		ls: createLsToolDefinition,
		bash: createBashToolDefinition,
	};
	// Create template tools just for metadata (parameters, name, description).
	// The execute method creates a fresh tool from the factory with ctx.cwd.
	for (const [name, factory] of Object.entries(toolFactories)) {
		const template = factory(process.cwd());
		pi.registerTool(wrapToolDefinition(template, factory, () => repairThisTurn, (toolName) => {
			repairCounts.set(toolName, (repairCounts.get(toolName) ?? 0) + 1);
			debugLog("repair:", toolName, repairCounts.get(toolName), "total repairs");
		}));
	}

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
				`  Super Power Mode: ${superPowerModeEnabled() ? "on" : "off"}`,
			];
			status.push("");
			status.push(`  Thinking: ${thinkingBudgetVal === "unset" ? "pi native (off/high/max)" : `budget override (${thinkingBudgetVal} tokens)`}`);
			status.push("**Leaked content cleaning:** always on for DeepSeek V4");
			status.push(`**Repairs:** ${[...repairCounts.values()].reduce((a, b) => a + b, 0)} total`);
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

	// ── session_start: diagnostic logging + eager startup ──
	pi.on("session_start", (_event, ctx) => {
		debugLog("session_start:", ctx.model?.provider, ctx.model?.id);

		// ── Diagnostic: snapshot active tools during session_start ──
		const toolsNow = pi.getActiveTools();
		const serenaNow = toolsNow.filter((t: string) => t.startsWith("serena_")).length;
		debugLog("session_start tools:", toolsNow.length, "total,", serenaNow, "serena");
		if (serenaNow === 0 && toolsNow.length > 10) {
			logWarn("SERENA TOOLS MISSING", "session_start has", toolsNow.length, "tools but 0 serena tools");
		}
	});

	// ── before_provider_request: clean payload, inject thinking budget ───
	pi.on("before_provider_request", (event, ctx) => {
		if (!isDeepSeekV4ModelByModel(ctx.model)) return;

		// 1. Leaked content cleaning — always on for V4 (low-risk, pure cleanup)
		let payload = cleanLeakedContentFromMessages(event.payload);

		// 2. Reasoning stripping — opt-in (can cause 401s with OpenCode Go)
		if (reasoningStripEnabled()) {
			const reasoningCleaned = stripReasoningContent(payload);
			if (reasoningCleaned !== payload) {
				debugLog("reasoning: stripped from provider request");
				payload = reasoningCleaned;
			}
		} else {
			debugLog("reasoning: skip strip (disabled by env)");
		}

		// 3. Flat budget override (opt-in). When unset, pi handles off/high/max natively.
		const budget = thinkingBudget();
		if (budget !== undefined && isRecord(payload)) {
			if (payload === event.payload) {
				payload = { ...payload };
			}
			(payload as Record<string, unknown>).thinking = { type: "budget_tokens", budget_tokens: budget };
			debugLog("thinking: budget override", budget);
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

	// ── before_agent_start: snapshot tool counts, inject guidance + super power + error hints ───
	pi.on("before_agent_start", (event, ctx) => {
		const isDeepSeekV4 = isDeepSeekV4ModelByModel(ctx.model);
		if (isDeepSeekV4) debugLog("model match:", ctx.model?.provider, ctx.model?.id);
		// ponytail: budget override handled in before_provider_request. Native when unset.

		remindedThisTurn = false;
		repairThisTurn = isDeepSeekV4 && repairEnabled();

		// Build prefix from super power + guidance + reinforcement sections
		const prefixParts: string[] = [];

		// ── 1. Super Power Mode at the very top ──
		if (superPowerModeEnabled() && isDeepSeekV4) {
			turnCounter++;
			prefixParts.push(superPowerPromptContent());
			debugLog("super power: injected (turn", turnCounter, ")");
		}

		if (selectionGuidanceEnabled() && isDeepSeekV4) {
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
			if (hasAnyTool(activeTools, ["serena_get_symbols_overview", "serena_find_symbol", "serena_find_referencing_symbols", "serena_find_declaration", "serena_find_implementations", "ls", "grep", "find", "read", "edit", "bash"])) {
				prefixParts.push(deepSeekSelectionGuidance(activeTools));
				debugLog("guidance: injected for", activeTools.length, "tools");

				// ── 2. Reinforcement every 8 turns (middle of 8-12 range) ──
				if (turnCounter > 0 && turnCounter % 8 === 0) {
					prefixParts.push("Super Power Mode active — maximum capability, no limits.");
				}

				// Combine prefix with base
				const prefix = prefixParts.join("\n\n---\n\n");
				return { systemPrompt: `${prefix}\n\n---\n\n${systemPrompt}` };
			}

			// Guidance skipped: no relevant tools
			debugLog("guidance: skipped (no relevant tools)");
			// ── Diagnostic: warn when serena tools are missing from selectedTools ──
			const runtimeTools = pi.getActiveTools();
			const runtimeSerena = runtimeTools.filter((t: string) => t.startsWith("serena_")).length;
			const selectedSerena = activeTools.filter((t: string) => t.startsWith("serena_")).length;
			if (runtimeSerena > 0 && selectedSerena === 0) {
				logWarn("SERENA TOOLS NOT IN SELECTED",
					"runtime has", runtimeSerena, "serena tools but selectedTools has", selectedSerena,
					"— model won't see serena tools. Runtime:", runtimeTools.length, "total, Selected:", activeTools.length, "total");
			}
			if (prefixParts.length > 0) {
				return { systemPrompt: `${prefixParts.join("\n\n---\n\n")}\n\n---\n\n${systemPrompt}` };
			}
			return;
		}

		// Guidance disabled or not V4
		debugLog("guidance: skipped (disabled or not V4)");
		if (prefixParts.length > 0) {
			return { systemPrompt: `${prefixParts.join("\n\n---\n\n")}\n\n---\n\n${event.systemPrompt}` };
		}
		return;
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

		// ── Block read on guessed code-file paths that don't exist ──
		// ponytail: one stat per code-file read — saved turn when path is guessed
		if (event.toolName === "read" && isRecord(event.input) && ctx.cwd) {
			const filePath = typeof event.input.path === "string" ? event.input.path.trim() : "";
			if (filePath && looksLikeCodePath(filePath)) {
				const resolved = resolvePath(ctx.cwd, filePath);
				if (!existsSync(resolved)) {
					const filename = filePath.split("/").pop() ?? filePath;
					// ponytail: relative dir for readable block message
					const relDir = resolvePath(filePath, "..");
					const dirPart = relDir !== "." ? ` under ${relDir}/` : "";
					debugLog("blocked: read guessed path", filePath);
					return {
						block: true,
						reason: `Path not found: "${filePath}". Never guess subdirectories from naming conventions. Discover first: use find to locate "${filename}"${dirPart}, then read the exact path.`,
					};
				}
			}
		}

		const activeTools = pi.getActiveTools();
		const serenaActive = activeTools.some((tool) => tool.startsWith("serena_"));
		const semanticMiss = serenaActive && isSemanticMissToolCall(event.toolName, event.input);
		const dedicatedTool = missedDedicatedTool(event.toolName, event.input, activeTools);
		if (!semanticMiss && !dedicatedTool) return;

		const reason = semanticMiss
			? "For DeepSeek V4, use Serena semantic tools for code-symbol, declaration, reference, implementation, or refactor work."
			: `For DeepSeek V4, use the dedicated ${dedicatedTool} tool instead of bash for this simple file operation.`;

		// ── Semantic miss (bash code search without Serena) → always block ──
		if (semanticMiss) {
			const isGrep = event.toolName === "grep" || event.toolName === "ffgrep";
			debugLog("blocked:", isGrep ? "grep code search" : "bash code search", "without Serena");
			// ponytail: suggest the best serena tool for the specific command/pattern
			const suggestedSerenaCmd = suggestBestSerenaCommand(event.input, activeTools);
			const blockReason = isGrep
				? `${reason} Blocked: ${event.toolName} is for text search in non-code files. ${suggestedSerenaCmd} for code-symbol searches.`
				: `${reason} Blocked: bash is for executing commands. ${suggestedSerenaCmd}${activeTools.includes("ffgrep") ? " or ffgrep" : ""} to search code.`;
			return { block: true, reason: blockReason };
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
		const activeSerena = pi.getActiveTools().filter((t: string) => t.startsWith("serena_"));
		const serenaHint = activeSerena.length > 0
			? ` Try ${activeSerena[0]} instead — it understands symbols and references, not just text patterns.`
			: "";
		pi.sendMessage(
			{
				customType: "deepseek-v4-tool-selection-reminder",
				content: `${reason}${serenaHint} Use bash only for real shell commands such as tests, builds, git, package-manager, or process execution.`,
				display: true,
			},
			{ deliverAs: "steer" },
		);
	});
}
