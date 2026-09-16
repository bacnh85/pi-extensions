import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig } from "./agents.ts";
import { runSubAgent, type SubAgentProgress, type SubAgentResult } from "./runner.ts";
import { resolveModel, runWithModelFallback } from "./model.ts";
import { effectiveAgentThinking, readSubagentRoles, resolveAgentModelChain } from "./roles.ts";
import {
  isRateLimitError,
  validateAgentTools,
  needsExtensions,
  resolveChildTimeouts,
  resolveSafeCwd,
  MAX_INSTRUCTIONS_LENGTH,
  READ_ONLY_TOOLS,
} from "./security.ts";

export const SUBAGENT_REQUEST_EVENT = "pi-subagent:run";

export interface SubagentRunRequest {
  id: string;
  agent: string;
  task: string;
  cwd?: string;
  timeout?: number;
  instructions?: string;
  readOnly?: boolean;
  signal?: AbortSignal;
  accept?: () => boolean;
  respond: (response: SubagentRunResponse) => void;
  onProgress?: (progress: SubAgentProgress) => void;
}

export type SubagentRunResponse =
  | { id: string; ok: true; result: SubAgentResult }
  | { id: string; ok: false; error: string };

export async function runNamedAgent(options: {
  agent: AgentConfig;
  task: string;
  cwd: string;
  ctx: ExtensionContext;
  timeout?: number;
  instructions?: string;
  signal?: AbortSignal;
  /** When true, only read-only tools are permitted regardless of agent.sandbox. */
  readOnly?: boolean;
  /** Trusted opt-out for child cwd outside the workspace (from getTrustedConfig). */
  allowExternalCwd?: boolean;
  onMessage?: (result: SubAgentResult) => void;
  onProgress?: (progress: SubAgentProgress) => void;
}): Promise<SubAgentResult> {
  const rolesCfg = readSubagentRoles(options.ctx);
  const agentChain = resolveAgentModelChain(options.agent, rolesCfg);
  const resolvedModel = await resolveModel(agentChain.candidates, options.ctx.model, options.ctx.modelRegistry);
  const { model, attempted } = resolvedModel;
  if (!model) throw new Error(`No model resolved for agent "${options.agent.name}" (tried: ${attempted.join(", ") || "none"})`);

  const modelRegistry = options.ctx.modelRegistry;
  const modelRuntime = (modelRegistry as any).runtime;
  const authStorage = (modelRegistry as any).authStorage;

  // Security: validate and normalise timeout — the same shared resolver the
  // tool path uses, so agent frontmatter `timeout:` is honored and the hard
  // lifetime cap is raised to match (never shorter than the idle window).
  const timeoutResult = resolveChildTimeouts({
    requested: options.timeout,
    agentTimeoutMins: options.agent.timeout,
  });
  if (timeoutResult.error) {
    throw new Error(timeoutResult.error);
  }
  const effectiveTimeoutMs = timeoutResult.timeoutMs;
  const effectiveHardMs = timeoutResult.hardTimeoutMs;

  // Parent tool names — agents without an explicit `tools` line inherit them.
  const parentToolNames = (options.ctx as any).getAllTools?.()?.map((t: { name: string }) => t.name) as string[] | undefined;

  // Security: validate tools against allowlist (built-ins ∪ inherited parent tools).
  // readOnly from the caller (e.g. pi-review) is enforced even when agent.sandbox
  // is unset — never trust a caller-supplied tool list without the read-only filter.
  const effectiveReadOnly = options.readOnly === true || options.agent.sandbox === "read-only";
  let rawTools = options.agent.tools ?? parentToolNames ?? ["read", "bash", "edit", "write", "grep", "find", "ls"];
  // Enforce read-only sandbox: strip mutating and execution tools
  if (effectiveReadOnly) {
    rawTools = rawTools.filter(t => READ_ONLY_TOOLS.includes(t));
    if (rawTools.length === 0) rawTools = [...READ_ONLY_TOOLS];
  }
  const toolValidation = validateAgentTools({ tools: rawTools, readOnly: effectiveReadOnly, availableTools: parentToolNames });
  if (toolValidation.errors.length > 0) {
    throw new Error(`Tool validation errors for agent "${options.agent.name}": ${toolValidation.errors.join("; ")}`);
  }
  const loadExtensions = needsExtensions(toolValidation.tools);
  const projectTrusted = options.ctx.isProjectTrusted();

  // Security: validate cwd (service caller must provide valid cwd).
  // The service path uses the same policy as the tool path.
  const safeCwd = resolveSafeCwd({ workspaceRoot: options.ctx.cwd, childCwd: options.cwd, allowExternalCwd: options.allowExternalCwd });
  if (safeCwd.error) {
    throw new Error(safeCwd.error);
  }

  const contract = options.instructions?.slice(0, MAX_INSTRUCTIONS_LENGTH);

  // Retry loop: rate-limit model fallback — shared with the tool path so the
  // triedModels bookkeeping and per-candidate `:thinking` resolution stay in
  // one place (see runWithModelFallback in model.ts). Errors are thrown here;
  // the caller maps them to its own response shape.
  return runWithModelFallback<SubAgentResult>({
    candidates: agentChain.candidates,
    parentModel: options.ctx.model,
    modelRegistry: options.ctx.modelRegistry,
    thinkingByCandidate: agentChain.thinkingByCandidate,
    defaultThinking: effectiveAgentThinking(options.agent, rolesCfg),
    runAttempt: (model, thinkingLevel) =>
      runSubAgent({
        cwd: safeCwd.path,
        sandbox: options.agent.sandbox === "worktree" ? "worktree" : undefined,
        systemPrompt: contract ? `${options.agent.systemPrompt}\n\n## Task Contract\n${contract}` : options.agent.systemPrompt,
        task: options.task,
        tools: toolValidation.tools,
        model,
        modelRuntime,
        authStorage,
        modelRegistry,
        signal: options.signal,
        timeoutMs: effectiveTimeoutMs,
        hardTimeoutMs: effectiveHardMs,
        agentName: options.agent.name,
        thinkingLevel,
        onMessage: options.onMessage,
        onProgress: options.onProgress,
        loadExtensions,
        projectTrusted,
      }),
    isRateLimited: (result) => Boolean(result.errorMessage && isRateLimitError(result.errorMessage)),
    onExhausted: (reason, triedModels, remaining) => {
      const tried = triedModels.join(" → ") || "(none)";
      const parent = options.ctx.model ? `${options.ctx.model.provider}/${options.ctx.model.id}` : "none";
      if (reason === "no-model") {
        throw new Error(
          `All models rate-limited or unavailable. Tried: ${tried}. ` +
          `Remaining candidates: ${remaining.join(", ") || "none"}. ` +
          `Parent: ${parent}.`,
        );
      }
      throw new Error(`All available models exhausted. Tried: ${tried}.`);
    },
  });
}
