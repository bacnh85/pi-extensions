import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  TrajectoryBuffer,
  categorizeError,
  digestInput,
  type TrajectoryEntry,
} from "./lib/buffer";
import {
  type Learning,
  resolveStoreConfig,
  writeLearning,
  readRecentLearnings,
  searchLearnings,
  activeBackend,
} from "./lib/store";
import { buildInjectDigest } from "./lib/inject";
import { readEvolveSettings } from "./lib/config";

// ponytail: one buffer per process. Reset on session_start (new/resume/fork)
// so cross-session digests don't leak. Bounded by bufferCap within a session.
const buffer = new TrajectoryBuffer();
let sealedSnapshot: TrajectoryEntry[] = [];
let lastSealTs: number | null = null;
let learningsWritten = 0;

/** Test helper: reset the module-level buffer + counters. Exported for tests only. */
export function _resetForTest(): void {
  buffer.clear();
  sealedSnapshot = [];
  lastSealTs = null;
  learningsWritten = 0;
}

const INJECT_HEADER = `## pi-evolve: trajectory self-learning

This session has automatic trajectory capture enabled. Tool calls and outcomes
are recorded in a short-lived buffer. When a task reveals a transferable lesson
(fixing a bug, recovering from an error, discovering a non-obvious workflow),
call \`evolve_reflect\` to extract structured learnings from the recent
trajectory, then \`evolve_save\` to persist them. Past learnings are injected
above as "Recent Learnings" when available — apply one only if its trigger
matches the current work.`;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function evolveExtension(pi: ExtensionAPI) {
  // ====================================================================
  // Tools
  // ====================================================================

  pi.registerTool({
    name: "evolve_reflect",
    label: "Evolve Reflect",
    description:
      "Extract transferable learnings from the recent live trajectory. Returns the current trajectory snapshot + a prompt skeleton for the model to produce 1-3 structured learnings (strategy/recovery/optimization). Call after fixing a bug, recovering from an error, or completing a multi-step task.",
    promptSnippet: "Reflect on recent trajectory to extract learnings",
    promptGuidelines: [
      "Use evolve_reflect after fixing a bug, recovering from an error, or completing a multi-step task — when the trajectory contains a transferable lesson.",
      "Skip evolve_reflect for trivial one-shot work with no recovery or non-obvious insight.",
      "evolve_reflect returns the current trajectory snapshot; you produce the learnings and persist them via evolve_save.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const settings = readEvolveSettings(ctx.cwd);
      if (!settings.enabled) {
        return { content: [{ type: "text" as const, text: "pi-evolve is disabled (evolve.enabled=false)." }] };
      }
      const snapshot = buffer.snapshot();
      if (snapshot.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "Trajectory buffer is empty — nothing to reflect on yet." },
          ],
        };
      }
      const errors = snapshot.filter((e) => e.status === "error");
      const recoveries = countRecoveries(snapshot);
      const digest = renderSnapshotForModel(snapshot);
      const skeleton = REFLECT_SKELETON(errors.length, recoveries);
      return {
        content: [
          {
            type: "text" as const,
            text: `Recent trajectory (${snapshot.length} entries, ${errors.length} errors, ${recoveries} recoveries):\n\n${digest}\n\n---\n${skeleton}`,
          },
        ],
        details: { snapshot, store: activeBackend({}, resolveStoreConfig(settings), ctx.cwd) },
      };
    },
  });

  pi.registerTool({
    name: "evolve_save",
    label: "Evolve Save Learning",
    description:
      "Persist a structured learning extracted via evolve_reflect. Stored to Munin (if configured) or local .pi/evolve/learnings.jsonl with tag type:learning.",
    promptSnippet: "Save a learning to long-term store",
    promptGuidelines: [
      "Use evolve_save to persist each learning produced from an evolve_reflect call.",
      "Provide kind (strategy|recovery|optimization), a short trigger (the symptom/task context), the lesson, and optional anchors (file paths/symbols).",
      "Do not use evolve_save for secrets, raw logs, or trivial observations.",
    ],
    parameters: Type.Object({
      kind: Type.Union(
        [
          Type.Literal("strategy"),
          Type.Literal("recovery"),
          Type.Literal("optimization"),
        ],
        { description: "strategy = successful pattern; recovery = error→fix; optimization = inefficient→better." },
      ),
      trigger: Type.String({ description: "Short description of the task/symptom context this applies to." }),
      lesson: Type.String({ description: "The transferable takeaway, one or two sentences." }),
      anchors: Type.Optional(
        Type.Array(Type.String(), { description: "Optional file paths, symbols, or commands." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const settings = readEvolveSettings(ctx.cwd);
      if (!settings.enabled) {
        return { content: [{ type: "text" as const, text: "pi-evolve is disabled." }] };
      }
      const { kind, trigger, lesson, anchors } = params as {
        kind: Learning["kind"];
        trigger: string;
        lesson: string;
        anchors?: string[];
      };
      if (!trigger?.trim() || !lesson?.trim()) {
        return {
          content: [
            { type: "text" as const, text: "Both trigger and lesson are required." },
          ],
          details: { error: true },
        };
      }
      const learning: Learning = {
        kind,
        trigger: trigger.trim(),
        lesson: lesson.trim(),
        anchors: anchors?.filter(Boolean),
      };
      const storeCfg = resolveStoreConfig(settings);
      // Harden: a Munin outage must not crash the tool. Fall back to local on auto, else structured error.
      let stored: { key: string; title: string; storedAt: string };
      let backend: "munin" | "local";
      try {
        stored = await writeLearning(learning, {}, storeCfg, ctx.cwd);
        backend = activeBackend({}, storeCfg, ctx.cwd);
      } catch (err) {
        if (storeCfg.store === "auto") {
          // Fall back to local JSONL.
          try {
            const localCfg = { ...storeCfg, store: "local" as const };
            stored = await writeLearning(learning, {}, localCfg, ctx.cwd);
            backend = "local";
          } catch (localErr) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Learning save failed (munin + local fallback): ${errMsg(localErr)}`,
                },
              ],
              details: { error: true },
            };
          }
        } else {
          return {
            content: [
              { type: "text" as const, text: `Learning save failed: ${errMsg(err)}` },
            ],
            details: { error: true },
          };
        }
      }
      learningsWritten++;
      return {
        content: [
          {
            type: "text" as const,
            text: `Saved [${kind}] learning \`${stored.key}\` to ${backend}.\nTrigger: ${trigger}\nLesson: ${lesson}`,
          },
        ],
        details: { stored, backend },
      };
    },
  });

  // ====================================================================
  // Command
  // ====================================================================

  pi.registerCommand("evolve", {
    description: "Show pi-evolve status: buffer, last seal, learnings written, store backend.",
    handler: async (_args, ctx) => {
      const settings = readEvolveSettings(ctx.cwd);
      const backend = activeBackend({}, resolveStoreConfig(settings), ctx.cwd);
      const status = settings.enabled ? "enabled" : "disabled";
      const seal = lastSealTs ? new Date(lastSealTs).toISOString() : "never";
      ctx.ui.notify(
        `pi-evolve ${status}:\n  Buffer: ${buffer.size}/${settings.bufferCap} entries (${buffer.errorCount} errors)\n  Last seal: ${seal}\n  Learnings written this session: ${learningsWritten}\n  Auto-inject: ${settings.autoInject ? "on" : "off"} (max ${settings.maxInject})\n  Store: ${backend}`,
        "info",
      );
    },
  });

  // ====================================================================
  // Event hooks — capture + inject
  // ====================================================================

  // Reset on new/resume/fork session so cross-session digests don't leak.
  pi.on("session_start", (event: any) => {
    const reason = String(event?.reason ?? "");
    if (reason === "new" || reason === "resume" || reason === "fork" || reason === "startup" || reason === "") {
      buffer.clear();
      sealedSnapshot = [];
      lastSealTs = null;
      learningsWritten = 0;
    }
  });

  // Capture: tool call
  pi.on("tool_call", (event: any, ctx: any) => {
    const settings = readEvolveSettings(ctx?.cwd);
    if (!settings.enabled) return;
    const tool = String(event?.toolName ?? "unknown");
    const inputDigest = digestInput(event?.input, 200);
    buffer.record(tool, inputDigest, event?.toolCallId);
  });

  // Capture: tool result (error classification)
  pi.on("tool_result", (event: any, ctx: any) => {
    const settings = readEvolveSettings(ctx?.cwd);
    if (!settings.enabled) return;
    const tool = String(event?.toolName ?? "");
    if (!tool) return;
    const isError = Boolean(event?.isError);
    const errorCategory = isError ? categorizeError(extractText(event?.content)) : undefined;
    buffer.markResult(tool, isError, errorCategory, event?.toolCallId);
  });

  // Capture: usage per turn
  pi.on("turn_end", (event: any, ctx: any) => {
    const settings = readEvolveSettings(ctx?.cwd);
    if (!settings.enabled) return;
    const usage = event?.message?.usage;
    if (usage && typeof usage === "object") {
      buffer.recordUsage({
        input: typeof usage.input === "number" ? usage.input : undefined,
        output: typeof usage.output === "number" ? usage.output : undefined,
      });
    }
  });

  // Capture: seal at agent end
  pi.on("agent_end", (_event: any, ctx: any) => {
    const settings = readEvolveSettings(ctx?.cwd);
    if (!settings.enabled) return;
    sealedSnapshot = buffer.snapshot();
    lastSealTs = Date.now();
    // v0.2: auto-reflect nudge — when the sealed buffer shows a recovery
    // (error → later ok on the same tool), surface a hint so the model can
    // extract a recovery learning. Best-effort; never throws.
    if (settings.autoReflect && countRecoveries(sealedSnapshot) > 0) {
      try {
        ctx?.ui?.notify?.(
          "pi-evolve: recovery pattern detected — consider evolve_reflect to capture a learning.",
          "info",
        );
      } catch { /* best-effort */ }
    }
  });

  // Inject: recent/similar learnings digest at session start
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const settings = readEvolveSettings(ctx?.cwd);
    if (!settings.enabled) return;
    // Always add the evolve header so the agent knows reflect/save exist.
    let prompt = `${INJECT_HEADER}\n\n---\n\n`;
    if (settings.autoInject) {
      try {
        const storeCfg = resolveStoreConfig(settings);
        const promptText = String(event?.prompt ?? "");
        const wantSimilar = settings.injectMode === "similar" || settings.injectMode === "both";
        const wantRecent = settings.injectMode === "recent" || settings.injectMode === "both";
        let learnings: Awaited<ReturnType<typeof readRecentLearnings>> = [];
        // Similarity-keyed first (v0.2): search learnings by the user prompt.
        if (wantSimilar && promptText.trim()) {
          learnings = await searchLearnings(promptText, settings.maxInject, {}, storeCfg, ctx.cwd);
        }
        // Fall back to recent when similar returned nothing (any mode), or when
        // the mode is recent-only (no similar attempt).
        if (learnings.length === 0 && (wantRecent || settings.injectMode === "similar")) {
          learnings = await readRecentLearnings(settings.maxInject, {}, storeCfg, ctx.cwd);
        }
        const digest = buildInjectDigest(learnings, settings.maxInject);
        if (digest) prompt = `${digest}\n\n---\n\n${prompt}`;
      } catch {
        // injection is best-effort; header still goes through
      }
    }
    return { systemPrompt: `${prompt}${event.systemPrompt}` };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n");
  }
  if (typeof content === "object" && content !== null) {
    return JSON.stringify(content);
  }
  return "";
}

/** Count recovery patterns: each error followed by a later ok of the same tool. */
function countRecoveries(entries: TrajectoryEntry[]): number {
  let recoveries = 0;
  const erroredTools = new Set<string>();
  for (const e of entries) {
    if (e.status === "error") erroredTools.add(e.tool);
    else if (e.status === "ok" && erroredTools.has(e.tool)) {
      // Count every error→ok transition; the errored flag stays set until an
      // ok clears it, so repeated error→ok cycles for the same tool each count.
      recoveries++;
      erroredTools.delete(e.tool);
    }
  }
  return recoveries;
}

function renderSnapshotForModel(entries: TrajectoryEntry[]): string {
  return entries
    .slice(-40) // keep the most recent 40 for the model prompt
    .map((e, i) => {
      const status = e.status ? ` → ${e.status}${e.errorCategory ? `(${e.errorCategory})` : ""}` : "";
      const usage = e.usage ? ` [in:${e.usage.input ?? "?"} out:${e.usage.output ?? "?"}]` : "";
      return `${i + 1}. ${e.tool}${status}${usage}: ${e.inputDigest}`;
    })
    .join("\n");
}

const REFLECT_SKELETON = (errors: number, recoveries: number) =>
  `Based on the trajectory above, extract 0-3 learnings. ${errors > 0 ? `There ${errors === 1 ? "was 1 error" : `were ${errors} errors`} (${recoveries} recovered).` : "Focus on successful strategies or optimization opportunities."}

For each learning, emit a JSON object on its own line, then call \`evolve_save\` for each:
\`\`\`json
{"kind":"strategy|recovery|optimization","trigger":"<task/symptom context>","lesson":"<transferable takeaway>","anchors":["path/symbol"]}
\`\`\`

- **strategy**: a successful pattern worth repeating.
- **recovery**: how an error was diagnosed and fixed (anchor the root cause).
- **optimization**: an inefficient path and the better approach.

Only extract a learning if it is genuinely transferable to a future task. Quality over quantity — zero learnings is a valid outcome.`;
