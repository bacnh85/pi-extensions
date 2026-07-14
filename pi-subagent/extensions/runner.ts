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
import {
	classifyStopReason,
	createCombinedAbortSignal,
	type SubagentStatus,
} from "./security.ts";

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
	/** Canonical result status (added in 0.6.0). */
	status?: SubagentStatus;
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
	onMessage?: (partialResult: SubAgentResult) => void;
	/** Pre-validated timeout in ms. When provided, an abort signal will be created. */
	timeoutMs?: number;
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
		onMessage,
		timeoutMs,
	} = options;

	const result: SubAgentResult = {
		agent: agentName,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: `${model.provider}/${model.id}`,
		status: undefined,
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

	// Hoisted so the outer catch can clean up on early failure.
	let timeoutController: AbortController | undefined;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let cleanupCombined: (() => void) | undefined;

	try {
		// Build combined signal from parent signal and timeout
		const signalsToCombine: (AbortSignal | undefined | null | false)[] = [signal];

		// Create timeout controller
		if (timeoutMs && timeoutMs > 0) {
			timeoutController = new AbortController();
			timeoutId = setTimeout(() => timeoutController!.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
			signalsToCombine.push(timeoutController.signal);
		}

		const { signal: combinedSignal, cleanup: cleanupCb } = createCombinedAbortSignal(signalsToCombine);
		cleanupCombined = cleanupCb;

		if (combinedSignal.aborted) {
			result.exitCode = 1;
			const isTimeout = timeoutController?.signal.aborted === true && signal?.aborted !== true;
			result.stopReason = isTimeout ? "timeout" : "aborted";
			result.errorMessage = combinedSignal.reason instanceof Error ? combinedSignal.reason.message : "Sub-agent aborted before start";
			result.status = classifyStopReason(result.stopReason, !isTimeout, isTimeout);
			cleanupCombined?.();
			if (timeoutId) clearTimeout(timeoutId);
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
		let abortedBySignal = false;
		let timedOut = false;
		let eventUnsubscribe: (() => void) | undefined;

		try {
			// Wire combined abort signal to session
			const onAbort = () => {
				session.abort();
			};
			if (combinedSignal.aborted) {
				abortedBySignal = true;
				timedOut = timeoutController?.signal.aborted === true && signal?.aborted !== true;
				onAbort();
				return result;
			}
			combinedSignal.addEventListener("abort", onAbort, { once: true });
			cleanupAbort = () => combinedSignal.removeEventListener("abort", onAbort);

			// Collect all messages and usage stats from events
			const eventPromise = new Promise<void>((resolve, reject) => {
				let settled = false;
				const finish = (fn: () => void) => {
					if (settled) return;
					settled = true;
					fn();
				};

				let unsubscribe: (() => void) | undefined;
				unsubscribe = session.subscribe((event) => {
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
									unsubscribe?.();
									resolve();
								});
								break;
							}
						}
					} catch (err) {
						finish(() => {
							unsubscribe?.();
							reject(err);
						});
					}
				});
				eventUnsubscribe = unsubscribe;

				// Resolve on abort so the eventPromise doesn't hang
				const onAbortResolve = () => {
					finish(() => {
						result.exitCode = 1;
						if (!result.errorMessage) result.errorMessage = "Sub-agent aborted";
						unsubscribe?.();
						resolve();
					});
				};
				combinedSignal.addEventListener("abort", onAbortResolve, { once: true });
				cleanupEventAbort = () => combinedSignal.removeEventListener("abort", onAbortResolve);
			});

			await Promise.race([
				session.prompt(task),
				eventPromise,
			]);

			// Detect timeout vs. parent abort.
			timedOut = timeoutController?.signal.aborted === true && signal?.aborted !== true;
			abortedBySignal = combinedSignal.aborted && !timedOut;

			if (timedOut) {
				result.exitCode = 1;
				result.stopReason = "timeout";
				result.errorMessage ||= `Timeout after ${timeoutMs}ms`;
			} else if (abortedBySignal) {
				result.exitCode = 1;
				result.stopReason = "aborted";
				result.errorMessage ||= "Sub-agent aborted";
			} else {
				result.exitCode = 0;
			}

			// Classify canonical status.
			result.status = classifyStopReason(result.stopReason, result.stopReason === "aborted", result.stopReason === "timeout");

			return result;
		} finally {
			cleanupAbort?.();
			cleanupEventAbort?.();
			cleanupCombined();
			eventUnsubscribe?.();
			if (timeoutId) clearTimeout(timeoutId);
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
		result.status = classifyStopReason("error", false, false);
		// Ensure cleanup runs even when the outer try fails before the inner finally.
		cleanupCombined?.();
		if (timeoutId) clearTimeout(timeoutId);
		return result;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const texts: string[] = [];
		for (const part of msg.content) {
			if (part.type === "text" && part.text.trim()) texts.push(part.text);
		}
		if (texts.length === 0) continue;
		return texts.join("");
	}
	return "";
}

export function isFailedResult(result: SubAgentResult): boolean {
	// Use canonical status if available.
	if (result.status) {
		return result.status === "error" || result.status === "aborted" || result.status === "timeout";
	}
	// Fall back to legacy heuristics.
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
