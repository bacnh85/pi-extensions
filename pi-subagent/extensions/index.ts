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
import { StringEnum } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  DynamicBorder,
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
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  mapWithConcurrencyLimit,
  runSubAgent,
  startHeartbeat,
} from "./runner.ts";
import {
  isRateLimitError,
  normalizeTimeout,
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
import { resolveModel } from "./model.ts";
import { ThreadViewer, type ThreadViewerCallbacks } from "./thread-viewer.ts";
import { createTaskWidgetController, renderLiveThreadLine, type TaskWidgetController } from "./widget.ts";
import {
  startBackgroundTask,
  cancelBackgroundTask,
  getBackgroundTask,
  snapshotTask,
  clearBackgroundTasks,
} from "./background.ts";
import { parseStructuredResult } from "./result.ts";
import { appendHistory, readHistory, markInterruptedOnRestart, trimHistory, getHistoryPath } from "./history.ts";

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


// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
  timeout: Type.Optional(Type.Number({ description: "Inactivity timeout in milliseconds for this task; real child activity resets it (default 3 minutes, absolute cap 20 minutes)" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
  timeout: Type.Optional(Type.Number({ description: "Inactivity timeout in milliseconds for this step; real child activity resets it (default 3 minutes, absolute cap 20 minutes)" })),
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
  timeout: Type.Optional(Type.Number({ description: "Global inactivity timeout in milliseconds (default 3 minutes; real activity resets it; fixed 20-minute absolute cap)" })),
  instructions: Type.Optional(Type.String({ description: "Bounded repository/task instructions passed to each child (max 16 KB)" })),
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
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let currentCtx: ExtensionContext | undefined;

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
    // Clear any widget from a prior session.
    widget.clearWidgetIfIdle();
    // Mark prior-session running tasks as interrupted (we can't resume them).
    // ponytail: honest about the in-process ceiling — no live-session resume.
    try {
      markInterruptedOnRestart(path.join(ctx.cwd, CONFIG_DIR_NAME));
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
    const catalog = discovery.agents
      .map((agent) => {
        const candidates = getModelCandidates(agent);
        const modelInfo = candidates.length > 0
          ? ` (models: ${candidates.join(" → ")} → parent fallback)`
          : " (parent fallback)";
        const thinkingInfo = agent.thinking ? `, thinking: ${agent.thinking}` : "";
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
    description: "List available sub-agents, reload agent definitions, or show agent details",
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
          content: `Available agents (${discovery.agents.length}):\n  ${list.text}${extra}${diagText}\n\nScopes searched:\n  user: ${path.join(getAgentDir(), "agents")}${dirs}\n  bundled: ${bundledAgentsDir}\n\nUse /subagent <name> for agent details, /subagent reload to refresh.`,
          display: true,
        });
        return;
      }

      if (cmd) {
        // Show details for a specific agent
        const agent = discovery.agents.find(
          (a) => a.name.toLowerCase() === cmd,
        );
        if (!agent) {
          ctx.ui.notify(`Unknown agent: "${args.trim()}". Use /subagent to list all.`, "error");
          return;
        }
        const candidates = getModelCandidates(agent);
        pi.sendMessage({
          customType: "pi-subagent",
          content: [
            `Agent: ${agent.name} (${agent.source})`,
            `Description: ${agent.description}`,
            `Models: ${candidates.length > 0 ? `${candidates.join(" → ")} → parent fallback` : "parent fallback"}`,
            `Thinking: ${agent.thinking || "off"}`,
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

      // List all agents
      const list = formatAgentList(discovery.agents, 20);
      const extra = list.remaining > 0 ? `\n  ... +${list.remaining} more` : "";
      const dirs = discovery.projectAgentsDir ? `\n  project: ${discovery.projectAgentsDir}` : "";
      const diagText = discovery.diagnostics.length > 0
        ? "\n\nWarnings:\n" + discovery.diagnostics.map(d => `  - [${d.severity}] ${d.filePath}: ${d.issue}`).join("\n")
        : "";
      pi.sendMessage({
        customType: "pi-subagent",
        content: `Available agents (${discovery.agents.length}):\n  ${list.text}${extra}${diagText}\n\nScopes searched:\n  user: ${path.join(getAgentDir(), "agents")}${dirs}\n  bundled: ${bundledAgentsDir}\n\nUse /subagent <name> for agent details, /subagent reload to refresh.`,
        display: true,
      });
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
      "Use /subagent to list all available agents or /subagent <name> for agent details.",
    ],
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
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

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SubAgentResult[]): SubagentDetails => ({
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });

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
          details: makeDetails("single")([]),
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
            details: makeDetails("single")([]),
            isError: true,
          };
        }
        const bgTask = getBackgroundTask(taskId);
        if (params.operation === "status") {
          if (!bgTask) {
            return { content: [{ type: "text" as const, text: `No background task with id "${taskId}".` }], details: makeDetails("single")([]) };
          }
          const snap = snapshotTask(bgTask);
          const lines = [
            `Task ${snap.id} (${snap.agent}): ${snap.status}`,
            `Elapsed: ${Math.round(snap.elapsedMs / 1000)}s`,
            `Task: ${snap.task}`,
          ];
          if (snap.result) {
            lines.push(`Output: ${String(snap.result.output).slice(0, 2000)}`);
          } else {
            lines.push("(still running — no final output yet)");
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }], details: makeDetails("single")([]) };
        }

        // cancel
        const result = cancelBackgroundTask(taskId);
        if (result.outcome === "not_found") {
          return { content: [{ type: "text" as const, text: `No background task with id "${taskId}".` }], details: makeDetails("single")([]), isError: true };
        }
        if (result.outcome === "already_done") {
          return { content: [{ type: "text" as const, text: `Task ${taskId} already finished (${result.task?.status}).` }], details: makeDetails("single")([]) };
        }
        return { content: [{ type: "text" as const, text: `Cancelled background task ${taskId}.` }], details: makeDetails("single")([]) };
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
            if (ctx.hasUI) {
              const names = projectAgentsRequested.map((a) => a.name).join(", ");
              const dir = discovery.projectAgentsDir ?? "(unknown)";
              const ok = await ctx.ui.confirm(
                "Run project-local agents?",
                `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
              );
              if (!ok) {
                return {
                  content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
                  details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
                };
              }
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

      // Helper: record a completed foreground task to the history registry.
      // ponytail: best-effort — history is non-fatal metadata for /subagent history.
      function recordForegroundHistory(
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
            id: `fg-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
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

      // Helper: normalise timeout.
      function resolveChildTimeout(childTimeout: number | undefined, globalTimeout: number | undefined): number | undefined {
        const effectiveTimeout = childTimeout ?? globalTimeout;
        const result = normalizeTimeout({ requested: effectiveTimeout });
        if (result.error) {
          throw new Error(result.error);
        }
        return result.timeoutMs;
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

        const resolved = await resolveModel(getModelCandidates(agent), ctx.model, ctx.modelRegistry);
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
        let safeCwd: string;
        try {
          const resolved = resolveChildTools(agent.tools, agent.sandbox, isReadOnly);
          tools = resolved.tools;
          loadExtensions = resolved.loadExtensions;
          effectiveTimeoutMs = resolveChildTimeout(timeoutMs, params.timeout);
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

        // Retry loop: rate-limit model fallback
        const candidates = getModelCandidates(agent);
        const triedModels: string[] = [];

        // Transport keep-alive only: resets parent idle timeout so a long child
        // run isn't killed. The visible progress now lives in the live widget;
        // we no longer push the plain "still running…" text.
        const stopHeartbeat = onUpdate ? startHeartbeat(() => {
          onHeartbeat?.();
          onUpdate({ content: [{ type: "text", text: "" }], details: heartbeatDetails?.() ?? makeDetails("single")([]) });
          widget.requestRender();
        }) : undefined;
        try {
          const tryWithFallback = async (): Promise<SubAgentResult> => {
            const remaining = candidates.filter(m => !triedModels.includes(m));
            const isParentFallback = remaining.length === 0;
            const fallbackResolved = await resolveModel(remaining, ctx.model, ctx.modelRegistry);
            if (!fallbackResolved.model) {
              return {
                agent: agentName,
                task,
                exitCode: 1,
                status: "error" as const,
                stopReason: "error" as const,
                messages: [],
                stderr: [
                  `All models rate-limited or unavailable.`,
                  `Tried: ${triedModels.join(" → ") || "(none)"}.`,
                  `Remaining candidates: ${remaining.join(", ") || "none"}.`,
                  `Parent: ${ctx.model?.provider}/${ctx.model?.id}.`,
                ].join(" "),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                errorMessage: `All models exhausted (tried: ${triedModels.join(" → ") || "none"})`,
              };
            }
            const triedName = `${fallbackResolved.model!.provider}/${fallbackResolved.model!.id}`;
            if (triedModels.includes(triedName)) {
              // Already tried this model (e.g., all candidates unavailable
              // and parent fallback) — no further options.
              return {
                agent: agentName,
                task,
                exitCode: 1,
                status: "error" as const,
                stopReason: "error" as const,
                messages: [],
                stderr: [
                  `All available models exhausted.`,
                  `Tried: ${triedModels.join(" → ")}.`,
                ].join(" "),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                errorMessage: `All available models exhausted (tried: ${triedModels.join(" → ")})`,
              };
            }
            triedModels.push(triedName);
            // Also track the raw candidate name so candidates.filter() can
            // exclude it even when the agent uses unqualified names.
            // Avoid duplicating when candidate name is already qualified (matchedCandidate === triedName).
            if (fallbackResolved.matchedCandidate && fallbackResolved.matchedCandidate !== triedName) {
              triedModels.push(fallbackResolved.matchedCandidate);
            }

            const result = await runSubAgent({
              cwd: safeCwd,
              sandbox: agent.sandbox === "worktree" ? "worktree" : undefined,
              systemPrompt: params.instructions
              ? `${agent.systemPrompt}\n\n## Task Contract\n${params.instructions.slice(0, MAX_INSTRUCTIONS_LENGTH)}`
              : agent.systemPrompt,
              task,
              tools,
              model: fallbackResolved.model,
              modelRuntime,
              authStorage,
              modelRegistry,
              signal: parentSignal,
              timeoutMs: effectiveTimeoutMs,
              agentName,
              thinkingLevel: agent.thinking,
              onMessage: onProgress,
              onProgress: onActivity,
              loadExtensions,
              projectTrusted,
            });

            if (result.errorMessage && isRateLimitError(result.errorMessage)) {
              // If the model that just rate-limited was the parent fallback
              // (no remaining candidates), stop — no further options.
              if (isParentFallback) {
                return {
                  agent: agentName,
                  task,
                  exitCode: 1,
                  status: "error" as const,
                  stopReason: "error" as const,
                  messages: [],
                  stderr: [
                    `All available models exhausted.`,
                    `Tried: ${triedModels.join(" → ")}.`,
                  ].join(" "),
                  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                  errorMessage: `All available models exhausted (tried: ${triedModels.join(" → ")})`,
                };
              }
              return tryWithFallback();
            }
            return result;
          };

          return tryWithFallback();
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

          const thread = threadStore.createThread({
            agentName: step.agent,
            task: taskWithContext,
            mode: "chain-step",
            toolCallId: _toolCallId,
            color: agentToThemeColor(step.agent),
          });
          if (ctx.mode === "tui") widget.ensureWidget(ctx);
          const result = await runOne(
            step.agent, taskWithContext, step.cwd,
            signal, step.timeout ?? params.timeout,
            (partial) => threadStore.updateThread(thread.id, { result: partial }),
            (progress) => threadStore.updateProgress(thread.id, progress),
            () => makeDetails("chain")(results),
            () => threadStore.refreshHeartbeat(thread.id),
          );
          threadStore.updateThread(thread.id, {
            status: isFailedResult(result) ? (result.stopReason === "aborted" ? "aborted" : "failed") : "completed",
            result,
          });
          recordForegroundHistory(step.agent, taskWithContext, result, thread.createdAt);
          results.push(result);

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
              content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
              details: makeDetails("chain")(results),
            });
          }
        }

        const last = results[results.length - 1];
        return {
          content: [
            { type: "text", text: getFinalOutput(last.messages) || "(no output)" },
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
                const result = await runOne(
                  t.agent, t.task, t.cwd,
                  parallelController.signal, t.timeout ?? params.timeout,
                  (partial) => threadStore.updateThread(parallelThreads[index].id, { result: partial }),
                  (progress) => threadStore.updateProgress(parallelThreads[index].id, progress),
                  () => makeDetails("parallel")([...allResults]),
                  () => threadStore.refreshHeartbeat(parallelThreads[index].id),
                );
                allResults[index] = result;
                threadStore.updateThread(parallelThreads[index].id, {
                  status: isFailedResult(result) ? (result.stopReason === "aborted" ? "aborted" : "failed") : "completed",
                  result,
                });
                recordForegroundHistory(t.agent, t.task, result, parallelThreads[index].createdAt);
                // Early-abort: if this task failed and abortOnFailure is set
                if (abortOnFailure && isFailedResult(result) && !abortCause) {
                  abortCause = result.stopReason === "timeout" ? "timeout" : "sibling";
                  parallelController.abort();
                }
                emitParallelUpdate();
                return result;
              },
            );

            const successCount = results.filter((r) => !isFailedResult(r)).length;
            const cancelCount = results.filter((r) => r.stopReason === "aborted" && r.errorMessage?.includes("Cancelled")).length;
            const summaries = results.map((r) => {
              const output = truncateParallelOutput(getResultOutput(r));
              const status = isFailedResult(r)
                ? `failed${r.stopReason ? ` (${r.stopReason})` : ""}`
                : "completed";
              return `### [${r.agent}] ${status}\n\n${output}`;
            });

            let headerText = `Parallel: ${successCount}/${results.length} succeeded`;
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
            agentColor: agentToThemeColor(params.agent),
            toolCallId: _toolCallId,
            deps: { pi, ctx, runOne, threadStore },
          });
          if (ctx.mode === "tui") widget.ensureWidget(ctx);
          return {
            content: [{ type: "text", text: receipt }],
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
        const result = await runOne(
          params.agent, params.task, params.cwd,
          signal, params.timeout,
          (partial) => threadStore.updateThread(thread.id, { result: partial }),
          (progress) => threadStore.updateProgress(thread.id, progress),
          () => makeDetails("single")([]),
          () => threadStore.refreshHeartbeat(thread.id),
        );
        threadStore.updateThread(thread.id, {
          status: isFailedResult(result) ? (result.stopReason === "aborted" ? "aborted" : "failed") : "completed",
          result,
        });
        recordForegroundHistory(params.agent, params.task, result, thread.createdAt);
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
          return {
            content: [
              {
                type: "text",
                text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
              },
            ],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }

        return {
          content: [
            { type: "text", text: getFinalOutput(result.messages) || "(no output)" },
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