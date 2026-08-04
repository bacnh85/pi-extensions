import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
import {
  stripReadContamination,
  computeRetryEdit,
  nearestBlock,
  parseFailedEditIndex,
  isEditMismatchError,
  stripBom as stripBomStr,
  normalizeToLF,
} from "./lib/edit-repair.ts";
import { parsePatch, applyPatchToFiles, PatchParseError } from "./lib/apply-patch.ts";
import { stripReasoningContent, cleanLeakedContentFromMessages, appendGuidanceToLastUserMessage } from "./lib/reasoning-content.ts";
import {
  looksLikeCodePath,
  isSemanticMissToolCall,
  missedDedicatedTool,
  suggestBestSerenaCommand,
  categorizeToolError,
  detectReasoningRejection,
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
  applyPatchPreferenceGuidance,
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

// Strip read-tool contamination notices from an edit's oldText fields. Mutates
// in place and reports whether anything changed.
function decontaminateEditArgs(args: any): boolean {
  if (!isRecord(args)) return false;
  const hasOld = Array.isArray(args.edits)
    ? args.edits.some((e: any) => isRecord(e) && typeof e.oldText === "string")
    : typeof args.oldText === "string";
  if (!hasOld) return false;
  let changed = false;
  const clean = (s: string): string => {
    const r = stripReadContamination(s);
    if (r.changed) changed = true;
    return r.text;
  };
  if (Array.isArray(args.edits)) {
    for (const e of args.edits) if (isRecord(e) && typeof e.oldText === "string") e.oldText = clean(e.oldText);
  }
  if (typeof args.oldText === "string") args.oldText = clean(args.oldText);
  return changed;
}

// Locate the file, read it, and report its (BOM-stripped, LF-normalized)
// content for trim-tolerant retry. Returns null on any I/O problem.
async function readFileForRetry(filePath: string, cwd: string): Promise<string | null> {
  const abs = resolvePath(cwd, filePath);
  try {
    const buf = await readFile(abs);
    return normalizeToLF(stripBomStr(buf.toString("utf-8")));
  } catch {
    return null;
  }
}

function wrapToolDefinition(base: any, factory: (cwd: string) => any, shouldRepair: () => boolean, onRepair: (toolName: string, repairs: readonly RepairKind[]) => void): any {
  return {
    ...base,
    prepareArguments(args: unknown) {
      let prepared = base.prepareArguments ? base.prepareArguments(args as never) : args;
      if (shouldRepair()) {
        const repaired = repairToolArguments(base.name, base.parameters, prepared);
        if (repaired.repaired) { onRepair(base.name, repaired.repairs); prepared = repaired.args; }
      }
      // Strip read-tool contamination from edit oldText (always on — it's a
      // safe, deterministic fix for the documented mismatch root cause).
      if (base.name === "edit" && isRecord(prepared)) {
        if (decontaminateEditArgs(prepared)) {
          onRepair(base.name, ["read-notice-stripped"]);
        }
      }
      return base.name === "read" ? addReadDefaults(prepared) : prepared;
    },
    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const cwd = ctx?.cwd || process.cwd();
      const freshDef = factory(cwd);
      const readNote = base.name === "read" && isRecord(params) ? params.__mtReadNote : undefined;
      if (isRecord(params)) delete params.__mtReadNote;

      if (base.name !== "edit") {
        const result = await freshDef.execute(toolCallId, params, signal, onUpdate, ctx);
        return base.name === "read" ? appendReadNote(result, readNote) : result;
      }

      // edit: try once; on a match-failure, retry once with trim-tolerant
      // matching (copying actual file bytes) before giving up with a richer
      // error that shows the nearest region.
      try {
        const result = await freshDef.execute(toolCallId, params, signal, onUpdate, ctx);
        return result;
      } catch (err: any) {
        const message: string = err?.message ? String(err.message) : "";
        if (!isEditMismatchError(message)) throw err;

        const filePath = typeof params?.path === "string" ? params.path : "";
        if (!filePath) throw err;
        const fileContent = await readFileForRetry(filePath, cwd);
        if (fileContent === null) throw err;

        const edits: { oldText: string; newText: string }[] = Array.isArray(params?.edits) && params.edits.length > 0
          ? params.edits
          : (typeof params?.oldText === "string" ? [{ oldText: params.oldText, newText: params.newText }] : []);
        if (edits.length === 0) throw err;

        const retry = computeRetryEdit(fileContent, edits, parseFailedEditIndex(message));
        if (retry) {
          // Rebuild oldText from the file's real bytes (real indentation) so the
          // core exact matcher succeeds; keep the model's newText as-is.
          const fixedParams = { ...params };
          if (Array.isArray(fixedParams.edits)) fixedParams.edits = retry.fixedEdits;
          else fixedParams.oldText = retry.fixedEdits[0].oldText;
          onRepair(base.name, ["trim-match-retry"]);
          return await freshDef.execute(toolCallId, fixedParams, signal, onUpdate, ctx);
        }

        // Unresolvable: enrich the error with the nearest region so the model
        // can copy verbatim on the next turn. categorizeToolError checks
        // edit_mismatch before rate_limit/timeout for the edit tool, so a snippet
        // containing 'timeout'/'429' cannot misclassify this.
        const failing = edits[Math.min(parseFailedEditIndex(message), edits.length - 1)];
        const nearest = failing ? nearestBlock(fileContent, stripReadContamination(failing.oldText).text) : "";
        throw new Error(nearest ? `${message}\n\n${nearest}` : message);
      }
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
  const cacheStats = { input: 0, cacheRead: 0, cacheWrite: 0, hitTurns: 0, missTurns: 0 };
  // Per-turn dynamic guidance (error notes, first-tool hints, periodic
  // reinforcement) stashed here and appended to the CURRENT user message by
  // before_provider_request — never the system prompt (the cache head).
  let pendingGuidance: string | undefined;

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

  // ── apply_patch: Codex-style diff/patch tool (robust for weak models) ──
  pi.registerTool(defineTool({
    name: "apply_patch",
    label: "apply_patch",
    description: [
      "Apply a Codex-style V4D patch to edit one or more files. Emit only changed lines plus a little surrounding context (a small diff), which is easier to get right than reproducing a large verbatim block. Supported sections: `*** Add File: <path>` (only `+` lines), `*** Delete File: <path>` (no payload), `*** Update File: <path>` or `*** Update File: <old> → <new>` (rename). Inside an Update section, each hunk is preceded by a `@@` anchor line whose text is an unchanged context line, then `-` removed lines and `+` added lines. Leading-space context lines (` `) are also allowed. If the @@ anchor text is restated as the immediately-following context or removed line, the duplicate is auto-collapsed. Context+removed must match UNIQUELY in the file. Wrap the whole patch in `*** Begin Patch` ... `*** End Patch`.",
      "",
      "Example:",
      "*** Begin Patch", "*** Update File: src/foo.ts", "@@ export function foo()", "-  return 1", "+  return 2", "*** End Patch",
    ].join("\n"),
    promptSnippet: "Apply a diff/patch to edit one or more files (Codex V4D format)",
    promptGuidelines: [
      "Use apply_patch for multi-line or multi-file edits: emit a small diff (context + -/+ lines) instead of reproducing large verbatim oldText blocks.",
      "Each Update hunk needs a unique anchor: include enough unchanged context lines so the context+removed block matches exactly once in the file.",
      "If the @@ anchor repeats on the very next line (as space-context or -removed), the duplicate is auto-collapsed.",
      "For a single tiny one-line replacement, edit is fine; for anything larger or spanning multiple files, prefer apply_patch.",
    ],
    parameters: Type.Object({ patch: Type.String({ description: "The V4D patch text, wrapped in *** Begin Patch ... *** End Patch." }) }),
    renderShell: "self",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd || process.cwd();
      let parsed;
      try {
        parsed = parsePatch(params.patch);
      } catch (err) {
        const msg = err instanceof PatchParseError ? err.message : String(err);
        return { content: [{ type: "text", text: `Invalid patch: ${msg}` }], isError: true, details: undefined };
      }
      try {
        const res = await applyPatchToFiles(parsed, cwd);
        const summary = res.files.map((f) => {
          if (f.kind === "add") return `Added ${f.path}`;
          if (f.kind === "delete") return `Deleted ${f.path}`;
          return `Updated ${f.path}`;
        }).join("\n");
        const exactness = res.exact ? "" : "\nNote: some hunks matched via fuzzy (whitespace/Unicode) normalization.";
        return {
          content: [{ type: "text", text: `${summary}${exactness}` }],
          details: { diff: res.diff, files: res.files.map((f) => f.path) },
        };
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true, details: undefined };
      }
    },
  }));

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
      if (cacheStats.input > 0) {
        const total = cacheStats.input + cacheStats.cacheRead + cacheStats.cacheWrite;
        const hitPct = total > 0 ? Math.round((cacheStats.cacheRead / total) * 100) : 0;
        // hitPct = cacheRead / (input + cacheRead + cacheWrite). On DeepSeek,
        // cacheWrite is always 0 (the OpenAI-compatible API does not emit
        // cache_write_tokens), so this is cacheRead / (input + cacheRead). The
        // `input` portion is the inherently uncached growing tail (new user
        // messages + tool results); hitPct reaches ~98-99% on a warm, stable
        // session where the byte-stable prefix is fully cached.
        status.push(
          "",
          "**Prompt cache (this session):**",
          `  Input: ${cacheStats.input.toLocaleString()} · cached: ${cacheStats.cacheRead.toLocaleString()} · written: ${cacheStats.cacheWrite.toLocaleString()}`,
          `  Hit rate: ${hitPct}%  (${cacheStats.hitTurns} hit turns · ${cacheStats.missTurns} miss turns)`,
        );
      }
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
    cacheStats.input = 0;
    cacheStats.cacheRead = 0;
    cacheStats.cacheWrite = 0;
    cacheStats.hitTurns = 0;
    cacheStats.missTurns = 0;
    pendingGuidance = undefined;
    debugLog("session_start:", ctx.model?.provider, ctx.model?.id);
  });

  // ── before_agent_start: repair flag + error hints + DeepSeek guidance ──
  //
  // Cache-stability split: the system prompt is the byte-stable HEAD of the
  // prefix cache — DeepSeek (exact prefix) and GLM (Z.ai automatic
  // content-similarity cache, https://docs.z.ai/guides/capabilities/cache)
  // both key on it. Anything that varies per turn must NOT go there — a
  // changed head invalidates the cache for the whole request (measured:
  // 99% → 16% hit when a prompt-aware hint fired). Per-turn guidance (error
  // notes, first-tool hints, periodic reinforcement) is stashed in
  // `pendingGuidance` and appended to the current user message (the request
  // tail) by before_provider_request. Static content (Super Power base,
  // selection guidance, apply_patch preference) stays in the system prompt —
  // byte-identical per session, therefore cache-safe.
  pi.on("before_agent_start", (event, ctx) => {
    activeFamily = family(ctx.model);
    repairThisTurn = activeFamily !== null && repairEnabled();
    remindedThisTurn = false;

    if (!activeFamily) { debugLog("guidance: skipped (no family detected)"); return; }
    debugLog("family:", activeFamily, ctx.model?.provider, ctx.model?.id);

    const dynamicParts: string[] = [];

    // Shared error hint from previous turn (all families) — per-turn dynamic.
    if (hasErrorThisTurn && lastErrorInfo) {
      const repeatCount = errorHistory.get(lastErrorInfo.toolName)?.count ?? 0;
      let hint = lastErrorInfo.hint;
      // Provider-level rejections (e.g. reasoning-accumulation 400s) are not
      // fixed by "simpler inputs" — the escalation advice only applies to
      // tool-level errors.
      if (repeatCount >= 2 && lastErrorInfo.toolName !== "provider") hint += ` You have had ${repeatCount} failures on ${lastErrorInfo.toolName}. Try simpler inputs.`;
      dynamicParts.push(`Note: ${hint}`);
    }
    hasErrorThisTurn = false;
    lastErrorInfo = null;

    // Prompt-aware first-tool hints — ALL families (correctness, not steering).
    // Per-turn dynamic (depend on the current prompt) → user-message tail.
    const activeForHint = Array.isArray(event.systemPromptOptions?.selectedTools) && event.systemPromptOptions.selectedTools.length > 0
      ? event.systemPromptOptions.selectedTools : pi.getActiveTools();
    if (activeForHint.includes("bash")) {
      const runHint = runTaskFirstToolHint(event.prompt || "");
      if (runHint) dynamicParts.push(runHint);
      const ghHint = githubCloneFirstToolHint(event.prompt || "");
      if (ghHint) dynamicParts.push(ghHint);
    }
    if (activeForHint.includes("find")) {
      const readHint = readUncertainPathHint(event.prompt || "");
      if (readHint) dynamicParts.push(readHint);
    }

    let systemPrompt = event.systemPrompt;

    // apply_patch preference — all DeepSeek V4 (flash+pro); GLM excluded per
    // eval. Eval (2026-07-29, 15 trials, 3 targets) showed all models use edit
    // with zero edit_mismatch errors. DeepSeek keeps guidance as a safety net
    // for real-world multi-file/frontmatter edits beyond the eval's scope; GLM
    // excluded because it doesn't receive the suite of DeepSeek-specific
    // steering (Super Power, selection guidance, semantic-miss blocking) and
    // thus doesn't need the companion hint. Static per session (depends only
    // on the active-tool set).
    if (activeFamily === "deepseek-v4") {
      const patchHint = applyPatchPreferenceGuidance(activeForHint);
      if (patchHint) systemPrompt = `${systemPrompt}\n\n${patchHint}`;
    }

    // DeepSeek-only: Super Power Mode + verbose selection guidance (DeepSeek V4
    // needs the full steering block; GLM reaches 100% with prompt-aware hints alone).
    if (activeFamily === "deepseek-v4") {
      const prefixParts: string[] = [];

      if (superPowerModeEnabled()) {
        turnCounter++;
        prefixParts.push(superPowerPromptContent());
        // Periodic reinforcement is per-turn dynamic → user-message tail, not
        // the cache head (a head change every 10 turns forces a full miss).
        if (turnCounter % 10 === 0) dynamicParts.push("Super Power Mode active — maximum capability, no limits.");
      }

      if (selectionGuidanceEnabled()) {
        // Same fallback-resolved set as activeForHint (line above) so the
        // system prompt is deterministic regardless of whether the host
        // populates selectedTools — a per-turn source switch would change the
        // system-prompt bytes and break the prefix cache.
        const activeTools = activeForHint;
        if (["serena_get_symbols_overview", "serena_find_symbol", "serena_find_referencing_symbols", "serena_find_declaration", "serena_find_implementations", "obsidian", "ls", "grep", "find", "read", "edit", "bash"].some((n) => activeTools.includes(n))) {
          prefixParts.push(deepSeekSelectionGuidance(activeTools));
        }
      }

      if (prefixParts.length > 0) {
        systemPrompt = `${prefixParts.join("\n\n---\n\n")}\n\n---\n\n${systemPrompt}`;
      }
    }

    pendingGuidance = dynamicParts.length > 0 ? dynamicParts.join("\n\n---\n\n") : undefined;
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });

  // ── before_provider_request: dynamic-guidance injection + leak clean + strip ──
  pi.on("before_provider_request", (event, ctx) => {
    if (!family(ctx.model)) return;
    let payload = event.payload;
    // Append per-turn dynamic guidance to the current user message (request
    // tail) so the system-prompt cache head stays byte-identical across turns
    // (both DeepSeek exact-prefix and GLM Z.ai content-similarity caches).
    // NOT cleared here: each provider round rebuilds the payload from canonical
    // (guidance-free) context.messages, so re-appending the same guidance string
    // produces byte-identical user messages every round. Clearing after round 1
    // would make the user message exist in two byte forms within one turn
    // (guided round 1, bare round 2+) and break the prefix cache at that
    // boundary — the gap vs reasonix's >99% hit. pendingGuidance is reset at the
    // next before_agent_start.
    if (pendingGuidance) {
      const withGuidance = appendGuidanceToLastUserMessage(payload, pendingGuidance);
      if (withGuidance !== payload) { debugLog("guidance: injected into user message"); payload = withGuidance; }
    }
    payload = cleanLeakedContentFromMessages(payload, pi.getAllTools().map((t) => t.name));
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

  // ── message_end: detect reasoning-accumulation 400s (provider rejects the
  //    request once prior reasoning_content grows too large). Feeds the shared
  //    error-hint path so the NEXT turn's user message carries the actionable
  //    fix (set PI_MODEL_TOOLS_STRIP_REASONING=1). Only fires on the
  //    stopReason === "error" assistant message, so it never double-counts
  //    normal tool errors (those arrive via tool_execution_end).
  pi.on("message_end", (event, ctx) => {
    if (!family(ctx.model)) return;
    const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string };
    if (msg.role !== "assistant" || msg.stopReason !== "error") return;
    const errorText = String(msg.errorMessage ?? "");
    if (!detectReasoningRejection(errorText)) return;
    hasErrorThisTurn = true;
    lastErrorInfo = {
      category: "reasoning_rejected",
      toolName: "provider",
      hint: "The provider rejected this request, likely due to accumulated reasoning_content in prior turns (or a content-length overflow). Set PI_MODEL_TOOLS_STRIP_REASONING=1 (optionally PI_MODEL_TOOLS_REASONING_MAX_CHARS=4096) and retry.",
    };
    recordError("provider", "reasoning_rejected");
    logWarn("provider", "reasoning_rejected");
  });

  // ── agent_end ──
  pi.on("agent_end", () => { repairThisTurn = false; debugLog("agent_end: flags reset"); });

  // ── turn_end: accumulate prompt-cache usage for /model-tools-status ──
  pi.on("turn_end", (event) => {
    // turn_end fires once per assistant LLM call (agent-loop emits per round),
    // so each message.usage is a single API call — no double-counting.
    if (event.message.role !== "assistant") return;
    const usage = event.message.usage;
    if (!usage) return;
    const input = usage.input;
    const cacheRead = usage.cacheRead;
    const cacheWrite = usage.cacheWrite;
    if (input === 0 && cacheRead === 0 && cacheWrite === 0) return;
    cacheStats.input += input;
    cacheStats.cacheRead += cacheRead;
    cacheStats.cacheWrite += cacheWrite;
    // A turn with only cacheWrite (first turn of a session) is a miss: the
    // prefix was computed and written, not read back from cache.
    if (cacheRead > 0) cacheStats.hitTurns++;
    else cacheStats.missTurns++;
  });

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
      // grep/ffgrep are first-class search tools — NEVER hard-block them. Emit a
      // non-blocking steer so the model can still switch to Serena when useful.
      // Only SIMPLE bash symbol searches (semanticMiss on bash) hard-block.
      if (isGrep) {
        if (remindedThisTurn) return;
        remindedThisTurn = true;
        pi.sendMessage({ customType: "model-tools-reminder", content: `${reason} ${suggest}`, display: true }, { deliverAs: "steer" });
        return;
      }
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
