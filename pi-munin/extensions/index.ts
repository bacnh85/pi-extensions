import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	formatCapabilities,
	toTextResult,
	parseTags,
	validateMemoryTags,
	validateMemoryKey,
	validateSearchQuery,
	classifyError,
	sanitizeErrorMessage,
	getMuninConfig,
} from "./lib/helpers";
import { withRetry } from "./lib/retry";

// ponytail: @kalera/munin-sdk is a hard dependency, no reason to lazy-load it
const { MuninClient: MuninClientClass } = require("@kalera/munin-sdk");

// Shared schemas
const projectParam = Type.Optional(
	Type.String({ description: "Munin project ID. Defaults to MUNIN_PROJECT env var.", default: "" }),
);
const apiKeyParam = Type.Optional(
	Type.String({ description: "Munin API key. Defaults to MUNIN_API_KEY env var.", default: "" }),
);
const baseUrlParam = Type.Optional(
	Type.String({
		description: "Munin base URL. Defaults to MUNIN_BASE_URL or https://munin.kalera.ai",
		default: "",
	}),
);

const controlSchema = {
	project: projectParam,
	api_key: apiKeyParam,
	base_url: baseUrlParam,
};

// ---------------------------------------------------------------------------
// Core SDK call with retry and stale-protocol handling
// ---------------------------------------------------------------------------

function withMuninClient<T extends Record<string, unknown>>(
	params: T,
	callback: (client: any, projectId: string) => Promise<unknown>,
	ctx?: { cwd?: string; isProjectTrusted?: () => boolean },
): Promise<unknown> {
	const { apiKey, projectId, baseUrl } = getMuninConfig(
		params,
		ctx?.cwd,
		ctx?.isProjectTrusted?.() === true,
	);
	const client = new MuninClientClass({ apiKey, baseUrl });
	return callback(client, projectId);
}

/**
 * Core Munin invocation with retry and error sanitization.
 * Some actions like 'delete' are not advertised in server capabilities
 * but are still supported. Pass ensureCapability: false for those.
 */
async function callMunin(
	client: any,
	projectId: string,
	action: string,
	payload: Record<string, unknown> = {},
): Promise<unknown> {
	const directAction = action === "get" ? "retrieve" : action;
	// Server doesn't advertise 'delete' in capabilities, but supports it.
	// Use ensureCapability: false to avoid capability-check rejection.
	const invokeOptions = directAction === "delete"
		? { ensureCapability: false }
		: { ensureCapability: true };

	try {
		return await withRetry(async () => {
			if (typeof client[directAction] === "function") {
				return client[directAction](projectId, payload);
			}
			if (typeof client.invoke === "function") {
				return client.invoke(projectId, directAction, payload, invokeOptions);
			}
			throw new Error(`Munin SDK does not support action: ${directAction}`);
		});
	} catch (error) {
		// Let the tool_result event handler classify the error;
		// avoid double-wrapping by not adding "Munin error:" prefix here.
		const sanitized = sanitizeErrorMessage(
			error instanceof Error ? error : new Error(String(error)),
		);
		throw new Error(sanitized);
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function muninExtension(pi: ExtensionAPI) {
	// ====================================================================
	// Individual tools
	// ====================================================================

	pi.registerTool({
		name: "munin_search",
		label: "Munin Search",
		description: "Search memories using Munin semantic search with optional filters.",
		promptSnippet: "Search long-term memory for relevant knowledge",
		promptGuidelines: [
			"Use munin_search before non-trivial work when prior project context could affect the outcome.",
			"Build focused queries from exact errors, subsystem names, file paths, and dependency names.",
			"Use --tags type:bug-fix,domain:auth for targeted results. Use --topK 5 for focused lookup, up to 20 for exploration.",
		],
		parameters: Type.Object({
			...controlSchema,
			query: Type.String({ description: "Search query terms." }),
			topK: Type.Optional(
				Type.Number({ description: "Maximum results to return. Default 10.", default: 10 }),
			),
			tags: Type.Optional(Type.String({ description: "Comma-separated tags to filter by." })),
			tag_mode: Type.Optional(
				Type.String({ description: "Tag matching mode: 'all' (default) or 'any'.", default: "all" }),
			),
			since: Type.Optional(
				Type.String({
					description: "Filter results updated after this date (e.g., '2024-01-01', 'last week').",
				}),
			),
			before: Type.Optional(Type.String({ description: "Filter results updated before this date." })),
			include_total: Type.Optional(
				Type.Boolean({ description: "Include total count in response.", default: false }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const { query, topK = 10, tags, tag_mode, since, before, include_total } = params as any;
			validateSearchQuery(query);
			const result = await withMuninClient(params, async (client, projectId) => {
				const searchParams: Record<string, unknown> = { query, topK };
				if (tags)
					searchParams.tags = tags
						.split(",")
						.map((t: string) => t.trim())
						.filter(Boolean);
				if (tag_mode) searchParams.tagMode = tag_mode;
				if (since) searchParams.since = since;
				if (before) searchParams.before = before;
				if (include_total) searchParams.includeTotal = include_total;
				return callMunin(client, projectId, "search", searchParams);
			});
			return {
				content: [{ type: "text" as const, text: toTextResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "munin_get",
		label: "Munin Get Memory",
		description: "Retrieve a single memory by its key.",
		promptSnippet: "Get a specific memory by key",
		promptGuidelines: [
			"Use munin_get after munin_search to retrieve full content of a promising result.",
			"Verify the retrieved memory against current repository evidence before relying on it.",
		],
		parameters: Type.Object({
			...controlSchema,
			key: Type.String({ description: "Memory key to retrieve." }),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const { key } = params as any;
			validateMemoryKey(key);
			const result = await withMuninClient(params, async (client, projectId) => {
				return callMunin(client, projectId, "get", { key });
			});
			return {
				content: [{ type: "text" as const, text: toTextResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "munin_store",
		label: "Munin Store Memory",
		description:
			"Store a single verified memory with required type and domain tags.",
		promptSnippet: "Store durable project knowledge in long-term memory",
		promptGuidelines: [
			"Use munin_store at the end of a session for verified, durable knowledge that future sessions need.",
			"Required tags: at least one type: (decision, bug-fix, fact, dependency, fact) AND one domain: (auth, frontend, backend, infra, memory).",
			"Include conclusion, why it matters, evidence, and file/symbol anchors.",
			"Never store secrets, credentials, raw logs, or transient TODOs.",
		],
		parameters: Type.Object({
			...controlSchema,
			key: Type.String({
				description:
					"Unique memory key. Use kebab-case namespaced like domain/subject (e.g., auth/refresh-token-fix).",
			}),
			title: Type.String({ description: "Short descriptive title." }),
			content: Type.String({
				description:
					"Memory body. Must include conclusion, why it matters, evidence/verification, and durable anchors.",
			}),
			tags: Type.String({
				description:
					"Comma-separated tags. MUST include at least one type: and one domain: tag.",
			}),
			valid_from: Type.Optional(
				Type.String({ description: "ISO date when this memory becomes valid." }),
			),
			valid_to: Type.Optional(
				Type.String({ description: "ISO date when this memory expires." }),
			),
			pinned: Type.Optional(
				Type.Boolean({
					description: "Whether this memory is pinned for higher relevance.",
					default: false,
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const { key, title, content, tags, valid_from, valid_to, pinned } = params as any;
			validateMemoryKey(key);
			const tagValidation = validateMemoryTags(tags);
			if (!tagValidation.ok) {
				return {
					content: [{ type: "text" as const, text: tagValidation.message }],
					details: null,
				};
			}
			const result = await withMuninClient(params, async (client, projectId) => {
				const payload: Record<string, unknown> = { key, title, content, tags: tagValidation.tags };
				if (valid_from) payload.validFrom = valid_from;
				if (valid_to) payload.validTo = valid_to;
				if (typeof pinned === "boolean") payload.pinned = pinned;
				return callMunin(client, projectId, "store", payload);
			});
			const keyStr = (result as any)?.key ?? key;
			return {
				content: [
					{
						type: "text" as const,
						text: `Stored memory \`${keyStr}\` with tags \`${tags ?? "none"}\`.`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "munin_list",
		label: "Munin List Memories",
		description: "List memories with pagination support.",
		promptSnippet: "List available memories",
		promptGuidelines: [
			"Use munin_list to explore what project knowledge is already stored. Good for planning work.",
		],
		parameters: Type.Object({
			...controlSchema,
			limit: Type.Optional(
				Type.Number({ description: "Maximum memories to return. Default 20.", default: 20 }),
			),
			offset: Type.Optional(
				Type.Number({ description: "Pagination offset.", default: 0 }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const { limit = 20, offset = 0 } = params as any;
			const result = await withMuninClient(params, async (client, projectId) => {
				return callMunin(client, projectId, "list", { limit, offset });
			});
			return {
				content: [{ type: "text" as const, text: toTextResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "munin_recent",
		label: "Munin Recent Memories",
		description: "Show recently updated memories.",
		promptSnippet: "Show recently updated memories",
		promptGuidelines: [
			"Use munin_recent to see what knowledge has been added or modified recently.",
		],
		parameters: Type.Object({
			...controlSchema,
			limit: Type.Optional(
				Type.Number({ description: "Maximum memories to return. Default 10.", default: 10 }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const { limit = 10 } = params as any;
			const result = await withMuninClient(params, async (client, projectId) => {
				return callMunin(client, projectId, "recent", { limit });
			});
			return {
				content: [{ type: "text" as const, text: toTextResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "munin_delete",
		label: "Munin Delete Memory",
		description:
			"Delete a memory by key. Requires explicit confirmation unless forced.",
		promptSnippet: "Delete a memory from long-term storage",
		promptGuidelines: [
			"Only use munin_delete when the user explicitly asks to remove a memory. Confirm before deleting.",
		],
		parameters: Type.Object({
			...controlSchema,
			key: Type.String({ description: "Memory key to delete." }),
			force: Type.Optional(
				Type.Boolean({ description: "Skip confirmation.", default: false }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { key, force } = params as any;
			validateMemoryKey(key);
			if (force !== true) {
				const confirmed = await ctx.ui.confirm(
					"Delete Munin memory?",
					`Delete memory \`${key}\` from long-term storage? This cannot be undone.`,
				);
				if (!confirmed) {
					return {
						content: [
							{ type: "text" as const, text: `Delete cancelled for memory \`${key}\`.` },
						],
						details: { cancelled: true, key },
					};
				}
			}
			const result = await withMuninClient(params, async (client, projectId) => {
				return callMunin(client, projectId, "delete", { key, force: true });
			});
			return {
				content: [{ type: "text" as const, text: `Deleted memory \`${key}\`.` }],
				details: result,
			};
		},
	});



	pi.registerTool({
		name: "munin_capabilities",
		label: "Munin Capabilities",
		description: "Show Munin server capabilities.",
		promptSnippet: "Show Munin server capabilities",
		promptGuidelines: [
			"Use munin_capabilities to check what server features are available.",
		],
		parameters: Type.Object({
			...controlSchema,
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const result = await withMuninClient(params, async (client, projectId) => {
				return callMunin(client, projectId, "capabilities", {});
			});
			return {
				content: [{ type: "text" as const, text: formatCapabilities(result as Record<string, unknown>) }],
				details: result,
			};
		},
	});

	// ponytail: acknowledge_setup, encrypt, decrypt, export — speculative server features, cut until needed
	// ponytail: recall, capture, summarize — composite tools the agent can do with 1-2 primitive calls

	// ====================================================================
	// Commands
	// ====================================================================

	pi.registerCommand("munin-status", {
		description:
			"Show Munin configuration status (API key present, project, base URL)",
		handler: async (_args, ctx) => {
			try {
				const { apiKey, projectId, baseUrl } = getMuninConfig({});
				ctx.ui.notify(
					`Munin Status:\n  API Key: ${apiKey ? "present" : "missing"}\n  Project: ${projectId}\n  Base URL: ${baseUrl}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`Munin Status: ${sanitizeErrorMessage(err instanceof Error ? err : new Error(String(err)))}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("munin-recent", {
		description: "Show recent memories for the configured project",
		handler: async (args, ctx) => {
			try {
				const limit = parseInt(args?.trim() || "10", 10);
				const { apiKey, projectId, baseUrl } = getMuninConfig({});
				const client = new MuninClientClass({ apiKey, baseUrl });
				const result = await callMunin(client, projectId, "recent", { limit });
				const text = toTextResult(result);
				ctx.ui.notify(text, "info");
			} catch (err) {
				ctx.ui.notify(
					`Error: ${sanitizeErrorMessage(err instanceof Error ? err : new Error(String(err)))}`,
					"error",
				);
			}
		},
	});

	// ====================================================================
	// Event hooks
	// ====================================================================

	pi.on("before_agent_start", async (event) => {
		const prompt = event.prompt.toLowerCase();
		if (
			/\b(search my memory|recall|remember|what did we|past work|previously|last time)\b/.test(
				prompt,
			)
		) {
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\nMunin long-term memory tools are available as Pi-native tools. Before non-trivial work, or when the user references past work, memory, or history, use munin_search to retrieve relevant context from the project's long-term memory. Always verify memories against current repository evidence before relying on them.",
			};
		}
		if (
			/\b(store this|remember this|save this to memory|capture this|document this)\b/.test(
				prompt,
			)
		) {
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\nMunin long-term memory tools are available as Pi-native tools. When the user asks to save, store, or remember verified project knowledge, use munin_store. Ensure tags include at least one type: AND one domain: tag.",
			};
		}
	});

	pi.on("tool_result", async (event) => {
		if (!event.toolName.startsWith("munin_") || !event.isError) return;
		const text = event.content.map((part: any) => part?.text ?? "").join("\n");
		// Strip any existing "Munin <type> error:" prefix to avoid double-wrapping.
		// The stale-protocol handler and classifyError both may add this prefix.
		const classified = classifyError(new Error(text));
		const sanitized = sanitizeErrorMessage(new Error(classified.message));
		return {
			content: [
				{
					type: "text" as const,
					text: `Munin ${classified.type} error: ${sanitized}`,
				},
			],
			details: { errorType: classified.type, message: sanitized },
		};
	});
}
