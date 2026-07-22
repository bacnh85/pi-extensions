import { buildSessionContext, convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { runIsolated } from "../lib/isolated-model";
import { chooseModel, exactModel, modelRef, modelSearchText } from "../lib/model-picker";

/** Default hard turn cap for a goal loop (Claude recommends bounding in the condition too). */
export const DEFAULT_GOAL_MAX_TURNS = 50;
const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);
const GOAL_ENTRY = "pi-plan-goal";
const GOAL_CONTEXT_BUDGET = 8_192; // ~2K tokens of recent surfaced context for the evaluator

const EVALUATOR_SYSTEM = `You are a goal-completion evaluator for an autonomous coding agent. Decide whether the GOAL CONDITION has been met based ONLY on what the agent has surfaced in the conversation (its messages and tool results). You cannot run commands, read files, or use tools yourself.

Respond with STRICT JSON only, no prose before or after:
{"met": <true|false>, "reason": "<one short sentence>"}

Rules:
- Return "met": true ONLY when the conversation shows concrete evidence the condition holds (a passing test run, a build exit code, a file count, an empty queue, etc.). A bare claim of "done" without evidence is NOT met.
- Return "met": false when work remains or evidence is missing; "reason" names what still needs to happen.
- Keep "reason" under 200 characters.`;

export interface GoalState {
  condition: string;
  active: boolean;
  paused: boolean;
  startedAt: number;
  turns: number;
  lastReason?: string;
  maxTurns: number;
}

/** Goal dependencies owned by index.ts (shared state, persistence, sending). */
export interface GoalAccessors {
  getModel(): string | undefined;
  setModel(model: string | undefined): Promise<void>;
  getGoal(): GoalState | undefined;
  /** Replace goal state (undefined clears), persist, and refresh the footer. */
  commit(ctx: ExtensionContext, goal: GoalState | undefined): void;
  isPlanMode(): boolean;
  isFlowActive(): boolean;
  loadConfig(ctx: ExtensionContext): Promise<{ model?: string; maxTurns: number }>;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details: unknown }): void;
}

function activeModelKey(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  return model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
}

async function resolveGoalModel(ctx: ExtensionContext, a: GoalAccessors): Promise<string | undefined> {
  const pref = a.getModel();
  if (pref) return pref;
  const config = await a.loadConfig(ctx);
  return config.model ?? activeModelKey(ctx);
}

/** Compact recent transcript (first message + recent window) for the evaluator. */
function buildGoalTranscript(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getEntries() as any[];
  const leafId = ctx.sessionManager.getLeafId() as string;
  const messages = buildSessionContext(entries, leafId).messages ?? [];
  if (!messages.length) return "<conversation>(empty session)</conversation>";
  const sanitized = convertToLlm(messages).map((message: any) => JSON.parse(JSON.stringify(message, (key: string, value: unknown) => {
    if (value && typeof value === "object" && (value as any).type === "image") return { type: "image", omitted: true };
    if (key === "thinking" || key === "signature") return "[omitted]";
    return value;
  })));
  const first = sanitized.slice(0, 1);
  const recent: typeof sanitized = [];
  let size = JSON.stringify(first).length;
  for (let i = sanitized.length - 1; i >= 1; i--) {
    const next = JSON.stringify(sanitized[i]).length + 1;
    if (size + next > GOAL_CONTEXT_BUDGET) break;
    recent.unshift(sanitized[i]);
    size += next;
  }
  const omitted = sanitized.length - first.length - recent.length;
  return `<conversation>\n${JSON.stringify({ omitted, messages: [...first, ...recent] }, null, 2)}\n</conversation>`;
}

/** Parse the evaluator's JSON verdict; conservative false on any parse failure. */
function parseEvaluation(raw: string): { met: boolean; reason: string } {
  const text = raw.trim();
  const fromObject = (parsed: any): { met: boolean; reason: string } | undefined =>
    parsed && typeof parsed === "object" && typeof parsed.met === "boolean"
      ? { met: parsed.met, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "" }
      : undefined;
  try { const r = fromObject(JSON.parse(text)); if (r) return r; } catch { /* fall through */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { const r = fromObject(JSON.parse(match[0])); if (r) return r; } catch { /* fall through */ } }
  // ponytail: conservative — unparseable means "keep working", never a false success
  return { met: false, reason: text.slice(0, 300) || "evaluator response was not valid JSON" };
}

async function evaluateGoal(ctx: ExtensionContext, model: string | undefined, goal: GoalState): Promise<{ met: boolean; reason: string }> {
  const raw = await runIsolated(ctx, model, {
    systemPrompt: EVALUATOR_SYSTEM,
    messages: [{
      role: "user",
      content: [{ type: "text", text: `${buildGoalTranscript(ctx)}\n\nGOAL CONDITION:\n${goal.condition}\n\nHas the goal condition been met based on the surfaced conversation above? Reply with strict JSON only.` }],
      timestamp: Date.now(),
    }],
  });
  return parseEvaluation(raw);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** One loop step, called from the agent_settled handler while a goal is active. */
// ponytail: module-level guard — one evaluator run at a time across the single session
let evaluating = false;
export async function advanceGoal(ctx: ExtensionContext, a: GoalAccessors): Promise<void> {
  const started = a.getGoal();
  // ponytail: re-entrancy guard — a manual turn settling mid-evaluation would otherwise double-continue
  if (!started?.active || started.paused || a.isPlanMode() || a.isFlowActive() || evaluating) return;
  evaluating = true;
  try {
    let result: { met: boolean; reason: string };
    try {
      result = await evaluateGoal(ctx, await resolveGoalModel(ctx, a), started);
    } catch (error) {
      // ponytail: evaluator failure pauses the loop instead of silently looping forever
      const current = a.getGoal();
      if (current?.active) { current.paused = true; a.commit(ctx, current); }
      ctx.ui.notify(`Goal evaluator failed and is paused: ${String(error)}. Run /goal resume to retry.`, "error");
      return;
    }
    const current = a.getGoal();
    // Cleared, replaced (even with the same condition), or paused mid-evaluation: do not act on stale results.
    if (!current || current !== started || current.paused) return;
    current.turns += 1;
    current.lastReason = result.reason;

    if (result.met) {
      const achieved = { ...current };
      a.commit(ctx, undefined);
      a.sendMessage({ customType: GOAL_ENTRY, content: `Goal achieved: ${achieved.condition} · ${achieved.turns} turn(s)`, display: true, details: achieved });
      ctx.ui.notify(`Goal achieved after ${achieved.turns} turn(s): ${achieved.condition}`, "info");
      return;
    }
    if (current.turns >= current.maxTurns) {
      current.active = false;
      a.commit(ctx, current);
      ctx.ui.notify(`Goal stopped after ${current.turns}/${current.maxTurns} turns (cap). ${result.reason}`, "warning");
      return;
    }
    a.commit(ctx, current);
    a.sendUserMessage(`Goal not yet met: ${result.reason}. Continue working toward: ${current.condition}`, { deliverAs: "followUp" });
  } finally {
    evaluating = false;
  }
}

export function registerGoal(pi: ExtensionAPI, a: GoalAccessors): void {
  let registry: ExtensionContext["modelRegistry"] | undefined;

  async function setModel(model: string | undefined, ctx: ExtensionContext): Promise<void> {
    try { await a.setModel(model); }
    catch (error) { ctx.ui.notify(`Goal model preference failed: ${String(error)}`, "error"); return; }
    ctx.ui.notify(model ? `Goal evaluator set to ${model}.` : "Goal evaluator will use the active model.", "info");
  }

  function status(goal: GoalState | undefined, ctx: ExtensionContext): void {
    if (!goal?.active) {
      ctx.ui.notify("No goal set. Use /goal <objective>.", "info");
      return;
    }
    const paused = goal.paused ? " (paused)" : "";
    const last = goal.lastReason ? `\nLast: ${goal.lastReason}` : "";
    ctx.ui.notify(`Goal${paused}: ${goal.condition}\nTurn ${goal.turns}/${goal.maxTurns} · ${formatDuration(Date.now() - goal.startedAt)}${last}`, "info");
  }

  pi.registerCommand("goal", {
    description: "Keep the agent working toward a verifiable condition: /goal <objective> | status | pause | resume | clear",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const goal = a.getGoal();
      const lower = trimmed.toLowerCase();

      if (!trimmed || lower === "status") { status(goal, ctx); return; }

      if (CLEAR_ALIASES.has(lower)) {
        if (!goal?.active) { ctx.ui.notify("No goal set.", "info"); return; }
        const condition = goal.condition;
        a.commit(ctx, undefined);
        ctx.ui.notify(`Goal cleared: ${condition}`, "info");
        return;
      }

      if (lower === "pause") {
        if (!goal?.active) { ctx.ui.notify("No active goal to pause.", "info"); return; }
        if (goal.paused) { ctx.ui.notify("Goal is already paused.", "info"); return; }
        goal.paused = true;
        a.commit(ctx, goal);
        ctx.ui.notify("Goal paused. Run /goal resume to continue.", "info");
        return;
      }

      if (lower === "resume") {
        if (!goal?.active) { ctx.ui.notify("No goal to resume.", "info"); return; }
        if (!goal.paused) { ctx.ui.notify("Goal is already running.", "info"); return; }
        goal.paused = false;
        a.commit(ctx, goal);
        ctx.ui.notify("Goal resumed.", "info");
        a.sendUserMessage(`Resuming goal: ${goal.condition}`, { deliverAs: "followUp" });
        return;
      }

      // Set / replace goal
      if (a.isPlanMode()) { ctx.ui.notify("Exit plan mode before setting a goal (run /plan).", "warning"); return; }
      if (a.isFlowActive()) { ctx.ui.notify("A plan workflow is active. Run /flow stop before setting a goal.", "warning"); return; }
      const { maxTurns } = await a.loadConfig(ctx);
      const next: GoalState = { condition: trimmed, active: true, paused: false, startedAt: Date.now(), turns: 0, maxTurns };
      a.commit(ctx, next);
      ctx.ui.notify(`Goal set: ${trimmed}`, "info");
      a.sendUserMessage(trimmed, { deliverAs: "followUp" });
    },
  });

  pi.registerCommand("goal-model", {
    description: "Configure the /goal evaluator model: /goal-model [model hint|off]",
    getArgumentCompletions: (prefix) => {
      const models = registry?.getAvailable() ?? [];
      const matches = prefix ? fuzzyFilter(models, prefix, modelSearchText) : models;
      return matches.map((model) => ({ value: modelRef(model), label: model.id, description: model.provider }));
    },
    handler: async (args, ctx) => {
      registry = ctx.modelRegistry;
      const value = args.trim();
      if (value.toLowerCase() === "off") return await setModel(undefined, ctx);
      try { await ctx.modelRegistry.refresh(); } catch { /* use cached models */ }
      const match = value ? exactModel(ctx.modelRegistry.getAvailable(), value) : undefined;
      if (match) return await setModel(modelRef(match), ctx);
      const choice = await chooseModel(ctx, a.getModel(), value || undefined);
      if (choice) return await setModel(choice, ctx);
      if (ctx.mode !== "tui") throw new Error("Usage: /goal-model <provider/model|off>");
    },
  });
}
