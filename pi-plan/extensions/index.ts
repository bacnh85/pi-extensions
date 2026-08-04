import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  CustomEditor,
  isToolCallEventType,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PLAN_MODE_SERENA_GUIDANCE } from "./lib/guidance";
import { captureRewindCheckpoint, restoreRewindCheckpoint, rewindToFlowBaseline, snapshotUntrackedFiles, validateRewindCheckpoint, type RewindCheckpoint } from "./lib/lifecycle";
import { BLOCKED_TOOLS, READ_ONLY_TOOLS } from "./lib/plan-tools";
import { loadUtilityConfig, parseModel } from "./lib/utility-config";
import { registerAdvisor } from "./commands/advisor";
import { advanceGoal, DEFAULT_GOAL_MAX_TURNS, registerGoal, type GoalAccessors, type GoalState } from "./commands/goal";
import { registerBtw } from "./commands/btw";
import { registerDoctor } from "./commands/doctor";
import { registerHandoff } from "./commands/handoff";
import { registerSpecs } from "./commands/specs";

const STATUS_KEY = "pi-plan";
const PLAN_DIR = ".agents/plans";
const PLAN_TOOL = "write_plan";
const ASK_USER_QUESTION_TOOL = "ask_user_question";
// ponytail: deprecated alias — drop after one release
const PLAN_QUESTION_TOOL = "ask_plan_question";
const PLAN_EXECUTE_COMMAND = "plan-execute";
// ponytail: keep in sync with pi-review/extensions/index.ts REVIEW_EVENT
const REVIEW_EVENT = "pi-review:run";
const MAX_REVIEW_PASSES = 3;
const REVIEW_INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000;
const REVIEW_HARD_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_DIRTY_PATCH_BYTES = 50 * 1024;
const MAX_UNTRACKED_REVIEW_BYTES = 12 * 1024;
function preferencesFile(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "pi-plan", "preferences.json");
}
const REWIND_CHECKPOINT_TYPE = "pi-plan-rewind";
const MAX_REWIND_CHECKPOINTS = 100;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type PlanStatus = "draft" | "approved" | "executing";
type FlowPhase = "implement" | "fix" | "review" | "done" | "stopped";

interface ReviewFinding {
  severity: string;
  file: string;
  line: number;
  issue: string;
  evidence: string;
  expectedBehavior: string;
  suggestedFix: string;
  acceptanceCriteria: string;
  blocking: boolean;
}

interface FlowState {
  baseline: string;
  initialDirty: string;
  initialDirtyPatch?: string;
  initialCachedPatch?: string;
  initialUnstagedPatch?: string;
  initialUntracked?: string;
  initialUntrackedSnapshot?: string;
  initialUntrackedSnapshotVersion?: 1;
  phase: FlowPhase;
  reviewPass: number;
  verificationSummary?: string;
  reviewFindings?: ReviewFinding[];
  blockingFindings?: ReviewFinding[];
}

interface PlanState {
  enabled: boolean;
  planThinking: ThinkingLevel;
  normalThinking: ThinkingLevel;
  toolsBeforePlan?: string[];
  lastPlanPath?: string;
  lastPlanTitle?: string;
  lastPlanStatus?: PlanStatus;
  planReadyForReview?: boolean;
  specGateActive?: boolean;
  specGatePlanMode?: boolean;
  specPath?: string;
  flow?: FlowState;
  goal?: GoalState;
}

interface PlanPreferences {
  version: 2;
  defaults: { planThinking: ThinkingLevel; normalThinking: ThinkingLevel };
  perModel: Record<
    string,
    { planThinking: ThinkingLevel; normalThinking: ThinkingLevel }
  >;
  advisorModel?: string;
  goalModel?: string;
  planModel?: string;
  normalModel?: string;
}

interface WritePlanParams {
  title: string;
  content: string;
  status?: PlanStatus;
}

interface PlanQuestionOption {
  label: string;
  description?: string;
}

interface PlanQuestionParams {
  question: string;
  options: PlanQuestionOption[];
  recommended?: string;
  allowOther?: boolean;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

function isPlanStatus(value: string | undefined): value is PlanStatus {
  return value === "draft" || value === "approved" || value === "executing";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "plan";
}

function normalizePlanContent(params: WritePlanParams): string {
  const title = params.title.trim() || "Plan";
  const body = params.content.trim();
  if (/^#\s+/m.test(body)) return `${body}\n`;
  return `# ${title}\n\n${body}\n`;
}

function planPath(cwd: string, title: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(cwd, PLAN_DIR, `${stamp}-${slugify(title)}.md`);
}

function relativeToCwd(cwd: string, absolutePath: string): string {
  return path.relative(cwd, absolutePath).split(path.sep).join("/");
}

export { snapshotUntrackedFiles } from "./lib/lifecycle";

function formatShortContextUsage(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  return usage?.percent === null || usage?.percent === undefined
    ? "Context unknown."
    : `Context: ${Math.round(usage.percent)}% used.`;
}

function buildExecutionPrompt(relativePlan: string, mode: "current" | "new", flow = false): string {
  const prefix = mode === "new" ? "This is a fresh session created from an approved pi-plan. " : "";
  const verification = flow ? " Finish your response with `[verification: pass]` after listing exact checks and outcomes, or `[verification: fail]` with the blocker." : "";
  return `${prefix}Execute the approved plan in ${relativePlan}. Read the plan file if needed, keep the implementation scoped to the plan, update the plan if reality differs materially, and run the verification described there.${verification}`;
}

function hasOpenQuestionWarning(content: string): boolean {
  const headingRe = /(^|\n)#{1,6}\s+.*open questions?.*\n/gi;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(content)) !== null) {
    const rest = content.slice(match.index + match[0].length);
    // ponytail: scope to same section — stop at the next heading of any level
    const nextHeading = rest.match(/\n(?=#{1,6}\s)/);
    const section = nextHeading ? rest.slice(0, nextHeading.index!) : rest;
    if (/\?/.test(section)) return true;
  }
  return false;
}

function modelKey(model: { provider?: string; id?: string } | undefined): string | undefined {
  if (!model?.provider || !model?.id) return undefined;
  return `${model.provider}/${model.id}`;
}

type CommandDisposition = "read" | "write" | "confirm";

/** Classify one shell command for plan mode without attempting to interpret arbitrary executables. */
/** Split a shell command on separators (; & |) that are OUTSIDE quotes. */
function splitShellSegments(cmd: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (/[;&|]/.test(ch)) {
      if (cur.trim()) segments.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) segments.push(cur.trim());
  return segments;
}

function classifyCommand(cmd: string): CommandDisposition {
  const c = cmd.trim();
  if (!c) return "confirm";
  // Redirects, command substitution, and heredocs can create/modify files or run
  // arbitrary code regardless of the surrounding command — always a write.
  // Note: the < > check is intentionally conservative — it also catches "a < b"
  // inside quotes. Acceptable: rare in read-only greps, and safety wins.
  if (/[\r\n<>]/.test(c) || /\$\(|`/.test(c) || /--output(?:=|\s)/i.test(c)) return "write";
  // Split on command separators OUTSIDE quotes so read-only pipelines (grep ... | head)
  // and chains (ls -la; echo done) classify per segment, while quoted alternation
  // patterns like "sqi_manager_task\|SYS_Tasks" stay one segment. The whole command
  // is read only if EVERY segment is read only; any known writer wins; else confirm.
  const segments = splitShellSegments(c);
  if (segments.length > 1) {
    if (segments.some((seg) => classifySegment(seg) === "write")) return "write";
    if (segments.every((seg) => classifySegment(seg) === "read")) return "read";
    return "confirm";
  }
  return classifySegment(c);
}

function classifySegment(seg: string): CommandDisposition {
  const inspection = seg.replace(/^\S*\/(?=[^/\s]+(?:\s|$))/, "");
  if (/^git\s+/i.test(inspection)) {
    const read = /^git\s+(status|rev-parse|diff|show|log|ls-files)\b/i.test(inspection)
      || /^git\s+branch\s+--(?:list|all|remote|merged|no-merged|contains|show-current)\b/i.test(inspection);
    return read ? (inspection === seg ? "read" : "confirm") : "write";
  }
  if (/^(?:(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|install|truncate|dd|mktemp)|sudo|env|command|time|nohup)\b/i.test(inspection)) return "write";
  if (/^sed\b/i.test(inspection) && (/\s(?:-i\S*|--in-place(?:=\S*)?)(?:\s|$)/i.test(inspection) || /\b(?:\d+)?w\s+/i.test(inspection) || /\/w\s/i.test(inspection))) return "write";
  if (/^tee\b/i.test(inspection)) return "write";
  if (/^find\b/i.test(inspection) && /-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/i.test(inspection)) return "write";
  // Catch sort -o in any short-option form: standalone -o, combined -no/-on, and --output=.
  if (/^sort\b/i.test(inspection) && (/(?:^|\s)-[a-zA-Z]*o[a-zA-Z]*(?:\s|=|$)/i.test(inspection) || /--output(?:=|\s)/i.test(inspection))) return "write";
  // awk is a Turing-complete interpreter (system(), | getline, print>redirect) — never auto-allow.
  return /^(?:rg|grep|find|fd|ls|pwd|cat|head|tail|wc|sort|uniq|cut|echo|printf)\b/i.test(inspection) ? "read" : "confirm";
}

function getEffectiveThinking(prefs: PlanPreferences, model: { provider?: string; id?: string } | undefined): { plan: ThinkingLevel; normal: ThinkingLevel } {
  const key = modelKey(model);
  const stored = key ? prefs.perModel[key] : undefined;
  return {
    plan: stored?.planThinking ?? prefs.defaults.planThinking,
    normal: stored?.normalThinking ?? prefs.defaults.normalThinking,
  };
}

async function loadPreferences(): Promise<PlanPreferences | undefined> {
  try {
    const raw = await readFile(preferencesFile(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, any>;
    if (parsed.version !== 2 || !isThinkingLevel(parsed.defaults?.planThinking) || !isThinkingLevel(parsed.defaults?.normalThinking) || typeof parsed.perModel !== "object" || parsed.perModel === null) {
      return undefined;
    }
    // ponytail: validate each persisted per-model entry
    const perModel: Record<string, { planThinking: ThinkingLevel; normalThinking: ThinkingLevel }> = {};
    for (const [key, val] of Object.entries(parsed.perModel)) {
      const m = val as Record<string, string>;
      if (isThinkingLevel(m.planThinking) && isThinkingLevel(m.normalThinking)) {
        perModel[key] = { planThinking: m.planThinking, normalThinking: m.normalThinking };
      }
    }
    return {
      version: 2,
      defaults: parsed.defaults,
      perModel,
      advisorModel: typeof parsed.advisorModel === "string" && parsed.advisorModel.trim() ? parsed.advisorModel.trim() : undefined,
      planModel: typeof parsed.planModel === "string" && parsed.planModel.trim() ? parsed.planModel.trim() : undefined,
      normalModel: typeof parsed.normalModel === "string" && parsed.normalModel.trim() ? parsed.normalModel.trim() : undefined,
    };
  } catch {
    return undefined;
  }
}

async function savePreferences(preferences: PlanPreferences): Promise<void> {
  const file = preferencesFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

function isReviewFinding(value: unknown): value is ReviewFinding {
  const finding = value as ReviewFinding;
  return !!finding && ["critical", "high", "medium", "low"].includes(finding.severity) &&
    typeof finding.file === "string" && finding.file.trim().length > 0 && Number.isInteger(finding.line) && finding.line > 0 &&
    typeof finding.issue === "string" && finding.issue.trim().length > 0 &&
    typeof finding.evidence === "string" && finding.evidence.trim().length > 0 &&
    typeof finding.expectedBehavior === "string" && finding.expectedBehavior.trim().length > 0 &&
    typeof finding.suggestedFix === "string" && finding.suggestedFix.trim().length > 0 &&
    typeof finding.acceptanceCriteria === "string" && finding.acceptanceCriteria.trim().length > 0 &&
    typeof finding.blocking === "boolean";
}

function isReviewResult(value: unknown): value is { summary: string; findings: ReviewFinding[] } {
  const result = value as { summary: string; findings: ReviewFinding[] };
  return !!result && typeof result.summary === "string" && result.summary.trim().length > 0 &&
    Array.isArray(result.findings) && result.findings.every(isReviewFinding);
}

function checkpointLabel(checkpoint: RewindCheckpoint): string {
  const prompt = checkpoint.prompt.trim().replace(/\s+/g, " ") || "(empty prompt)";
  return `${new Date(checkpoint.timestamp).toLocaleString()} · ${prompt.slice(0, 90)}`;
}

function checkpointFromEntry(entry: any): RewindCheckpoint | undefined {
  const checkpoint = entry?.type === "custom" && entry.customType === REWIND_CHECKPOINT_TYPE ? entry.data : undefined;
  if (!checkpoint || typeof checkpoint !== "object") return undefined;
  if (typeof checkpoint.promptEntryId !== "string" || typeof checkpoint.prompt !== "string" || typeof checkpoint.timestamp !== "string") return undefined;
  if (!/^[0-9a-f]{7,64}$/i.test(checkpoint.baseline)) return undefined;
  // New format: external payload file (no inline patches needed)
  if (typeof checkpoint.patchFile === "string") return { ...checkpoint, untrackedSnapshotVersion: 1 } as RewindCheckpoint;
  // Legacy format: inline patch payloads
  if (typeof checkpoint.cachedPatch === "string" && typeof checkpoint.unstagedPatch === "string" && typeof checkpoint.untrackedSnapshot === "string") return { ...checkpoint, untrackedSnapshotVersion: 1 } as RewindCheckpoint;
  return undefined;
}

export default function piPlanExtension(pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let toolsBeforePlan: string[] | undefined;
  let planThinking: ThinkingLevel = "high";
  let normalThinking: ThinkingLevel = "medium";
  let lastPlanPath: string | undefined;
  let lastPlanTitle: string | undefined;
  let lastPlanStatus: PlanStatus | undefined;
  let applyingStoredThinking = false;
  let applyingStoredModel = false;
  /** Deferred-retry state: when the configured per-mode model isn't in the
   *  registry yet (late-loading provider like 9router), schedule one retry.
   *  Cleared by the 9router:models-loaded event or the timeout firing. */
  let pendingModelApply = false;
  let modelRetryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Most-recent ExtensionContext, used by the models-loaded event callback. */
  let lastCtx: ExtensionContext | undefined;
  /** One-shot retry for a per-mode model skipped at startup because auth wasn't
   *  configured yet (e.g. before /login). Armed once on the first auth failure,
   *  consumed once on the next prompt — never re-armed, so it can't loop or
   *  override an in-session /model pick. Core emits no login event, so the next
   *  prompt (after /login refreshes the snapshot) is the trigger. */
  let pendingAuthApply = false;
  let authApplyDone = false;
  /** Set on successful write_plan, cleared after first agent_settled prompt. */
  let planReadyForReview = false;
  /** Suppress --plan flag during fresh-session handoff. */
  let executionHandoff = false;
  let flow: FlowState | undefined;
  let flowController: AbortController | undefined;
  let preferences: PlanPreferences | undefined;
  let reviewTimer: ReturnType<typeof setTimeout> | undefined;
  let writePlanInProgress = false;
  let specGateActive = false;
  let specGatePlanMode = false;
  let specPath: string | undefined;
  let advisor: { sync(ctx: ExtensionContext): void };
  let goal: GoalState | undefined;

  // ── UI helpers ──────────────────────────────────────────────

  function clearPlanWidget(ctx: ExtensionContext): void {
    ctx.ui.setWidget(STATUS_KEY, undefined);
  }

  function isFlowActive(): boolean {
    return !!flow && !["done", "stopped"].includes(flow.phase);
  }

  function updateFooter(ctx: ExtensionContext): void {
    const flowStatus = isFlowActive()
      ? `flow: ${flow!.phase} · review ${flow!.reviewPass}/${MAX_REVIEW_PASSES}`
      : undefined;
    const goalStatus = goal?.active
      ? `goal · turn ${goal.turns}/${goal.maxTurns}${goal.paused ? " (paused)" : ""}`
      : undefined;
    const label = flowStatus ?? goalStatus ?? (planModeEnabled ? "Plan mode" : undefined);
    ctx.ui.setStatus(STATUS_KEY, label ? ctx.ui.theme.fg("accent", label) : undefined);
  }

  function persistState(): void {
    pi.appendEntry("pi-plan", {
      enabled: planModeEnabled,
      planThinking,
      normalThinking,
      toolsBeforePlan,
      lastPlanPath,
      lastPlanTitle,
      lastPlanStatus,
      planReadyForReview,
      specGateActive,
      specGatePlanMode,
      specPath,
      flow,
      goal,
    } satisfies PlanState);
  }

  async function persistPreferences(): Promise<void> {
    if (!preferences) return;
    try { await savePreferences(preferences); } catch { /* best-effort persist */ }
  }

  // ponytail: shared state restore — session_start and session_tree both need this
  function restoreStateFromBranch(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager.getBranch();
    const saved = branch
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "pi-plan")
      .pop() as { data?: PlanState } | undefined;
    if (!saved?.data) {
      // ponytail: no saved entry for this branch — reset ALL branch-scoped state
      // so the subsequent persistState() in session_tree doesn't leak the
      // previous branch's workflow or plan mode into the selected branch.
      flow = undefined;
      planModeEnabled = false;
      lastPlanPath = undefined;
      lastPlanTitle = undefined;
      lastPlanStatus = undefined;
      planReadyForReview = false;
      toolsBeforePlan = undefined;
      specGateActive = false;
      specGatePlanMode = false;
      specPath = undefined;
      goal = undefined;
      return;
    }
    // ponytail: treat saved state as authoritative — no ?? fallback to
    // previous module state, which leaks state across unrelated branches.
    planModeEnabled = saved.data.enabled ?? false;
    if (isThinkingLevel(saved.data.planThinking)) planThinking = saved.data.planThinking;
    if (isThinkingLevel(saved.data.normalThinking)) normalThinking = saved.data.normalThinking;
    toolsBeforePlan = saved.data.toolsBeforePlan;
    lastPlanPath = saved.data.lastPlanPath;
    lastPlanTitle = saved.data.lastPlanTitle;
    lastPlanStatus = saved.data.lastPlanStatus;
    planReadyForReview = typeof saved.data.planReadyForReview === "boolean" ? saved.data.planReadyForReview : false;
    specGateActive = saved.data.specGateActive === true;
    specGatePlanMode = saved.data.specGatePlanMode === true;
    specPath = typeof saved.data.specPath === "string" ? saved.data.specPath : undefined;
    flow = saved.data.flow ?? undefined;
    goal = saved.data.goal ?? undefined;
  }

  function enablePlanTools(): void {
    const baseline = [...new Set([...(toolsBeforePlan ?? pi.getActiveTools()), PLAN_TOOL])];
    toolsBeforePlan = baseline;
    // ponytail: preserve active read tools, remove mutators. ask_user_question is read-only/no-mutate so survives naturally.
    pi.setActiveTools([
      ...baseline.filter((t) => !BLOCKED_TOOLS.has(t)),
    ]);
  }

  function restoreTools(): void {
    if (toolsBeforePlan) pi.setActiveTools(toolsBeforePlan);
    toolsBeforePlan = undefined;
  }

  function applyThinking(level: ThinkingLevel): void {
    applyingStoredThinking = true;
    try {
      pi.setThinkingLevel(level);
    } finally {
      applyingStoredThinking = false;
    }
  }

  function recordActiveThinkingLevel(
    level: ThinkingLevel,
    ctx: ExtensionContext,
  ): void {
    if (planModeEnabled) {
      if (planThinking === level) return;
      planThinking = level;
    } else {
      if (normalThinking === level) return;
      normalThinking = level;
    }
    const key = modelKey(ctx.model);
    if (key && preferences) {
      preferences.perModel[key] = {
        planThinking,
        normalThinking,
      };
    }
    updateFooter(ctx);
    persistState();
    persistPreferences();
  }

  /** Resolve the configured per-mode model object from the registry, or
   *  undefined if none configured / not yet loaded. */
  function resolveModeModel(ctx: ExtensionContext):
    { model: NonNullable<ExtensionContext["model"]>; target: string } | undefined {
    const target = planModeEnabled ? preferences?.planModel : preferences?.normalModel;
    if (!target) return undefined;
    const parsed = parseModel(target);
    if (!parsed) return undefined;
    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    return model ? { model, target } : undefined;
  }

  /** Schedule a single deferred retry of applyModeModel (clears any prior). */
  function scheduleModelRetry(ctx: ExtensionContext): void {
    if (modelRetryTimer) clearTimeout(modelRetryTimer);
    pendingModelApply = true;
    // ponytail: heuristic 1.5s fallback; 9router:models-loaded fires sooner
    modelRetryTimer = setTimeout(() => {
      modelRetryTimer = undefined;
      pendingModelApply = false;
      void applyModeModel(ctx);
    }, 1500);
    modelRetryTimer.unref?.();
  }

  async function applyModeModel(ctx: ExtensionContext): Promise<void> {
    const resolved = resolveModeModel(ctx);
    if (!resolved) {
      const target = planModeEnabled ? preferences?.planModel : preferences?.normalModel;
      if (target) {
        // Model configured but not in the registry yet (late-loading provider).
        // Don't give up — retry once when providers finish loading.
        ctx.ui.notify(
          `Configured ${planModeEnabled ? "plan" : "code"} model not loaded yet: ${target}. Will retry when providers are ready.`,
          "info",
        );
        scheduleModelRetry(ctx);
      }
      return;
    }
    const { model, target } = resolved;
    const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    if (target === current) return; // ponytail: avoid settings.json churn; core no-ops on equal anyway
    applyingStoredModel = true;
    try {
      const ok = await pi.setModel(model); // returns false (not throw) when no API key
      if (!ok) {
        ctx.ui.notify(`No API key for ${target}; ${planModeEnabled ? "plan" : "code"} model switch skipped — will retry after /login.`, "warning");
        // Arm a ONE-SHOT retry (only the first time) so /login can activate the
        // model on the next prompt without looping or overriding a manual pick.
        if (!authApplyDone) pendingAuthApply = true;
        return;
      }
      // recompute per-model thinking for the newly-selected model
      if (preferences) {
        const effective = getEffectiveThinking(preferences, model);
        planThinking = effective.plan;
        normalThinking = effective.normal;
      }
      ctx.ui.notify(`Switched to ${planModeEnabled ? "plan" : "code"} model: ${target}`, "info");
    } catch (error) {
      ctx.ui.notify(`${planModeEnabled ? "Plan" : "Code"} model switch failed: ${String(error)}`, "warning");
    } finally {
      applyingStoredModel = false;
    }
  }

  function recordActiveModel(ref: string): void {
    if (!preferences) return;
    if (planModeEnabled) {
      if (preferences.planModel === ref) return;
      preferences.planModel = ref;
    } else {
      if (preferences.normalModel === ref) return;
      preferences.normalModel = ref;
    }
    persistPreferences();
  }

  async function enterPlanMode(ctx: ExtensionContext): Promise<void> {
    planModeEnabled = true;
    // ponytail: after approval, start fresh plan path
    if (lastPlanStatus === "approved" || lastPlanStatus === "executing") {
      flow = undefined;
      lastPlanPath = undefined;
      lastPlanTitle = undefined;
      lastPlanStatus = undefined;
    }
    enablePlanTools();
    await applyModeModel(ctx);
    applyThinking(planThinking);
    updateFooter(ctx);
    clearPlanWidget(ctx);
    persistState();
    ctx.ui.notify(
      `Plan mode enabled. Plans will be written to ${PLAN_DIR}/`,
      "info",
    );
  }

  async function leavePlanMode(
    ctx: ExtensionContext,
    restoreThinking = true,
  ): Promise<void> {
    planModeEnabled = false;
    planReadyForReview = false;
    restoreTools();
    await applyModeModel(ctx);
    if (restoreThinking) applyThinking(normalThinking);
    updateFooter(ctx);
    clearPlanWidget(ctx);
    persistState();
    ctx.ui.notify("Plan mode disabled.", "info");
  }

  async function activateSpecGate(file: string, ctx: ExtensionContext): Promise<void> {
    specGatePlanMode = planModeEnabled;
    specGateActive = true;
    specPath = file;
    if (!planModeEnabled) await enterPlanMode(ctx);
    persistState();
  }

  async function approveSpecGate(ctx: ExtensionContext): Promise<string | undefined> {
    if (!specGateActive || !specPath) return undefined;
    const approvedPath = specPath;
    specGateActive = false;
    specPath = undefined;
    const keepPlanMode = specGatePlanMode;
    specGatePlanMode = false;
    if (!keepPlanMode) await leavePlanMode(ctx);
    else persistState();
    ctx.ui.notify("Specs approved; write gate released.", "info");
    return approvedPath;
  }

  // ── Commands ────────────────────────────────────────────────

  async function handlePlanCommand(
    args: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (args.trim().length > 0) {
      ctx.ui.notify(
        "/plan does not take arguments; use /plan or Ctrl+Alt+P to toggle plan mode.",
        "warning",
      );
      return;
    }
    if (planModeEnabled) {
      if (specGateActive) return ctx.ui.notify("/specs gate is active. Run /specs-approve before leaving plan mode.", "warning");
      await leavePlanMode(ctx);
    } else await enterPlanMode(ctx);
  }

  function checkpoints(ctx: ExtensionContext): RewindCheckpoint[] {
    return ctx.sessionManager.getBranch().flatMap((entry) => {
      const checkpoint = checkpointFromEntry(entry);
      return checkpoint ? [checkpoint] : [];
    }).slice(-MAX_REWIND_CHECKPOINTS);
  }

  async function rewindFlow(ctx: ExtensionContext): Promise<void> {
    if (!flow) return ctx.ui.notify("No rewind checkpoint is available.", "warning");
    if (ctx.hasUI && !await ctx.ui.confirm("Rewind workflow?", "Current changes will be stashed, then the workflow baseline restored.")) return;
    const activeFlow = flow;
    const result = await withFileMutationQueue(path.join(ctx.cwd, ".git", "pi-plan-rewind"), () => rewindToFlowBaseline(ctx.cwd, activeFlow));
    flow = undefined;
    if (lastPlanPath) lastPlanStatus = "approved";
    planReadyForReview = false;
    persistState();
    updateFooter(ctx);
    ctx.ui.notify(`Rewound. Backup: ${result.stash}.`, "info");
  }

  async function rewind(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.isIdle()) return ctx.ui.notify("Rewind is available after the active agent settles.", "warning");
    if (!ctx.hasUI) return ctx.ui.notify("Rewind checkpoint selection requires an interactive UI.", "warning");
    const available = checkpoints(ctx);
    if (available.length === 0) {
      try { await rewindFlow(ctx); } catch (error) { ctx.ui.notify(`Rewind failed: ${String(error)}`, "error"); }
      return;
    }
    const labels = available.map(checkpointLabel);
    const selected = await ctx.ui.select("Rewind to prompt:", flow ? ["Workflow baseline", ...labels] : labels);
    if (selected === "Workflow baseline") {
      try { await rewindFlow(ctx); } catch (error) { ctx.ui.notify(`Rewind failed: ${String(error)}`, "error"); }
      return;
    }
    const checkpoint = selected === undefined ? undefined : available[labels.indexOf(selected)];
    if (!checkpoint) return;
    const action = await ctx.ui.select("Rewind action:", ["Restore conversation", "Restore code", "Restore code and conversation"]);
    if (!action) return;
    try {
      if (action === "Restore code and conversation") await validateRewindCheckpoint(ctx.cwd, checkpoint);
      if (action !== "Restore code") {
        const prompt = ctx.sessionManager.getEntry(checkpoint.promptEntryId);
        const navigation = await ctx.navigateTree(prompt?.parentId ?? checkpoint.promptEntryId);
        if (navigation.cancelled) return ctx.ui.notify("Conversation rewind cancelled.", "info");
        ctx.ui.setEditorText(checkpoint.prompt);
      }
      if (action !== "Restore conversation") {
        const result = await withFileMutationQueue(path.join(ctx.cwd, ".git", "pi-plan-rewind"), () => restoreRewindCheckpoint(ctx.cwd, checkpoint));
        ctx.ui.notify(`Code restored. Backup: ${result.stash}.`, "info");
      }
    } catch (error) {
      ctx.ui.notify(`Rewind failed: ${String(error)}`, "error");
    }
  }

  function installRewindShortcut(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      const handleInput = editor.handleInput.bind(editor);
      let lastEscape = 0;
      editor.handleInput = (data: string) => {
        if ((data === "\u001b\u001b" || (data === "\u001b" && Date.now() - lastEscape < 600)) && ctx.isIdle() && !ctx.ui.getEditorText()) {
          lastEscape = 0;
          ctx.ui.setEditorText("/rewind");
          ctx.ui.notify("Press Enter to choose a rewind checkpoint.", "info");
          return;
        }
        lastEscape = data === "\u001b" ? Date.now() : 0;
        handleInput(data);
      };
      return editor;
    });
  }

  async function beginCurrentSessionExecution(
    ctx: ExtensionContext,
    relativePlan: string,
  ): Promise<void> {
    planModeEnabled = false;
    planReadyForReview = false;
    lastPlanStatus = "approved";
    restoreTools();
    await applyModeModel(ctx);
    applyThinking(normalThinking);
    updateFooter(ctx);
    clearPlanWidget(ctx);
    persistState();
    // ponytail: one-shot execution prompt, no persistent execution mode
    pi.sendUserMessage(
      buildExecutionPrompt(relativePlan, "current"),
      { deliverAs: "followUp" },
    );
  }

  async function beginNewSessionExecution(
    ctx: ExtensionCommandContext,
    withFlow = false,
  ): Promise<void> {
    if (!lastPlanPath) {
      ctx.ui.notify("No approved plan is available to execute.", "error");
      return;
    }

    await ctx.waitForIdle();
    const planPathToExecute = lastPlanPath;
    const planTitleToExecute = lastPlanTitle;
    const relativePlan = relativeToCwd(ctx.cwd, planPathToExecute);
    const parentSession = ctx.sessionManager.getSessionFile();
    const priorFlow = flow;
    if (withFlow) {
      const [head, dirty, cachedPatch, unstagedPatch, untracked] = await Promise.all([
        pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5_000 }),
        pi.exec("git", ["status", "--porcelain"], { timeout: 5_000 }),
        pi.exec("git", ["diff", "--cached", "--binary", "HEAD"], { timeout: 30_000 }),
        pi.exec("git", ["diff", "--binary"], { timeout: 30_000 }),
        pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { timeout: 5_000 }),
      ]);
      if (head.code !== 0 || !head.stdout.trim()) {
        ctx.ui.notify("Cannot create workflow: git repository not found (rev-parse HEAD failed).", "error");
        return;
      }
      if (dirty.code !== 0) {
        ctx.ui.notify("Cannot create workflow: could not capture git status.", "error");
        return;
      }
      if (cachedPatch.code !== 0 || unstagedPatch.code !== 0) {
        ctx.ui.notify("Cannot create workflow: initial dirty patch could not be captured.", "error");
        return;
      }
      const initialCachedPatch = cachedPatch.stdout;
      const initialUnstagedPatch = unstagedPatch.stdout;
      if (Buffer.byteLength(initialCachedPatch, "utf8") + Buffer.byteLength(initialUnstagedPatch, "utf8") > MAX_DIRTY_PATCH_BYTES) {
        ctx.ui.notify(`Cannot create workflow: initial dirty patch exceeds ${MAX_DIRTY_PATCH_BYTES / 1024} KB. Commit, stash, or reduce existing changes first.`, "error");
        return;
      }
      let initialUntrackedSnapshot: string;
      try {
        initialUntrackedSnapshot = await snapshotUntrackedFiles(ctx.cwd);
      } catch (error) {
        ctx.ui.notify(`Cannot create workflow: untracked file snapshot failed (required for change tracking). ${String(error)}`, "error");
        return;
      }
      flow = {
        baseline: head.code === 0 ? head.stdout.trim() : "unavailable",
        initialDirty: dirty.code === 0 ? dirty.stdout.trim() : "unavailable",
        initialCachedPatch,
        initialUnstagedPatch,
        initialUntracked: untracked.code === 0 ? untracked.stdout.trim() : undefined,
        initialUntrackedSnapshot,
        initialUntrackedSnapshotVersion: 1,
        phase: "implement",
        reviewPass: 0,
      };
    }
    const state: PlanState = {
      enabled: false,
      planThinking,
      normalThinking,
      lastPlanPath: planPathToExecute,
      lastPlanTitle: planTitleToExecute,
      lastPlanStatus: "approved",
      planReadyForReview: false,
      flow,
    };

    executionHandoff = true;
    try {
      const result = await ctx.newSession({
        parentSession,
        setup: async (sessionManager) => { sessionManager.appendCustomEntry("pi-plan", state); },
        withSession: async (replacementCtx) => replacementCtx.sendUserMessage(
          buildExecutionPrompt(relativePlan, "new", withFlow),
        ),
      });
      if (result.cancelled) {
        if (flow) flow.phase = "stopped";
        ctx.ui.notify("New-session execution cancelled.", "info");
      }
    } catch (error) {
      if (withFlow) {
        flow = priorFlow;
        persistState();
      }
      throw error;
    } finally {
      executionHandoff = false;
    }
  }


  function latestAssistantText(ctx: ExtensionContext): string {
    const branch = ctx.sessionManager.getBranch() as any[];
    for (let i = branch.length - 1; i >= 0; i--) {
      const item = branch[i];
      if (!item || typeof item !== "object" || !("message" in item)) continue;
      const message = item?.type === "message" ? item.message : undefined;
      if (message?.role === "user") return "";
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      return message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
    }
    return "";
  }

  async function requestFlowReview(ctx: ExtensionContext): Promise<{ ok: boolean; findings?: ReviewFinding[]; error?: string }> {
    if (!flow || !lastPlanPath) return { ok: false, error: "Workflow state is incomplete" };
    try { await access(lastPlanPath); } catch { return { ok: false, error: `Plan file not found: ${lastPlanPath}` }; }
    const id = crypto.randomUUID();
    let reviewState: "IDLE" | "ACCEPTED" | "RESOLVED" | "TIMED_OUT" = "IDLE";
    let resolve!: (value: { ok: boolean; findings?: ReviewFinding[]; error?: string }) => void;
    const result = new Promise<{ ok: boolean; findings?: ReviewFinding[]; error?: string }>((done) => { resolve = done; });
    flowController?.abort();
    const controller = new AbortController();
    flowController = controller;
    if (reviewTimer) clearTimeout(reviewTimer);

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (reviewTimer === idleTimer) reviewTimer = undefined;
      if (flowController === controller) flowController = undefined;
    };
    controller.signal.addEventListener("abort", () => {
      if (reviewState !== "IDLE" && reviewState !== "ACCEPTED") return;
      reviewState = "RESOLVED";
      cleanup();
      resolve({ ok: false, error: "Reviewer cancelled" });
    }, { once: true });

    const timeout = (reason: "idle" | "hard") => {
      if (reviewState === "IDLE" || reviewState === "ACCEPTED") {
        reviewState = "TIMED_OUT";
        controller.abort();
        cleanup();
        resolve({ ok: false, error: `Reviewer ${reason} timeout` });
      }
    };
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => timeout("idle"), REVIEW_INACTIVITY_TIMEOUT_MS);
      reviewTimer = idleTimer;
    };
    resetIdle();
    hardTimer = setTimeout(() => timeout("hard"), REVIEW_HARD_TIMEOUT_MS);

    let untrackedDelta = "";
    try {
      type SnapshotEntry = { path: string; hash: string; content: string; mode?: number; kind?: string };
      const currentRaw = await snapshotUntrackedFiles(ctx.cwd);
      const beforeEntries = (flow.initialUntrackedSnapshot ? JSON.parse(flow.initialUntrackedSnapshot) as SnapshotEntry[] : []).filter((entry) => entry.kind !== "dir");
      const currentEntries = (currentRaw ? JSON.parse(currentRaw) as SnapshotEntry[] : []).filter((entry) => entry.kind !== "dir");
      const before = new Map<string, SnapshotEntry>(beforeEntries.map((entry) => [entry.path, entry]));
      const current = new Map<string, SnapshotEntry>(currentEntries.map((entry) => [entry.path, entry]));
      const paths = new Set([...before.keys(), ...current.keys()]);
      let usedBytes = 0;
      const changes: unknown[] = [...paths].flatMap<unknown>((file) => {
        const oldEntry = before.get(file);
        const newEntry = current.get(file);
        if (oldEntry?.hash === newEntry?.hash && oldEntry?.mode === newEntry?.mode) return [];
        const change = {
          path: file,
          before: oldEntry ? Buffer.from(oldEntry.content, "base64").toString("utf8").slice(0, 2_000) : null,
          after: newEntry ? Buffer.from(newEntry.content, "base64").toString("utf8").slice(0, 2_000) : null,
          beforeMode: oldEntry?.mode,
          afterMode: newEntry?.mode,
        };
        const bytes = Buffer.byteLength(JSON.stringify(change), "utf8");
        if (usedBytes + bytes <= MAX_UNTRACKED_REVIEW_BYTES) {
          usedBytes += bytes;
          return [change];
        }
        const summary = { path: file, beforeHash: oldEntry?.hash, afterHash: newEntry?.hash, beforeMode: oldEntry?.mode, afterMode: newEntry?.mode, truncated: true };
        const summaryBytes = Buffer.byteLength(JSON.stringify(summary), "utf8");
        if (usedBytes + summaryBytes > MAX_UNTRACKED_REVIEW_BYTES) return [];
        usedBytes += summaryBytes;
        return [summary];
      });
      untrackedDelta = changes.length
        ? `\n\nUntracked content changes since start (12 KB max):\n${JSON.stringify(changes, null, 2)}`
        : "\n\nUntracked files unchanged since start.";
    } catch (error) {
      cleanup();
      return { ok: false, error: `Current untracked file snapshot failed: ${String(error)}` };
    }

    pi.events.emit(REVIEW_EVENT, {
      id,
      cwd: ctx.cwd,
      prompt: `Review implementation of ${relativeToCwd(ctx.cwd, lastPlanPath)} against Git baseline ${flow.baseline}. Initial dirty paths at workflow start (exclude unless changed by this implementation):\n${(flow.initialDirty || "(none)").slice(0, MAX_DIRTY_PATCH_BYTES)}\n\nInitial dirty patches (staged + unstaged, 50 KB max):\n${flow.initialDirtyPatch ?? ([flow.initialCachedPatch, flow.initialUnstagedPatch].filter(Boolean).join("\n") || "(none)")}${untrackedDelta}\n\nCompare the current diff against the initial patch above. Report only regressions introduced by this implementation, not pre-existing dirt.`,
      gitRange: `${flow.baseline}...HEAD`,
      requireExactRange: true,
      timeout: REVIEW_INACTIVITY_TIMEOUT_MS,
      signal: controller.signal,
      onProgress: () => resetIdle(),
      accept: () => {
        if (reviewState !== "IDLE") return false;
        reviewState = "ACCEPTED";
        return true;
      },
      respond: (response: any) => {
        if ((reviewState !== "IDLE" && reviewState !== "ACCEPTED") || response?.id !== id) return;
        reviewState = "RESOLVED";
        cleanup();
        if (response?.ok !== true) resolve({ ok: false, error: response?.error ?? "Reviewer failed" });
        else if (!isReviewResult(response.result)) resolve({ ok: false, error: "Reviewer returned malformed result" });
        else resolve({ ok: true, findings: response.result.findings });
      },
    });
    await new Promise<void>(r => queueMicrotask(r));
    if (reviewState === "IDLE") {
      reviewState = "RESOLVED";
      cleanup();
      return { ok: false, error: "pi-review is unavailable" };
    }
    return result;
  }

  async function advanceFlow(ctx: ExtensionContext): Promise<void> {
    if (!flow || !["implement", "fix"].includes(flow.phase)) return;
    const verification = latestAssistantText(ctx);
    flow.verificationSummary = verification.slice(-2_000);
    if (/\[verification:\s*fail\]/i.test(verification) || !/\[verification:\s*pass\]/i.test(verification)) {
      flow.phase = "stopped";
      persistState();
      updateFooter(ctx);
      ctx.ui.notify(/\[verification:\s*fail\]/i.test(verification)
        ? "Workflow stopped: verification failed."
        : "Workflow stopped: verification evidence marker missing.", "error");
      return;
    }

    flow.phase = "review";
    flow.reviewPass++;
    persistState();
    updateFooter(ctx);
    const review = await requestFlowReview(ctx);
    // Recheck — the workflow may have been stopped while we awaited the review
    if (!flow || flow.phase !== "review") return;
    if (!review.ok) {
      flow.phase = "stopped";
      persistState();
      updateFooter(ctx);
      ctx.ui.notify(`Workflow stopped: ${review.error}`, "error");
      return;
    }

    const currentFindings = review.findings ?? [];
    const carried = flow.reviewFindings?.filter((finding) => !finding.blocking) ?? [];
    const findings = [...new Map([...carried, ...currentFindings].map((finding) => [`${finding.file}:${finding.line}:${finding.issue}`, finding])).values()];
    const blocking = findings.filter((finding) => finding.blocking);
    flow.reviewFindings = findings;
    flow.blockingFindings = blocking;
    if (blocking.length === 0) {
      flow.phase = "done";
      persistState();
      updateFooter(ctx);
      pi.sendMessage({
        customType: "pi-flow-result",
        content: findings.length === 0
          ? `Workflow complete. Verification recorded; independent review clean on pass ${flow.reviewPass}.`
          : `Workflow complete. Verification recorded; ${findings.length} non-blocking review finding(s) preserved in result details on pass ${flow.reviewPass}.`,
        display: true,
        details: flow,
      });
      return;
    }
    if (flow.reviewPass >= MAX_REVIEW_PASSES) {
      flow.phase = "stopped";
      persistState();
      updateFooter(ctx);
      ctx.ui.notify(`Workflow stopped after ${MAX_REVIEW_PASSES} review passes.`, "error");
      return;
    }

    flow.phase = "fix";
    persistState();
    updateFooter(ctx);
    pi.sendUserMessage(`Independent review found blocking issues:\n${JSON.stringify(blocking, null, 2)}\n\nFix only these evidenced issues to their expected behavior and acceptance criteria, rerun affected checks, and finish with [verification: pass] or [verification: fail].`, { deliverAs: "followUp" });
  }


  async function handlePlanApproval(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (specGateActive) {
      ctx.ui.notify("/specs gate is active. Run /specs-approve before execution.", "warning");
      return;
    }
    if (!lastPlanPath) {
      ctx.ui.notify("No plan is ready for approval.", "warning");
      return;
    }
    const relativePlan = relativeToCwd(ctx.cwd, lastPlanPath);
    let mode = args.trim().toLowerCase();
    if (!mode) {
      if (!ctx.hasUI) {
        ctx.ui.notify("Usage: /plan-approve current|new|flow", "warning");
        return;
      }
      const currentChoice = "Implement in current session";
      const newChoice = `Clear context and implement · ${formatShortContextUsage(ctx)}`;
      const flowChoice = "Implement, verify, and review · fresh context";
      const stayChoice = "Stay in Plan mode";
      const choice = await ctx.ui.select("Implement this plan?", [currentChoice, newChoice, flowChoice, stayChoice]);
      if (!choice || choice === stayChoice) return;
      mode = choice === currentChoice ? "current" : choice === newChoice ? "new" : "flow";
    }
    if (!(["current", "new", "flow"] as string[]).includes(mode)) {
      ctx.ui.notify("Usage: /plan-approve current|new|flow", "warning");
      return;
    }
    if (mode === "current") {
      await beginCurrentSessionExecution(ctx, relativePlan);
      return;
    }
    await leavePlanMode(ctx, true);
    lastPlanStatus = "approved";
    persistState();
    await beginNewSessionExecution(ctx, mode === "flow");
  }

  // ── Registration ────────────────────────────────────────────


  pi.registerFlag("plan", {
    description:
      "Start in pi-plan read-only planning mode",
    type: "boolean",
    default: false,
  });

  pi.registerTool({
    name: PLAN_TOOL,
    label: "Write Plan",
    description: `Write/replace plan as Markdown under ${PLAN_DIR}/. Use when plan is ready for review.`,
    promptSnippet: `Write plan to ${PLAN_DIR}/ as Markdown for user review`,
    promptGuidelines: [
      `Use ${PLAN_TOOL} in plan mode after exploration. No edit/write until plan approved.`,
      `Don't call ${PLAN_TOOL} while blocking questions remain; use ${ASK_USER_QUESTION_TOOL} first.`,
    ],
    parameters: Type.Object({
      title: Type.String({
        description: "Short plan title",
      }),
      content: Type.String({
        description: "Markdown plan content",
      }),
      status: Type.Optional(
        Type.String({
          description: "draft, approved, or executing",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // ponytail: guard against concurrent write_plan calls
      if (writePlanInProgress) throw new Error("write_plan is already in progress, wait for completion before calling again.");
      writePlanInProgress = true;
      try {
      // ponytail: write_plan is available in normal mode too — agent updates plans during execution
      const typedParams = params as WritePlanParams;

      // ponytail: reuse draft path for refinements, new path for new plans
      let destination: string;
      if (
        lastPlanPath &&
        lastPlanStatus === "draft" &&
        typedParams.title.trim() === lastPlanTitle
      ) {
        // ponytail: compare relative to resolved plan dir (portable, rejects siblings)
        const resolved = path.resolve(ctx.cwd, lastPlanPath);
        const planDir = path.resolve(ctx.cwd, PLAN_DIR);
        const rel = path.relative(planDir, resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          throw new Error(`Plan path is outside ${PLAN_DIR}/`);
        }
        destination = resolved;
      } else {
        destination = planPath(
          ctx.cwd,
          typedParams.title,
        );
      }

      const content = normalizePlanContent(typedParams);
      await withFileMutationQueue(
        destination,
        async () => {
          await mkdir(path.dirname(destination), {
            recursive: true,
          });
          await writeFile(
            destination,
            content,
            "utf8",
          );
        },
      );
      lastPlanPath = destination;
      lastPlanTitle =
        typedParams.title.trim() || "Plan";
      lastPlanStatus = isPlanStatus(typedParams.status)
        ? typedParams.status
        : "draft";
      planReadyForReview = true;
      persistState();

      const warning = hasOpenQuestionWarning(content)
        ? ` If the plan contains blocking user-answerable open questions, call ${ASK_USER_QUESTION_TOOL} before requesting approval.`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Plan written to ${relativeToCwd(ctx.cwd, destination)}. If no blocking user-answerable questions remain, ask the user to approve, refine, execute in current session, execute in a new session, or keep planning.${warning}`,
          },
        ],
        details: {
          path: destination,
          title: lastPlanTitle,
          status: lastPlanStatus,
        },
      };
    } finally {
      writePlanInProgress = false;
    }
  },
  });

  function buildAskQuestionSchema() {
    return Type.Object({
      question: Type.String({
        description: "Question to ask the user",
      }),
      options: Type.Array(
        Type.Object({
          label: Type.String({
            description: "Option label",
          }),
          description: Type.Optional(
            Type.String({
              description:
                "Optional explanation",
            }),
          ),
        }),
        {
          description:
            "Options to choose from (2-4 required)",
          minItems: 2,
          maxItems: 4,
        },
      ),
      recommended: Type.Optional(
        Type.String({
          description:
            "Label of the recommended option (must match one option label). It is shown with a ★ marker.",
        }),
      ),
      allowOther: Type.Optional(
        Type.Boolean({
          description:
            "Allow free-form user answer; default true",
        }),
      ),
    });
  }

  /**
   * Validate ask_user_question params. Throws on invalid input.
   * Returns resolved options + recommendedIndex (0 if recommended absent).
   */
  function validateQuestionParams(typedParams: PlanQuestionParams): {
    options: PlanQuestionOption[];
    recommendedIndex: number | null;
  } {
    const options = typedParams.options ?? [];
    // ponytail: runtime validation since TypeBox minItems can't check blank/duplicate
    const labels = options.map((o) => o.label.trim());
    if (labels.some((l) => !l)) {
      throw new Error("Each option must have a non-blank label.");
    }
    if (new Set(labels).size !== labels.length) {
      throw new Error("Option labels must be unique.");
    }
    if (
      labels.some(
        (l) =>
          l.toLowerCase() === "other" ||
          l.toLowerCase().startsWith("other "),
      )
    ) {
      throw new Error(
        'Option labels cannot conflict with the "Other" label.',
      );
    }

    let recommendedIndex: number | null = null;
    if (typedParams.recommended) {
      const recTrim = typedParams.recommended.trim();
      const matchIdx = labels.findIndex(
        (l) => l.toLowerCase() === recTrim.toLowerCase(),
      );
      if (matchIdx === -1) {
        throw new Error(
          "recommended must match one of the option labels.",
        );
      }
      recommendedIndex = matchIdx;
    }
    return { options, recommendedIndex };
  }

  /**
   * Shared execute for ask_user_question and the deprecated ask_plan_question alias.
   * Uses the built-in ctx.ui.select list dialog (same UX as the original ask_plan_question),
   * with the recommended option marked ★. "Other / type my answer" opens a simple editor.
   */
  // ponytail: typed helper avoids `as const` on every content block
  const textBlock = (text: string) => ({ type: "text" as const, text });

  async function executeAskQuestion(
    _toolCallId: string,
    params: unknown,
    _signal: unknown,
    _onUpdate: unknown,
    ctx: ExtensionContext,
    isAlias: boolean,
  ) {
    const typedParams = params as PlanQuestionParams;
    const { options, recommendedIndex } = validateQuestionParams(typedParams);

    // ponytail: surface deprecation in every mode — notify (UI) + prefix result text (all modes)
    const deprecateNote = isAlias ? "[Deprecated: use ask_user_question instead] " : "";
    if (isAlias && ctx.hasUI) {
      ctx.ui.notify(
        "ask_plan_question is deprecated; use ask_user_question",
        "warning",
      );
    }

    if (!ctx.hasUI) {
      return {
        content: [textBlock(deprecateNote + "UI is not available. Ask this question directly in chat and wait for the user's answer.")],
        details: {
          question: typedParams.question,
          options,
          answer: null,
          wasCustom: false,
          cancelled: false,
        },
      };
    }

    const allowOther = typedParams.allowOther !== false;
    // Build the display list; recommended option gets a ★ marker.
    const displayLabels = options.map((option, i) => {
      const star = recommendedIndex !== null && i === recommendedIndex && options.length > 1 ? "★ " : "";
      return option.description ? `${star}${option.label} — ${option.description}` : `${star}${option.label}`;
    });
    const otherLabel = "Other / type my answer";
    const choice = await ctx.ui.select(
      typedParams.question,
      allowOther ? [...displayLabels, otherLabel] : displayLabels,
    );
    if (!choice) {
      return {
        content: [textBlock(deprecateNote + "User cancelled the question.")],
        details: {
          question: typedParams.question,
          options,
          answer: null,
          cancelled: true,
          wasCustom: false,
        },
      };
    }

    if (choice === otherLabel) {
      const answer = (await ctx.ui.editor("Your answer", ""))?.trim();
      if (!answer) {
        return {
          content: [textBlock(deprecateNote + "User cancelled the question.")],
          details: {
            question: typedParams.question,
            options,
            answer: null,
            cancelled: true,
            wasCustom: false,
          },
        };
      }
      return {
        content: [textBlock(deprecateNote + `User wrote: ${answer}`)],
        details: {
          question: typedParams.question,
          options,
          answer,
          wasCustom: true,
          cancelled: false,
        },
      };
    }

    const selectedIndex = displayLabels.indexOf(choice);
    const selected = options[selectedIndex];
    const answer = selected?.label ?? choice;
    return {
      content: [textBlock(deprecateNote + `User selected: ${answer}`)],
      details: {
        question: typedParams.question,
        options,
        answer,
        selectedIndex, // 0-based, matches options array + recommendedIndex
        wasCustom: false,
        cancelled: false,
      },
    };
  }

  const askQuestionGuidelines = [
    "Use only when repo research leaves a consequential ambiguity.",
    "Prefer 2-4 concrete options. Use short labels.",
    "Don't ask what's discoverable from repo.",
    "Respect user's stated preference.",
    "Provide a recommended option when one choice is clearly preferable.",
  ];

  pi.registerTool({
    name: ASK_USER_QUESTION_TOOL,
    label: "Ask User Question",
    description:
      "Ask user a clarifying question with selectable options, a recommended default, and optional free-form input. Works in any mode.",
    promptSnippet:
      "Ask user a clarifying question with 2-4 options and a recommended default; works in any mode",
    promptGuidelines: askQuestionGuidelines,
    parameters: buildAskQuestionSchema(),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeAskQuestion(toolCallId, params, signal, onUpdate, ctx, false);
    },
  });

  // ponytail: deprecated alias — delegates to the same handler, warns on use. Drop after one release.
  pi.registerTool({
    name: PLAN_QUESTION_TOOL,
    label: "Ask Plan Question (deprecated)",
    description:
      "Deprecated alias for ask_user_question. Use ask_user_question instead.",
    promptSnippet:
      "Deprecated: use ask_user_question instead",
    promptGuidelines: askQuestionGuidelines,
    parameters: buildAskQuestionSchema(),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeAskQuestion(toolCallId, params, signal, onUpdate, ctx, true);
    },
  });

  pi.registerCommand("plan", {
    description: "Toggle pi-plan mode",
    handler: async (args, ctx) =>
      handlePlanCommand(args, ctx),
  });

  pi.registerCommand("plan-approve", {
    description: "Approve the current plan for current, fresh, or reviewed execution",
    handler: async (args, ctx) => handlePlanApproval(args, ctx),
  });

  advisor = registerAdvisor(pi, {
    getModel: () => preferences?.advisorModel,
    setModel: async (model) => {
      if (!preferences) throw new Error("Advisor preferences are unavailable.");
      const previous = preferences.advisorModel;
      preferences.advisorModel = model;
      try {
        await savePreferences(preferences);
      } catch (error) {
        preferences.advisorModel = previous;
        throw error;
      }
    },
    getThinking: () => normalThinking,
    onAvailabilityChange: (enabled) => {
      if (!toolsBeforePlan) return;
      toolsBeforePlan = enabled
        ? [...new Set([...toolsBeforePlan, "advisor"])]
        : toolsBeforePlan.filter((tool) => tool !== "advisor");
    },
  });
  const goalAccessors: GoalAccessors = {
    getModel: () => preferences?.goalModel,
    setModel: async (model) => {
      if (!preferences) throw new Error("Goal preferences are unavailable.");
      const previous = preferences.goalModel;
      preferences.goalModel = model;
      try {
        await savePreferences(preferences);
      } catch (error) {
        preferences.goalModel = previous;
        throw error;
      }
    },
    getGoal: () => goal,
    commit: (ctx, next) => { goal = next ?? undefined; persistState(); updateFooter(ctx); },
    isPlanMode: () => planModeEnabled,
    isFlowActive,
    loadConfig: async (ctx) => {
      const config = await loadUtilityConfig(ctx);
      return { model: config.goal.model, maxTurns: config.goal.maxTurns ?? DEFAULT_GOAL_MAX_TURNS };
    },
    sendUserMessage: (content, options) => pi.sendUserMessage(content, options),
    sendMessage: (message) => pi.sendMessage(message),
  };
  registerGoal(pi, goalAccessors);
  registerBtw(pi);
  registerSpecs(pi, activateSpecGate, approveSpecGate);
  registerDoctor(pi, () => preferences
    ? `plan=${preferences.planModel ?? "-"} · normal=${preferences.normalModel ?? "-"}`
    : "unset");

  registerHandoff(pi, {
    getPlanContext: (cwd) => {
      const lines: string[] = [];
      if (lastPlanPath) lines.push(`- plan: ${lastPlanTitle ?? "Plan"} (${lastPlanStatus ?? "draft"}) — ${relativeToCwd(cwd, lastPlanPath)}`);
      if (flow && !["done", "stopped"].includes(flow.phase)) lines.push(`- workflow: ${flow.phase}, review pass ${flow.reviewPass}`);
      return lines.join("\n");
    },
  });

  pi.registerCommand("rewind", {
    description: "Stash current work and restore the active workflow baseline",
    handler: async (_args, ctx) => rewind(ctx),
  });

  pi.registerCommand(PLAN_EXECUTE_COMMAND, {
    description: "Backward-compatible fresh plan execution command",
    handler: async (args, ctx) => {
      if (specGateActive) return ctx.ui.notify("/specs gate is active. Run /specs-approve before execution.", "warning");
      const mode = args.trim();
      if (mode !== "new" && mode !== "flow") {
        ctx.ui.notify(`Usage: /${PLAN_EXECUTE_COMMAND} new|flow`, "warning");
        return;
      }
      await beginNewSessionExecution(ctx, mode === "flow");
    },
  });

  pi.registerCommand("flow", {
    description: "Show or stop the active plan workflow",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command === "stop" && flow && !["done", "stopped"].includes(flow.phase)) {
        // abort listener resolves the pending review and cleans up its timer/controller
        flowController?.abort();
        flow.phase = "stopped";
        persistState();
        updateFooter(ctx);
        ctx.ui.notify("Workflow stopped.", "info");
        return;
      }
      if (command !== "status") return ctx.ui.notify("Usage: /flow status|stop", "warning");
      ctx.ui.notify(flow ? `flow: ${flow.phase} · review ${flow.reviewPass}/${MAX_REVIEW_PASSES}` : "No workflow state.", "info");
    },
  });

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle pi-plan mode",
    handler: async (ctx) => {
      if (planModeEnabled) {
        if (specGateActive) return ctx.ui.notify("/specs gate is active. Run /specs-approve before leaving plan mode.", "warning");
        await leavePlanMode(ctx);
      } else await enterPlanMode(ctx);
    },
  });

  // ── Events ──────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    lastCtx = ctx;
    preferences = await loadPreferences();
    if (!preferences) {
      preferences = {
        version: 2,
        defaults: { planThinking, normalThinking },
        perModel: {},
      };
    }
    const effective = getEffectiveThinking(
      preferences,
      ctx.model,
    );
    planThinking = effective.plan;
    normalThinking = effective.normal;

    // ponytail: restore state from current branch (shared with session_tree)
    restoreStateFromBranch(ctx);

    // Goal loop counters reset on resume (per Claude Code /goal semantics)
    if (goal?.active) { goal = { ...goal, turns: 0, startedAt: Date.now() }; persistState(); }

    // ponytail: ensure write_plan + ask_user_question are always visible — covers --plan and normal-mode starts
    const active = pi.getActiveTools();
    const additions = [PLAN_TOOL, ASK_USER_QUESTION_TOOL].filter((t) => !active.includes(t));
    if (additions.length) pi.setActiveTools([...active, ...additions]);

    // ponytail: skip plan mode re-entry during execution handoff
    if (
      event.reason === "startup" &&
      pi.getFlag("plan") === true &&
      !executionHandoff
    ) {
      planModeEnabled = true;
    }
    await applyModeModel(ctx);
    if (planModeEnabled) {
      enablePlanTools();
      applyThinking(planThinking);
    } else {
      applyThinking(normalThinking);
    }
    advisor.sync(ctx);
    updateFooter(ctx);
    clearPlanWidget(ctx);
    installRewindShortcut(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    lastCtx = ctx;
    if (!preferences) return;
    if (applyingStoredModel || event.source === "restore") return;
    // ponytail: only genuine user-initiated selections (built-in /model or
    // Ctrl+P cycling) should be recorded as the per-mode pick. Other sources
    // (e.g. an extension re-selecting a model) are ignored to avoid corruption.
    if (event.source !== "set" && event.source !== "cycle") return;
    recordActiveModel(`${event.model.provider}/${event.model.id}`);
    const effective = getEffectiveThinking(preferences, event.model);
    // ponytail: always update both stored levels, then apply active one
    planThinking = effective.plan;
    normalThinking = effective.normal;
    applyThinking(planModeEnabled ? planThinking : normalThinking);
    updateFooter(ctx);
    persistState();
  });

  // Cross-extension signal: a late-loading provider (e.g. pi-9router) has
  // finished registering its models. If we deferred a per-mode model apply
  // because the model wasn't in the registry yet, retry immediately.
  pi.events.on("9router:models-loaded", () => {
    if (pendingModelApply && lastCtx) {
      pendingModelApply = false;
      if (modelRetryTimer) { clearTimeout(modelRetryTimer); modelRetryTimer = undefined; }
      void applyModeModel(lastCtx);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    const previousToolsBeforePlan = toolsBeforePlan;
    restoreStateFromBranch(ctx);
    if (planModeEnabled) {
      toolsBeforePlan ??= previousToolsBeforePlan ?? pi.getActiveTools();
      enablePlanTools();
      applyThinking(planThinking);
    } else {
      if (previousToolsBeforePlan) pi.setActiveTools(previousToolsBeforePlan);
      toolsBeforePlan = undefined;
      applyThinking(normalThinking);
    }
    advisor.sync(ctx);
    updateFooter(ctx);
    persistState();
  });

  pi.on("message_start", async (event, ctx) => {
    if (planModeEnabled) return;
    // The user message is persisted on its message_end, which fires before the
    // assistant message_start. turn_start fires too early (leaf is still the
    // prior assistant), so capture here, where the user leaf is in the tree
    // and the agent has not yet edited any files.
    if (event.message?.role !== "assistant") return;
    const entry = ctx.sessionManager.getLeafEntry();
    if (entry?.type !== "message" || entry.message.role !== "user" || checkpoints(ctx).some((checkpoint) => checkpoint.promptEntryId === entry.id)) return;
    const prompt = typeof entry.message.content === "string"
      ? entry.message.content
      : entry.message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    try {
      const checkpoint = await captureRewindCheckpoint(ctx.cwd, entry.id, prompt, ctx.sessionManager.getSessionId());
      pi.appendEntry(REWIND_CHECKPOINT_TYPE, checkpoint);
    } catch (error) {
      ctx.ui.notify(`Rewind checkpoint skipped: ${String(error)}`, "warning");
    }
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (applyingStoredThinking) return;
    if (!isThinkingLevel(event.level)) return;
    recordActiveThinkingLevel(event.level, ctx);
  });

  /**
   * Tool gating in plan mode:
   *   - Blocked tools → deny with error
   *   - Bash (write commands) → hard-blocked (no file mutations via bash)
   *   - Bash (strict read commands) → auto-allowed
   *   - Bash (unknown executables) → require confirmation
   *   - Baseline tools NOT on the known-read list → require confirmation
   *   - Unknown tools (outside baseline) → require confirmation
   *   - Known-read tools → auto-allowed
   */
  pi.on("tool_call", async (event, ctx) => {
    if (!planModeEnabled) return;
    if (specGateActive && !READ_ONLY_TOOLS.has(event.toolName) && event.toolName !== ASK_USER_QUESTION_TOOL && event.toolName !== PLAN_QUESTION_TOOL && event.toolName !== PLAN_TOOL) {
      return { block: true, reason: "pi-plan: /specs gate is active. Run /specs-approve before workspace writes." };
    }

    // ponytail: hard-blocked mutators never available
    if (BLOCKED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `pi-plan: ${event.toolName} is not available in plan mode. Use ${PLAN_TOOL} to write the plan file.`,
      };
    }

    // ask_user_question (and its deprecated alias) are always allowed — read-only, no mutate.
    if (event.toolName === ASK_USER_QUESTION_TOOL || event.toolName === PLAN_QUESTION_TOOL) return;

    if (isToolCallEventType("bash", event)) {
      const disposition = classifyCommand(event.input.command || "");
      if (disposition === "read") return;
      // ponytail: block explicit writers outright — confirmation doesn't override read-only plan mode
      if (disposition === "write") {
        return {
          block: true,
          reason: `pi-plan: writing to the filesystem is not allowed in plan mode. "${event.input.command}" may modify files. Exit plan mode to run this command, or use ${PLAN_TOOL} to add file content to the plan.`,
        };
      }
      if (!ctx.hasUI) return { block: true, reason: `pi-plan: this command requires confirmation but UI is not available.\nCommand: ${event.input.command}` };
      if (!await ctx.ui.confirm("Allow command with possible side effects?", `This command may execute repository-controlled code or modify files.\n\nCommand: ${event.input.command}`)) {
        return { block: true, reason: `pi-plan: bash command rejected by user.\nCommand: ${event.input.command}` };
      }
      return;
    }

    // ponytail: even baseline/unknown custom tools (e.g. obsidian) need confirm unless known-read
    if (!READ_ONLY_TOOLS.has(event.toolName)) {
      if (!ctx.hasUI) return { block: true, reason: `pi-plan: ${event.toolName} requires confirmation but UI is not available.` };
      if (!await ctx.ui.confirm(`Allow ${event.toolName} in plan mode?`, `Tool: ${event.toolName}`)) {
        return { block: true, reason: `pi-plan: ${event.toolName} rejected by user.` };
      }
      return;
    }
  });

  /**
   * Inject planning instructions via systemPrompt chaining.
   * This preserves Ponytail, project instructions, and other
   * extensions regardless of load order.
   */
  pi.on("before_agent_start", async (_event, ctx) => {
    // One-shot retry: re-apply a per-mode model that was skipped at startup
    // because auth wasn't configured yet (e.g. before /login). Consumed once —
    // authApplyDone prevents any re-arm, so this can't loop or override an
    // in-session /model pick (applyModeModel targets the current normalModel).
    if (pendingAuthApply && !authApplyDone) {
      pendingAuthApply = false;
      authApplyDone = true;
      await applyModeModel(ctx);
    }
    if (planModeEnabled) {
      const relativePlan = lastPlanPath
        ? relativeToCwd(ctx.cwd, lastPlanPath)
        : `${PLAN_DIR}/<timestamp>-<title>.md`;
      return {
        systemPrompt:
          _event.systemPrompt +
          `\n\n## Plan Mode\n\nYou are in read-only planning mode. Research the codebase and produce a reviewable implementation plan before making changes.\n\nRules:\n- Do not edit source files, configs, lockfiles, or git state.\n- You may read files, search, inspect git state, and use dedicated read/research tools.\n- Bash commands that write to files (redirect, heredoc, sed -i, tee, cp/mv/rm, etc.) or contain command substitution are hard-blocked. Read-only bash commands (ls, grep, find, git status) run automatically — including pipelines/chains whose every segment is read-only (e.g. \`grep foo src | head\`). Test/build/package scripts and other unknown executables require confirmation.\n- ${PLAN_MODE_SERENA_GUIDANCE}\n- Ask concise clarifying questions if requirements are ambiguous. Use ${ASK_USER_QUESTION_TOOL} for consequential open decisions with 2-4 clear options, a recommended default, and an Other/user-opinion path.\n- Do not ask about details you can discover from repository evidence. If the user already gave an opinion, incorporate it instead of asking again.\n- Before calling ${PLAN_TOOL}, if any consequential, user-answerable decision remains, call ${ASK_USER_QUESTION_TOOL} and wait for the answer. Do not place blocking user decisions in the final plan as open questions.\n- When the plan is ready, call ${PLAN_TOOL} with a complete Markdown plan.\n- The plan file must live in ${PLAN_DIR}/. Current/next plan path: ${relativePlan}\n${specGateActive && specPath ? `- An active draft specification is at ${relativeToCwd(ctx.cwd, specPath)}. Read it before refining or approving it; workspace writes remain locked until /specs-approve.\n` : ""}- Goal: honor active system/project/skill constraints. Choose the smallest complete implementation — reuse existing code, stdlib, and native features before adding abstractions.\n\nPlan content should include:\n1. Goal and assumptions.\n2. Key findings with durable file/symbol paths.\n3. Proposed implementation steps.\n4. Verification plan.\n5. Risks, non-blocking open questions, and rejected alternatives if relevant.`,
      };
    }
  });

    /**
   * Session replacement APIs are command-only. Extension-originated
   * sendUserMessage() deliberately skips command routing, so the TUI must
   * submit /plan-approve before showing the approval picker.
   *
   * Instead of showing the picker here (ctx is ExtensionContext — no
   * newSession()), prefill /plan-approve so the command handler runs with
   * the proper ExtensionCommandContext that has newSession().
   */
  pi.on("agent_settled", async (_event, ctx) => {
    if (flow && !planModeEnabled && ["implement", "fix"].includes(flow.phase)) {
      await advanceFlow(ctx);
      return;
    }
    if (goal?.active && !planModeEnabled && !isFlowActive()) {
      await advanceGoal(ctx, goalAccessors);
      return;
    }
    if (
      !planModeEnabled ||
      !planReadyForReview ||
      !lastPlanPath ||
      !ctx.hasUI
    )
      return;

    planReadyForReview = false;
    persistState();
    // ponytail: prefill command — command handler (ExtensionCommandContext)
    // owns the picker and newSession() call.
    ctx.ui.setEditorText("/plan-approve");
    ctx.ui.notify(
      "Plan ready for approval. Press Enter to run /plan-approve.",
      "info",
    );
  });
}
