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
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	CONFIG_DIR_NAME,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList, invalidateAgentCache } from "./agents.ts";
import {
	type SubAgentResult,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	runSubAgent,
} from "./runner.ts";
import {
	normalizeTimeout,
	resolveSafeCwd,
	validateAgentTools,
	truncateParallelOutput,
	validateExecutionRequest,
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
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds for this task" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds for this step" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
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
	timeout: Type.Optional(Type.Number({ description: "Global timeout in milliseconds for all sub-agents (overridden by per-task/step timeouts)" })),
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
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;

	// Invalidate agent cache + clear thread store on session replacement.
	pi.on("session_start", (event, ctx) => {
		currentCtx = ctx;
		if (event.reason === "reload") invalidateAgentCache();
		threadStore.clear();
	});

	// Proactively steer agents toward sub-agent delegation when users mention it
	pi.on("before_agent_start", async (event) => {
		const prompt = event.prompt.toLowerCase();
		if (/\b(delegate to|use a subagent|run in parallel|spawn an agent|scout|review this|chain|worker agent)\b/.test(prompt)) {
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\nThe subagent tool is available for delegating tasks to specialized agents with isolated context. Use /subagent to list available agents. Bundled: scout (fast recon), reviewer (code review), worker (implementation), general-purpose (fallback). Modes: single, parallel (max 8), chain.",
			};
		}
	});

	// Resolve bundled agents directory relative to this extension file
	const bundledAgentsDir = path.resolve(__dirname, "../agents");

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
		const thread = threadStore.createThread({ agentName: agent.name, task: request.task, mode: "single" });
		void runNamedAgent({
			agent: request.readOnly ? { ...agent, tools: ["read", "grep", "find", "ls"] } : agent,
			task: request.task,
			cwd: request.cwd ?? ctx.cwd,
			ctx,
			timeout: request.timeout,
			instructions: request.instructions,
			signal: request.signal,
			onMessage: (result) => threadStore.updateThread(thread.id, { result }),
		}).then((result) => {
			threadStore.updateThread(thread.id, {
				status: isFailedResult(result) ? (result.stopReason === "aborted" ? "aborted" : "failed") : "completed",
				result,
			});
			if (isFailedResult(result)) request.respond({ id: request.id, ok: false, error: getResultOutput(result) });
			else request.respond({ id: request.id, ok: true, result });
		}, (error) => {
			threadStore.updateThread(thread.id, { status: "failed" });
			request.respond({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
		});
	});

	// /subagent command — list available agents
	pi.registerCommand("subagent", {
		description: "List available sub-agents, reload agent definitions, or show agent details",
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();
			const discovery = discoverAgents(ctx.cwd, "both", bundledAgentsDir);

			if (cmd === "reload" || cmd === "refresh") {
				invalidateAgentCache();
				const fresh = discoverAgents(ctx.cwd, "both", bundledAgentsDir);
				const list = formatAgentList(fresh.agents, 20);
				const extra = list.remaining > 0 ? `\n  ... +${list.remaining} more` : "";
				const dirs = fresh.projectAgentsDir ? `project: ${fresh.projectAgentsDir}` : "no project agents dir";
				pi.sendMessage({
					customType: "pi-subagent",
					content: `Agent definitions reloaded.\n\nAvailable agents (${fresh.agents.length}):\n  ${list.text}${extra}\n\nDirectories searched:\n  user: ${path.join(getAgentDir(), "agents")}\n  ${dirs}\n  bundled: ${bundledAgentsDir}`,
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
				pi.sendMessage({
					customType: "pi-subagent",
					content: `Available agents (${discovery.agents.length}):\n  ${list.text}${extra}\n\nScopes searched:\n  user: ${path.join(getAgentDir(), "agents")}${dirs}\n  bundled: ${bundledAgentsDir}\n\nUse /subagent <name> for agent details, /subagent reload to refresh.`,
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
				pi.sendMessage({
					customType: "pi-subagent",
					content: [
						`Agent: ${agent.name} (${agent.source})`,
						`Description: ${agent.description}`,
						`Model: ${agent.model || "inherits from parent"}`,
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
			pi.sendMessage({
				customType: "pi-subagent",
				content: `Available agents (${discovery.agents.length}):\n  ${list.text}${extra}\n\nScopes searched:\n  user: ${path.join(getAgentDir(), "agents")}${dirs}\n  bundled: ${bundledAgentsDir}\n\nUse /subagent <name> for agent details, /subagent reload to refresh.`,
				display: true,
			});
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context (SDK-based, minimal overhead).",
			"Modes: single (agent + task), parallel (tasks array, max 8, 4 concurrent), chain (sequential with {previous}).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" or "project".`,
		].join(" "),
		parameters: SubagentParams,
		promptSnippet: "Delegate tasks to specialized sub-agents (scout, reviewer, worker, general-purpose)",
		promptGuidelines: [
			"Use subagent to delegate work that would flood the main context with search results or file contents.",
			"Modes: single {agent, task}, parallel {tasks: [...]} (max 8, 4 concurrent), chain {chain: [...]} (sequential with {previous}).",
			"Bundled agents: scout (fast recon), reviewer (code review), worker (implementation), general-purpose (fallback).",
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

			// Shared auth/model setup for SDK sessions
			// ponytail: reuse parent modelRegistry instead of a fresh copy — avoids
			// internal API casts (storeModelHeaders) and preserves env/headers/OAuth.
			const authStorage = AuthStorage.inMemory();
			const modelRegistry = ctx.modelRegistry;

			// Helper: inject parent's API key into child auth storage
			async function injectApiKey(model: Model<any>): Promise<void> {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (auth.ok) {
					if (auth.apiKey) authStorage.setRuntimeApiKey(model.provider, auth.apiKey);
					// ponytail: headers/env stay on the parent registry — no copy needed.
				}
			}

			// Helper: resolve a safe child working directory.
			function resolveChildCwd(childCwd: string | undefined): string {
				const safe = resolveSafeCwd({ workspaceRoot, childCwd, allowExternalCwd });
				if (safe.error) {
					throw new Error(safe.error);
				}
				return safe.path;
			}

			// Helper: validate and normalise tools for an agent.
			function resolveChildTools(agentTools: string[] | undefined, readOnly?: boolean): string[] {
				const defaultTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
				const rawTools = agentTools ?? defaultTools;
				const result = validateAgentTools({ tools: rawTools, readOnly });
				if (result.errors.length > 0) {
					throw new Error(`Tool validation errors: ${result.errors.join("; ")}`);
				}
				return result.tools;
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
				isReadOnly?: boolean,
			): Promise<SubAgentResult> {
				const agent = agents.find((a) => a.name === agentName);

				if (!agent) {
					const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
					return {
						agent: agentName,
						task,
						exitCode: 1,
						messages: [],
						stderr: `Unknown agent: "${agentName}". Available: ${available}.`,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						errorMessage: `Unknown agent: "${agentName}"`,
					};
				}

				const resolved = resolveModel(agent.model, ctx.model, ctx.modelRegistry);
				if (!resolved.model) {
					const tried = resolved.attempted.join(", ") || "none";
					const parentInfo = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
					return {
						agent: agentName,
						task,
						exitCode: 1,
						messages: [],
						stderr: `Model not found for agent "${agentName}". Tried: ${tried}. Parent model: ${parentInfo}. Check agent definition and pi model configuration.`,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						errorMessage: `No model resolved (tried: ${tried})`,
					};
				}

				// Security: validate tools, timeout, and cwd (wrapped in try/catch).
				let tools: string[];
				let effectiveTimeoutMs: number | undefined;
				let safeCwd: string;
				try {
					// Inject parent's API key so --api-key and other runtime overrides work
					await injectApiKey(resolved.model);
					tools = resolveChildTools(agent.tools, isReadOnly);
					effectiveTimeoutMs = resolveChildTimeout(timeoutMs, params.timeout);
					safeCwd = resolveChildCwd(cwd);
				} catch (err: unknown) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					return {
						agent: agentName,
						task,
						exitCode: 1,
						messages: [],
						stderr: `Validation error: ${errorMsg}`,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						errorMessage: errorMsg,
					};
				}

				const result = await runSubAgent({
					cwd: safeCwd,
					systemPrompt: params.instructions
					? `${agent.systemPrompt}\n\n## Task Contract\n${params.instructions.slice(0, MAX_INSTRUCTIONS_LENGTH)}`
					: agent.systemPrompt,
					task,
					tools,
					model: resolved.model,
					authStorage,
					modelRegistry,
					signal: parentSignal,
					timeoutMs: effectiveTimeoutMs,
					agentName,
					thinkingLevel: agent.thinking,
					onMessage: onProgress,
				});
				return result;
			}

			// --- Chain mode ---
			if (params.chain && params.chain.length > 0) {
				const results: SubAgentResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const thread = threadStore.createThread({
						agentName: step.agent,
						task: taskWithContext,
						mode: "chain-step",
						toolCallId: _toolCallId,
					});
					const result = await runOne(
						step.agent, taskWithContext, step.cwd,
						signal, step.timeout ?? params.timeout,
						(partial) => threadStore.updateThread(thread.id, { result: partial }),
					);
					threadStore.updateThread(thread.id, {
						status: isFailedResult(result) ? (result.stopReason === "aborted" ? "aborted" : "failed") : "completed",
						result,
					});
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
						}),
					);

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
								);
								allResults[index] = result;
								threadStore.updateThread(parallelThreads[index].id, {
									status: isFailedResult(result) ? (result.stopReason === "aborted" ? "aborted" : "failed") : "completed",
									result,
								});
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
				const thread = threadStore.createThread({
					agentName: params.agent,
					task: params.task,
					mode: "single",
					toolCallId: _toolCallId,
				});
				const result = await runOne(
					params.agent, params.task, params.cwd,
					signal, params.timeout,
					(partial) => threadStore.updateThread(thread.id, { result: partial }),
				);
				threadStore.updateThread(thread.id, {
					status: isFailedResult(result) ? (result.stopReason === "aborted" ? "aborted" : "failed") : "completed",
					result,
				});
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

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const fg = theme.fg.bind(theme);

			// Chain
			if (args.chain && args.chain.length > 0) {
				let text =
					fg("toolTitle", theme.bold("subagent ")) +
					fg("accent", `chain (${args.chain.length} steps)`) +
					fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						fg("muted", `${i + 1}.`) +
						" " +
						fg("accent", step.agent) +
						fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3)
					text += `\n  ${fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			// Parallel
			if (args.tasks && args.tasks.length > 0) {
				let text =
					fg("toolTitle", theme.bold("subagent ")) +
					fg("accent", `parallel (${args.tasks.length} tasks)`) +
					fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${fg("accent", t.agent)}${fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			// Single
			const agentName = args.agent || "...";
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			let text =
				fg("toolTitle", theme.bold("subagent ")) +
				fg("accent", agentName) +
				fg("muted", ` [${scope}]`);
			text += `\n  ${fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const fg = theme.fg.bind(theme);
			const mdTheme = getMarkdownTheme();

			// --- Single ---
			if (details.mode === "single" && details.results.length === 1) {
				return renderSingleResult(details.results[0], expanded, theme);
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
									fg("accent", r.agent) +
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
					text += `\n  ${stepIcon} ${fg("accent", r.agent)}`;
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
								fg("muted", "─── ") + fg("accent", r.agent) + ` ${taskIcon}`,
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
					text += `\n  ${taskIcon} ${fg("accent", r.agent)}`;
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