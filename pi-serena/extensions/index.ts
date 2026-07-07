import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { SerenaWorkerClient, type SerenaWorkerResponse } from "./worker";
import { SEMANTIC_MISS_THRESHOLD } from "./lib/detect";
import { SERENA_FIRST_GUIDANCE, SERENA_MISS_GUIDANCE, shouldBlockSemanticMiss } from "./lib/guidance";
import { normalizeProject, normalizeContext, normalizeTimeoutMs, stripControlParams } from "./lib/normalize";

const DEFAULT_CONTEXT = "ide";

const PROJECT_PARAM = Type.Optional(Type.String({ description: "Project path or registered Serena project name. Defaults to Pi's current working directory." }));
const CONTEXT_PARAM = Type.Optional(Type.String({ description: "Serena context name. Defaults to ide." }));
const MAX_CHARS_PARAM = Type.Optional(Type.Number({ description: "Maximum Serena response characters. Defaults to Serena config." }));
const TIMEOUT_MS_PARAM = Type.Optional(Type.Number({ description: "Per-call timeout in milliseconds. Defaults to 120000." }));
const OUTPUT_MAX_BYTES = 50 * 1024;
const OUTPUT_MAX_LINES = 2_000;

const controlSchema = {
	project: PROJECT_PARAM,
	context: CONTEXT_PARAM,
	timeout_ms: TIMEOUT_MS_PARAM,
};

const statusSchema = Type.Object({
	project: PROJECT_PARAM,
	context: CONTEXT_PARAM,
	includeAgent: Type.Optional(Type.Boolean({ description: "Initialize/read a SerenaAgent and include active tools/backend details." })),
	timeout_ms: TIMEOUT_MS_PARAM,
});

const listToolsSchema = Type.Object({
	...controlSchema,
	includeAgent: Type.Optional(Type.Boolean({ description: "Initialize/read a SerenaAgent before listing active tools." })),
});

const overviewSchema = Type.Object({
	...controlSchema,
	relative_path: Type.String({ description: "File path relative to the Serena project root." }),
	depth: Type.Optional(Type.Number({ description: "Symbol overview depth." })),
	max_answer_chars: MAX_CHARS_PARAM,
});

const findSymbolSchema = Type.Object({
	...controlSchema,
	name_path_pattern: Type.String({ description: "Symbol name path pattern, e.g. MyClass/my_method." }),
	depth: Type.Optional(Type.Number()),
	relative_path: Type.Optional(Type.String({ description: "Optional file or directory restriction relative to project root." })),
	include_body: Type.Optional(Type.Boolean()),
	include_info: Type.Optional(Type.Boolean()),
	substring_matching: Type.Optional(Type.Boolean()),
	max_matches: Type.Optional(Type.Number()),
	max_answer_chars: MAX_CHARS_PARAM,
});

const referencingSchema = Type.Object({
	...controlSchema,
	name_path: Type.String({ description: "Exact symbol name path from find_symbol." }),
	relative_path: Type.String({ description: "File containing the symbol, relative to project root." }),
	include_kinds: Type.Optional(Type.Array(Type.Number({ description: "LSP symbol kind integers to include." }))),
	exclude_kinds: Type.Optional(Type.Array(Type.Number({ description: "LSP symbol kind integers to exclude." }))),
	max_answer_chars: MAX_CHARS_PARAM,
});

const replaceBodySchema = Type.Object({
	...controlSchema,
	name_path: Type.String({ description: "Exact symbol name path to replace." }),
	relative_path: Type.String({ description: "File containing the symbol, relative to project root." }),
	body: Type.String({ description: "Complete new symbol definition/body, including signature line." }),
});

const insertSchema = Type.Object({
	...controlSchema,
	name_path: Type.String({ description: "Exact reference symbol name path." }),
	relative_path: Type.String({ description: "File containing the reference symbol, relative to project root." }),
	body: Type.String({ description: "Content to insert." }),
});

const renameSchema = Type.Object({
	...controlSchema,
	name_path: Type.String({ description: "Exact symbol name path to rename." }),
	relative_path: Type.String({ description: "File containing the symbol, relative to project root." }),
	new_name: Type.String({ description: "New symbol name." }),
});

const safeDeleteSchema = Type.Object({
	...controlSchema,
	name_path_pattern: Type.String({ description: "Symbol name path pattern to delete if unreferenced." }),
	relative_path: Type.String({ description: "File containing the symbol, relative to project root." }),
});

const emptyToolSchema = Type.Object({ ...controlSchema });

const symbolRefSchema = Type.Object({
	...controlSchema,
	name_path: Type.String({ description: "Exact symbol name path to look up." }),
	relative_path: Type.String({ description: "File containing the symbol, relative to project root." }),
});

const diagnosticsSchema = Type.Object({
	...controlSchema,
	relative_path: Type.String({ description: "File path relative to the Serena project root to get diagnostics for." }),
});

const searchPatternSchema = Type.Object({
	...controlSchema,
	pattern: Type.String({ description: "Pattern to search for." }),
	relative_path: Type.Optional(Type.String({ description: "Optional file or directory restriction relative to the Serena project root." })),
	paths_include_glob: Type.Optional(Type.String({ description: "Optional glob for included paths." })),
	paths_exclude_glob: Type.Optional(Type.String({ description: "Optional glob for excluded paths." })),
	context_lines_before: Type.Optional(Type.Number({ description: "Number of context lines before each match." })),
	context_lines_after: Type.Optional(Type.Number({ description: "Number of context lines after each match." })),
	restrict_search_to_code_files: Type.Optional(Type.Boolean({ description: "Restrict search to source/code files when supported by Serena." })),
	multiline: Type.Optional(Type.Boolean({ description: "Treat the pattern as a multiline regular expression when supported by Serena." })),
	max_answer_chars: MAX_CHARS_PARAM,
});

const replaceContentSchema = Type.Object({
	...controlSchema,
	relative_path: Type.String({ description: "File path relative to the Serena project root." }),
	needle: Type.Optional(Type.String({ description: "Exact text or regex pattern to replace." })),
	repl: Type.Optional(Type.String({ description: "Replacement text." })),
	mode: Type.Optional(Type.Union([Type.Literal("literal"), Type.Literal("regex")], { description: "Interpret needle as exact text or as a Python regex." })),
	allow_multiple_occurrences: Type.Optional(Type.Boolean({ description: "Allow replacing multiple matches when supported." })),
});





function truncateText(text: string): string {
	const lines = text.split("\n");
	if (lines.length <= OUTPUT_MAX_LINES && Buffer.byteLength(text, "utf8") <= OUTPUT_MAX_BYTES) return text;
	const output = lines.slice(0, OUTPUT_MAX_LINES).join("\n").slice(0, OUTPUT_MAX_BYTES);
	return output + `\n\n[Serena output truncated to ${OUTPUT_MAX_LINES} lines / ${OUTPUT_MAX_BYTES} bytes.]`;
}

const ERROR_HINTS: Record<string, (tool?: string) => string> = {
	language_server_error: () => " The language server may need a restart. Try serena_restart_language_server first.",
	missing_tool: (tool) => ` The tool '${tool ?? "unknown"}' is not available. Try serena_list_tools to see available tools for this project.`,
	inactive_tool: (tool) => ` The tool '${tool ?? "unknown"}' is not active in the current context. Try serena_list_tools to see active tools.`,
	timeout: () => " The request timed out. Retry with a longer timeout_ms parameter.",
	project_error: () => " There is a project configuration issue. Try serena_get_current_config to inspect the active project.",
};

function errorSuggestion(errorType: string | undefined, tool: string | undefined): string {
	const hint = errorType ? ERROR_HINTS[errorType] : undefined;
	return hint ? hint(tool) : "";
}

function resultText(response: SerenaWorkerResponse): string {
	if (!response.ok) {
		const suggestion = errorSuggestion(response.errorType as string | undefined, response.tool as string | undefined);
		return `Error: ${response.error ?? "Unknown Serena error"}${suggestion}`;
	}
	// For search results, show a friendly empty-state instead of raw "{}".
	if (response.tool === "search_for_pattern") {
		if (response.result == null || (typeof response.result === "object" && Object.keys(response.result as object).length === 0)) {
			return "No results found.";
		}
	}
	return typeof response.result === "string" ? response.result : JSON.stringify(response, null, 2);
}

export default function serenaToolsExtension(pi: ExtensionAPI) {
	let worker: SerenaWorkerClient | undefined;
	let semanticMissCount = 0;
	let lastReminderTs = 0;

	const getWorker = (ctx?: { ui?: { setStatus?: (key: string, value: string | undefined) => void } }) => {
		if (!worker) worker = new SerenaWorkerClient((status) => ctx?.ui?.setStatus?.("serena", status ? "serena ✓" : undefined));
		return worker;
	};

	const callWorkerAction = async (ctx: any, action: string, rawParams: Record<string, unknown>, extraPayload: Record<string, unknown> = {}, lockPath?: string) => {
		const { project, context, timeoutMs, params } = stripControlParams(rawParams);
		const payload = { action, project, context, params, ...extraPayload };
		const requestWithRetry = async (): Promise<SerenaWorkerResponse> => {
			try {
				const response = await getWorker(ctx).request(payload, timeoutMs);
				const errorType = response.errorType as string | undefined;
				return !response.ok && (errorType === "timeout" || errorType === "language_server_error")
					? getWorker(ctx).request(payload, timeoutMs)
					: response;
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (!/Serena worker request timed out|Serena worker killed due to timeout, restarted|Serena worker exited/.test(msg)) throw error;
				return getWorker(ctx).request(payload, timeoutMs);
			}
		};
		const run = async (): Promise<{ content: { type: "text"; text: string }[]; details: SerenaWorkerResponse }> => {
			const response = await requestWithRetry();
			return {
				content: [{ type: "text" as const, text: resultText(response) }],
				details: response,
			};
		};
		return lockPath ? withFileMutationQueue(lockPath, run) : run();
	};

	const callSerena = async (ctx: any, tool: string, rawParams: Record<string, unknown>, lockPath?: string) => {
		return callWorkerAction(ctx, "call", rawParams, { tool }, lockPath);
	};

	const lockPathForRelativeFile = (rawParams: Record<string, unknown>): string | undefined => {
		const project = normalizeProject(rawParams.project);
		return typeof rawParams.relative_path === "string" && rawParams.relative_path.trim()
			? path.resolve(project, rawParams.relative_path)
			: undefined;
	};

	const lockPathForProject = (rawParams: Record<string, unknown>): string => path.resolve(normalizeProject(rawParams.project));

	pi.registerTool({
		name: "serena_status",
		label: "Serena Status",
		description: "Show Serena worker and project status for semantic code tools.",
		promptSnippet: "Check Serena semantic worker availability and active project/tool state",
		promptGuidelines: ["Use serena_status before semantic code retrieval/refactoring if Serena availability is uncertain."],
		parameters: statusSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const project = normalizeProject(params.project);
			const context = normalizeContext(params.context);
			const response = await getWorker(ctx).request({ action: "status", project, context, includeAgent: Boolean(params.includeAgent) }, normalizeTimeoutMs(params.timeout_ms));
			return { content: [{ type: "text", text: truncateText(JSON.stringify(response, null, 2)) }], details: response };
		},
	});

	pi.registerTool({
		name: "serena_list_tools",
		label: "Serena List Tools",
		description: "List active Serena tools for the current project/context.",
		promptSnippet: "List available Serena semantic code and workflow tools",
		promptGuidelines: ["Use serena_list_tools when you need to know which Serena tools are active for this project/context."],
		parameters: listToolsSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const project = normalizeProject(params.project);
			const context = normalizeContext(params.context);
			const response = await getWorker(ctx).request({ action: "status", project, context, includeAgent: true }, normalizeTimeoutMs(params.timeout_ms));
			const tools = Array.isArray(response.activeTools) ? response.activeTools : [];
			const text = tools.length > 0 ? tools.map((tool) => `- ${tool}`).join("\n") : JSON.stringify(response, null, 2);
			return { content: [{ type: "text", text: truncateText(text) }], details: response };
		},
	});

	pi.registerTool({
		name: "serena_get_symbols_overview",
		label: "Serena Symbols Overview",
		description: "Get top-level symbols for a code file using Serena's language-server backend.",
		promptSnippet: "Get a semantic outline of symbols in a source file",
		promptGuidelines: ["Use serena_get_symbols_overview before reading an entire code file when symbol structure is enough."],
		parameters: overviewSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callSerena(ctx, "get_symbols_overview", params);
		},
	});

	pi.registerTool({
		name: "serena_find_symbol",
		label: "Serena Find Symbol",
		description: "Find symbols by name path pattern using Serena semantic code retrieval.",
		promptSnippet: "Find functions, classes, methods, and variables by semantic symbol name path",
		promptGuidelines: ["Use serena_find_symbol for code navigation before grep when the target is a function, class, method, or variable."],
		parameters: findSymbolSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callSerena(ctx, "find_symbol", params);
		},
	});

	pi.registerTool({
		name: "serena_find_referencing_symbols",
		label: "Serena Find References",
		description: "Find symbols that reference a given symbol using Serena semantic retrieval.",
		promptSnippet: "Find semantic references/callers/usages of a known symbol",
		promptGuidelines: ["Use serena_find_referencing_symbols before changing public behavior or renaming a symbol."],
		parameters: referencingSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// ponytail: strip include_body param (not supported by Python backend)
			const { include_body: _ib, ...findRefParams } = params;
			return callSerena(ctx, "find_referencing_symbols", findRefParams);
		},
	});

	pi.registerTool({
		name: "serena_replace_symbol_body",
		label: "Serena Replace Symbol Body",
		description: "Replace a complete function/class/method definition using Serena symbol-aware editing.",
		promptSnippet: "Replace a complete known symbol body by semantic boundary",
		promptGuidelines: ["Use serena_replace_symbol_body only after serena_find_symbol identifies the exact symbol to replace."],
		parameters: replaceBodySchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callSerena(ctx, "replace_symbol_body", params, lockPathForRelativeFile(params));
		},
	});

	pi.registerTool({
		name: "serena_insert_before_symbol",
		label: "Serena Insert Before Symbol",
		description: "Insert content before a known symbol definition using Serena symbol-aware editing.",
		promptSnippet: "Insert code before a known symbol definition",
		promptGuidelines: ["Use serena_insert_before_symbol for symbol-adjacent code insertion after locating the target symbol."],
		parameters: insertSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callSerena(ctx, "insert_before_symbol", params, lockPathForRelativeFile(params));
		},
	});

	pi.registerTool({
		name: "serena_insert_after_symbol",
		label: "Serena Insert After Symbol",
		description: "Insert content after a known symbol definition using Serena symbol-aware editing.",
		promptSnippet: "Insert code after a known symbol definition",
		promptGuidelines: ["Use serena_insert_after_symbol for adding sibling/helper symbols after a located symbol."],
		parameters: insertSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callSerena(ctx, "insert_after_symbol", params, lockPathForRelativeFile(params));
		},
	});

	pi.registerTool({
		name: "serena_rename_symbol",
		label: "Serena Rename Symbol",
		description: "Rename a symbol across the codebase using Serena language-server refactoring.",
		promptSnippet: "Semantic rename of a known symbol across references",
		promptGuidelines: ["Use serena_rename_symbol for cross-file code renames after finding the exact symbol and references."],
		parameters: renameSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callSerena(ctx, "rename_symbol", params, lockPathForProject(params));
		},
	});

	pi.registerTool({
		name: "serena_safe_delete_symbol",
		label: "Serena Safe Delete Symbol",
		description: "Delete a symbol only if Serena finds no remaining references.",
		promptSnippet: "Safely delete an unreferenced symbol",
		promptGuidelines: ["Use serena_safe_delete_symbol instead of text deletion when remaining references matter."],
		parameters: safeDeleteSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callSerena(ctx, "safe_delete_symbol", params, lockPathForRelativeFile(params));
		},
	});

	pi.registerTool({
		name: "serena_search_for_pattern",
		label: "Serena Search Pattern",
		description: "Search project files through Serena with project-aware path filtering.",
		promptSnippet: "Search for a text or regex pattern using Serena",
		promptGuidelines: ["Use serena_search_for_pattern for project-scoped code searches when symbol lookup is not enough."],
		parameters: searchPatternSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.multiline === true) {
				return {
					content: [{ type: "text" as const, text: "Error: serena_search_for_pattern does not support multiline mode. Use serena_search_for_pattern without multiline or use serena_find_symbol for symbol-aware searches instead." }],
					details: { ok: false, error: "multiline not supported" },
				};
			}
			// ponytail: map pattern→substring_pattern for Python backend
			const { pattern, multiline: _ml, ...searchParams } = params;
			if (pattern) searchParams.substring_pattern = pattern;
			return callSerena(ctx, "search_for_pattern", searchParams);
		},
	});

	pi.registerTool({
		name: "serena_replace_content",
		label: "Serena Replace Content",
		description: "Replace file content through Serena when symbol-aware editing is not the right boundary.",
		promptSnippet: "Perform a Serena content replacement in a project file",
		promptGuidelines: ["Prefer symbol-aware Serena edit tools for whole symbols; use serena_replace_content for non-symbol scoped replacements supported by Serena."],
		parameters: replaceContentSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// ponytail: strip legacy params and validate
			const { old_string: _os, new_string: _ns, content: _c, regex: _r, ...normalized } = params;
			if (typeof normalized.needle !== "string") return { content: [{ type: "text" as const, text: "serena_replace_content requires string parameter 'needle'." }], details: { ok: false } };
			if (typeof normalized.repl !== "string") return { content: [{ type: "text" as const, text: "serena_replace_content requires string parameter 'repl'." }], details: { ok: false } };
			if (normalized.mode !== "literal" && normalized.mode !== "regex") return { content: [{ type: "text" as const, text: "serena_replace_content requires mode to be 'literal' or 'regex'." }], details: { ok: false } };
			return callSerena(ctx, "replace_content", normalized, lockPathForRelativeFile(params));
		},
	});

	pi.registerTool({
		name: "serena_restart_language_server",
		label: "Serena Restart Language Server",
		description: "Restart Serena's language server for the active project when diagnostics/symbol data are stale.",
		promptSnippet: "Restart the Serena language server",
		promptGuidelines: ["Use serena_restart_language_server when Serena symbol retrieval appears stale or language-server diagnostics are stuck."],
		parameters: emptyToolSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callWorkerAction(ctx, "restart_language_server", params);
		},
	});

	pi.registerTool({
		name: "serena_get_current_config",
		label: "Serena Current Config",
		description: "Show Serena's current project/configuration details.",
		promptSnippet: "Inspect Serena project, context, modes, tools, and backend configuration",
		promptGuidelines: ["Use serena_get_current_config when project activation, contexts, modes, or tool availability are unclear."],
		parameters: emptyToolSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callWorkerAction(ctx, "config", params);
		},
	});

	pi.registerTool({
		name: "serena_check_onboarding_performed",
		label: "Serena Check Onboarding",
		description: "Check whether Serena onboarding memories exist for this project.",
		promptSnippet: "Check whether project onboarding was already performed",
		promptGuidelines: ["Use serena_check_onboarding_performed before relying on Serena project memories (or use munin_search for cross-project long-term memory)."],
		parameters: emptyToolSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callSerena(ctx, "check_onboarding_performed", params);
		},
	});

	pi.registerTool({
		name: "serena_onboarding",
		label: "Serena Onboarding",
		description: "Run Serena's onboarding prompt for collecting project memories.",
		promptSnippet: "Start Serena project onboarding",
		promptGuidelines: ["Use serena_onboarding only when project onboarding has not been performed or the user asks to refresh it. For cross-project long-term memory, use munin_store instead."],
		parameters: emptyToolSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callSerena(ctx, "onboarding", params);
		},
	});

	// ponytail: memory tools removed — use munin_search/munin_store/munin_get for all memory operations.
	// Serena keeps only code-navigation tools (find_symbol, find_declaration, replace_body, etc.)

	pi.registerTool({
		name: "serena_find_declaration",
		label: "Serena Find Declaration",
		description: "Find the declaration/definition of a symbol using the language server backend.",
		promptSnippet: "Find the declaration/definition of a symbol",
		promptGuidelines: ["Use serena_find_declaration to navigate to the definition of a known symbol, e.g. to find where a function is defined."],
		parameters: symbolRefSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callWorkerAction(ctx, "find_declaration", params);
		},
	});

	pi.registerTool({
		name: "serena_find_implementations",
		label: "Serena Find Implementations",
		description: "Find implementations of a symbol using the language server backend.",
		promptSnippet: "Find symbols that implement the given symbol",
		promptGuidelines: ["Use serena_find_implementations to locate implementations of interfaces, abstract methods, or base classes."],
		parameters: symbolRefSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callWorkerAction(ctx, "find_implementations", params);
		},
	});

	pi.registerTool({
		name: "serena_get_diagnostics_for_file",
		label: "Serena File Diagnostics",
		description: "Get LSP diagnostics (errors, warnings, hints) for a file using the language server backend.",
		promptSnippet: "Get diagnostics for a file from the language server",
		promptGuidelines: ["Use serena_get_diagnostics_for_file to inspect compiler/IDE diagnostics for a specific file."],
		parameters: diagnosticsSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return callWorkerAction(ctx, "get_diagnostics_for_file", params);
		},
	});

	pi.registerCommand("serena-dashboard", {
		description: "Open the Serena dashboard for the current project",
		handler: async (args, ctx) => {
			const project = args?.trim() || process.cwd();
			const response = await getWorker(ctx).request({ action: "dashboard", project, context: DEFAULT_CONTEXT, open: true });
			if (response.ok) {
				const opened = response.opened ? "opened" : "available";
				ctx.ui.notify(`Serena dashboard ${opened}: ${response.dashboardUrl ?? "dashboard URL unavailable"}`, "info");
			} else {
				ctx.ui.notify(resultText(response), "error");
			}
		},
	});

	pi.registerCommand("serena-restart", {
		description: "Restart the persistent Serena worker",
		handler: async (_args, ctx) => {
			getWorker(ctx).restart();
			ctx.ui.notify("Restarted Serena worker", "info");
		},
	});

	// Serena guidance — only inject when serena tools are actually active
	pi.on("before_agent_start", async (event) => {
		const serenaActive = event.systemPromptOptions?.selectedTools?.includes("serena_find_symbol");
		if (!serenaActive) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${SERENA_FIRST_GUIDANCE}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		// Skip semantic miss detection if serena tools are not active (e.g., plan mode)
		const activeTools = pi.getActiveTools();
		if (!activeTools.includes("serena_find_symbol")) return;

		// DeepSeek V4: deepseek-tools handles semantic misses — skip to avoid duplicate steer
		if (ctx.model?.provider === "opencode-go" && ctx.model?.id?.startsWith("deepseek-v4")) return;

		if (event.toolName.startsWith("serena_")) {
			semanticMissCount = 0;
			return;
		}

		const looksLikeSemanticMiss = shouldBlockSemanticMiss(event.toolName, event.input as Record<string, unknown>);
		if (!looksLikeSemanticMiss) return;
		const strict = process.env.PI_SERENA_STRICT === "1" || process.env.PI_SERENA_STRICT_MISSES === "1";
		if (strict) {
			return { block: true, reason: `Serena-first mode: ${SERENA_MISS_GUIDANCE}` };
		}
		semanticMissCount += 1;
		if ((semanticMissCount >= SEMANTIC_MISS_THRESHOLD || process.env.PI_SERENA_REMIND_ON_FIRST_MISS === "1") && Date.now() - lastReminderTs > 30_000) {
			semanticMissCount = 0;
			lastReminderTs = Date.now();
			pi.sendMessage(
				{
					customType: "serena-reminder",
					content: `Reminder: ${SERENA_MISS_GUIDANCE}`,
					display: true,
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		}
	});

	// Eager startup: pre-spawn the worker on session start when SERENA_EAGER_STARTUP=1
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.SERENA_EAGER_STARTUP === "1") {
			// Spawn the worker via a lightweight status request to warm the Python bridge
			getWorker(ctx).request({ action: "status", project: process.cwd(), context: DEFAULT_CONTEXT }, 30_000).catch(() => {
				// Eager startup is best-effort; failures are handled when the tool is first used
			});
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await worker?.stop();
		worker = undefined;
		ctx.ui.setStatus("serena", undefined);
	});
}
