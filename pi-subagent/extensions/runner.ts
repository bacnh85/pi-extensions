/**
 * SDK-based sub-agent runner for pi-subagent.
 *
 * Creates an in-process AgentSession via the pi SDK instead of spawning a
 * separate `pi` process. This eliminates cold-start overhead and allows
 * fine-grained control over token budget:
 *
 *   - Only the agent's system prompt is used (no pi defaults).
 *   - No AGENTS.md, no extensions, no skills, no prompt templates loaded.
 *   - Thinking disabled, compaction disabled, one transient retry.
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

export const DEFAULT_INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000;
export const HARD_TIMEOUT_MS = 20 * 60 * 1000;

export interface SubAgentProgress {
	label: string;
	at: number;
	elapsedMs: number;
	inactivityDeadline: number;
	hardDeadline: number;
	result: SubAgentResult;
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

export function startHeartbeat(onHeartbeat: () => void, intervalMs = 30_000): () => void {
	const timer = setInterval(onHeartbeat, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

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
	onProgress?: (progress: SubAgentProgress) => void;
	timeoutMs?: number;
	hardTimeoutMs?: number;
}): Promise<SubAgentResult> {
	const {
		cwd, systemPrompt, task, tools, model, authStorage, modelRegistry, signal,
		agentName = "subagent", thinkingLevel = "off", onMessage, onProgress,
		timeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS, hardTimeoutMs = HARD_TIMEOUT_MS,
	} = options;
	const result: SubAgentResult = {
		agent: agentName, task, exitCode: 0, messages: [], stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: `${model.provider}/${model.id}`, status: undefined,
	};
	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt, getAppendSystemPrompt: () => [], extendResources: () => {}, reload: async () => {},
	};
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1 } });
	const startedAt = Date.now();
	let inactivityDeadline = startedAt + timeoutMs;
	const hardDeadline = startedAt + hardTimeoutMs;
	let timeoutKind: "idle" | "hard" | undefined;
	const timeoutController = new AbortController();
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let hardTimer: ReturnType<typeof setTimeout> | undefined;
	let cleanupCombined: (() => void) | undefined;
	const clearTimers = () => { if (idleTimer) clearTimeout(idleTimer); if (hardTimer) clearTimeout(hardTimer); };
	const armIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		inactivityDeadline = Date.now() + timeoutMs;
		idleTimer = setTimeout(() => { timeoutKind = "idle"; timeoutController.abort(new Error(`Idle timeout after ${timeoutMs}ms`)); }, timeoutMs);
	};
	const snapshot = (label: string): SubAgentProgress => ({ label, at: Date.now(), elapsedMs: Date.now() - startedAt, inactivityDeadline, hardDeadline, result: { ...result, messages: [...result.messages] } });
	try {
		armIdle();
		hardTimer = setTimeout(() => { timeoutKind = "hard"; timeoutController.abort(new Error(`Hard timeout after ${hardTimeoutMs}ms`)); }, hardTimeoutMs);
		const { signal: combinedSignal, cleanup } = createCombinedAbortSignal([signal, timeoutController.signal]);
		cleanupCombined = cleanup;
		if (combinedSignal.aborted) {
			result.exitCode = 1;
			const timedOut = timeoutController.signal.aborted && !signal?.aborted;
			result.stopReason = timedOut ? "timeout" : "aborted";
			result.errorMessage = timedOut ? `${timeoutKind === "idle" ? "Idle" : "Hard"} timeout after ${timeoutKind === "idle" ? timeoutMs : hardTimeoutMs}ms` : "Sub-agent aborted before start";
			result.status = classifyStopReason(result.stopReason, !timedOut, timedOut);
			return result;
		}
		const { session } = await createAgentSession({ cwd, model, thinkingLevel, authStorage, modelRegistry, resourceLoader, tools, sessionManager: SessionManager.inMemory(cwd), settingsManager });
		let unsubscribe: (() => void) | undefined;
		let removeAbort: (() => void) | undefined;
		try {
			const eventDone = new Promise<void>((resolve, reject) => {
				let done = false;
				const finish = (fn: () => void) => { if (!done) { done = true; unsubscribe?.(); fn(); } };
				unsubscribe = session.subscribe((event) => {
					try {
						// Any SDK session lifecycle event is actual child activity, unlike a parent heartbeat.
						armIdle(); onProgress?.(snapshot(event.type));
						if (event.type === "message_end") {
							const msg = event.message as AgentMessage;
							if (msg.role === "assistant") {
								result.usage.turns++;
								if (msg.usage) { result.usage.input += msg.usage.input || 0; result.usage.output += msg.usage.output || 0; result.usage.cacheRead += msg.usage.cacheRead || 0; result.usage.cacheWrite += msg.usage.cacheWrite || 0; result.usage.cost += msg.usage.cost?.total || 0; result.usage.contextTokens = msg.usage.totalTokens || 0; }
								if (!result.model && msg.model) result.model = `${msg.provider || "?"}/${msg.model}`;
								if (msg.stopReason) result.stopReason = msg.stopReason;
								result.errorMessage = msg.errorMessage;
							}
							result.messages.push(msg as unknown as Message);
							onMessage?.({ ...result, messages: [...result.messages] });
						} else if (event.type === "agent_end" && !event.willRetry) {
							if (!result.messages.length && event.messages) result.messages = event.messages as unknown as Message[];
							finish(resolve);
						}
					} catch (error) { finish(() => reject(error)); }
				});
				const abort = () => finish(resolve);
				combinedSignal.addEventListener("abort", abort, { once: true });
				removeAbort = () => combinedSignal.removeEventListener("abort", abort);
			});
			const abortSession = () => session.abort();
			combinedSignal.addEventListener("abort", abortSession, { once: true });
			const removeSessionAbort = () => combinedSignal.removeEventListener("abort", abortSession);
			await Promise.race([session.prompt(task), eventDone]);
			removeSessionAbort();
			const timedOut = timeoutController.signal.aborted && !signal?.aborted;
			if (timedOut) { result.stopReason = "timeout"; result.errorMessage = `${timeoutKind === "idle" ? "Idle" : "Hard"} timeout after ${timeoutKind === "idle" ? timeoutMs : hardTimeoutMs}ms`; }
			else if (combinedSignal.aborted) { result.stopReason = "aborted"; result.errorMessage ||= "Sub-agent aborted"; }
			result.status = classifyStopReason(result.stopReason, result.stopReason === "aborted", result.stopReason === "timeout");
			result.exitCode = result.status === "success" || result.status === "partial" ? 0 : 1;
			return result;
		} finally {
			unsubscribe?.(); removeAbort?.();
			try { session.dispose(); } catch { /* best effort */ }
		}
	} catch (error) {
		result.exitCode = 1;
		result.errorMessage = error instanceof Error ? error.message : String(error);
		result.stopReason ||= "error";
		result.status = classifyStopReason(result.stopReason, false, false);
		return result;
	} finally {
		clearTimers(); cleanupCombined?.();
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
