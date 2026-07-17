import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, getModelCandidates } from "./agents.ts";
import { runSubAgent, type SubAgentProgress, type SubAgentResult } from "./runner.ts";
import { resolveModel } from "./model.ts";
import {
	validateAgentTools,
	normalizeTimeout,
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
	onMessage?: (result: SubAgentResult) => void;
	onProgress?: (progress: SubAgentProgress) => void;
}): Promise<SubAgentResult> {
	const { model, attempted } = await resolveModel(getModelCandidates(options.agent), options.ctx.model, options.ctx.modelRegistry);
	if (!model) throw new Error(`No model resolved for agent "${options.agent.name}" (tried: ${attempted.join(", ") || "none"})`);

	const modelRegistry = options.ctx.modelRegistry;
	const modelRuntime = (modelRegistry as any).runtime;
	const authStorage = (modelRegistry as any).authStorage;

	// Security: validate and normalise timeout.
	const effectiveTimeoutMs = normalizeTimeout({ requested: options.timeout }).timeoutMs;

	// Security: validate tools against allowlist.
	let rawTools = options.agent.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"];
	// Enforce read-only sandbox: strip mutating and execution tools
	if (options.agent.sandbox === "read-only") {
		rawTools = rawTools.filter(t => READ_ONLY_TOOLS.includes(t));
		if (rawTools.length === 0) rawTools = [...READ_ONLY_TOOLS];
	}
	const toolValidation = validateAgentTools({ tools: rawTools, readOnly: options.agent.sandbox === "read-only" });
	if (toolValidation.errors.length > 0) {
		throw new Error(`Tool validation errors for agent "${options.agent.name}": ${toolValidation.errors.join("; ")}`);
	}

	// Security: validate cwd (service caller must provide valid cwd).
	// The service path uses the same policy as the tool path.
	const safeCwd = resolveSafeCwd({ workspaceRoot: options.ctx.cwd, childCwd: options.cwd });
	if (safeCwd.error) {
		throw new Error(safeCwd.error);
	}

	const contract = options.instructions?.slice(0, MAX_INSTRUCTIONS_LENGTH);

	try {
		const result = await runSubAgent({
			cwd: safeCwd.path,
			systemPrompt: contract ? `${options.agent.systemPrompt}\n\n## Task Contract\n${contract}` : options.agent.systemPrompt,
			task: options.task,
			tools: toolValidation.tools,
			model,
			modelRuntime,
			authStorage,
			modelRegistry,
			signal: options.signal,
			timeoutMs: effectiveTimeoutMs,
			agentName: options.agent.name,
			thinkingLevel: options.agent.thinking,
			onMessage: options.onMessage,
			onProgress: options.onProgress,
		});
		return result;
	} finally {
		// No manual timeout handling needed — runSubAgent handles timeouts internally.
	}
}
