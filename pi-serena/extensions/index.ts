import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { SerenaWorkerClient, type SerenaWorkerResponse } from "./worker";
import { SERENA_FIRST_GUIDANCE, SERENA_MISS_GUIDANCE, shouldBlockSemanticMiss } from "./lib/guidance";
import { normalizeProject, normalizeContext, normalizeTimeoutMs, stripControlParams } from "./lib/normalize";
import { repairSymbolNameKey } from "./lib/symbol-key";

const DEFAULT_CONTEXT = "ide";

/** Set of "provider/modelId" strings that should skip semantic-miss detection (e.g., deepseek-tools handles it). */
const SKIP_SEMANTIC_MISS_MODELS = new Set(
  (process.env.PI_SERENA_SKIP_SEMANTIC_MISS_MODELS || "opencode-go/deepseek-v4,opencode-go/deepseek-v4-flash,opencode-go/deepseek-v4-pro")
    .split(",")
    .map((s) => s.trim()),
);

const PROJECT_PARAM = Type.Optional(Type.String({ description: "Project path or registered Serena project name. Default: CWD." }));
const CONTEXT_PARAM = Type.Optional(Type.String({ description: "Serena context name. Default: ide. Available: agent, chatgpt, claude-code, codex, copilot-cli, desktop-app, ide, jb-ai-assistant, junie, oaicompat-agent, vscode." }));
const MAX_CHARS_PARAM = Type.Optional(Type.Number({ description: "Max response chars. Default: Serena config." }));
const TIMEOUT_MS_PARAM = Type.Optional(Type.Number({ description: "Timeout in ms. Default: 120000." }));
const SEMANTIC_MISS_THRESHOLD = 2;

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
  includeAgent: Type.Optional(Type.Boolean({ description: "Include active tools/backend details via SerenaAgent." })),
  timeout_ms: TIMEOUT_MS_PARAM,
});

const listToolsSchema = Type.Object({
  ...controlSchema,
  includeAgent: Type.Optional(Type.Boolean({ description: "Include SerenaAgent before listing." })),
});

const overviewSchema = Type.Object({
  ...controlSchema,
  relative_path: Type.String({ description: "Path relative to project root." }),
  depth: Type.Optional(Type.Number({ description: "Overview depth." })),
  max_answer_chars: MAX_CHARS_PARAM,
});

const findSymbolSchema = Type.Object({
  ...controlSchema,
  name_path_pattern: Type.String({ description: "Name path pattern, e.g. MyClass/my_method." }),
  depth: Type.Optional(Type.Number()),
  relative_path: Type.Optional(Type.String({ description: "Optional dir/file restriction relative to project root." })),
  include_body: Type.Optional(Type.Boolean()),
  include_info: Type.Optional(Type.Boolean()),
  substring_matching: Type.Optional(Type.Boolean()),
  max_matches: Type.Optional(Type.Number()),
  max_answer_chars: MAX_CHARS_PARAM,
});

const referencingSchema = Type.Object({
  ...controlSchema,
  name_path: Type.String({ description: "Exact symbol name path from find_symbol." }),
  relative_path: Type.String({ description: "Symbol's file, relative to project root." }),
  include_kinds: Type.Optional(Type.Array(Type.Number({ description: "LSP kind integers to include." }))),
  exclude_kinds: Type.Optional(Type.Array(Type.Number({ description: "LSP kind integers to exclude." }))),
  max_answer_chars: MAX_CHARS_PARAM,
});

const replaceBodySchema = Type.Object({
  ...controlSchema,
  name_path: Type.String({ description: "Exact name path to replace." }),
  relative_path: Type.String({ description: "Symbol's file, relative to project root." }),
  body: Type.String({ description: "Complete new symbol definition/body, including signature line." }),
});

const insertSchema = Type.Object({
  ...controlSchema,
  name_path: Type.String({ description: "Exact name path of reference symbol." }),
  relative_path: Type.String({ description: "Symbol's file, relative to project root." }),
  body: Type.String({ description: "Content to insert." }),
});

const renameSchema = Type.Object({
  ...controlSchema,
  name_path: Type.String({ description: "Exact name path to rename." }),
  relative_path: Type.String({ description: "Symbol's file, relative to project root." }),
  new_name: Type.String({ description: "New symbol name." }),
});

const safeDeleteSchema = Type.Object({
  ...controlSchema,
  name_path_pattern: Type.String({ description: "Name path pattern to delete if unreferenced." }),
  relative_path: Type.String({ description: "Symbol's file, relative to project root." }),
});

const emptyToolSchema = Type.Object({ ...controlSchema });

const symbolRefSchema = Type.Object({
  ...controlSchema,
  name_path: Type.String({ description: "Exact name path to look up." }),
  relative_path: Type.String({ description: "Symbol's file, relative to project root." }),
});

const diagnosticsSchema = Type.Object({
  ...controlSchema,
  relative_path: Type.String({ description: "Path relative to project root." }),
});

const searchPatternSchema = Type.Object({
  ...controlSchema,
  pattern: Type.String({ description: "Pattern to search for." }),
  relative_path: Type.Optional(Type.String({ description: "Optional dir restriction relative to project root." })),
  paths_include_glob: Type.Optional(Type.String({ description: "Glob for included paths." })),
  paths_exclude_glob: Type.Optional(Type.String({ description: "Glob for excluded paths." })),
  context_lines_before: Type.Optional(Type.Number({ description: "Context lines before each match." })),
  context_lines_after: Type.Optional(Type.Number({ description: "Context lines after each match." })),
  restrict_search_to_code_files: Type.Optional(Type.Boolean({ description: "Restrict search to source/code files when supported by Serena." })),
  multiline: Type.Optional(Type.Boolean({ description: "Treat the pattern as a multiline regular expression when supported by Serena." })),
  max_answer_chars: MAX_CHARS_PARAM,
  limit: Type.Optional(Type.Number({ description: "Max matches to return." })),
});

const replaceContentSchema = Type.Object({
  ...controlSchema,
  relative_path: Type.String({ description: "Path relative to project root." }),
  needle: Type.Optional(Type.String({ description: "Text or regex to replace." })),
  repl: Type.Optional(Type.String({ description: "Replacement text." })),
  mode: Type.Optional(Type.Union([Type.Literal("literal"), Type.Literal("regex")], { description: "Literal or regex." })),
  allow_multiple_occurrences: Type.Optional(Type.Boolean({ description: "Allow replacing multiple matches when supported." })),
});

function truncateText(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= OUTPUT_MAX_LINES && Buffer.byteLength(text, "utf8") <= OUTPUT_MAX_BYTES) return text;
  const truncatedLines = lines.slice(0, OUTPUT_MAX_LINES).join("\n");
  const buf = Buffer.from(truncatedLines, "utf8");
  if (buf.length <= OUTPUT_MAX_BYTES) return truncatedLines;
  // Find a safe split point that doesn't break a multi-byte character
  let byteLen = OUTPUT_MAX_BYTES;
  while (byteLen > 0 && (buf[byteLen] & 0xc0) === 0x80) byteLen--;
  const output = buf.subarray(0, byteLen).toString("utf8");
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
    const errorDetail = response.error
      ?? (typeof response.result === "string" ? response.result : undefined)
      ?? "Unknown Serena error";
    return `Error: ${errorDetail}${suggestion}`;
  }
  // For search results, show a friendly empty-state instead of raw "{}".
  if (response.tool === "search_for_pattern") {
    if (response.result == null || response.result === '{}' || (typeof response.result === "object" && Object.keys(response.result as object).length === 0)) {
      return "No results found.";
    }
  }
  return typeof response.result === "string" ? response.result : JSON.stringify(response.result, null, 2);
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
        return !response.ok && errorType === "timeout"
          ? getWorker(ctx).request(payload, timeoutMs)
          : response;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!(msg.includes('timed out') || msg.includes('killed due to timeout') || msg.includes('worker exited') || msg.includes('restarted'))) throw error;
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
    if (typeof rawParams.relative_path !== "string" || !rawParams.relative_path.trim()) return undefined;
    const resolved = path.resolve(project, rawParams.relative_path);
    const relative = path.relative(project, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return resolved;
  };

  const lockPathForProject = (rawParams: Record<string, unknown>): string => path.resolve(normalizeProject(rawParams.project));

  pi.registerTool({
    name: "serena_status",
    label: "Serena Status",
    description: "Show Serena worker and project status.",
    promptSnippet: "Check worker availability and project/tool state",
    promptGuidelines: ["Check availability before semantic work."],
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
    description: "List active Serena tools for project/context.",
    promptSnippet: "List available Serena tools",
    promptGuidelines: ["Discover active tools for current project/context."],
    parameters: listToolsSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const project = normalizeProject(params.project);
      const context = normalizeContext(params.context);
      const response = await getWorker(ctx).request({ action: "status", project, context, includeAgent: true }, normalizeTimeoutMs(params.timeout_ms));
      const tools = Array.isArray(response.activeTools) ? response.activeTools : [];
      const text = tools.length > 0 ? tools.map((tool) => `- ${tool}`).join("\n") : 'No active tools found for this project/context.';
      return { content: [{ type: "text", text: truncateText(text) }], details: response };
    },
  });

  pi.registerTool({
    name: "serena_get_symbols_overview",
    label: "Serena Symbols Overview",
    description: "Get top-level symbols via the language server.",
    promptSnippet: "Outline symbols in a source file",
    promptGuidelines: ["Use before reading a whole file when symbols suffice."],
    parameters: overviewSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return callSerena(ctx, "get_symbols_overview", params);
    },
  });

  pi.registerTool({
    name: "serena_find_symbol",
    label: "Serena Find Symbol",
    description: "Find symbols by name path pattern.",
    promptSnippet: "Find symbols by name path",
    promptGuidelines: ["Navigate to named symbols before grep or read."],
    parameters: findSymbolSchema,
    prepareArguments: (args) => repairSymbolNameKey(args, true),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return callSerena(ctx, "find_symbol", params);
    },
  });

  pi.registerTool({
    name: "serena_find_referencing_symbols",
    label: "Serena Find References",
    description: "Find symbols referencing a given symbol.",
    promptSnippet: "Find references/usages of a known symbol",
    promptGuidelines: ["Use before changing public behavior or renames."],
    parameters: referencingSchema,
    prepareArguments: (args) => repairSymbolNameKey(args, false),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return callSerena(ctx, "find_referencing_symbols", params);
    },
  });

  pi.registerTool({
    name: "serena_replace_symbol_body",
    label: "Serena Replace Symbol Body",
    description: "Replace a function/class/method body via symbolic editing.",
    promptSnippet: "Replace a known symbol body",
    promptGuidelines: ["Use only after find_symbol identifies the target."],
    parameters: replaceBodySchema,
    prepareArguments: (args) => repairSymbolNameKey(args, false),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return callSerena(ctx, "replace_symbol_body", params, lockPathForRelativeFile(params));
    },
  });

  pi.registerTool({
    name: "serena_insert_before_symbol",
    label: "Serena Insert Before Symbol",
    description: "Insert content before a known symbol definition.",
    promptSnippet: "Insert code before a known symbol definition",
    promptGuidelines: ["Insert code adjacent to a located symbol's definition."],
    parameters: insertSchema,
    prepareArguments: (args) => repairSymbolNameKey(args, false),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return callSerena(ctx, "insert_before_symbol", params, lockPathForRelativeFile(params));
    },
  });

  pi.registerTool({
    name: "serena_insert_after_symbol",
    label: "Serena Insert After Symbol",
    description: "Insert content after a known symbol definition.",
    promptSnippet: "Insert code after a known symbol definition",
    promptGuidelines: ["Add sibling/helper symbols after a located definition."],
    parameters: insertSchema,
    prepareArguments: (args) => repairSymbolNameKey(args, false),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return callSerena(ctx, "insert_after_symbol", params, lockPathForRelativeFile(params));
    },
  });

  pi.registerTool({
    name: "serena_rename_symbol",
    label: "Serena Rename Symbol",
    description: "Rename a symbol across the codebase.",
    promptSnippet: "Rename a known symbol across references",
    promptGuidelines: ["Cross-file renames after finding the exact symbol."],
    parameters: renameSchema,
    prepareArguments: (args) => repairSymbolNameKey(args, false),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return callSerena(ctx, "rename_symbol", params, lockPathForProject(params));
    },
  });

  pi.registerTool({
    name: "serena_safe_delete_symbol",
    label: "Serena Safe Delete Symbol",
    description: "Delete a symbol with no remaining references.",
    promptSnippet: "Safely delete an unreferenced symbol",
    promptGuidelines: ["Delete an unreferenced symbol safely."],
    parameters: safeDeleteSchema,
    prepareArguments: (args) => repairSymbolNameKey(args, true),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return callSerena(ctx, "safe_delete_symbol", params, lockPathForRelativeFile(params));
    },
  });

  pi.registerTool({
    name: "serena_search_for_pattern",
    label: "Serena Search Pattern",
    description: "Search project files with path filtering.",
    promptSnippet: "Search for text or regex",
    promptGuidelines: ["Project-scoped text/regex search when symbol lookup falls short."],
    parameters: searchPatternSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.multiline === true) {
        return {
          content: [{ type: "text" as const, text: "Error: serena_search_for_pattern does not support multiline mode. Use serena_search_for_pattern without multiline or use serena_find_symbol for symbol-aware searches instead." }],
          details: { ok: false, error: "multiline not supported" },
        };
      }
      // ponytail: rename pattern → substring_pattern for Python backend
      const { multiline: _ml, limit: _limit, pattern, ...restParams } = params;
      const searchParams: Record<string, unknown> = { ...restParams };
      if (pattern) {
        searchParams.substring_pattern = pattern;
      }
      const result = await callSerena(ctx, "search_for_pattern", searchParams);
      if (_limit && result.content?.[0]?.text) {
        try {
          // ponytail: parse result JSON, count matches, truncate if over limit
          const parsed = JSON.parse(result.content[0].text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const entries = Object.entries(parsed) as [string, unknown[]][];
            const total = entries.reduce((s, [, v]) => s + (Array.isArray(v) ? v.length : 0), 0);
            if (total > _limit) {
              let kept = 0;
              const out: Record<string, unknown[]> = {};
              for (const [f, arr] of entries) {
                if (!Array.isArray(arr)) continue;
                const need = _limit - kept;
                if (need <= 0) break;
                out[f] = arr.slice(0, need);
                kept += out[f]!.length;
              }
              result.content[0].text = JSON.stringify(out) + `\n\n[Results truncated to ${_limit} matches out of ${total}. Refine search or increase limit.]`;
            }
          }
        } catch {
          // ponytail: not JSON, fall back to line truncation
          const lines = result.content[0].text.split("\n");
          if (lines.length > _limit) {
            result.content[0].text = lines.slice(0, _limit).join("\n") + `\n\n[Results truncated to ${_limit} lines. Refine search or increase limit.]`;
          }
        }
      }
      return result;
    },
  });

  pi.registerTool({
    name: "serena_replace_content",
    label: "Serena Replace Content",
    description: "Replace file content when symbolic editing isn't the right boundary.",
    promptSnippet: "Content replacement in a project file",
    promptGuidelines: ["Fallback for non-symbol content replacement."],
    parameters: replaceContentSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const normalized = { ...params };
      if (typeof normalized.needle !== "string") return { content: [{ type: "text" as const, text: "serena_replace_content requires string parameter 'needle'." }], details: { ok: false } };
      if (typeof normalized.repl !== "string") return { content: [{ type: "text" as const, text: "serena_replace_content requires string parameter 'repl'." }], details: { ok: false } };
      const mode = normalized.mode ?? "literal";
      if (mode !== "literal" && mode !== "regex") return { content: [{ type: "text" as const, text: "serena_replace_content requires mode to be 'literal' or 'regex'." }], details: { ok: false } };
      normalized.mode = mode;
      return callSerena(ctx, "replace_content", normalized, lockPathForRelativeFile(params));
    },
  });

  pi.registerTool({
    name: "serena_restart_language_server",
    label: "Serena Restart Language Server",
    description: "Restart the language server when diagnostics are stale.",
    promptSnippet: "Restart the Serena language server",
    promptGuidelines: ["Use when symbol retrieval or diagnostics appear stale.", "For a full worker restart (Python bridge), use serena_restart_worker instead."],
    parameters: emptyToolSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return callWorkerAction(ctx, "restart_language_server", params);
    },
  });

  pi.registerTool({
    name: "serena_restart_worker",
    label: "Serena Restart Worker",
    description: "Restart the persistent Serena Python worker process. Use when diagnostics seem stale or after configuration changes.",
    promptSnippet: "Restart the persistent Serena worker (Python bridge)",
    promptGuidelines: ["Use when the worker is unresponsive or after serena configuration changes.", "This kills and re-spawns the Python bridge process. Equivalent to /serena-restart."],
    parameters: emptyToolSchema,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      getWorker(ctx).restart();
      return {
        content: [{ type: "text" as const, text: "Serena worker restarted." }],
        details: { ok: true, result: "Worker restarted" },
      };
    },
  });

  pi.registerTool({
    name: "serena_get_current_config",
    label: "Serena Current Config",
    description: "Show current project/config details.",
    promptSnippet: "Inspect project, context, modes, tools, and backend config",
    promptGuidelines: ["Check project activation, contexts, modes, or tool availability."],
    parameters: emptyToolSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const resp = await callWorkerAction(ctx, "config", params);
      if (resp.details?.ok && typeof resp.details.result === "string") {
        // Strip the "Available but not active" section — those are backend-only tools
        // not callable as Pi tools, and listing them misleads the model.
        const text = resp.details.result;
        const cutoff = text.indexOf("\nAvailable but not active tools:");
        if (cutoff >= 0) {
          resp.content[0].text = text.slice(0, cutoff);
        }
      }
      return resp;
    },
  });

  pi.registerTool({
    name: "serena_check_onboarding_performed",
    label: "Serena Check Onboarding",
    description: "Check whether onboarding memories exist.",
    promptSnippet: "Check whether project onboarding was already performed",
    promptGuidelines: ["Check before relying on project memories (or use munin for cross-project)."],
    parameters: emptyToolSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return callSerena(ctx, "check_onboarding_performed", params);
    },
  });

  pi.registerTool({
    name: "serena_onboarding",
    label: "Serena Onboarding",
    description: "Run onboarding prompt for project memories.",
    promptSnippet: "Start Serena project onboarding",
    promptGuidelines: ["Run only when onboarding hasn't been done or user asks. Use munin for cross-project memory."],
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
    description: "Find the declaration of a symbol via the language server.",
    promptSnippet: "Find a symbol's declaration",
    promptGuidelines: ["Navigate to the definition of a known symbol."],
    parameters: symbolRefSchema,
    prepareArguments: (args) => repairSymbolNameKey(args, false),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return callWorkerAction(ctx, "find_declaration", params);
    },
  });

  pi.registerTool({
    name: "serena_find_implementations",
    label: "Serena Find Implementations",
    description: "Find implementations of a symbol via the language server.",
    promptSnippet: "Find implementations of a given symbol",
    promptGuidelines: ["Locate implementations of interfaces, abstract methods, or base classes."],
    parameters: symbolRefSchema,
    prepareArguments: (args) => repairSymbolNameKey(args, false),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return callWorkerAction(ctx, "find_implementations", params);
    },
  });

  pi.registerTool({
    name: "serena_get_diagnostics_for_file",
    label: "Serena File Diagnostics",
    description: "Get LSP diagnostics (errors, warnings, hints) for a file.",
    promptSnippet: "Get diagnostics from the language server",
    promptGuidelines: ["Inspect compiler/IDE diagnostics for a specific file."],
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

    // Models whose built-in tool-handling already manages semantic misses — skip to avoid duplicate steer
    const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    if (modelKey && SKIP_SEMANTIC_MISS_MODELS.has(modelKey)) return;

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
    // Reset semantic miss counters on new session
    semanticMissCount = 0;
    lastReminderTs = 0;
    if (process.env.SERENA_EAGER_STARTUP === "1") {
      // Spawn the worker via a lightweight status request to warm the Python bridge
      getWorker(ctx).request({ action: "status", project: process.cwd(), context: DEFAULT_CONTEXT }, 30_000).catch(() => {
        // Eager startup is best-effort; failures are handled when the tool is first used
      });
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await worker?.stop();
    } catch {
      // worker stop failed — proceed with cleanup
    } finally {
      worker = undefined;
      ctx.ui.setStatus("serena", undefined);
    }
  });
}
