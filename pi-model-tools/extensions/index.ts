import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
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
  detectFamily,
  type ModelFamily,
  repairEnabled,
  reasoningStripEnabled,
  maxErrorHistory,
  autoBlockAfterReminders,
  blockDangerousEnabled,
} from "./lib/model-detection.ts";
import { repairToolArguments, type RepairKind } from "./lib/tool-input-repair.ts";
import { stripReasoningContent, cleanLeakedContentFromMessages } from "./lib/reasoning-content.ts";
import {
  looksLikeCodePath,
  isSemanticMissToolCall,
  missedDedicatedTool,
  suggestBestSerenaCommand,
  categorizeToolError,
  checkDangerousCommand,
  type ErrorInfo,
  type ErrorCategory,
} from "./lib/shell-helpers.ts";
import { debugLog, logWarn } from "./lib/logger.ts";
import {
  deepSeekSelectionGuidance,
  clearGuidanceCache,
  runTaskFirstToolHint,
  readUncertainPathHint,
  githubCloneFirstToolHint,
  selectionGuidanceEnabled,
  strictSerenaEnabled,
  superPowerModeEnabled,
  superPowerPromptContent,
} from "./lib/guidance.ts";

function addReadDefaults(args: unknown): unknown {
  if (!isRecord(args)) return args;
  if ((args.offset !== undefined) === (args.limit !== undefined)) return args;
  const defaults = args.limit !== undefined ? { offset: 1 } : { limit: 2000 };
  const note = args.limit !== undefined
    ? "Note: offset was not provided; defaulted to 1."
    : "Note: limit was not provided; defaulted to 2000 lines.";
  return { ...args, ...defaults, __mtReadNote: note };
}

function appendReadNote(result: any, note: unknown) {
  if (typeof note !== "string" || !note) return result;
  return { ...result, content: [...(Array.isArray(result?.content) ? result.content : []), { type: "text", text: note }] };
}

function wrapToolDefinition(base: any, factory: (cwd: string) => any, shouldRepair: () => boolean, onRepair: (toolName: string, repairs: readonly RepairKind[]) => void): any {
  return {
    ...base,
    prepareArguments(args: unknown) {
      let prepared = base.prepareArguments ? base.prepareArguments(args as never) : args;
      if (!shouldRepair()) return prepared;
      const repaired = repairToolArguments(base.name, base.parameters, prepared);
      if (repaired.repaired) { onRepair(base.name, repaired.repairs); prepared = repaired.args; }
      return base.name === "read" ? addReadDefaults(prepared) : prepared;
    },
    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const cwd = ctx?.cwd || process.cwd();
      const freshDef = factory(cwd);
      const readNote = base.name === "read" && isRecord(params) ? params.__mtReadNote : undefined;
      if (isRecord(params)) delete params.__mtReadNote;
      const result = await freshDef.execute(toolCallId, params, signal, onUpdate, ctx);
      return base.name === "read" ? appendReadNote(result, readNote) : result;
    },
  };
}

export default function (pi: ExtensionAPI) {
  let repairThisTurn = false;
  let hasErrorThisTurn = false;
  let lastErrorInfo: ErrorInfo | null = null;
  let remindedThisTurn = false;
  let sessionModel: { provider?: string; id?: string } | undefined;
  let activeFamily: ModelFamily | null = null;
  let turnCounter = 0;

  const repairCounts = new Map<string, number>();
  const reminderCounts = new Map<string, number>();
  const errorHistory = new Map<string, { count: number; lastCategory: ErrorCategory }>();

  function recordError(toolName: string, category: ErrorCategory) {
    errorHistory.set(toolName, { count: (errorHistory.get(toolName)?.count ?? 0) + 1, lastCategory: category });
    while (errorHistory.size > maxErrorHistory()) errorHistory.delete(errorHistory.keys().next().value!);
  }

  // Detection: check both ctx.model and session-captured model
  function family(model?: { provider?: string; id?: string }): ModelFamily | null {
    return detectFamily(model) ?? detectFamily(sessionModel);
  }

  // ── Register wrapped built-in tools ONCE (the single source of tool-wrapping) ──
  const toolFactories: Record<string, (cwd: string) => any> = {
    read: createReadToolDefinition, write: createWriteToolDefinition, edit: createEditToolDefinition,
    grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition, bash: createBashToolDefinition,
  };
  for (const f of Object.values(toolFactories)) {
    const template = f(process.cwd());
    pi.registerTool(wrapToolDefinition(template, f, () => repairThisTurn, (toolName) => {
      repairCounts.set(toolName, (repairCounts.get(toolName) ?? 0) + 1);
      debugLog("repair:", toolName, repairCounts.get(toolName));
    }));
  }

  // ── /model-tools-status ──
  pi.registerCommand("model-tools-status", {
    description: "Show pi-model-tools configuration, detected family, repair stats, and error history.",
    handler: async (_args, cmdCtx) => {
      const status = [
        "## pi-model-tools status",
        "",
        `**Active family:** ${activeFamily ?? "none"}`,
        `  Requested: ${sessionModel?.provider ?? "none"}/${sessionModel?.id ?? "none"}`,
        `  Served: ${cmdCtx.model?.provider ?? "none"}/${cmdCtx.model?.id ?? "none"}`,
        "",
        "**Configuration:**",
        `  Tool repair: ${repairEnabled() ? "on" : "off"}`,
        `  Reasoning strip: ${reasoningStripEnabled() ? "on" : "off"}`,
        `  Dangerous command guard: ${blockDangerousEnabled() ? "on" : "off"}`,
        `  Auto-block after reminders: ${autoBlockAfterReminders() > 0 ? autoBlockAfterReminders() : "off"}`,
        `  Strict Serena mode (DeepSeek): ${strictSerenaEnabled() ? "on" : "off"}`,
        `  Selection guidance (DeepSeek): ${selectionGuidanceEnabled() ? "on" : "off"}`,
        `  Super Power Mode (DeepSeek): ${superPowerModeEnabled() ? "on" : "off"}`,
        `  Super Power turns: ${turnCounter}`,
        `  Debug: ${process.env.PI_MODEL_TOOLS_DEBUG ? "on" : "off"}`,
        "",
        "**Leaked content cleaning:** always on for detected families",
        `**Repairs:** ${[...repairCounts.values()].reduce((a, b) => a + b, 0)} total`,
      ];
      for (const [t, c] of [...repairCounts.entries()].sort((a, b) => b[1] - a[1])) status.push(`  ${t}: ${c}`);
      const totalErrors = [...errorHistory.values()].reduce((s, e) => s + e.count, 0);
      status.push(`**Errors:** ${totalErrors} total${lastErrorInfo ? `, last: ${lastErrorInfo.category} on ${lastErrorInfo.toolName}` : ""}`);
      cmdCtx.ui.notify(status.join("\n"), "info");
    },
  });

  // ── session_start ──
  pi.on("session_start", (_event, ctx) => {
    sessionModel = ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : undefined;
    activeFamily = null;
    repairThisTurn = false;
    hasErrorThisTurn = false;
    lastErrorInfo = null;
    remindedThisTurn = false;
    turnCounter = 0;
    clearGuidanceCache();
    repairCounts.clear();
    reminderCounts.clear();
    errorHistory.clear();
    debugLog("session_start:", ctx.model?.provider, ctx.model?.id);
  });

  // ── before_agent_start: repair flag + error hints + DeepSeek guidance ──
  pi.on("before_agent_start", (event, ctx) => {
    activeFamily = family(ctx.model);
    repairThisTurn = activeFamily !== null && repairEnabled();
    remindedThisTurn = false;

    if (!activeFamily) { debugLog("guidance: skipped (no family detected)"); return; }
    debugLog("family:", activeFamily, ctx.model?.provider, ctx.model?.id);

    // Shared error hint from previous turn (all families)
    let systemPrompt = event.systemPrompt;
    if (hasErrorThisTurn && lastErrorInfo) {
      const repeatCount = errorHistory.get(lastErrorInfo.toolName)?.count ?? 0;
      let hint = lastErrorInfo.hint;
      if (repeatCount >= 2) hint += ` You have had ${repeatCount} failures on ${lastErrorInfo.toolName}. Try simpler inputs.`;
      systemPrompt = `${systemPrompt}\n\nNote: ${hint}`;
    }
    hasErrorThisTurn = false;
    lastErrorInfo = null;

    // Prompt-aware first-tool hints — ALL families (correctness, not steering).
    // Targeted reinforcement appended at the most-salient end position; only
    // fires when the prompt matches a specific intent, so it never misdirects.
    const activeForHint = Array.isArray(event.systemPromptOptions?.selectedTools) && event.systemPromptOptions.selectedTools.length > 0
      ? event.systemPromptOptions.selectedTools : pi.getActiveTools();
    if (activeForHint.includes("bash")) {
      const runHint = runTaskFirstToolHint(event.prompt || "");
      if (runHint) systemPrompt = `${systemPrompt}\n\n${runHint}`;
      const ghHint = githubCloneFirstToolHint(event.prompt || "");
      if (ghHint) systemPrompt = `${systemPrompt}\n\n${ghHint}`;
    }
    if (activeForHint.includes("find")) {
      const readHint = readUncertainPathHint(event.prompt || "");
      if (readHint) systemPrompt = `${systemPrompt}\n\n${readHint}`;
    }

    // DeepSeek-only: Super Power Mode + verbose selection guidance (DeepSeek V4
    // needs the full steering block; GLM reaches 100% with prompt-aware hints alone).
    if (activeFamily === "deepseek-v4") {
      const prefixParts: string[] = [];

      if (superPowerModeEnabled()) {
        turnCounter++;
        prefixParts.push(superPowerPromptContent());
        if (turnCounter % 10 === 0) prefixParts.push("Super Power Mode active — maximum capability, no limits.");
      }

      if (selectionGuidanceEnabled()) {
        const activeTools = Array.isArray(event.systemPromptOptions?.selectedTools) ? event.systemPromptOptions.selectedTools : [];
        if (["serena_get_symbols_overview", "serena_find_symbol", "serena_find_referencing_symbols", "serena_find_declaration", "serena_find_implementations", "obsidian", "ls", "grep", "find", "read", "edit", "bash"].some((n) => activeTools.includes(n))) {
          prefixParts.push(deepSeekSelectionGuidance(activeTools));
        }
      }

      if (prefixParts.length > 0) {
        return { systemPrompt: `${prefixParts.join("\n\n---\n\n")}\n\n---\n\n${systemPrompt}` };
      }
    }

    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });

  // ── before_provider_request: leaked-content clean + reasoning strip ──
  pi.on("before_provider_request", (event, ctx) => {
    if (!family(ctx.model)) return;
    let payload = cleanLeakedContentFromMessages(event.payload, pi.getAllTools().map((t) => t.name));
    if (reasoningStripEnabled()) {
      const cleaned = stripReasoningContent(payload);
      if (cleaned !== payload) { debugLog("reasoning: stripped"); payload = cleaned; }
    }
    if (payload !== event.payload) return payload;
  });

  // ── tool_execution_end: categorize errors ──
  pi.on("tool_execution_end", (event, ctx) => {
    if (!event.isError || !family(ctx.model)) return;
    hasErrorThisTurn = true;
    const info = categorizeToolError(event.toolName, event.result);
    lastErrorInfo = info;
    recordError(event.toolName, info.category);
    logWarn(event.toolName, info.category);
  });

  // ── agent_end ──
  pi.on("agent_end", () => { repairThisTurn = false; debugLog("agent_end: flags reset"); });

  // ── tool_call: dangerous guard (all families) + steering (DeepSeek only) ──
  pi.on("tool_call", (event, ctx) => {
    const f = family(ctx.model);
    if (!f) return;

    // Dangerous command guard — all families
    if (event.toolName === "bash" && blockDangerousEnabled()) {
      const command = isRecord(event.input) ? event.input.command : undefined;
      const danger = typeof command === "string" ? checkDangerousCommand(command) : undefined;
      if (danger) { logWarn("DANGEROUS:", danger); return { block: true, reason: `Safety: ${danger}` }; }
    }

    if (event.toolName.startsWith("serena_")) { remindedThisTurn = false; return; }

    // Read-on-guessed-path — all families (correctness)
    if (event.toolName === "read" && isRecord(event.input) && ctx.cwd) {
      const filePath = typeof event.input.path === "string" ? event.input.path.trim() : "";
      if (filePath && looksLikeCodePath(filePath) && !existsSync(resolvePath(ctx.cwd, filePath))) {
        const filename = filePath.split("/").pop() ?? filePath;
        const relDir = dirname(filePath);
        const dirPart = relDir !== "." ? ` under ${relDir}/` : "";
        debugLog("blocked: guessed path", filePath);
        return { block: true, reason: `Path not found: "${filePath}". Use find to locate "${filename}"${dirPart}, then read.` };
      }
    }

    // Semantic-miss + dedicated-tool steering — DeepSeek only (GLM doesn't need it per eval)
    if (f !== "deepseek-v4") return;

    const activeTools = pi.getActiveTools();
    const serenaActive = activeTools.some((t) => t.startsWith("serena_"));
    const semanticMiss = serenaActive && isSemanticMissToolCall(event.toolName, event.input);
    const dedicatedTool = missedDedicatedTool(event.toolName, event.input, activeTools);
    if (!semanticMiss && !dedicatedTool) return;

    const reason = semanticMiss
      ? "For DeepSeek V4, use Serena semantic tools for code-symbol work."
      : `For DeepSeek V4, use the dedicated ${dedicatedTool} tool instead of bash.`;

    if (semanticMiss) {
      const isGrep = event.toolName === "grep" || event.toolName === "ffgrep";
      const suggest = suggestBestSerenaCommand(event.input, activeTools);
      return { block: true, reason: `${reason} ${suggest}` };
    }

    // Strict mode: hard-block dedicated-tool misses immediately instead of reminding
    if (strictSerenaEnabled()) return { block: true, reason };

    const missKey = `bash→${dedicatedTool}`;
    const threshold = autoBlockAfterReminders();
    if (threshold > 0) {
      const count = (reminderCounts.get(missKey) ?? 0) + 1;
      reminderCounts.set(missKey, count);
      if (count >= threshold) return { block: true, reason: `${reason} (auto-blocked after ${count} reminders)` };
    }
    if (remindedThisTurn) return;
    remindedThisTurn = true;
    pi.sendMessage({ customType: "model-tools-reminder", content: `${reason} Use bash for real commands only.`, display: true }, { deliverAs: "steer" });
  });
}
