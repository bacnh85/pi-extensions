/**
 * SDK-based sub-agent runner for pi-subagent.
 *
 * Creates an in-process AgentSession via the pi SDK instead of spawning a
 * separate `pi` process. This eliminates cold-start overhead and allows
 * fine-grained control over token budget:
 *
 *   - Only the agent's system prompt is used (no pi defaults).
 *   - No AGENTS.md, no extensions, no skills, no prompt templates loaded.
 *   - Thinking disabled, compaction disabled, retry disabled.
 *   - In-memory session (no disk I/O).
 *   - Shared auth/model infrastructure (no re-connection).
 *
 * Estimated token savings vs process-spawn: ~4-11K tokens per invocation.
 */

import type { Message, Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	AuthStorage,
	createAgentSession,
	createExtensionRuntime,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubAgentResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runSubAgent(options: {
	cwd: string;
	systemPrompt: string;
	task: string;
	tools: string[];
	model: Model<any>;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	agentName?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	onUpdate?: (text: string) => void;
	onMessage?: (partialResult: SubAgentResult) => void;
}): Promise<SubAgentResult> {
	const {
		cwd,
		systemPrompt,
		task,
		tools,
		model,
		authStorage,
		modelRegistry,
		signal,
		agentName = "subagent",
		thinkingLevel = "off",
		onUpdate,
		onMessage,
	} = options;

	const result: SubAgentResult = {
		agent: agentName,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: `${model.provider}/${model.id}`,
	};

	// Build a minimal resource loader. The sub-agent sees ONLY the agent's
	// system prompt — no pi defaults, no AGENTS.md, no extensions, no skills.
	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});

	try {
		if (signal?.aborted) {
			result.exitCode = 1;
			result.stopReason = "aborted";
			result.errorMessage = "Sub-agent aborted before start";
			return result;
		}

		const { session } = await createAgentSession({
			cwd,
			model,
			thinkingLevel,
			authStorage,
			modelRegistry,
			resourceLoader,
			tools,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
		});

		let cleanupAbort: (() => void) | undefined;
		let cleanupEventAbort: (() => void) | undefined;
		try {
			// Wire abort signal
			if (signal) {
				const onAbort = () => session.abort();
				if (signal.aborted) {
					// Already aborted — shortcut
					result.exitCode = 1;
					result.stopReason = "aborted";
					result.errorMessage = "Sub-agent aborted before start";
					onAbort();
					return result;
				}
				signal.addEventListener("abort", onAbort, { once: true });
				cleanupAbort = () => signal.removeEventListener("abort", onAbort);
			}

			// Collect all messages and usage stats from events
			const eventPromise = new Promise<void>((resolve, reject) => {
				let settled = false;
				const finish = (fn: () => void) => {
					if (settled) return;
					settled = true;
					fn();
				};

				const unsubscribe = session.subscribe((event) => {
					try {
						switch (event.type) {
							case "message_end": {
								const msg = event.message as AgentMessage;
								if (msg.role === "assistant") {
									result.usage.turns++;
									if (msg.usage) {
										result.usage.input += msg.usage.input || 0;
										result.usage.output += msg.usage.output || 0;
										result.usage.cacheRead += msg.usage.cacheRead || 0;
										result.usage.cacheWrite += msg.usage.cacheWrite || 0;
										result.usage.cost += msg.usage.cost?.total || 0;
										result.usage.contextTokens = msg.usage.totalTokens || 0;
									}
									if (!result.model && msg.model) {
										result.model = `${msg.provider || "?"}/${msg.model}`;
									}
									if (msg.stopReason) result.stopReason = msg.stopReason;
									if (msg.errorMessage) result.errorMessage = msg.errorMessage;
								}
								// Collect all messages for extraction
								result.messages.push(msg as unknown as Message);
								if (onMessage) onMessage({ ...result, messages: [...result.messages] });
								break;
							}
							case "agent_end": {
								// agent_end carries all messages; use them if we haven't collected
								if (result.messages.length === 0 && event.messages) {
									result.messages = event.messages as unknown as Message[];
								}
								finish(() => {
									unsubscribe();
									resolve();
								});
								break;
							}
						}
					} catch (err) {
						finish(() => {
							unsubscribe();
							reject(err);
						});
					}
				});

				// Resolve on abort so the eventPromise doesn't hang
				if (signal) {
					const onAbortResolve = () => {
						finish(() => {
							result.exitCode = 1;
							result.stopReason = "aborted";
							if (!result.errorMessage) result.errorMessage = "Sub-agent aborted";
							unsubscribe();
							resolve();
						});
					};
					signal.addEventListener("abort", onAbortResolve, { once: true });
					cleanupEventAbort = () => signal.removeEventListener("abort", onAbortResolve);
				}
			});

			await Promise.race([
				session.prompt(task),
				eventPromise,
			]);

			if (result.stopReason !== "aborted") {
				result.exitCode = 0;
			}
			return result;
		} finally {
			cleanupAbort?.();
			cleanupEventAbort?.();
			try {
				session.dispose();
			} catch {
				// Best-effort cleanup
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		result.exitCode = 1;
		result.errorMessage = message;
		if (!result.stopReason) result.stopReason = "error";
		return result;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getFinalOutput(messages: Message[]): string {
	// Prefer the last assistant message with non-empty text and NO tool calls (pure final answer).
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const texts: string[] = [];
		let hasToolCalls = false;
		for (const part of msg.content) {
			if (part.type === "text" && part.text.trim()) texts.push(part.text);
			else if (part.type === "toolCall") hasToolCalls = true;
		}
		if (texts.length > 0 && !hasToolCalls) return texts.join("");
	}
	// Fallback: last assistant message with any non-empty text (even if it also has tool calls).
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const texts = msg.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text" && p.text.trim().length > 0)
			.map((p) => p.text);
		if (texts.length > 0) return texts.join("");
	}
	return "";
}

export function isFailedResult(result: SubAgentResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "timeout"
	);
}

export function getResultOutput(result: SubAgentResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/** Concurrency-limited map. Runs up to `concurrency` async operations at a time. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
