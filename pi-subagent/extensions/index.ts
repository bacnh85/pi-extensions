/**
 * pi-subagent — Minimal-overhead sub-agent extension for pi.
 *
 * Provides a `subagent` tool that delegates tasks to specialized agents
 * running in isolated in-process SDK sessions. Supports three modes:
 *
 *   - Single:  { agent: "scout", task: "find auth code" }
 *   - Parallel: { tasks: [{ agent: "scout", task: "..." }, ...] }
 *   - Chain:    { chain: [{ agent: "scout", task: "..." }, ...] }
 *
 * Compared to process-spawning, this saves ~4-11K tokens per sub-agent
 * by using the pi SDK directly with a minimal system prompt, no AGENTS.md,
 * no extensions, no skills, no thinking, and no compaction.
 */

import * as path from "node:path";
import * as fsPromises from "node:fs/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  DynamicBorder,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  getMarkdownTheme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { type AgentColor, type AgentConfig, type AgentScope, discoverAgents, formatAgentList, getModelCandidates, invalidateAgentCache } from "./agents.ts";
import {
  type SubAgentProgress,
  type SubAgentResult,
  formatPatchBlock,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  mapWithConcurrencyLimit,
  runSubAgent,
  startHeartbeat,
} from "./runner.ts";
import {
  flushWarnings,
  isRetryableModelResult,
  resolveChildTimeouts,
  resolveSafeCwd,
  validateAgentTools,
  needsExtensions,
  truncateParallelOutput,
  validateExecutionRequest,
  READ_ONLY_TOOLS,
  MAX_CONCURRENCY,
  MAX_PARALLEL_TASKS,
  MAX_CHAIN_LENGTH,
  MAX_INSTRUCTIONS_LENGTH,
} from "./security.ts";
import {
  aggregateUsage,
  formatUsageStats,
  renderSingleResult,
} from "./render.ts";
import { type SubagentThread, threadStore } from "./threads.ts";
import { SUBAGENT_REQUEST_EVENT, runNamedAgent, type SubagentRunRequest } from "./service.ts";
import { resolveModel, runWithModelFallback } from "./model.ts";
import { DEFAULT_ROLES, describeAgentModels, effectiveAgentThinking, readSubagentRoles, readSubagentRolesGlobal, resolveAgentModelChain, type RolesConfig } from "./roles.ts";
import {
  createAutoReviewState,
  handleAutoReviewSettle,
  latestEntryId,
} from "./auto-review.ts";
import { ThreadViewer, type ThreadViewerCallbacks } from "./thread-viewer.ts";
import { createTaskWidgetController, renderLiveThreadLine, type TaskWidgetController } from "./widget.ts";
import {
  startBackgroundTask,
  backgroundHerdrHint,
  cancelBackgroundTask,
  getBackgroundTask,
  getAllBackgroundTasks,
  snapshotTask,
  clearBackgroundTasks,
} from "./background.ts";
import { parseStructuredResult } from "./result.ts";
import { appendHistory, readHistory, markInterruptedOnRestart, trimHistory, getHistoryPath } from "./history.ts";
import { herdrCli } from './herdr.ts';
/** Keep-alive cadence for herdr delegations (test seam: shorten to assert). */
export const herdrHeartbeat = { intervalMs: 30_000 };
import {
  cancelAgent,
  canCloseHerdrTab,
  collectResult,
  executeHerdrTask,
  forgetHerdrAgent,
  forgetHerdrTab,
  getAgentInfo,
  herdrDisabled,
  getHerdrRegistry,
  herdrEnvDetected,
  herdrTabCloseBlockers,
  isDelegatedHerdrAgent,
  listHerdrAgents,
  HERDR_TASK_BUDGET,
  MAX_HERDR_TASK_BYTES,
  MAX_REPORT_BYTES,
  prepareHerdrTask,
  promptAndWait,
  resolveEffectiveRunner,
  truncateHerdrTask,
  wrapTaskPrompt,
  wouldHerdrDelegate,
  type HerdrHandle,
  type PromptOutcome,
} from "./herdr.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Namespace for trusted configuration loaded from pi settings, never from tool params. */
function getTrustedConfig(ctx: ExtensionContext): { allowUnconfirmedProjectAgents: boolean; allowExternalCwd: boolean } {
  // Use pi's settings infrastructure if available; fall back to env vars for testing.
  // The model cannot influence these values.
  const settings = (ctx as any).settings ?? {};
  return {
    allowUnconfirmedProjectAgents:
      (settings as Record<string, unknown>).allowUnconfirmedProjectAgents === true ||
      process.env.PI_SUBAGENT_ALLOW_UNCONFIRMED_PROJECT_AGENTS === "true",
    allowExternalCwd:
      (settings as Record<string, unknown>).allowExternalCwd === true ||
      process.env.PI_SUBAGENT_ALLOW_EXTERNAL_CWD === "true",
  };
}

/** Session-scoped approvals for project-local agents ("Trust for this session"). */
const trustedProjectAgentDirs = new Set<string>();


// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
  timeout: Type.Optional(Type.Number({ description: "Inactivity timeout in ms; aborts on no activity within timeout. Default: 3 min (PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS). The agent always has a lifetime cap: default 20 min  or (PI_SUBAGENT_HARD_TIMEOUT_MINS)." })),
  merge: Type.Optional(StringEnum(["3way"] as const, { description: "With a worktree-sandboxed agent, apply its diff to the parent checkout via git apply --3way after it completes. Conflicts are reported, not resolved. Default: patch returned only." })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
  timeout: Type.Optional(Type.Number({ description: "Inactivity timeout in ms; aborts on no activity within timeout. Default: 3 min (PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS). The agent always has a lifetime cap: default 20 min or (PI_SUBAGENT_HARD_TIMEOUT_MINS)." })),
  merge: Type.Optional(StringEnum(["3way"] as const, { description: "With a worktree-sandboxed agent, apply its diff to the parent checkout via git apply --3way after the step completes. Conflicts are reported, not resolved." })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: "user",
});

const SubagentParams = Type.Object({
  operation: Type.Optional(
    Type.Union([Type.Literal("status"), Type.Literal("cancel")], {
      description: 'Task control: inspect ("status") or cancel ("cancel") an existing task by taskId, without starting a new agent. Omit for normal start/resume.',
    }),
  ),
  taskId: Type.Optional(
    Type.String({ description: "Existing background task id, for operation: status/cancel" }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: "Run async (single mode only). You will be notified on completion — DO NOT poll or sleep. Default: false.",
      default: false,
    }),
  ),
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, {
      description: "Array of {agent, task} for sequential execution with {previous}",
    }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  // Security: confirmProjectAgents is NOT exposed as a model-controllable parameter.
  // Project-agent confirmation is enforced via trusted configuration.
  // See Security model section in README.
  cwd: Type.Optional(Type.String({ description: "Working directory (single mode, must be inside workspace)" })),
  timeout: Type.Optional(Type.Number({ description: "Inactivity timeout for the whole run, in ms; resets on activity, aborts on silence. Default 3 min (PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS). Lifetime cap: 20 min or (PI_SUBAGENT_HARD_TIMEOUT_MINS)." })),
  merge: Type.Optional(StringEnum(["3way"] as const, { description: "Single mode: with a worktree-sandboxed agent, apply its diff to the parent checkout via git apply --3way after it completes. Conflicts are reported, not resolved. Default: patch returned only." })),
  instructions: Type.Optional(Type.String({ description: "Bounded repository/task instructions passed to each child (max 16 KB)" })),
  runner: Type.Optional(StringEnum(["sdk", "herdr"] as const, {
    description: 'Execution backend: "sdk" (in-process, lean) or "herdr" (visible interactive pi panes in a herdr session; one tab per agent type, one pane per instance). Default: herdr when pi runs inside herdr, otherwise sdk.',
  })),
  abortOnFailure: Type.Optional(Type.Boolean({ description: "In parallel mode, cancel remaining tasks when one fails. Default: false.", default: false })),
});

// ---------------------------------------------------------------------------
// Details type
// ---------------------------------------------------------------------------

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SubAgentResult[];
  /** Set when a background task was started (single mode + background:true). */
  backgroundTaskId?: string;
  /** Set when the run was delegated to herdr panes. */
  runner?: "herdr";
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let currentCtx: ExtensionContext | undefined;
  let autoReviewState = createAutoReviewState();

  // Live progress widget — fed by threadStore subscriptions (per SDK event).
  const widget: TaskWidgetController = createTaskWidgetController(
    () => threadStore.getAllThreads(),
    (listener) => threadStore.subscribe(listener),
  );

  // Invalidate agent cache + clear thread store on session replacement.
  pi.on("session_start", (event, ctx) => {
    currentCtx = ctx;
    if (event.reason === "reload") invalidateAgentCache();
    threadStore.clear();
    trustedProjectAgentDirs.clear();
    autoReviewState = createAutoReviewState();
    // Reseed before any turn runs so the session's FIRST coding turn is
    // reviewed too (reseed-on-first-settle would silently consume it).
    try {
      if (ctx) autoReviewState.cursor = latestEntryId(ctx.sessionManager.getEntries() as any[]);
    } catch { /* no session yet — analyzeTurn handles undefined cursor */ }
    // Clear any widget from a prior session.
    widget.clearWidgetIfIdle();
    // Mark prior-session running tasks as interrupted (we can't resume them),
    // but keep entries for background tasks still live in this process — only
    // shutdown aborts them, so a session reload must not mislabel them.
    // ponytail: honest about the in-process ceiling — no live-session resume.
    try {
      const liveBgIds = new Set(getAllBackgroundTasks().map((t) => t.id));
      markInterruptedOnRestart(path.join(ctx.cwd, CONFIG_DIR_NAME), liveBgIds);
    } catch { /* history file not writable — non-fatal */ }
  });

  // Clear the widget + abort background tasks on shutdown.
  pi.on("session_shutdown", () => {
    widget.dispose();
    clearBackgroundTasks();
  });

  // Resolve bundled agents directory relative to this extension file
  const bundledAgentsDir = path.resolve(__dirname, "../agents");

  // Inject available agent catalog into system prompt for semantic auto-delegation
  pi.on("before_agent_start", async (event) => {
    const ctx = currentCtx;
    const discovery = discoverAgents(ctx?.cwd ?? process.cwd(), "both", bundledAgentsDir);
    const projectTrusted = ctx?.isProjectTrusted?.() ?? false;
    // Security: project agents are repo-controlled (untrusted until the user
    // approves them). Never let their description text reach the parent's
    // system prompt unless the project is trusted — same gate as AGENTS.md.
    const catalogAgents = discovery.agents.filter(
      (agent) => projectTrusted || agent.source !== "project",
    );
    const rolesCfg = readSubagentRoles(ctx);
    const catalog = catalogAgents
      .map((agent) => {
        const modelInfo = ` (models: ${describeAgentModels(agent, rolesCfg)})`;
        const thinkingInfo = effectiveAgentThinking(agent, rolesCfg) ? `, thinking: ${effectiveAgentThinking(agent, rolesCfg)}` : "";
        const sandboxInfo = agent.sandbox ? `, sandbox: ${agent.sandbox}` : "";
        // ponytail: one-line inheritance hint; the model picks agents by description, this just sets expectations.
        const toolsInfo = agent.tools ? `, tools: ${agent.tools.join(", ")}` : ", tools: inherits all parent tools";
        return `- **${agent.name}**: ${agent.description}${modelInfo}${thinkingInfo}${sandboxInfo}${toolsInfo}`;
      })
      .join("\n");
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Available Subagents\n${catalog}\n\n` +
        "The subagent tool can delegate tasks to these specialized agents with isolated context. " +
        "Use for read-heavy exploration, parallel analysis, or work that would flood the main context.\n" +
        "Agents marked `inherits all parent tools` can use web, Serena, Munin, and other extensions the main agent has; " +
        "agents with an explicit tool list are leaner and restricted to those tools.\n" +
        "Prefer **scout** and **tester** for cheap routine work. " +
        "Prefer **worker** or **general-purpose** for normal coding. " +
        "Prefer **planner** and **reviewer** for consequential reasoning. " +
        "Delegate only when isolation/parallelism/specialization pays off — do NOT delegate single-file small edits or quick greps; do those inline. " +
        "Modes: single, parallel (max 8 tasks, 4 concurrent), chain.",
    };
  });

  // Public one-request/one-response service used by pi-review.
  pi.events.on(SUBAGENT_REQUEST_EVENT, (raw) => {
    const request = raw as SubagentRunRequest;
    const ctx = currentCtx;
    if (!ctx || !request?.id || typeof request.respond !== "function") return;
    if (request.accept && !request.accept()) return;
    const agent = discoverAgents(ctx.cwd, "user", bundledAgentsDir).agents.find((item) => item.name === request.agent);
    if (!agent) {
      request.respond({ id: request.id, ok: false, error: `Unknown agent: ${request.agent}` });
      return;
    }
    const thread = threadStore.createThread({ agentName: agent.name, task: request.task, mode: "single", color: agent.color ? AGENT_TO_THEME_COLOR[agent.color as AgentColor] : undefined });
    if (ctx.mode === "tui") widget.ensureWidget(ctx);
    void runNamedAgent({
      agent: request.readOnly ? { ...agent, tools: ["read", "grep", "find", "ls"] } : agent,
      task: request.task,
      cwd: request.cwd ?? ctx.cwd,
      ctx,
      timeout: request.timeout,
      instructions: request.instructions,
      signal: request.signal,
      readOnly: request.readOnly,
      allowExternalCwd: getTrustedConfig(ctx).allowExternalCwd,
      onMessage: (result) => threadStore.updateThread(thread.id, { result }),
      onProgress: (progress) => { threadStore.updateProgress(thread.id, progress); request.onProgress?.(progress); },
    }).then((result) => {
      threadStore.updateThread(thread.id, {
        status: isFailedResult(result) ? (result.stopReason === "aborted" ? "aborted" : "failed") : "completed",
        result,
      });
      try {
        if (isFailedResult(result)) request.respond({ id: request.id, ok: false, error: getResultOutput(result) });
        else request.respond({ id: request.id, ok: true, result });
      } catch { /* respond channel closed */ }
    }, (error) => {
      threadStore.updateThread(thread.id, { status: "failed" });
      try {
        request.respond({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      } catch { /* respond channel closed */ }
    });
  });

  // Auto-review: after a user-initiated turn that mutated files, dispatch the
  // read-only reviewer on the current uncommitted diff of the turn's touched
  // files as a background task. Config: `subagent.autoReview`.
  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx) return;
    const dispatched = await handleAutoReviewSettle({
      pi,
      ctx,
      state: autoReviewState,
      bundledAgentsDir,
      threadStore,
      agentColor: agentToThemeColor("reviewer"),
      dispatch: startBackgroundTask,
      isRunning: () => getAllBackgroundTasks().some((t) => t.status === "running"),
    });
    if (dispatched && ctx.mode === "tui") widget.ensureWidget(ctx);
  });

  // Register renderer for background-task completion (follow-up turn).
  pi.registerMessageRenderer?.("pi-subagent-complete", (message, _opts, theme) => {
    const d = (message.details ?? {}) as {
      agent?: string; status?: string; summary?: string; full_output?: string;
      elapsed_ms?: number; model?: string; usage?: { turns?: number; cost?: number };
    };
    const fg = theme.fg.bind(theme);
    const isErr = d.status && d.status !== "completed";
    const icon = isErr ? fg("error", "✗") : fg("success", "✓");
    const container = new Container();
    const agentColor = "accent";
    container.addChild(new Text(
      `${icon} ${fg(agentColor, theme.bold(d.agent ?? "subagent"))} ${fg("muted", `[background · ${d.status ?? "done"}]`)}`,
      0, 0,
    ));
    if (d.full_output) {
      const md = new Markdown(d.full_output.trim(), 0, 0, getMarkdownTheme());
      for (const line of md.render(100)) {
        container.addChild(new Text(line, 0, 0));
      }
    }
    const usageParts: string[] = [];
    if (d.usage?.turns) usageParts.push(`${d.usage.turns} turn${d.usage.turns > 1 ? "s" : ""}`);
    if (d.usage?.cost) usageParts.push(`$${d.usage.cost.toFixed(4)}`);
    if (d.elapsed_ms) {
      const secs = Math.round(d.elapsed_ms / 1000);
      usageParts.push(`${secs}s`);
    }
    if (d.model) usageParts.push(d.model);
    if (usageParts.length > 0) {
      container.addChild(new Text(fg("dim", usageParts.join(" · ")), 0, 0));
    }
    return container;
  });
  pi.registerCommand("subagent", {
    description: "Configure model roles (/subagent), list agents (/subagent list), agent details (/subagent <name>), role detail (/subagent @role), reload definitions (/subagent reload), history (/subagent history)",
    getArgumentCompletions: (prefix) => {
      const ctx = currentCtx;
      const keywords = ["list", "all", "agents", "roles", "reload", "refresh", "history"];
      const vocab = [...keywords];
      if (ctx) {
        const discovery = discoverAgents(ctx.cwd, "both", bundledAgentsDir);
        vocab.push(...discovery.agents.map((a) => a.name));
        try { vocab.push(...Object.keys(readSubagentRoles(ctx).roles).map((r) => `@${r}`)); } catch { /* roles optional */ }
      }
      const q = prefix.trim().toLowerCase();
      const items = vocab.filter((v) => v.toLowerCase().startsWith(q))
        .map((v) => ({ value: v, label: v, description: keywords.includes(v) ? "subagent command" : "agent / role" }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase();
      const discovery = discoverAgents(ctx.cwd, "both", bundledAgentsDir);

      // /subagent history — list recent task delegations (durable metadata).
      if (cmd === "history" || cmd === "hist") {
        const piDir = path.join(ctx.cwd, CONFIG_DIR_NAME);
        const entries = readHistory(piDir)
          .sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt))
          .slice(0, 20);
        if (entries.length === 0) {
          pi.sendMessage({
            customType: "pi-subagent",
            content: "No task history yet. History is recorded when subagent tasks complete.",
            display: true,
          });
          return;
        }
        const lines = entries.map((e) => {
          const time = new Date(e.startedAt).toLocaleString();
          const statusIcon = e.status === "completed" ? "✓" : e.status === "interrupted" ? "⚠" : "✗";
          const bg = e.background ? " [bg]" : "";
          const summary = e.summary ? ` — ${e.summary.slice(0, 60)}` : "";
          return `  ${statusIcon} ${e.agent}${bg} · ${time}${summary}`;
        });
        pi.sendMessage({
          customType: "pi-subagent",
          content: `Recent task history (${entries.length}${entries.length === 20 ? "+" : ""}):\n${lines.join("\n")}\n\nFile: ${getHistoryPath(piDir)}`,
          display: true,
        });
        return;
      }

      const openRolesEditor = async (): Promise<void> => {
        // Role mapping editor: panel in TUI, plain text otherwise.
        const [{ openConfigPanel }, { buildRows, buildRolesPanelCfg, cfgToPatch, invalidAgentThinking, makeAddRoleAction, makeRemoveRoleAction, preserveUnknownAgentModels, writeSubagentSection }] = await Promise.all([
          import("@bacnh85/pi-config-panel"),
          import("./roles-panel.ts"),
        ]);
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          const rolesCfg = readSubagentRoles(ctx);
          const lines = discovery.agents.map((a) => `  ${a.name.padEnd(16)} ${describeAgentModels(a, rolesCfg)}`);
          pi.sendMessage({
            customType: "pi-subagent",
            content: [
              "Model roles (edit ~/.pi/agent/settings.json → subagent.roles, or run /subagent in a TUI):",
              ...Object.entries(rolesCfg.roles).map(([name, chain]) =>
                `  @${name} = ${Array.isArray(chain) ? chain.join(", ") : chain}`),
              "",
              "Effective models per agent:",
              ...lines,
            ].join("\n"),
            display: true,
          });
          return;
        }
        const current = readSubagentRolesGlobal();
        const working = buildRolesPanelCfg(discovery.agents, current);
        // Actions (add/remove role) set model.dirty but not editedKeys — guard
        // the save on a working-copy diff instead (pi-a2a pattern).
        const before = JSON.stringify([working.roles, working.agentModels, working.agentThinking]);
        const notify = (message: string, kind?: "info" | "warning" | "error") => ctx.ui.notify(message, kind ?? "info");
        const panelOptions = {
          models: () => {
            try { return ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`); }
            catch { return []; }
          },
          // Working copy: tracks live edits + freshly added (unsaved) roles.
          roles: () => Object.keys(working.roles),
          effectiveRoles: working.roles,
        };
        const actions = {
          addRole: makeAddRoleAction(working, { notify }),
          removeRole: makeRemoveRoleAction(working, { notify }),
        };
        await openConfigPanel({
          ctx,
          cfg: working,
          actions,
          build: (cfg, panelActions) => buildRows(cfg, discovery.agents, panelOptions, panelActions),
          title: "Subagent model roles",
          onSave: (saved) => {
            if (!saved || JSON.stringify([working.roles, working.agentModels, working.agentThinking]) === before) return;
            const invalid = invalidAgentThinking(working);
            if (invalid.length > 0) {
              ctx.ui.notify(`Dropped invalid thinking for: ${invalid.join(", ")} (valid: off…max).`, "warning");
            }
            const patch = cfgToPatch(working);
            patch.agentModels = preserveUnknownAgentModels(
              patch.agentModels,
              discovery.agents.map((a) => a.name),
              current.agentModels,
            );
            patch.agentThinking = preserveUnknownAgentModels(
              patch.agentThinking,
              discovery.agents.map((a) => a.name),
              current.agentThinking,
            );
            try {
              writeSubagentSection(patch);
              invalidateAgentCache();
              ctx.ui.notify("Model roles saved to settings.json", "info");
            } catch (err) {
              ctx.ui.notify(`Not saved — ${err instanceof Error ? err.message : String(err)}`, "error");
            }
          },
        });
        return;
      };

      if (cmd === "roles") {
        await openRolesEditor();
        return;
      }

      if (cmd === "reload" || cmd === "refresh") {
        invalidateAgentCache();
        const fresh = discoverAgents(ctx.cwd, "both", bundledAgentsDir);
        const list = formatAgentList(fresh.agents, 20);
        const extra = list.remaining > 0 ? `\n  ... +${list.remaining} more` : "";
        const dirs = fresh.projectAgentsDir ? `project: ${fresh.projectAgentsDir}` : "no project agents dir";
        const diagText = fresh.diagnostics.length > 0
          ? "\n\nWarnings:\n" + fresh.diagnostics.map(d => `  - [${d.severity}] ${d.filePath}: ${d.issue}`).join("\n")
          : "";
        pi.sendMessage({
          customType: "pi-subagent",
          content: `Agent definitions reloaded.\n\nAvailable agents (${fresh.agents.length}):\n  ${list.text}${extra}${diagText}\n\nDirectories searched:\n  user: ${path.join(getAgentDir(), "agents")}\n  ${dirs}\n  bundled: ${bundledAgentsDir}`,
          display: true,
        });
        ctx.ui.notify("Agent definitions reloaded", "info");
        return;
      }

      // Handle listing keywords before agent lookup
      if (cmd === "all" || cmd === "list" || cmd === "agents") {
        const list = formatAgentList(discovery.agents, 20);
        const extra = list.remaining > 0 ? `\n  ... +${list.remaining} more` : "";
        const dirs = discovery.projectAgentsDir ? `\n  project: ${discovery.projectAgentsDir}` : "";
        const diagText = discovery.diagnostics.length > 0
          ? "\n\nWarnings:\n" + discovery.diagnostics.map(d => `  - [${d.severity}] ${d.filePath}: ${d.issue}`).join("\n")
          : "";
        pi.sendMessage({
          customType: "pi-subagent",
          content: `Available agents (${discovery.agents.length}):\n  ${list.text}${extra}${diagText}\n\nScopes searched:\n  user: ${path.join(getAgentDir(), "agents")}${dirs}\n  bundled: ${bundledAgentsDir}\n\nUse /subagent <name> for agent details, /subagent @role for role detail, /subagent reload to refresh.`,
          display: true,
        });
        return;
      }

      if (cmd) {
        // Show details for a specific agent; fall back to a role detail view
        // when the name matches a model role (e.g. "/subagent coder").
        const agent = discovery.agents.find(
          (a) => a.name.toLowerCase() === cmd,
        );
        if (!agent) {
          const rolesCfg = readSubagentRoles(ctx);
          const arg = args.trim().toLowerCase();
          const roleName = arg.startsWith("@") ? arg.slice(1) : arg;
          // Resolve the role key case-insensitively (role names are free-form).
          const roleKey = Object.keys(rolesCfg.roles).find((k) => k.toLowerCase() === roleName);
          const roleChain = roleKey !== undefined ? rolesCfg.roles[roleKey] : undefined;
          const role = roleKey !== undefined && roleChain !== undefined
            ? { key: roleKey, chain: roleChain }
            : undefined;
          if (role) {
            const { key, chain } = role;
            const chainText = Array.isArray(chain) ? chain.join(" → ") : String(chain);
            const users = discovery.agents.filter((a) => getModelCandidates(a).some((c) => c.toLowerCase().split(":")[0] === `@${key.toLowerCase()}`));
            const overrides = Object.entries(rolesCfg.agentModels).filter(([, v]) => v.toLowerCase().split(":")[0] === `@${key.toLowerCase()}`);
            const defaultText = DEFAULT_ROLES[key] !== undefined
              ? (Array.isArray(DEFAULT_ROLES[key]) ? (DEFAULT_ROLES[key] as string[]).join(" → ") : String(DEFAULT_ROLES[key]))
              : "(custom role)";
            pi.sendMessage({
              customType: "pi-subagent",
              content: [
                `Role: @${key}`,
                `Chain: ${chainText} → parent fallback`,
                `Default: ${defaultText}`,
                users.length > 0 ? `Agents using @${key}: ${users.map((a) => a.name).join(", ")}` : `No agent references @${key} yet`,
                overrides.length > 0 ? `Overrides via @${key}: ${overrides.map(([n]) => n).join(", ")}` : "",
                "",
                `Edit with /subagent (roles editor) or ~/.pi/agent/settings.json → subagent.roles.`,
              ].filter(Boolean).join("\n"),
              display: true,
            });
            return;
          }
          ctx.ui.notify(`Unknown agent: "${args.trim()}". Use /subagent list to list all.`, "error");
          return;
        }
        const rolesCfg = readSubagentRoles(ctx);
        pi.sendMessage({
          customType: "pi-subagent",
          content: [
            `Agent: ${agent.name} (${agent.source})`,
            `Description: ${agent.description}`,
            `Models: ${describeAgentModels(agent, rolesCfg)}`,
            `Thinking: ${effectiveAgentThinking(agent, rolesCfg) || "off"}${rolesCfg.agentThinking[agent.name] ? " (settings override)" : ""}`,
            `Tools: ${agent.tools?.join(", ") || "all default"}`,
            `Source file: ${agent.filePath}`,
            "",
            "--- System Prompt ---",
            agent.systemPrompt,
          ].join("\n"),
          display: true,
        });
        return;
      }

      // Bare /subagent — open the roles editor (list moved to /subagent list).
      await openRolesEditor();
    },
  });

  /** Map AgentColor (from agent frontmatter) to ThemeColor (for pi TUI). */
  const AGENT_TO_THEME_COLOR: Record<AgentColor, ThemeColor> = {
    red: "error",
    blue: "accent",
    green: "success",
    yellow: "warning",
    purple: "syntaxType",
    orange: "syntaxString",
    pink: "customMessageLabel",
    cyan: "syntaxVariable",
  };

  /** Resolve agent-defined color to a valid ThemeColor for thread creation. */
  const agentToThemeColor = (agentName: string): ThemeColor | undefined => {
    const ctx = currentCtx;
    if (!ctx) return undefined;
    const agent = discoverAgents(ctx.cwd, "both", bundledAgentsDir).agents.find(a => a.name === agentName);
    return agent?.color ? AGENT_TO_THEME_COLOR[agent.color] : undefined;
  };

  /** Look up agent color by name for TUI rendering. */
  const resolveAgentColor = (name: string): ThemeColor => {
    const ctx = currentCtx;
    if (!ctx) return "accent";
    const found = discoverAgents(ctx.cwd, "both", bundledAgentsDir).agents.find(a => a.name === name);
    return found?.color ? AGENT_TO_THEME_COLOR[found.color] : "accent";
  };

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context (SDK-based, minimal overhead).",
      "Modes: single (agent + task), parallel (tasks array, max 8, 4 concurrent), chain (sequential with {previous}).",
      "Task control: operation \"status\" or \"cancel\" with taskId inspects/cancels an existing background task without starting an agent.",
      "Background: single mode accepts background:true to run detached; completion arrives as a follow-up turn.",
      `Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
      `To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" or "project".`,
    ].join(" "),
    parameters: SubagentParams,
    promptSnippet: "Delegate tasks to specialized sub-agents with automatic role-based model routing",
    promptGuidelines: [
      "Use subagent to delegate work that would flood the main context with search results or file contents.",
      "Modes: single {agent, task}, parallel {tasks: [...]} (max 8, 4 concurrent), chain {chain: [...]} (sequential with {previous}).",
      "Bundled agents: scout (fast recon), tester (verification), worker (implementation), general-purpose (fallback), planner (planning), reviewer (review).",
      "For background single tasks use background:true — you will be notified on completion; DO NOT poll or sleep.",
      "Use operation: \"status\" with taskId to inspect a running/completed background task; operation: \"cancel\" to abort one.",
      "Worktree-sandboxed agents return their diff as a patch block in the result; pass merge: \"3way\" to auto-apply it to the parent checkout (git apply --3way; conflicts reported, never silently resolved).",
      `Runner: "sdk" runs agents in-process (lean, default outside herdr); "herdr" delegates to visible interactive pi panes in a herdr session (one tab per agent type, one pane per instance) — default when pi runs inside herdr. herdr children share the working tree and skip worktree isolation; background:true always uses the sdk runner.`,
      "Use /subagent list to list all available agents, /subagent <name> for agent details, /subagent @role for role detail.",
    ],
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Surface env-var timeout warnings collected at module load. The
      // interactive TUI swallows module-load stderr, so notify on launch.
      for (const msg of flushWarnings()) {
        ctx.ui?.notify?.(msg, "warning");
      }
      const agentScope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, agentScope, bundledAgentsDir);
      const agents = discovery.agents;

      // Trusted configuration — never from tool params.
      const trusted = getTrustedConfig(ctx);
      const confirmProjectAgents = !trusted.allowUnconfirmedProjectAgents;
      const allowExternalCwd = trusted.allowExternalCwd;

      // Resolve workspace root for cwd validation.
      const workspaceRoot = ctx.cwd;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      // Runner resolution: explicit param wins; default auto-detects herdr
      // (HERDR_ENV=1 + herdr binary answering, unless subagent.herdr:"off"
      // or the PI_SUBAGENT_HERDR=off child recursion guard). Task-control
      // operations and background runs never dispatch via herdr — skip the
      // binary probe entirely.
      const skipRunnerResolution = params.runner === undefined &&
        (params.operation !== undefined || params.background === true);
      const runnerResolved = skipRunnerResolution
        ? { runner: "sdk" as const }
        : await resolveEffectiveRunner(
            params.runner,
            (ctx as any).settings?.subagent ?? {},
            herdrCli.exec,
          );
      if (runnerResolved.error) {
        return {
          content: [{ type: "text", text: runnerResolved.error }],
          details: { mode: "single" as const, agentScope, projectAgentsDir: discovery.projectAgentsDir, results: [] },
          isError: true,
        };
      }
      // background:true always runs the in-process SDK runner (herdr tasks are
      // foreground) — keep the details stamp honest.
      const herdrActive = runnerResolved.runner === "herdr" && !params.background;

      // Worktree isolation / merge:"3way" is an SDK-runner feature — herdr
      // children share the parent's working tree, so a silent drop would turn
      // an explicit isolation request into unmerged edits in the shared tree.
      // Covers explicit merge params AND agent-level sandbox:"worktree".
      const requestedMerge = params.merge || params.tasks?.some((t) => t.merge) || params.chain?.some((c) => c.merge);
      const worktreeAgentRequested = [params.agent, ...(params.tasks ?? []).map((t) => t.agent), ...(params.chain ?? []).map((c) => c.agent)]
        .some((n) => agents.find((a) => a.name === n)?.sandbox === "worktree");
      if (herdrActive && (requestedMerge || worktreeAgentRequested)) {
        return {
          content: [{ type: "text", text: `Worktree isolation${requestedMerge ? " / merge:\"3way\"" : ""} requires runner:"sdk" — herdr children share the parent's working tree. Re-run with runner:"sdk"${requestedMerge ? " or drop merge" : ""}.` }],
          details: { mode: "single" as const, agentScope, projectAgentsDir: discovery.projectAgentsDir, results: [] },
          isError: true,
        };
      }

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SubAgentResult[]): SubagentDetails => ({
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
          runner: herdrActive ? "herdr" : undefined,
        });

      // Task-control results (operation status/cancel) describe an existing
      // background task — they ran nothing themselves, so they must not
      // inherit the ambient herdr stamp (a status lookup of an SDK task would
      // otherwise be labeled runner:"herdr").
      const opDetails = (): SubagentDetails => {
        const details = makeDetails("single")([]);
        details.runner = undefined;
        return details;
      };

      // Validate execution request before any processing.
      const validationErrors = validateExecutionRequest({
        agentName: params.agent,
        task: params.task,
        tasks: params.tasks,
        chain: params.chain,
        timeout: params.timeout,
      });
      if (validationErrors.length > 0) {
        const errorMessages = validationErrors.map((e) => `  • ${e.field}: ${e.message}`).join("\n");
        return {
          content: [{ type: "text", text: `Invalid parameters:\n${errorMessages}` }],
          details: opDetails(),
          isError: true,
        };
      }

      // Control requests (status/cancel) legitimately have no mode — handle
      // them before the mode-count validation rejects them.
      if (params.operation === "status" || params.operation === "cancel") {
        const taskId = params.taskId;
        if (!taskId) {
          return {
            content: [{ type: "text" as const, text: `Missing taskId for operation "${params.operation}". Provide the taskId returned when the task was started.` }],
            details: opDetails(),
            isError: true,
          };
        }
        const bgTask = getBackgroundTask(taskId);
        if (params.operation === "status") {
          if (!bgTask) {
            // Evicted after the 60s post-completion retention — fall back to
            // the durable history so a finished task doesn't read as "never existed".
            // Background entries only: foreground fg-* ids live here too, and
            // non-terminal entries (running/interrupted) aren't "finished".
            const hist = readHistory(path.join(ctx.cwd, CONFIG_DIR_NAME)).find((e) => e.id === taskId && e.background);
            if (hist) {
              const terminal = hist.status === "completed" || hist.status === "failed" || hist.status === "aborted" || hist.status === "timeout";
              const paren = terminal
                ? "finished — no longer retained in memory"
                : `history shows ${hist.status} — not live in this session`;
              const lines = [
                `Task ${hist.id} (${hist.agent}): ${hist.status} (${paren})`,
                `Task: ${hist.task}`,
              ];
              if (hist.summary) lines.push(`Summary: ${hist.summary}`);
              return { content: [{ type: "text" as const, text: lines.join("\n") }], details: opDetails() };
            }
            return { content: [{ type: "text" as const, text: `No background task with id "${taskId}".` }], details: opDetails() };
          }
          const snap = snapshotTask(bgTask);
          const lines = [
            `Task ${snap.id} (${snap.agent}): ${snap.status}`,
            `Elapsed: ${Math.round(snap.elapsedMs / 1000)}s`,
            `Task: ${snap.task}`,
          ];
          if (snap.result) {
            lines.push(`Output: ${String(snap.result.output).slice(0, 2000)}`);
            if (snap.result.patchLines) lines.push(`Patch: ${snap.result.patchLines} diff lines (worktree)`);
          } else {
            lines.push("(still running — no final output yet)");
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }], details: opDetails() };
        }

        // cancel
        const result = cancelBackgroundTask(taskId);
        if (result.outcome === "not_found") {
          return { content: [{ type: "text" as const, text: `No background task with id "${taskId}".` }], details: opDetails(), isError: true };
        }
        if (result.outcome === "already_done") {
          return { content: [{ type: "text" as const, text: `Task ${taskId} already finished (${result.task?.status}).` }], details: opDetails() };
        }
        return { content: [{ type: "text" as const, text: `Cancelled background task ${taskId}.` }], details: opDetails() };
      }

      // Validate: exactly one mode
      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: [
                "Invalid parameters. Provide exactly one mode:",
                "  single: { agent, task }",
                "  parallel: { tasks: [...] }",
                "  chain: { chain: [...] }",
                `Available agents: ${available}`,
              ].join("\n"),
            },
          ],
          details: makeDetails("single")([]),
          isError: true,
        };
      }

      // Handle project-local agent confirmation
      // Security: confirmation policy comes from trusted config, never from tool params.
      if (agentScope === "project" || agentScope === "both") {
        const requestedAgentNames = new Set<string>();
        if (params.chain) for (const s of params.chain) requestedAgentNames.add(s.agent);
        if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
        if (params.agent) requestedAgentNames.add(params.agent);

        const projectAgentsRequested = Array.from(requestedAgentNames)
          .map((name) => agents.find((a) => a.name === name))
          .filter((a): a is AgentConfig => a?.source === "project");

        if (projectAgentsRequested.length > 0) {
          if (confirmProjectAgents) {
            const dir = discovery.projectAgentsDir ?? "(unknown)";
            if (trustedProjectAgentDirs.has(dir)) {
              // Previously approved "Trust for this session" for this agents dir.
            } else if (ctx.hasUI) {
              const names = projectAgentsRequested.map((a) => a.name).join(", ");
              const choice = await ctx.ui.select(
                `Run project-local agents?\n\nAgents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
                ["Allow once", "Trust for this session", "Deny"],
              );
              if (choice !== "Allow once" && choice !== "Trust for this session") {
                return {
                  content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
                  details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
                };
              }
              if (choice === "Trust for this session") trustedProjectAgentDirs.add(dir);
            } else {
              // Fail closed in headless sessions.
              return {
                content: [{
                  type: "text",
                  text: "Project agents require explicit user approval. "
                    + "Enable the trusted project-agent setting to use them in headless mode.",
                }],
                details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
              };
            }
          }
          // else: allowUnconfirmedProjectAgents is true — skip confirmation.
        }
      }

      const modelRegistry = ctx.modelRegistry;
      const modelRuntime = (modelRegistry as any).runtime;
      const authStorage = (modelRegistry as any).authStorage;

      // Roles + per-agent overrides are read once per execute() call so every
      // child in this run sees a consistent mapping.
      const rolesCfg: RolesConfig = readSubagentRoles(ctx);

      // Parent session's registered tool names. Agents that omit `tools` inherit
      // the full set (minus the denylist); agents with an explicit `tools` line
      // are validated against built-ins ∪ this set.
      const parentToolNames = pi.getAllTools().map((t) => t.name);
      const projectTrusted = ctx.isProjectTrusted();

      // Helper: resolve a safe child working directory.
      function resolveChildCwd(childCwd: string | undefined): string {
        const safe = resolveSafeCwd({ workspaceRoot, childCwd, allowExternalCwd });
        if (safe.error) {
          throw new Error(safe.error);
        }
        return safe.path;
      }

      // Helper: stable history id for a foreground run (shared between the
      // running entry written at start and the completion entry).
      function makeForegroundHistoryId(startedAt: number): string {
        return `fg-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      }

      // Helper: record a running foreground task so a crash mid-run shows as
      // "interrupted" after restart (completion upserts by id and replaces it).
      function recordForegroundStart(entryId: string, agentName: string, taskText: string, startedAt: number): void {
        try {
          appendHistory(path.join(ctx.cwd, CONFIG_DIR_NAME), {
            id: entryId,
            agent: agentName,
            task: taskText,
            status: "running",
            startedAt,
          });
        } catch { /* history file not writable — non-fatal */ }
      }

      // Helper: record a completed foreground task to the history registry.
      // ponytail: best-effort — history is non-fatal metadata for /subagent history.
      function recordForegroundHistory(
        entryId: string,
        agentName: string,
        taskText: string,
        result: SubAgentResult,
        startedAt: number,
        background = false,
      ): void {
        try {
          const output = getFinalOutput(result.messages) || getResultOutput(result) || "";
          const structured = parseStructuredResult(output);
          const status = isFailedResult(result)
            ? result.stopReason === "timeout"
              ? "timeout"
              : result.stopReason === "aborted"
                ? "aborted"
                : "failed"
            : "completed";
          appendHistory(path.join(ctx.cwd, CONFIG_DIR_NAME), {
            id: entryId,
            agent: agentName,
            task: taskText,
            status,
            startedAt,
            completedAt: Date.now(),
            summary: structured.summary,
            background,
            model: result.model,
          });
        } catch { /* history file not writable — non-fatal */ }
      }

      // Helper: validate and normalise tools for an agent. Returns the effective
      // tool list and whether extensions must be loaded (any non-built-in tool).
      function resolveChildTools(agentTools: string[] | undefined, sandbox?: string, readOnly?: boolean): { tools: string[]; loadExtensions: boolean } {
        // Omitted tools => inherit all parent tools (Claude Code model).
        let rawTools = agentTools ?? parentToolNames;
        // sandbox overrides tools: silently strip mutation tools, not an error
        if (sandbox === "read-only") {
          rawTools = rawTools.filter(t => READ_ONLY_TOOLS.includes(t));
          if (rawTools.length === 0) rawTools = [...READ_ONLY_TOOLS];
        }
        const effectiveReadOnly = readOnly || sandbox === "read-only";
        const result = validateAgentTools({ tools: rawTools, readOnly: effectiveReadOnly, availableTools: parentToolNames });
        if (result.errors.length > 0) {
          throw new Error(`Tool validation errors: ${result.errors.join("; ")}`);
        }
        return { tools: result.tools, loadExtensions: needsExtensions(result.tools) };
      }

      // Helper: uniform error result for herdr-delegated tasks.
      function herdrErrorResult(agentName: string, task: string, message: string): SubAgentResult {
        return {
          agent: agentName, task, exitCode: 1, status: "error", stopReason: "error",
          messages: [], stderr: message,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          errorMessage: message,
        };
      }

      // Helper: widget progress snapshot from a herdr lifecycle state.
      function herdrProgress(agentName: string, task: string, state: string, startedAt: number, timeoutMs: number): SubAgentProgress {
        const now = Date.now();
        return {
          label: `herdr: ${state}`,
          at: now,
          elapsedMs: now - startedAt,
          inactivityDeadline: now + timeoutMs,
          hardDeadline: startedAt + timeoutMs,
          result: {
            agent: agentName, task, exitCode: -1, messages: [], stderr: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          },
        };
      }

      // Helper (herdr runner): validate + create topology + start the child pi,
      // without prompting — so parallel dispatch can materialise every pane
      // up front before any work starts.
      async function prepareHerdrOne(
        agentName: string,
        task: string,
        cwd: string | undefined,
        timeoutMs: number | undefined,
      ): Promise<{ handle: HerdrHandle; timeoutMs: number; startedAt: number } | { error: string }> {
        const agent = agents.find((a) => a.name === agentName);
        if (!agent) return { error: `Unknown agent: "${agentName}".` };
        const agentChain = resolveAgentModelChain(agent, rolesCfg);
        const resolved = await resolveModel(agentChain.candidates, ctx.model, ctx.modelRegistry);
        if (!resolved.model) {
          return { error: `No model resolved for agent "${agentName}" (tried: ${resolved.attempted.join(", ") || "none"}).` };
        }
        const timeouts = resolveChildTimeouts({ requested: timeoutMs, agentTimeoutMins: agent.timeout });
        if (timeouts.error) return { error: timeouts.error };
        const hardTimeoutMs = timeouts.hardTimeoutMs ?? timeouts.timeoutMs ?? 0;
        if (!hardTimeoutMs) return { error: "Invalid herdr timeout configuration." };
        const safe = resolveSafeCwd({ workspaceRoot, childCwd: cwd, allowExternalCwd });
        if (safe.error) return { error: safe.error };
        const startedAt = Date.now();
        const systemPrompt = params.instructions
          ? `${agent.systemPrompt}\n\n## Task Contract\n${params.instructions.slice(0, MAX_INSTRUCTIONS_LENGTH)}`
          : agent.systemPrompt;
        try {
          const handle = await prepareHerdrTask({
            agentType: agent.name,
            systemPrompt,
            task,
            cwd: safe.path,
            model: `${resolved.model.provider}/${resolved.model.id}`,
            thinking: agentChain.thinkingByCandidate.get(resolved.matchedCandidate ?? "") ?? effectiveAgentThinking(agent, rolesCfg),
            tools: agent.tools,
            readOnly: agent.sandbox === "read-only",
            timeoutMs: hardTimeoutMs,
          });
          return { handle, timeoutMs: hardTimeoutMs, startedAt };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }

      // Helper (herdr runner): full delegation (prepare + prompt + collect).
      async function startHerdrOne(
        agentName: string,
        task: string,
        cwd: string | undefined,
        parentSignal: AbortSignal | undefined,
        timeoutMs: number | undefined,
        onActivity?: (progress: SubAgentProgress) => void,
        onUpdate?: AgentToolUpdateCallback<SubagentDetails>,
        heartbeatDetails?: () => SubagentDetails,
        onHeartbeat?: () => void,
      ): Promise<SubAgentResult> {
        const prepared = await prepareHerdrOne(agentName, task, cwd, timeoutMs);
        if ("error" in prepared) return herdrErrorResult(agentName, task, prepared.error);
        const { handle, startedAt } = prepared;
        // Keep-alive parity with the SDK path: a long pane run must emit
        // onUpdate traffic or the host may idle-abort the tool call.
        const stopHeartbeat = onUpdate ? startHeartbeat(() => {
          onHeartbeat?.();
          onUpdate({ content: [{ type: "text", text: "" }], details: heartbeatDetails?.() ?? makeDetails("single")([]) });
          widget.requestRender();
        }, herdrHeartbeat.intervalMs) : undefined;
        let onCancel: (() => void) | undefined;
        if (parentSignal) {
          onCancel = () => { void cancelAgent(handle.name, herdrCli.exec); };
          // An already-aborted signal never fires its listeners — cancel now.
          if (parentSignal.aborted) onCancel();
          else parentSignal.addEventListener("abort", onCancel, { once: true });
        }
        try {
          return await executeHerdrTask(handle, {
            onState: onActivity
              ? (state) => onActivity(herdrProgress(handle.agentType, task, state, startedAt, prepared.timeoutMs))
              : undefined,
            signal: parentSignal,
          });
        } catch (err) {
          return herdrErrorResult(agentName, task, `herdr delegation failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          // Settled: stop the keep-alive and detach the abort listener so a
          // later abort never keystrokes a completed step's pane.
          stopHeartbeat?.();
          if (parentSignal && onCancel) parentSignal.removeEventListener("abort", onCancel);
        }
      }

      // Helper: run a single agent via SDK with security validation
      async function runOne(
        agentName: string,
        task: string,
        cwd: string | undefined,
        parentSignal?: AbortSignal,
        timeoutMs?: number,
        onProgress?: (partial: SubAgentResult) => void,
        onActivity?: (progress: SubAgentProgress) => void,
        heartbeatDetails?: () => SubagentDetails,
        onHeartbeat?: () => void,
        isReadOnly?: boolean,
        merge?: "3way",
      ): Promise<SubAgentResult> {
        const agent = agents.find((a) => a.name === agentName);

        if (!agent) {
          const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
          return {
            agent: agentName,
            task,
            exitCode: 1,
            status: "error",
            stopReason: "error",
            messages: [],
            stderr: `Unknown agent: "${agentName}". Available: ${available}.`,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            errorMessage: `Unknown agent: "${agentName}"`,
          };
        }

        const agentChain = resolveAgentModelChain(agent, rolesCfg);
        const resolved = await resolveModel(agentChain.candidates, ctx.model, ctx.modelRegistry);
        if (!resolved.model) {
          const tried = resolved.attempted.join(", ") || "none";
          const parentInfo = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
          return {
            agent: agentName,
            task,
            exitCode: 1,
            status: "error",
            stopReason: "error",
            messages: [],
            stderr: `Model not found for agent "${agentName}". Tried: ${tried}. Parent model: ${parentInfo}. Check agent definition and pi model configuration.`,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            errorMessage: `No model resolved (tried: ${tried})`,
          };
        }

        // Security: validate tools, timeout, and cwd (wrapped in try/catch).
        let tools: string[];
        let loadExtensions: boolean;
        let effectiveTimeoutMs: number | undefined;
        let effectiveHardMs: number | undefined;
        let safeCwd: string;
        try {
          const resolved = resolveChildTools(agent.tools, agent.sandbox, isReadOnly);
          tools = resolved.tools;
          loadExtensions = resolved.loadExtensions;
          // Precedence: per-call timeout > agent frontmatter default > global
          // default; the hard lifetime cap is raised to match (shared resolver
          // with the service path — resolveChildTimeouts in security.ts).
          const timeouts = resolveChildTimeouts({ requested: timeoutMs, agentTimeoutMins: agent.timeout, globalTimeout: params.timeout });
          if (timeouts.error) throw new Error(timeouts.error);
          effectiveTimeoutMs = timeouts.timeoutMs;
          effectiveHardMs = timeouts.hardTimeoutMs;
          safeCwd = resolveChildCwd(cwd);
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return {
            agent: agentName,
            task,
            exitCode: 1,
            status: "error",
            stopReason: "error",
            messages: [],
            stderr: `Validation error: ${errorMsg}`,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            errorMessage: errorMsg,
          };
        }

        // Retry loop: rate-limit model fallback (candidates already role-expanded).
        // Shared with the service path — single source of truth for triedModels
        // bookkeeping and per-candidate `:thinking` resolution.
        const candidates = agentChain.candidates;

        // Transport keep-alive only: resets parent idle timeout so a long child
        // run isn't killed. The visible progress now lives in the live widget;
        // we no longer push the plain "still running…" text.
        const stopHeartbeat = onUpdate ? startHeartbeat(() => {
          onHeartbeat?.();
          onUpdate({ content: [{ type: "text", text: "" }], details: heartbeatDetails?.() ?? makeDetails("single")([]) });
          widget.requestRender();
        }) : undefined;
        try {
          return await runWithModelFallback<SubAgentResult>({
            candidates,
            parentModel: ctx.model,
            modelRegistry: ctx.modelRegistry,
            thinkingByCandidate: agentChain.thinkingByCandidate,
            defaultThinking: effectiveAgentThinking(agent, rolesCfg),
            runAttempt: (model, thinkingLevel) =>
              runSubAgent({
                cwd: safeCwd,
                sandbox: agent.sandbox === "worktree" ? "worktree" : undefined,
                merge: agent.sandbox === "worktree" ? merge : undefined,
                systemPrompt: params.instructions
                ? `${agent.systemPrompt}\n\n## Task Contract\n${params.instructions.slice(0, MAX_INSTRUCTIONS_LENGTH)}`
                : agent.systemPrompt,
                task,
                tools,
                model,
                modelRuntime,
                authStorage,
                modelRegistry,
                signal: parentSignal,
                timeoutMs: effectiveTimeoutMs,
                hardTimeoutMs: effectiveHardMs,
                agentName,
                thinkingLevel,
                onMessage: onProgress,
                onProgress: onActivity,
                loadExtensions,
                projectTrusted,
              }),
            isRateLimited: (result) => isRetryableModelResult(result),
            onExhausted: (reason, triedModels, remaining) => {
              const exhaustedStderr = reason === "no-model"
                ? [
                    `All models rate-limited or unavailable.`,
                    `Tried: ${triedModels.join(" → ") || "(none)"}.`,
                    `Remaining candidates: ${remaining.join(", ") || "none"}.`,
                    `Parent: ${ctx.model?.provider}/${ctx.model?.id}.`,
                  ].join(" ")
                : [
                    `All available models exhausted.`,
                    `Tried: ${triedModels.join(" → ")}.`,
                  ].join(" ");
              return {
                agent: agentName,
                task,
                exitCode: 1,
                status: "error" as const,
                stopReason: "error" as const,
                messages: [],
                stderr: exhaustedStderr,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                errorMessage: reason === "no-model"
                  ? `All models exhausted (tried: ${triedModels.join(" → ") || "none"})`
                  : `All available models exhausted (tried: ${triedModels.join(" → ")})`,
              };
            },
          });
        } finally {
          stopHeartbeat?.();
        }
      }

      // --- Chain mode ---
      if (params.chain && params.chain.length > 0) {
        const results: SubAgentResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, () => previousOutput);
          // A large step report can blow the herdr argv ceiling — truncate the
          // substituted text (SDK tasks have no ceiling and stay untouched).
          const dispatchTask = herdrActive ? truncateHerdrTask(taskWithContext) : taskWithContext;

          const thread = threadStore.createThread({
            agentName: step.agent,
            task: dispatchTask,
            mode: "chain-step",
            toolCallId: _toolCallId,
            color: agentToThemeColor(step.agent),
          });
          if (ctx.mode === "tui") widget.ensureWidget(ctx);
          const historyId = makeForegroundHistoryId(thread.createdAt);
          recordForegroundStart(historyId, step.agent, dispatchTask, thread.createdAt);
          const result = herdrActive
            ? await startHerdrOne(
                step.agent, dispatchTask, step.cwd,
                signal, step.timeout ?? params.timeout,
                (progress) => threadStore.updateProgress(thread.id, progress),
                onUpdate,
                () => makeDetails("chain")(results),
                () => threadStore.refreshHeartbeat(thread.id),
              )
            : await runOne(
                step.agent, taskWithContext, step.cwd,
                signal, step.timeout ?? params.timeout,
                (partial) => threadStore.updateThread(thread.id, { result: partial }),
                (progress) => threadStore.updateProgress(thread.id, progress),
                () => makeDetails("chain")(results),
                () => threadStore.refreshHeartbeat(thread.id),
                undefined,
                step.merge,
              );
          threadStore.updateThread(thread.id, {
            status: isFailedResult(result) ? (result.stopReason === "aborted" ? "aborted" : "failed") : "completed",
            result,
          });
          recordForegroundHistory(historyId, step.agent, dispatchTask, result, thread.createdAt);
          results.push(result);

          // Herdr: a blocked pane needs human input — pause the chain instead
          // of feeding degraded output to the next step.
          if (result.stopReason === "blocked") {
            return {
              content: [{
                type: "text",
                text: `Chain paused at step ${i + 1}/${params.chain.length} (${step.agent}): the agent is blocked awaiting input. Answer it in its herdr pane (or via the herdr tool), then re-run the remaining steps.`,
              }],
              details: makeDetails("chain")(results),
            };
          }

          const isError = isFailedResult(result);
          if (isError) {
            const errorMsg = getResultOutput(result);
            if (onUpdate) {
              onUpdate({
                content: [{ type: "text", text: errorMsg }],
                details: makeDetails("chain")(results),
              });
            }
            // Include successful previous step outputs in the error content
            const prevCount = i;
            let contentText = `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`;
            const failedPatch = formatPatchBlock(result);
            if (failedPatch) contentText += `\n\n${failedPatch}`;
            if (prevCount > 0) {
              const prevSummaries = results
                .slice(0, prevCount)
                .map((r, j) => {
                  const out = getResultOutput(r).slice(0, 500);
                  return `Step ${j + 1} (${r.agent}): ${out}`;
                })
                .join("\n");
              contentText = `Chain stopped at step ${i + 1}/${params.chain.length}. ${prevCount} previous step(s) succeeded:\n\n${prevSummaries}\n\nError at step ${i + 1} (${step.agent}): ${errorMsg}`;
            }
            return {
              content: [{ type: "text", text: contentText }],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }

          previousOutput = getFinalOutput(result.messages);

          if (onUpdate) {
            onUpdate({
              content: [{ type: "text", text: [getFinalOutput(result.messages) || "(no output)", formatPatchBlock(result)].filter(Boolean).join("\n\n") }],
              details: makeDetails("chain")(results),
            });
          }
        }

        const last = results[results.length - 1];
        // Chain deliverable: final output plus every step's worktree patch,
        // labeled so the parent can merge them in order.
        const chainPatches = results
          .map((r, i) => (formatPatchBlock(r) ? `Step ${i + 1} (${r.agent}): ${formatPatchBlock(r)}` : ""))
          .filter(Boolean)
          .join("\n\n");
        return {
          content: [
            { type: "text", text: [getFinalOutput(last.messages) || "(no output)", chainPatches].filter(Boolean).join("\n\n") },
          ],
          details: makeDetails("chain")(results),
        };
      }

      // --- Parallel mode ---
      if (params.tasks && params.tasks.length > 0) {
        const abortOnFailure = params.abortOnFailure ?? false;
        const parallelController = new AbortController();
        let abortCause: "parent" | "sibling" | "timeout" | undefined;
        let cleanupParentSignal: (() => void) | undefined;

        // Link parent abort into parallelController so queued tasks see aborted state
        if (signal) {
          if (signal.aborted) {
            abortCause = "parent";
            parallelController.abort();
          } else {
            const onParentAbort = () => {
              if (!abortCause) abortCause = "parent";
              parallelController.abort();
            };
            signal.addEventListener("abort", onParentAbort, { once: true });
            cleanupParentSignal = () => signal.removeEventListener("abort", onParentAbort);
          }
        }

        // Wrap all remaining setup + execution so cleanupParentSignal always runs.
        let stopParallelHeartbeat: ReturnType<typeof startHeartbeat> | undefined;
        try {
          // Pre-create threads for all parallel tasks
          const parallelThreads = params.tasks.map((t) =>
            threadStore.createThread({
              agentName: t.agent,
              task: t.task,
              mode: "parallel-task",
              toolCallId: _toolCallId,
              color: agentToThemeColor(t.agent),
            }),
          );
          if (ctx.mode === "tui") widget.ensureWidget(ctx);

          const allResults: SubAgentResult[] = new Array(params.tasks.length);
          // Initialize placeholder results for streaming
          for (let i = 0; i < params.tasks.length; i++) {
            allResults[i] = {
              agent: params.tasks[i].agent,
              task: params.tasks[i].task,
              exitCode: -1,
              messages: [],
              stderr: "",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            };
          }

          // Herdr: materialise every pane up front so all delegated agents are
          // visible in herdr before any work starts, then submit prompts under
          // the concurrency limit below.
          const herdrPrepared = herdrActive
            ? await Promise.all(params.tasks.map(async (t) => {
                const startedAt = Date.now();
                const prepared = await prepareHerdrOne(t.agent, t.task, t.cwd, t.timeout ?? params.timeout);
                if ("error" in prepared) return { ok: false as const, error: prepared.error, startedAt };
                return { ok: true as const, handle: prepared.handle, timeoutMs: prepared.timeoutMs, startedAt: prepared.startedAt };
              }))
            : undefined;
          if (herdrPrepared) {
            const cancelAll = () => {
              for (const p of herdrPrepared) if (p.ok) void cancelAgent(p.handle.name, herdrCli.exec);
            };
            if (signal) {
              if (signal.aborted) cancelAll();
              else signal.addEventListener("abort", cancelAll, { once: true });
            }
            // abortOnFailure / parent abort go through parallelController —
            // in-flight herdr agents must be cancelled too, not just queued ones.
            parallelController.signal.addEventListener("abort", cancelAll, { once: true });
            const previousCleanup = cleanupParentSignal;
            cleanupParentSignal = () => {
              previousCleanup?.();
              signal?.removeEventListener("abort", cancelAll);
              parallelController.signal.removeEventListener("abort", cancelAll);
            };
          }

          // One keep-alive for the whole herdr parallel block (per tool call,
          // not per slot) — parity with the SDK path's heartbeat.
          stopParallelHeartbeat = herdrActive && onUpdate
            ? startHeartbeat(() => {
                onUpdate({ content: [{ type: "text", text: "" }], details: makeDetails("parallel")([...allResults]) });
                widget.requestRender();
              })
            : undefined;

          const emitParallelUpdate = () => {
            if (onUpdate) {
              const running = allResults.filter((r) => r.exitCode === -1).length;
              const done = allResults.filter((r) => r.exitCode !== -1).length;
              onUpdate({
                content: [
                  {
                    type: "text",
                    text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
                  },
                ],
                details: makeDetails("parallel")([...allResults]),
              });
            }
          };

          const results = await mapWithConcurrencyLimit(
              params.tasks,
              MAX_CONCURRENCY,
              async (t, index) => {
                // Skip if already aborted by sibling failure or parent abort
                if (parallelController.signal.aborted) {
                  const preparedSkip = herdrPrepared?.[index];
                  if (preparedSkip?.ok) void cancelAgent(preparedSkip.handle.name, herdrCli.exec);
                  const skippedResult: SubAgentResult = {
                    agent: t.agent,
                    task: t.task,
                    exitCode: 1,
                    status: "error",
                    messages: [],
                    stderr: "",
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                    stopReason: "aborted",
                    errorMessage:
                      abortCause === "sibling"
                      ? "Cancelled: sibling task failed"
                      : abortCause === "timeout"
                      ? "Cancelled: sibling task timed out"
                      : "Cancelled: parent operation aborted",
                  };
                  allResults[index] = skippedResult;
                  threadStore.updateThread(parallelThreads[index].id, {
                    status: "aborted",
                    result: skippedResult,
                  });
                  emitParallelUpdate();
                  return skippedResult;
                }
                const historyId = makeForegroundHistoryId(parallelThreads[index].createdAt);
                recordForegroundStart(historyId, t.agent, t.task, parallelThreads[index].createdAt);
                const prepared = herdrPrepared?.[index];
                const result = prepared
                  ? prepared.ok
                    ? await executeHerdrTask(prepared.handle, {
                        onState: (state) => threadStore.updateProgress(
                          parallelThreads[index].id,
                          herdrProgress(t.agent, t.task, state, prepared.startedAt, prepared.timeoutMs),
                        ),
                        // Covers abortOnFailure AND parent abort (parent abort
                        // feeds parallelController via onParentAbort).
                        signal: parallelController.signal,
                      })
                    : herdrErrorResult(t.agent, t.task, prepared.error)
                  : await runOne(
                      t.agent, t.task, t.cwd,
                      parallelController.signal, t.timeout ?? params.timeout,
                      (partial) => threadStore.updateThread(parallelThreads[index].id, { result: partial }),
                      (progress) => threadStore.updateProgress(parallelThreads[index].id, progress),
                      () => makeDetails("parallel")([...allResults]),
                      () => threadStore.refreshHeartbeat(parallelThreads[index].id),
                      undefined,
                      t.merge,
                    );
                allResults[index] = result;
                threadStore.updateThread(parallelThreads[index].id, {
                  status: isFailedResult(result) ? (result.stopReason === "aborted" ? "aborted" : "failed") : "completed",
                  result,
                });
                recordForegroundHistory(historyId, t.agent, t.task, result, parallelThreads[index].createdAt);
                // Early-abort: if this task failed and abortOnFailure is set
                if (abortOnFailure && isFailedResult(result) && !abortCause) {
                  abortCause = result.stopReason === "timeout" ? "timeout" : "sibling";
                  parallelController.abort();
                }
                emitParallelUpdate();
                return result;
              },
            );

            // Blocked herdr panes (status "partial") are neither succeeded nor
            // failed — they await human input and get their own count.
            const blockedCount = results.filter((r) => r.stopReason === "blocked").length;
            const successCount = results.filter((r) => !isFailedResult(r) && r.stopReason !== "blocked").length;
            const cancelCount = results.filter((r) => r.stopReason === "aborted" && r.errorMessage?.includes("Cancelled")).length;
            const summaries = results.map((r) => {
              const output = truncateParallelOutput(getResultOutput(r));
              const status = isFailedResult(r)
                ? `failed${r.stopReason ? ` (${r.stopReason})` : ""}`
                : r.stopReason === "blocked"
                  ? "blocked — awaiting input in its pane"
                  : "completed";
              const patch = formatPatchBlock(r);
              return `### [${r.agent}] ${status}\n\n${output}${patch ? `\n\n${patch}` : ""}`;
            });

            let headerText = `Parallel: ${successCount}/${results.length} succeeded`;
            if (blockedCount > 0) headerText += ` (${blockedCount} blocked awaiting input)`;
            if (cancelCount > 0) headerText += ` (${cancelCount} cancelled)`;
            return {
              content: [
                {
                  type: "text",
                  text: `${headerText}\n\n${summaries.join("\n\n---\n\n")}`,
                },
              ],
              details: makeDetails("parallel")(results),
            };
        } finally {
          stopParallelHeartbeat?.();
          cleanupParentSignal?.();
        }
      }

      // --- Single mode ---
      if (params.agent && params.task) {
        // Background: run detached, return receipt immediately, notify on completion.
        if (params.background) {
          const { taskId, receipt } = startBackgroundTask({
            agent: params.agent,
            task: params.task,
            cwd: params.cwd,
            timeout: params.timeout,
            merge: params.merge,
            agentColor: agentToThemeColor(params.agent),
            toolCallId: _toolCallId,
            deps: { pi, ctx, runOne, threadStore },
          });
          if (ctx.mode === "tui") widget.ensureWidget(ctx);
          // A foreground rerun of a pinned-sdk / disabled / unprobed call would
          // also run in-process — only advise when it would really delegate.
          const hint = backgroundHerdrHint(await wouldHerdrDelegate(params.runner, (ctx as any).settings?.subagent, herdrCli.exec));
          const receiptText = hint ? `${receipt}\n${hint}` : receipt;
          return {
            content: [{ type: "text", text: receiptText }],
            details: { ...makeDetails("single")([]), backgroundTaskId: taskId },
          };
        }
        const thread = threadStore.createThread({
          agentName: params.agent,
          task: params.task,
          mode: "single",
          toolCallId: _toolCallId,
          color: agentToThemeColor(params.agent),
        });
        if (ctx.mode === "tui") widget.ensureWidget(ctx);
        const historyId = makeForegroundHistoryId(thread.createdAt);
        recordForegroundStart(historyId, params.agent, params.task, thread.createdAt);
        const result = herdrActive
          ? await startHerdrOne(
              params.agent, params.task, params.cwd,
              signal, params.timeout,
              (progress) => threadStore.updateProgress(thread.id, progress),
              onUpdate,
              () => makeDetails("single")([]),
              () => threadStore.refreshHeartbeat(thread.id),
            )
          : await runOne(
              params.agent, params.task, params.cwd,
              signal, params.timeout,
              (partial) => threadStore.updateThread(thread.id, { result: partial }),
              (progress) => threadStore.updateProgress(thread.id, progress),
              () => makeDetails("single")([]),
              () => threadStore.refreshHeartbeat(thread.id),
              undefined,
              params.merge,
            );
        threadStore.updateThread(thread.id, {
          status: isFailedResult(result) ? (result.stopReason === "aborted" ? "aborted" : "failed") : "completed",
          result,
        });
        recordForegroundHistory(historyId, params.agent, params.task, result, thread.createdAt);
        const isError = isFailedResult(result);

        if (onUpdate) {
          onUpdate({
            content: [
              { type: "text", text: getFinalOutput(result.messages) || "(running...)" },
            ],
            details: makeDetails("single")([result]),
          });
        }

        if (isError) {
          const errorMsg = getResultOutput(result);
          const patch = formatPatchBlock(result);
          return {
            content: [
              {
                type: "text",
                text: `Agent ${result.stopReason || "failed"}: ${errorMsg}${patch ? `\n\n${patch}` : ""}`,
              },
            ],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }

        // Herdr panes blocked on a permission/question dialog are not
        // successes with no output — tell the model exactly what happened.
        if (result.stopReason === "blocked") {
          return {
            content: [{
              type: "text",
              text: `${params.agent} is blocked awaiting input in its herdr pane — answer it there (or via the herdr tool), then prompt again. ${result.errorMessage ?? ""}`,
            }],
            details: makeDetails("single")([result]),
          };
        }

        return {
          content: [
            { type: "text", text: [getFinalOutput(result.messages) || "(no output)", formatPatchBlock(result)].filter(Boolean).join("\n\n") },
          ],
          details: makeDetails("single")([result]),
        };
      }

      // Exhaustiveness check: the modeCount === 1 validation above ensures
      // at least one of the three branches is taken, but TS cannot prove it.
      throw new Error("unreachable");
    },

    // ------------------------------------------------------------------
    // TUI rendering
    // ------------------------------------------------------------------

    renderCall(args, theme, context) {
      const scope: AgentScope = args.agentScope ?? "user";
      const fg = theme.fg.bind(theme);
      const now = Date.now();

      // Live-render driver: while the tool executes, re-render every second
      // (bash.js pattern) so elapsed + tool-call count stay fresh in the TUI.
      // The interval lives in shared renderer state, cleared by renderResult.
      const state = context.state as { interval?: ReturnType<typeof setInterval> };
      if (context.executionStarted && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }

      // Look up threads for this tool call (stable toolCallId).
      const threads = threadStore
        .getAllThreads()
        .filter((t) => t.toolCallId === context.toolCallId);
      const runningThread = threads.find((t) => t.status === "running");

      // Task control (status/cancel) — no agent/task; show the operation.
      if (args.operation) {
        return new Text(
          fg("accent", String(args.operation)) +
          fg("muted", args.taskId ? ` [${args.taskId}]` : ""),
          0, 0,
        );
      }

      // Chain
      if (args.chain && args.chain.length > 0) {
        let text =
          fg("accent", `chain (${args.chain.length} steps)`) +
          fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          const stepThread = threads[i];
          const live = stepThread && stepThread.status === "running"
            ? "\n  " + renderLiveThreadLine(stepThread, theme, now, resolveAgentColor(step.agent))
            : "";
          text +=
            "\n  " +
            fg("muted", `${i + 1}.`) +
            " " +
            fg(resolveAgentColor(step.agent), step.agent) +
            fg("dim", ` ${preview}`) +
            live;
        }
        if (args.chain.length > 3)
          text += `\n  ${fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }

      // Parallel — live line per task with a running thread.
      if (args.tasks && args.tasks.length > 0) {
        let text =
          fg("accent", `parallel (${args.tasks.length} tasks)`) +
          fg("muted", ` [${scope}]`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          const taskThread = threads.find((th) => th.agentName === t.agent && th.task === t.task);
          const live = taskThread && taskThread.status === "running"
            ? "\n  " + renderLiveThreadLine(taskThread, theme, now, resolveAgentColor(t.agent))
            : "";
          text += `\n  ${fg(resolveAgentColor(t.agent), t.agent)}${fg("dim", ` ${preview}`)}${live}`;
        }
        if (args.tasks.length > 3)
          text += `\n  ${fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }

      // Single — live header while running, static summary otherwise.
      const agentName = args.agent || "...";
      const preview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : "...";
      let text =
        fg(resolveAgentColor(agentName), agentName) +
        fg("muted", ` [${scope}]`) +
        (args.background ? fg("dim", " bg") : "");
      if (runningThread) {
        text += "\n" + renderLiveThreadLine(runningThread, theme, now, resolveAgentColor(agentName));
      } else {
        text += `\n  ${fg("dim", preview)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      // Stop the live-render interval started by renderCall (shared state).
      const state = _context.state as { interval?: ReturnType<typeof setInterval> };
      if (state?.interval) {
        clearInterval(state.interval);
        state.interval = undefined;
      }

      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const fg = theme.fg.bind(theme);
      const mdTheme = getMarkdownTheme();

      // --- Single ---
      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        return renderSingleResult(r, expanded, theme, resolveAgentColor(r.agent));
      }

      // --- Chain ---
      if (details.mode === "chain") {
        const successCount = details.results.filter((r) => !isFailedResult(r)).length;
        const icon =
          successCount === details.results.length
            ? fg("success", "✓")
            : fg("error", "✗");

        if (expanded) {
          const container = new Container();
          container.addChild(
            new Text(
              icon +
                " " +
                fg("toolTitle", theme.bold("chain ")) +
                fg("accent", `${successCount}/${details.results.length} steps`),
              0,
              0,
            ),
          );
          for (const r of details.results) {
            container.addChild(new Spacer(1));
            const stepIcon = isFailedResult(r) ? fg("error", "✗") : fg("success", "✓");
            container.addChild(
              new Text(
                fg("muted", `─── Step ${r.exitCode !== -1 ? "" : "?"}: `) +
                  fg(resolveAgentColor(r.agent), r.agent) +
                  ` ${stepIcon}`,
                0,
                0,
              ),
            );
            if (r.errorMessage) {
              container.addChild(
                new Text(fg("error", `Error: ${r.errorMessage}`), 0, 0),
              );
            }
            const finalOutput = getResultOutput(r);
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }
            const usageStr = formatUsageStats(r.usage, r.model);
            if (usageStr)
              container.addChild(new Text(fg("dim", usageStr), 0, 0));
          }
          const totalUsage = formatUsageStats(aggregateUsage(details.results));
          if (totalUsage) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(fg("dim", `Total: ${totalUsage}`), 0, 0));
          }
          return container;
        }

        let text =
          icon +
          " " +
          fg("toolTitle", theme.bold("chain ")) +
          fg("accent", `${successCount}/${details.results.length} steps`);
        for (const r of details.results) {
          const stepIcon = isFailedResult(r) ? fg("error", "✗") : fg("success", "✓");
          const color = resolveAgentColor(r.agent);
          text += `\n  ${stepIcon} ${fg(color, r.agent)}`;
        }
        const totalUsage = formatUsageStats(aggregateUsage(details.results));
        if (totalUsage) text += `\n${fg("dim", totalUsage)}`;
        text += `\n${fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      // --- Parallel ---
      if (details.mode === "parallel") {
        const running = details.results.filter((r) => r.exitCode === -1).length;
        const successCount = details.results.filter(
          (r) => r.exitCode !== -1 && !isFailedResult(r),
        ).length;
        const failCount = details.results.filter(
          (r) => r.exitCode !== -1 && isFailedResult(r),
        ).length;
        const isRunning = running > 0;
        const icon = isRunning
          ? fg("warning", "⏳")
          : failCount > 0
            ? fg("warning", "◐")
            : fg("success", "✓");
        const status = isRunning
          ? `${successCount + failCount}/${details.results.length} done, ${running} running`
          : `${successCount}/${details.results.length} tasks`;

        if (expanded && !isRunning) {
          const container = new Container();
          container.addChild(
            new Text(
              `${icon} ${fg("toolTitle", theme.bold("parallel "))}${fg("accent", status)}`,
              0,
              0,
            ),
          );
          for (const r of details.results) {
            container.addChild(new Spacer(1));
            const taskIcon = isFailedResult(r)
              ? fg("error", "✗")
              : fg("success", "✓");
            container.addChild(
              new Text(
                fg("muted", "─── ") + fg(resolveAgentColor(r.agent), r.agent) + ` ${taskIcon}`,
                0,
                0,
              ),
            );
            container.addChild(
              new Text(fg("muted", "Task: ") + fg("dim", r.task), 0, 0),
            );
            if (r.errorMessage) {
              container.addChild(
                new Text(fg("error", `Error: ${r.errorMessage}`), 0, 0),
              );
            }
            const finalOutput = getResultOutput(r);
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(
                new Markdown(finalOutput.trim(), 0, 0, mdTheme),
              );
            }
            const taskUsage = formatUsageStats(r.usage, r.model);
            if (taskUsage)
              container.addChild(new Text(fg("dim", taskUsage), 0, 0));
          }
          const totalUsage = formatUsageStats(aggregateUsage(details.results));
          if (totalUsage) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(fg("dim", `Total: ${totalUsage}`), 0, 0));
          }
          return container;
        }

        let text = `${icon} ${fg("toolTitle", theme.bold("parallel "))}${fg("accent", status)}`;
        for (const r of details.results) {
          const taskIcon =
            r.exitCode === -1
              ? fg("warning", "⏳")
              : isFailedResult(r)
                ? fg("error", "✗")
                : fg("success", "✓");
          text += `\n  ${taskIcon} ${fg(resolveAgentColor(r.agent), r.agent)}`;
        }
        if (!isRunning) {
          const totalUsage = formatUsageStats(aggregateUsage(details.results));
          if (totalUsage) text += `\n${fg("dim", totalUsage)}`;
        }
        if (!expanded) text += `\n${fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      const fallback = result.content[0];
      return new Text(fallback?.type === "text" ? fallback.text : "(no output)", 0, 0);
    },
  });

  // ---------------------------------------------------------------------------
  // herdr control tool — main-session oversight of delegated pane agents
  // ---------------------------------------------------------------------------

  const HerdrControlParams = Type.Object({
    action: StringEnum(["list", "status", "read", "prompt", "cancel", "focus", "close-tab", "forget"] as const, {
      description:
        "list: delegated agents with live states; status: one agent's lifecycle state; " +
        "read: recent pane output (best-effort — TUI agents render on the alternate screen); " +
        "prompt: send a follow-up to the agent's session; cancel: interrupt (esc, then ctrl+c); " +
        "focus: raise the agent's tab; close-tab: close the tab of an agent this session delegated; " +
        "forget: drop a stale registry entry (e.g. after its tab was closed outside this session).",
    }),
    name: Type.Optional(Type.String({ description: "Herdr agent name (e.g. scout-1, from action \"list\"). Required for every action except list." })),
    text: Type.Optional(Type.String({ description: "Follow-up prompt text (action: prompt)." })),
    lines: Type.Optional(Type.Number({ description: "action: read — lines of recent output (default 120)." })),
    wait: Type.Optional(Type.Boolean({ description: "action: prompt — wait for a settled state and collect the report (default: submit and return immediately)." })),
    timeout: Type.Optional(Type.Number({ description: "action: prompt with wait:true — timeout in ms (default 120000)." })),
  });

  pi.registerTool({
    name: "herdr",
    label: "Herdr",
    description: [
      "Control agents this session delegated to herdr panes (subagent runner:\"herdr\", automatic inside herdr).",
      "Actions: list, status, read, prompt, cancel, focus, close-tab.",
    ].join(" "),
    parameters: HerdrControlParams,
    promptSnippet: "Control delegated herdr pane agents (list/status/read/prompt/cancel/focus/close-tab)",
    promptGuidelines: [
      "Use for oversight of herdr-delegated subagents: status/read to inspect, prompt to continue an agent's session, cancel to interrupt, focus to raise its tab.",
      "A blocked agent waits for human input — answer it in the pane directly, or cancel and re-delegate.",
      "prompt/cancel only accept agents this session delegated; status/read/focus can inspect any live herdr agent; close-tab only accepts tabs this session created.",
      "read is best-effort: pi renders on the terminal's alternate screen, so finished reports may not be scrollback-visible (delegated tasks deliver via report files instead).",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const toolResult = (text: string, isError = false) => ({
        content: [{ type: "text" as const, text }],
        isError,
        details: {},
      });
      if (!herdrEnvDetected()) {
        return toolResult("Not running inside herdr (HERDR_ENV!=1). Start pi inside a herdr pane to delegate agents to herdr tabs.", true);
      }
      if (herdrDisabled(undefined)) {
        // Delegated child session (PI_SUBAGENT_HERDR=off): no herdr control.
        return toolResult("herdr control is disabled in this session (PI_SUBAGENT_HERDR=off child guard).", true);
      }
      if (params.action !== "list" && !params.name) {
        return toolResult(`Missing name for action "${params.action}". Use a herdr agent name from action "list" (e.g. scout-1).`, true);
      }
      const name = params.name!;
      // Mutating actions are scoped to agents this session delegated —
      // Mutating actions are scoped to agents this session delegated —
      // the model must not drive (or kill) panes it never spawned.
      if ((params.action === "prompt" || params.action === "cancel") && !isDelegatedHerdrAgent(name)) {
        return toolResult(`"${name}" was not delegated by this session — refusing to ${params.action} an agent this session did not start. If this pane predates a /reload-runtime, interrupt or close it manually (herdr tab close <tabId>; tab id via herdr status).`, true);
      }
      switch (params.action) {
        case "list": {
          const entries = getHerdrRegistry();
          if (entries.length === 0) {
            return toolResult("No herdr-delegated agents this session. Delegation goes to herdr panes automatically while pi runs inside herdr (or with subagent runner:\"herdr\").");
          }
          const live = await listHerdrAgents(herdrCli.exec);
          const stateByPane = new Map(live.filter((a) => a.paneId).map((a) => [a.paneId!, a.status ?? "unknown"]));
          const lines = entries.map((e) =>
            `- ${e.name} · ${e.agentType} · ${stateByPane.get(e.paneId) ?? "unknown"} · tab ${e.tabId} / pane ${e.paneId} — ${e.task.slice(0, 60)}${e.task.length > 60 ? "…" : ""}`,
          );
          return toolResult(`Delegated herdr agents (${entries.length}):\n${lines.join("\n")}`);
        }
        case "status": {
          const info = await getAgentInfo(name, herdrCli.exec);
          if (!info) {
            return toolResult(`No herdr agent named "${name}".`, true);
          }
          return toolResult(`${name}: ${info.status ?? "unknown"} (tab ${info.tabId ?? "?"} / pane ${info.paneId ?? "?"}${info.cwd ? `, cwd ${info.cwd}` : ""})`);
        }
        case "read": {
          // Clamp scrollback size and cap the returned bytes (consistent with
          // report-file caps) — lines comes straight from the model.
          const lines = Math.min(Math.max(Math.trunc(params.lines ?? 120), 1), 1000);
          const res = await herdrCli.exec(
            "herdr",
            ["agent", "read", name, "--source", "recent-unwrapped", "--lines", String(lines)],
            { timeout: 10_000 },
          );
          const roEntry = getHerdrRegistry().find((e) => e.name === name);
          const text = res.code === 0
            ? res.stdout.trim().slice(0, MAX_REPORT_BYTES) || (roEntry?.readOnly
              ? "(no readable output — the agent may be rendering on the alternate screen; prompt it and it will reply inline — it has read-only tools and cannot write files)"
              : "(no readable output — the agent may be rendering on the alternate screen; prompt it to write its report to a file)")
            : `herdr agent read failed: ${(res.stderr || res.stdout).trim().split("\n")[0]}`;
          return toolResult(text, res.code !== 0);
        }
        case "prompt": {
          if (!params.text) {
            return toolResult('Missing text for action "prompt".', true);
          }
          if (Buffer.byteLength(params.text, "utf8") > HERDR_TASK_BUDGET) {
            return toolResult(`Prompt exceeds the ${HERDR_TASK_BUDGET}-byte budget (argv ceiling incl. delivery wrapper) — shorten it.`, true);
          }
          const entry = getHerdrRegistry().find((e) => e.name === name);
          // Delegated agents keep the delivery contract on follow-ups too
          // (report file — or inline reply for read-only children).
          const text = entry ? wrapTaskPrompt(params.text, entry.resultFile, entry.readOnly) : params.text;
          if (params.wait) {
            const timeoutMs = params.timeout ?? 120_000;
            const fileStampBefore = entry
              ? await fsPromises.stat(entry.resultFile).then((s) => `${s.size}:${s.mtimeMs}`).catch(() => "")
              : "";
            // Abortable: an aborted tool call interrupts the wait (esc to the
            // child) instead of blocking until the CLI timeout.
            const outcome = await new Promise<PromptOutcome>((resolve) => {
              let settled = false;
              const onAbort = () => {
                if (settled) return;
                settled = true;
                _signal?.removeEventListener("abort", onAbort);
                void cancelAgent(name, herdrCli.exec);
                resolve({ state: "unknown", delivered: false, error: "aborted: tool call cancelled" });
              };
              _signal?.addEventListener("abort", onAbort, { once: true });
              promptAndWait({ name, text, timeoutMs, exec: herdrCli.exec }).then((o) => {
                if (settled) return;
                settled = true;
                _signal?.removeEventListener("abort", onAbort);
                resolve(o);
              }, () => {
                if (settled) return;
                settled = true;
                _signal?.removeEventListener("abort", onAbort);
                resolve({ state: "unknown", delivered: false, error: "herdr agent prompt failed" });
              });
            });
            if (outcome.error) {
              return toolResult(`${name}: ${outcome.error} (state: ${outcome.state})`, true);
            }
            let output = "";
            if (entry) {
              const collected = await collectResult({ handle: entry, exec: herdrCli.exec });
              // Follow-ups reuse the same report file: only return its content
              // if THIS prompt changed it — otherwise the previous run's report
              // would come back as the answer.
              if (collected.source === "file") {
                const stampAfter = await fsPromises.stat(entry.resultFile).then((s) => `${s.size}:${s.mtimeMs}`).catch(() => "");
                if (stampAfter === fileStampBefore) {
                  // Unchanged file = the previous run's report — don't return
                  // it as the answer to this prompt.
                  return toolResult(`${name}: ${outcome.state} (no new report file content for this follow-up)`);
                }
                output = collected.output;
              } else {
                output = collected.output;
              }
            }
            return toolResult(`${name}: ${outcome.state}${output ? `\n\n${output}` : ""}`);
          }
          const res = await herdrCli.exec("herdr", ["agent", "prompt", name, text], { timeout: 15_000 });
          return toolResult(
            res.code === 0 ? `Prompt submitted to ${name}.` : `herdr agent prompt failed: ${(res.stderr || res.stdout).trim().split("\n")[0]}`,
            res.code !== 0,
          );
        }
        case "cancel": {
          await cancelAgent(name, herdrCli.exec);
          return toolResult(`Sent esc to ${name} (plus ctrl+c if it was still working).`);
        }
        case "focus": {
          const tabId = getHerdrRegistry().find((e) => e.name === name)?.tabId
            ?? (await getAgentInfo(name, herdrCli.exec))?.tabId;
          if (!tabId) {
            return toolResult(`No herdr agent named "${name}".`, true);
          }
          const res = await herdrCli.exec("herdr", ["tab", "focus", tabId], { timeout: 10_000 });
          return toolResult(
            res.code === 0 ? `Focused tab ${tabId}.` : `herdr tab focus failed: ${(res.stderr || res.stdout).trim().split("\n")[0]}`,
            res.code !== 0,
          );
        }
        case "close-tab": {
          const entry = getHerdrRegistry().find((e) => e.name === name);
          if (!entry) {
            return toolResult(`"${name}" was not delegated by this session — refusing to close tabs this session did not create. If this pane predates a /reload-runtime, close it manually (herdr tab close <tabId>; tab id via herdr status).`, true);
          }
          if (!canCloseHerdrTab(name)) {
            return toolResult(`"${name}" runs in a tab that existed before this session dispatched to it (label match) — reusing it for dispatch, but refusing to close it.`, true);
          }
          // Same-type agents share one tab: closing it kills every pane in it,
          // so refuse while the named agent or a sibling is still doing work.
          const live = await listHerdrAgents(herdrCli.exec);
          const stateByPane = new Map(live.filter((a) => a.paneId).map((a) => [a.paneId!, a.status]));
          const { siblings: busy, self: selfBusy } = herdrTabCloseBlockers(name, stateByPane);
          if (busy.length > 0) {
            return toolResult(`Refusing to close tab ${entry.tabId}: sibling agent(s) still busy or unverifiable: ${busy.join(", ")}. Cancel them first (herdr action "cancel") or wait until they settle.`, true);
          }
          if (selfBusy) {
            return toolResult(`"${name}" is still ${selfBusy} — cancel it first (herdr action "cancel") or wait for it to settle before closing its tab.`, true);
          }
          const res = await herdrCli.exec("herdr", ["tab", "close", entry.tabId], { timeout: 10_000 });
          if (res.code !== 0) {
            return toolResult(`herdr tab close failed: ${(res.stderr || res.stdout).trim().split("\n")[0]}`, true);
          }
          forgetHerdrTab(entry.tabId);
          return toolResult(`Closed tab ${entry.tabId} (all ${entry.agentType} panes in it).`);
        }
        case "forget": {
          // Registry hygiene: drops a stale entry (e.g. its tab was closed
          // outside this session). Never touches herdr state.
          if (!isDelegatedHerdrAgent(name)) {
            return toolResult(`"${name}" was not delegated by this session — nothing to forget.`, true);
          }
          forgetHerdrAgent(name);
          return toolResult(`Forgot ${name} (registry entry only — herdr panes/tabs untouched).`);
        }
      }
    },
  });
  // /agent command — switch between subagent threads.
  // When a thread is selected, the viewer replaces the main TUI (not overlay).
  pi.registerCommand("agent", {
    description: "Switch to a subagent thread to view its work in isolation",
    handler: async (_args, ctx) => {
      // Show picker overlay
      const selectedId = await showAgentPicker(ctx, buildPickerItems(threadStore.getAllThreads()));
      if (!selectedId) return; // Cancelled — stay in current view

      // Main selected — close viewer if active, return to conversation
      if (selectedId === "__main__") {
        if (activeViewerDone) {
          activeViewerDone();
          activeViewerDone = null;
        }
        return;
      }

      // Close existing viewer (if any) before opening new one
      if (activeViewerDone) {
        activeViewerDone();
        activeViewerDone = null;
      }

      // Show thread viewer (re-resolve against current store)
      const freshThreads = threadStore.getAllThreads();
      const idx = freshThreads.findIndex((t) => t.id === selectedId);
      if (idx === -1) {
        ctx.ui.notify("Selected subagent thread no longer exists.", "warning");
        return;
      }

      await showThreadViewer(ctx, freshThreads, idx);
    },
  });

  // ---------------------------------------------------------------------------
  // Module-level viewer state (so /agent can close an active viewer)
  // ---------------------------------------------------------------------------
  let activeViewerDone: (() => void) | null = null;

  // ---------------------------------------------------------------------------
  // Picker helpers (shared between /agent handler and Ctrl+P in viewer)
  // ---------------------------------------------------------------------------

  interface PickerItem { value: string; label: string; description: string }

  function buildPickerItems(threads: SubagentThread[]): PickerItem[] {
    const items: PickerItem[] = [
      { value: "__main__", label: "Main [default]", description: "(current)" },
    ];
    for (const t of threads) {
      let statusIcon: string;
      switch (t.status) {
        case "running": statusIcon = "⏳"; break;
        case "completed": statusIcon = "✓"; break;
        case "failed": statusIcon = "✗"; break;
        case "aborted": statusIcon = "✗"; break;
      }
      let modeTag = "";
      if (t.mode === "parallel-task") modeTag = " [parallel]";
      else if (t.mode === "chain-step") modeTag = " [chain]";
      const label = `${statusIcon} ${t.agentName}${modeTag}`;
      const desc = t.task.length > 60 ? `${t.task.slice(0, 57)}...` : t.task;
      items.push({ value: t.id, label, description: desc });
    }
    return items;
  }

  async function showAgentPicker(
    ctx: { ui: { custom: <T>(factory: any, opts?: any) => Promise<T> } },
    items: PickerItem[],
  ): Promise<string | null> {
    return ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (value: string | null) => void) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Subagents")), 1, 0));
      container.addChild(new Text(theme.fg("dim", "⌥ + ← previous, ⌥ + → next."), 1, 0));

      const selectList = new SelectList(
        items.map((it) => ({ value: it.value, label: it.label, description: it.description })),
        Math.min(items.length + 2, 15),
        {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        },
      );
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);

      container.addChild(new Text(
        `${theme.fg("dim", "↑↓ navigate · enter select · esc back")}`,
        1, 0,
      ));

      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => { selectList.handleInput(data); tui.requestRender(); },
      };
    }, { overlay: true });
  }

  // Helper: show thread viewer as overlay so editor remains visible.
  // Uses dynamic thread list + store subscriptions for live progress.
  // Ctrl+P opens picker overlay to jump to any thread.
  async function showThreadViewer(
    ctx: { ui: { custom: <T>(factory: any, opts?: any) => Promise<T> } },
    _threads: SubagentThread[],
    startIndex: number,
  ): Promise<void> {
    let currentIndex = startIndex;

    // Resolve thread list dynamically
    const getThreads = () => threadStore.getAllThreads();

    // Overlay mode: viewer appears above editor, Esc dismisses
    await ctx.ui.custom<void>((tui: any, theme: any, _kb: any, done: () => void) => {
      let unsubscribe: (() => void) | undefined;
      let closed = false;

      const cleanup = () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        activeViewerDone = null;
        done();
      };

      // Track this viewer so /agent can close it before opening a new one
      activeViewerDone = close;

      function makeCallbacks(): ThreadViewerCallbacks {
        const list = getThreads();
        return {
          onClose: close,
          onPrev: () => {
            const current = getThreads();
            if (currentIndex > 0) {
              currentIndex--;
              viewer.setThread(current[currentIndex], makeCallbacks());
              tui.requestRender();
            }
          },
          onNext: () => {
            const current = getThreads();
            if (currentIndex < current.length - 1) {
              currentIndex++;
              viewer.setThread(current[currentIndex], makeCallbacks());
              tui.requestRender();
            }
          },
          hasPrev: currentIndex > 0,
          hasNext: currentIndex < list.length - 1,
        };
      }

      const list = getThreads();
      if (list.length === 0 || currentIndex < 0 || currentIndex >= list.length) {
        close();
        return {
          render: (_w: number) => [],
          invalidate: () => {},
          handleInput: (_data: string) => {},
          dispose: () => {
          cleanup();
          if (activeViewerDone === close) activeViewerDone = null;
          closed = true;
        },
        };
      }

      const viewer = new ThreadViewer(list[currentIndex], makeCallbacks(), theme);
      let pickerOpen = false;

      // Subscribe to thread store for live updates (after viewer is created)
      unsubscribe = threadStore.subscribe(() => {
        const current = getThreads();
        if (current.length === 0) {
          close();
          return;
        }
        currentIndex = Math.min(currentIndex, current.length - 1);
        viewer.setThread(current[currentIndex], makeCallbacks());
        tui.requestRender();
      });

      return {
        render: (w: number) => viewer.render(w),
        invalidate: () => viewer.invalidate(),
        handleInput: (data: string) => {
          // Ctrl+P opens the picker to jump between threads
          if (data === "\x10") {
      if (!pickerOpen) {
        pickerOpen = true;
        openThreadPicker().finally(() => { pickerOpen = false; });
      }
            return;
          }
          viewer.handleInput(data);
          tui.requestRender();
        },
        dispose: () => {
          cleanup();
          if (activeViewerDone === close) activeViewerDone = null;
          closed = true;
        },
      };

      // Opens picker overlay on top of viewer to jump to any thread
      async function openThreadPicker() {
        const items = buildPickerItems(getThreads());
        const selectedId = await showAgentPicker(ctx, items);
        if (!selectedId) return;
        if (selectedId === "__main__") { close(); return; }
        const idx = getThreads().findIndex((t) => t.id === selectedId);
        if (idx >= 0) {
          currentIndex = idx;
          viewer.setThread(getThreads()[currentIndex], makeCallbacks());
          tui.requestRender();
        }
      }
    }, { overlay: true, overlayOptions: { maxHeight: "70%" } }); // Overlay: editor stays visible below
  }
}
