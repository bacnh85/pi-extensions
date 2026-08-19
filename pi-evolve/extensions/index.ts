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
// v0.3: per-{tool:category} error counts for repeat escalation (Layer 3).
const errorHistory = new Map<string, number>();

// v0.3.1: per-turn injection latency fix — TTL cache + timeout bound. Learnings
// are stable within a session; the old code re-ran a Munin semantic search
// (~1.9s live) on EVERY before_agent_start, blocking the message send. Cache is
// per-cwd; empty digests are cached too, so a dead Munin costs at most one
// timeout per window instead of one per turn. Timeout results get a short TTL
// so a recovered Munin is retried soon (not suppressed for the full window).
let injectCache: { key: string; digest: string; ts: number; ttl: number } | null = null;
// In-flight background seed promise (for deterministic tests; null when idle).
let seedInFlight: Promise<void> | null = null;
const INJECT_TTL_MS = 5 * 60 * 1000; // 5 min — non-timeout results (incl. genuine empties)
const INJECT_EMPTY_TTL_MS = 30 * 1000; // 30s — timeout results, self-healing retry
// Fresh budget for the recent fallback after the similar search burned the
// shared deadline — a slow search must not starve the recent fallback.
// ponytail: 1s per the reviewer's suggestion; worst case dead-Munin turn is
// 3s + 1s, once per TTL window (30s for timeouts).
const RECENT_FALLBACK_BUDGET_MS = 1000;
// Matches RECALL_TIMEOUT_MS: real Munin semantic search measures ~1.9s live,
// so 3s gives headroom. Test-overridable via _setInjectTimeoutForTest.
let injectTimeoutMs = 3000;

// v0.3 Layer 4: plan-mode deferred hint for write-recommending categories.
const PLAN_DEFER_HINT =
  "Plan mode active: edit is blocked. Note the exact oldText + surrounding context lines now; apply the edit when you exit plan mode.";

/** Test helper: reset the module-level buffer + counters. Exported for tests only. */
export function _resetForTest(): void {
  buffer.clear();
  sealedSnapshot = [];
  lastSealTs = null;
  learningsWritten = 0;
  injectCache = null;
  seedInFlight = null;
  errorHistory.clear();
}

/** Test helper: override the injection fetch timeout (default 3000ms). Exported for tests only. */
export function _setInjectTimeoutForTest(ms: number): void {
  injectTimeoutMs = ms;
}

/** Test helper: await the in-flight background cache seed (fire-and-forget makes
 *  the first before_agent_start return before Munin resolves). Exported for tests only. */
export function _seedInFlightForTest(): Promise<void> | null {
  return seedInFlight;
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
        details: { snapshot, store: activeBackend({}, resolveStoreConfig(settings), ctx.cwd, ctx?.isProjectTrusted?.() === true) },
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
        const trusted = ctx?.isProjectTrusted?.() === true;
        stored = await writeLearning(learning, {}, storeCfg, ctx.cwd, trusted);
        backend = activeBackend({}, storeCfg, ctx.cwd, trusted);
      } catch (err) {
        if (storeCfg.store === "auto") {
          // Fall back to local JSONL.
          try {
            const localCfg = { ...storeCfg, store: "local" as const };
            stored = await writeLearning(learning, {}, localCfg, ctx.cwd, ctx?.isProjectTrusted?.() === true);
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
      // Invalidate the injection cache: the just-saved learning must be
      // eligible on the next before_agent_start, not after TTL expiry.
      injectCache = null;
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
      const backend = activeBackend({}, resolveStoreConfig(settings), ctx.cwd, ctx?.isProjectTrusted?.() === true);
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
      errorHistory.clear();
      // Fresh injection cache per session (same-cwd resume/fork must not reuse
      // a previous session's digest; matches _resetForTest).
      injectCache = null;
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

  // Capture: tool result (error classification + v0.3 triage: inline hint,
  // stored-fix recall, repeat escalation, plan-mode deferral).
  pi.on("tool_result", async (event: any, ctx: any) => {
    const settings = readEvolveSettings(ctx?.cwd);
    if (!settings.enabled || !settings.errorTriage) {
      // Triage off: still record basic ok/error status (no hint/recall).
      const tool0 = String(event?.toolName ?? "");
      if (tool0) buffer.markResult(tool0, Boolean(event?.isError), undefined, event?.toolCallId);
      return;
    }
    const tool = String(event?.toolName ?? "");
    if (!tool) return;
    const isError = Boolean(event?.isError);
    if (!isError) {
      // Success: mark ok (synchronous) — no hint/recall needed.
      buffer.markResult(tool, false, undefined, event?.toolCallId);
      return;
    }
    const text = extractText(event?.content);
    const info = categorizeError(tool, text);
    if (!info) {
      // Unclassifiable/empty content: still record the error in the buffer so
      // agent_end's recovery detection + errorCount stay correct.
      buffer.markResult(tool, true, undefined, event?.toolCallId);
      return;
    }
    // Layer 4: plan-mode aware hint — defer write-recommending categories.
    const inPlan = pi.getFlag?.("plan") === true;
    const hint = inPlan && info.category === "edit_mismatch" ? PLAN_DEFER_HINT : info.hint;
    // Layer 3: repeat escalation (per {tool:category} count).
    const histKey = `${tool}:${info.category}`;
    const count = (errorHistory.get(histKey) ?? 0) + 1;
    errorHistory.set(histKey, count);
    let hintText = hint;
    if (count >= 2 && info.category !== "edit_mismatch") {
      hintText += ` You've hit ${info.category} on ${tool} ${count}× — try a different approach.`;
    }
    // Single markResult with the FINAL hint (escalation/plan-mode aware).
    buffer.markResult(tool, true, info.category, event?.toolCallId, hintText);
    // Build the augmented content: original content first (array OR string), then the hint.
    const parts = Array.isArray(event?.content)
      ? [...event.content]
      : typeof event?.content === "string" && event.content
        ? [{ type: "text" as const, text: event.content }]
        : [];
    const hintPart = { type: "text" as const, text: `\n💡 ${hintText}` };
    // Layer 2: stored-fix recall (best-effort, bounded by a race so it can't
    // block the tool result forever). Live Munin semantic search measures
    // ~1.8s (verified 2026-08-11), so the budget must exceed that — 3s gives
    // headroom; the static hint still ships even if recall times out.
    const RECALL_TIMEOUT_MS = 3000;
    let recallPart: { type: "text"; text: string } | null = null;
    if (settings.recallStoredFixes) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const storeCfg = resolveStoreConfig(settings);
        const timeout = new Promise<Awaited<ReturnType<typeof searchLearnings>>>((resolve) => {
          timer = setTimeout(() => resolve([]), RECALL_TIMEOUT_MS);
        });
        const found = await Promise.race([searchLearnings(text, 1, {}, storeCfg, ctx.cwd, ctx?.isProjectTrusted?.() === true), timeout]);
        if (found.length > 0 && found[0]?.lesson) {
          // Sanitize like the injection path (inject.ts sanitize): single-line,
          // strip heading markers + code fences, so a stored lesson can't inject
          // directives into the tool-result context.
          const safeLesson = found[0].lesson
            .replace(/[\r\n]+/g, " ")
            .replace(/(^|\s)#{1,6}(?=\s)/g, "$1")
            .replace(/^>\s?/g, "")
            .replace(/```/g, "")
            .replace(/\s+/g, " ")
            .trim();
          if (safeLesson) {
            recallPart = { type: "text", text: `\n📚 Prior fix for similar issue: ${safeLesson}` };
          }
        }
      } catch {
        // recall is best-effort; static hint still ships
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return {
      content: [...parts, hintPart, ...(recallPart ? [recallPart] : [])],
      // Merge triage metadata into the original details rather than replacing it.
      details: {
        ...(event?.details && typeof event.details === "object" ? event.details : {}),
        errorCategory: info.category,
        hint: hintText,
        repeatCount: count,
      },
    };
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
    // extract a recovery learning. Best-effort; never throws. Layer 4: in plan
    // mode, defer saving (evolve_save is blocked there).
    if (settings.autoReflect && countRecoveries(sealedSnapshot) > 0) {
      try {
        const inPlan = pi.getFlag?.("plan") === true;
        ctx?.ui?.notify?.(
          inPlan
            ? "pi-evolve: recovery pattern detected — consider evolve_reflect; save learnings after exiting plan mode."
            : "pi-evolve: recovery pattern detected — consider evolve_reflect to capture a learning.",
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
        // Cache key must cover the settings that shape the digest, so a
        // mid-session config edit (injectMode/maxInject/store) misses the
        // cache instead of serving a stale digest (reviewer finding).
        const cacheKey = JSON.stringify({
          cwd: ctx?.cwd ?? "",
          injectMode: settings.injectMode,
          maxInject: settings.maxInject,
          store: settings.store,
        });
        const cached = injectCache;
        let digest = "";
        if (cached !== null && cached.key === cacheKey && Date.now() - cached.ts < cached.ttl) {
          // TTL hit: no Munin round-trip this turn.
          digest = cached.digest;
        } else {
          // Cache miss: seed the cache in the BACKGROUND so the first message
          // never blocks on a Munin round-trip (~1.6s). Injection is
          // best-effort context ("apply when its trigger matches") — the agent
          // rarely needs learnings before it has done any work — so the digest
          // simply lands in the cache for message 2 onward.
          seedInFlight = seedInjectCache(cacheKey, settings, String(event?.prompt ?? ""), ctx.cwd, ctx?.isProjectTrusted?.() === true)
            .catch(() => { /* best-effort */ })
            .finally(() => { seedInFlight = null; });
        }
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

/** Race a promise against a fresh timeout budget. Used for the recent fallback
 *  after the shared deadline was burned by a slow similar search. */
async function raceWithBudget<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve([] as T);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Bounded fetch of learnings + cache write. Runs in the background on a cache
 *  miss so the first message never blocks on Munin (the digest lands in the
 *  cache for message 2 onward — injection is best-effort context). */
async function seedInjectCache(
  cacheKey: string,
  settings: ReturnType<typeof readEvolveSettings>,
  promptText: string,
  cwd: string,
  trusted = false,
): Promise<void> {
  const storeCfg = resolveStoreConfig(settings);
  const wantSimilar = settings.injectMode === "similar" || settings.injectMode === "both";
  const wantRecent = settings.injectMode === "recent" || settings.injectMode === "both";
  let learnings: Awaited<ReturnType<typeof readRecentLearnings>> = [];
  let recentRan = false;
  let searchTimedOut = false;
  let recentTimedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Awaited<ReturnType<typeof readRecentLearnings>>>((resolve) => {
    timer = setTimeout(() => {
      searchTimedOut = true;
      resolve([]);
    }, injectTimeoutMs);
  });
  try {
    if (wantSimilar && promptText.trim()) {
      learnings = await Promise.race([
        searchLearnings(promptText, settings.maxInject, {}, storeCfg, cwd, trusted),
        deadline,
      ]);
    }
    if (learnings.length === 0 && (wantRecent || settings.injectMode === "similar")) {
      recentRan = true;
      const recentPromise = readRecentLearnings(settings.maxInject, {}, storeCfg, cwd, trusted);
      if (searchTimedOut) {
        learnings = await raceWithBudget(recentPromise, RECENT_FALLBACK_BUDGET_MS, () => {
          recentTimedOut = true;
        });
      } else {
        learnings = await Promise.race([recentPromise, deadline]);
        if (searchTimedOut) recentTimedOut = true;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  const digest = buildInjectDigest(learnings, settings.maxInject);
  const timedOut = recentRan ? recentTimedOut : searchTimedOut;
  injectCache = {
    key: cacheKey,
    digest,
    ts: Date.now(),
    ttl: timedOut ? INJECT_EMPTY_TTL_MS : INJECT_TTL_MS,
  };
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
      const hint = e.hint ? ` — ${e.hint.slice(0, 160)}` : "";
      const usage = e.usage ? ` [in:${e.usage.input ?? "?"} out:${e.usage.output ?? "?"}]` : "";
      return `${i + 1}. ${e.tool}${status}${usage}: ${e.inputDigest}${hint}`;
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
