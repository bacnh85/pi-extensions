import { AuthStorage, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { runSubAgent, type SubAgentResult } from "./runner.ts";
import { resolveModel } from "./model.ts";

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
}): Promise<SubAgentResult> {
	const { model, attempted } = resolveModel(options.agent.model, options.ctx.model, options.ctx.modelRegistry);
	if (!model) throw new Error(`No model resolved for agent "${options.agent.name}" (tried: ${attempted.join(", ") || "none"})`);

	const authStorage = AuthStorage.inMemory();
	const modelRegistry = options.ctx.modelRegistry;
	const auth = await options.ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok) {
		if (auth.apiKey) authStorage.setRuntimeApiKey(model.provider, auth.apiKey);
		// ponytail: env and headers stay on the parent modelRegistry — reuse it directly.
	}

	const timeoutController = options.timeout && options.timeout > 0 ? new AbortController() : undefined;
	const timeoutId = timeoutController ? setTimeout(() => timeoutController.abort(), options.timeout) : undefined;
	const signals = [options.signal, timeoutController?.signal].filter((value): value is AbortSignal => Boolean(value));
	const signal = signals.length > 1
		? typeof (AbortSignal as any).any === "function"
			? (AbortSignal as any).any(signals)
			: signals[0]
		: signals[0];
	const contract = options.instructions?.slice(0, 16 * 1024);

	try {
		const result = await runSubAgent({
			cwd: options.cwd,
			systemPrompt: contract ? `${options.agent.systemPrompt}\n\n## Task Contract\n${contract}` : options.agent.systemPrompt,
			task: options.task,
			tools: (options.agent.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"]).filter((tool) => tool !== "subagent"),
			model,
			authStorage,
			modelRegistry,
			signal,
			agentName: options.agent.name,
			thinkingLevel: options.agent.thinking,
			onMessage: options.onMessage,
		});
		if (timeoutController?.signal.aborted && !options.signal?.aborted) {
			result.exitCode = 1;
			result.stopReason = "timeout";
			result.errorMessage ||= `Timeout after ${options.timeout}ms`;
		}
		return result;
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
