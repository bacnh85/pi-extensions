import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
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
  applyPatchEnabled,
  isSandboxed,
} from "./lib/model-detection.ts";
import { repairToolArguments } from "./lib/tool-input-repair.ts";
import {
  stripReadContamination,
  computePreflightEdits,
  editErrorEnrichment,
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

// The built-in tools whose arguments pi-model-tools repairs/intercepts. This is
// the exact scope of the former tool-wrapping (the same 7 names); other tools
// keep their own arguments untouched.
const SCHEMA_TOOL_NAMES = new Set(["read", "write", "edit", "grep", "find", "ls", "bash"]);

// Our own extension path, used to tell whether the live apply_patch is our
// registration or another extension's (see liveApplyPatchIsOurs).
const OUR_EXTENSION_PATH = fileURLToPath(import.meta.url);

// Whether a tool's sourceInfo identifies pi-model-tools' own registration.
// ponytail: substring identity match — robust across npm vs local-path installs
// without importing package.json.
function isOwnToolSource(sourceInfo?: { source?: string; path?: string } | null): boolean {
  if (!sourceInfo) return false;
  const source = sourceInfo.source ?? "";
  const path = sourceInfo.path ?? "";
  return source.includes("pi-model-tools") || path.includes("pi-model-tools") || path === OUR_EXTENSION_PATH;
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
// content for trim-tolerant pre-flight and error enrichment. Returns null on
// any I/O problem.
async function readFileForRetry(filePath: string, cwd: string): Promise<string | null> {
  const abs = resolvePath(cwd, filePath);
  try {
    const buf = await readFile(abs);
    return normalizeToLF(stripBomStr(buf.toString("utf-8")));
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
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

  // Sandbox detection is generic and load-order independent. A sandboxing
  // extension re-registers the host file tools (read/write/edit/bash) and wins
  // the host's first-registration-per-name resolution, so those tools then carry
  // a non-"builtin" sourceInfo in getAllTools(). `PI_TOOLS_ARE_SANDBOXED` is the
  // shared declared-override convention (set by the sandbox extension at module
  // top-level; all modules load before session_start, so it is visible here
  // regardless of load order). The tool snapshot is taken per session — not at
  // load — because the registry is only fully built after every extension has
  // loaded. `sandboxActive()` re-reads the env at call time, so a lazily-set
  // variable is still caught by the runtime block/hint.
  let toolSnapshot: Array<{ name: string; sourceInfo?: { source?: string; path?: string } | null }> = [];
  function sandboxActive(): boolean {
    return isSandboxed(process.env, toolSnapshot);
  }
  // The live apply_patch is ours (rather than a sandbox extension's) when the
  // tool in getAllTools() carries our package/path identity.
  function liveApplyPatchIsOurs(): boolean {
    const tool = toolSnapshot.find((t) => t.name === "apply_patch");
    return tool ? isOwnToolSource(tool.sourceInfo) : false;
  }
  // Our raw node:fs apply_patch must never run while the host tools are
  // sandboxed — if another extension owns the live apply_patch it is VM-routed
  // and safe, so only our registration is blocked.
  function applyPatchBlocked(): boolean {
    return sandboxActive() && liveApplyPatchIsOurs();
  }
  function hasRequestAccessTool(): boolean {
    return toolSnapshot.some((t) => t.name === "request_access");
  }
  // Snapshot of the built-in tools' parameter schemas, used by argument repair.
  let schemaByName = new Map<string, unknown>();

  function recordError(toolName: string, category: ErrorCategory) {
    errorHistory.set(toolName, { count: (errorHistory.get(toolName)?.count ?? 0) + 1, lastCategory: category });
    while (errorHistory.size > maxErrorHistory()) errorHistory.delete(errorHistory.keys().next().value!);
  }

  // Detection: check both ctx.model and session-captured model
  function family(model?: { provider?: string; id?: string }): ModelFamily | null {
    return detectFamily(model) ?? detectFamily(sessionModel);
  }

  function onRepair(toolName: string) {
    repairCounts.set(toolName, (repairCounts.get(toolName) ?? 0) + 1);
    debugLog("repair:", toolName, repairCounts.get(toolName));
  }

  // Apply repaired args back into event.input IN PLACE — the documented
  // tool_call contract ("mutate event.input in place to patch tool arguments
  // before execution"); the agent executes the same object reference. Returns
  // false when the repaired args cannot be represented on the input object
  // (e.g. a whole-args JSON string that repaired into an object).
  function applyRepairInPlace(input: unknown, args: unknown): boolean {
    if (!isRecord(input) || !isRecord(args)) return false;
    const target = input as Record<string, unknown>;
    const next = args as Record<string, unknown>;
    for (const key of Object.keys(target)) if (!(key in next)) delete target[key];
    for (const [key, value] of Object.entries(next)) target[key] = value;
    return true;
  }

  // ── apply_patch: Codex-style diff/patch tool (robust for weak models) ──
  // Registration is skippable via PI_MODEL_TOOLS_APPLY_PATCH=0. If another
  // extension already owns apply_patch, the host's first-registration-per-name
  // resolution drops ours silently. When ours is the live tool inside a
  // sandboxed session (it writes raw node:fs anywhere, bypassing the sandbox)
  // it is hard-blocked at runtime — see the tool_call sandbox gate.
  if (applyPatchEnabled()) {
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
        "**Sandboxing:**",
        `  Sandboxed session: ${sandboxActive() ? `yes (${process.env.PI_TOOLS_ARE_SANDBOXED ? "declared" : "auto-detected"})` : "no"}`,
        `  apply_patch: ${applyPatchEnabled() ? (applyPatchBlocked() ? "registered but blocked (sandbox)" : "on") : "off"}`,
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
    const tools = pi.getAllTools();
    toolSnapshot = tools.map((t) => ({ name: t.name, sourceInfo: t.sourceInfo }));
    schemaByName = new Map(tools.filter((t) => SCHEMA_TOOL_NAMES.has(t.name)).map((t) => [t.name, t.parameters]));
    debugLog("session_start:", ctx.model?.provider, ctx.model?.id, sandboxActive() ? "(sandboxed session: extension-owned host tools)" : "");
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
    // eval. Skipped while our apply_patch is hard-blocked in a sandboxed
    // session (a preference hint would steer the model into a blocked call).
    // When the live apply_patch is another extension's (e.g. a sandbox's
    // VM-routed tool), it is usable, so the hint still fires. Eval
    // (2026-07-29, 15 trials, 3 targets) showed all models use edit with zero
    // edit_mismatch errors. DeepSeek keeps guidance as a safety net for
    // real-world multi-file/frontmatter edits beyond the eval's scope; GLM
    // excluded because it doesn't receive the suite of DeepSeek-specific
    // steering (Super Power, selection guidance, semantic-miss blocking) and
    // thus doesn't need the companion hint. Static per session (depends only
    // on the active-tool set).
    if (activeFamily === "deepseek-v4" && !applyPatchBlocked()) {
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

  // ── tool_call: sandbox gate + dangerous guard (all families), argument repair
  //    + edit pre-flight (all families), steering (DeepSeek only) ──
  //
  // Tool interception happens HERE via the SDK's mutable-input tool_call hook
  // instead of re-registering the built-in tools (re-registering would make the
  // host resolve the name against other tool-owning extensions such as a
  // sandbox, in registration order). The hook fires before any registered tool
  // executes, so the repair/pre-flight compose with whoever owns the tool.
  pi.on("tool_call", async (event, ctx) => {
    // Sandbox gate — load-order independent and extension-agnostic: apply_patch
    // writes raw node:fs anywhere, so it must never run while a sandboxing
    // extension owns the host file tools AND the live apply_patch is ours (a
    // sandbox-owned apply_patch is VM-routed and safe).
    if (applyPatchBlocked() && event.toolName === "apply_patch") {
      return { block: true, reason: "apply_patch writes directly to the host filesystem and is disabled while a sandboxing extension owns the host file tools. Use edit instead." };
    }

    const f = family(ctx.model);

    // Dangerous command guard — all families.
    if (event.toolName === "bash" && blockDangerousEnabled()) {
      const command = isRecord(event.input) ? event.input.command : undefined;
      const danger = typeof command === "string" ? checkDangerousCommand(command) : undefined;
      if (danger) { logWarn("DANGEROUS:", danger); return { block: true, reason: `Safety: ${danger}` }; }
    }

    // Argument repair + edit pre-flight — all families (argument repair gated
    // on detected family + config; decontamination and pre-flight are safe,
    // deterministic fixes and run unconditionally).
    if (event.toolName === "edit" && isRecord(event.input)) {
      // Strip read-tool contamination from oldText (always on — it's a safe,
      // deterministic fix for the documented mismatch root cause).
      if (decontaminateEditArgs(event.input)) onRepair("edit");
      // Pre-flight indentation-drift correction: rewrite oldText to the file's
      // real bytes when there is exactly one trim-tolerant match, so the exact
      // matcher succeeds on the first (only) execution.
      if (typeof event.input.path === "string") {
        const fileContent = await readFileForRetry(event.input.path, ctx?.cwd || process.cwd());
        if (fileContent !== null) {
          const edits = Array.isArray(event.input.edits) ? event.input.edits : [];
          if (edits.length > 0) {
            const preflight = computePreflightEdits(fileContent, edits);
            if (preflight) { event.input.edits = preflight.fixedEdits; onRepair("edit"); }
          }
        }
      }
    }
    if (SCHEMA_TOOL_NAMES.has(event.toolName) && f && repairEnabled()) {
      const schema = schemaByName.get(event.toolName)
        ?? pi.getAllTools().find((t) => t.name === event.toolName)?.parameters;
      if (schema !== undefined) {
        const repaired = repairToolArguments(event.toolName, schema, event.input);
        if (repaired.repaired && applyRepairInPlace(event.input, repaired.args)) {
          onRepair(event.toolName);
        }
      }
    }

    if (event.toolName.startsWith("serena_")) { remindedThisTurn = false; return; }

    // Read-on-guessed-path — all families (correctness).
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

  // ── tool_result: enrich unresolvable edit mismatches with the nearest region
  //    (replaces the former execute-wrapper rethrow). Model-facing only — error
  //    categorization below still sees the original error text. ──
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" || !event.isError) return;
    const text = Array.isArray(event.content)
      ? event.content.map((p) => isRecord(p) && typeof p.text === "string" ? p.text : "").join("\n")
      : "";
    if (!isEditMismatchError(text)) return;
    const input = isRecord(event.input) ? event.input : undefined;
    if (!input || typeof input.path !== "string") return;
    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (edits.length === 0) return;
    const fileContent = await readFileForRetry(input.path, ctx?.cwd || process.cwd());
    if (fileContent === null) return;
    const enriched = editErrorEnrichment(fileContent, text, edits);
    if (!enriched) return;
    return { content: [{ type: "text", text: enriched }] };
  });

  // ── tool_execution_end: categorize errors ──
  pi.on("tool_execution_end", (event, ctx) => {
    if (!event.isError || !family(ctx.model)) return;
    hasErrorThisTurn = true;
    // In sandboxed sessions, permission denials are surfaced as ENOENT — pass
    // the flag so the hint steers to access-granting recovery instead of
    // "find first" (request_access is only suggested when actually present).
    const info = categorizeToolError(event.toolName, event.result, { sandboxed: sandboxActive(), hasRequestAccess: hasRequestAccessTool() });
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
}
