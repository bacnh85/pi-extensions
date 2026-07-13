import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	formatCapabilities,
	toTextResult,
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
	Type.String({ description: "Leave empty — defaults to $MUNIN_PROJECT. Do not set unless you need a different project.", default: "" }),
);
const apiKeyParam = Type.Optional(
	Type.String({ description: "API key. Default: $MUNIN_API_KEY.", default: "" }),
);
const baseUrlParam = Type.Optional(
	Type.String({
		description: "Base URL. Default: $MUNIN_BASE_URL or https://munin.kalera.ai",
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
			// ponytail: share() has different signature — skip direct call, use invoke
			if (typeof client[directAction] === "function" && directAction !== "share") {
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
		const err = error instanceof Error ? error : new Error(String(error));
		err.message = sanitizeErrorMessage(err);
		throw err;
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
		description: "BEFORE work: SEARCH for relevant past fixes, decisions, context.",
		promptSnippet: "BEFORE work: search memory for relevant context",
		promptGuidelines: [
			"Search before non-trivial work when prior context matters.",
			"Query: exact errors, subsystem names, file paths, deps.",
			"--tags for targeting, --topK 5-20.",
		],
		parameters: Type.Object({
			...controlSchema,
			query: Type.String({ description: "Query terms." }),
			topK: Type.Optional(
				Type.Number({ description: "Max results. Default 10.", default: 10 }),
			),
			tags: Type.Optional(Type.String({ description: "Tags, comma-separated." })),
			tag_mode: Type.Optional(
				Type.String({ description: "Mode: 'all' or 'any'.", default: "all" }),
			),
			since: Type.Optional(
				Type.String({
					description: "Results after this date (e.g., '2024-01-01').",
				}),
			),
			before: Type.Optional(Type.String({ description: "Results before this date." })),
			include_total: Type.Optional(
				Type.Boolean({ description: "Include total count.", default: false }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
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
			}, ctx);
			return {
				content: [{ type: "text" as const, text: toTextResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "munin_get",
		label: "Munin Get Memory",
		description: "AFTER search: retrieve full memory by key.",
		promptSnippet: "After search, get full content by key",
		promptGuidelines: [
			"After search, retrieve full content of promising results.",
			"Verify against current repo evidence before using.",
		],
		parameters: Type.Object({
			...controlSchema,
			key: Type.String({ description: "Key to retrieve." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { key } = params as any;
			validateMemoryKey(key);
			const result = await withMuninClient(params, async (client, projectId) => {
				return callMunin(client, projectId, "get", { key });
			}, ctx);
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
			"AT SESSION END (or after fix): STORE verified durable knowledge.",
		promptSnippet: "Store durable knowledge in long-term memory",
		promptGuidelines: [
			"Store at end of session for future sessions.",
			"Require: one type:(decision|bug-fix|fact|dependency) + one domain:(auth|frontend|backend|infra|memory).",
			"Include: conclusion, why it matters, evidence, anchors.",
			"Never store secrets, credentials, raw logs, or TODOs.",
		],
		parameters: Type.Object({
			...controlSchema,
			key: Type.String({
				description:
					"Unique key. Use kebab-case: domain/subject (e.g., auth/refresh-token-fix).",
			}),
			title: Type.String({ description: "Short title." }),
			content: Type.String({
				description:
					"Body with conclusion, why it matters, evidence, anchors.",
			}),
			tags: Type.String({
				description:
					"Tags, comma-separated. Requires one type: + one domain:.",
			}),
			valid_from: Type.Optional(
				Type.String({ description: "Valid-from ISO date." }),
			),
			valid_to: Type.Optional(
				Type.String({ description: "Expiry ISO date." }),
			),
			pinned: Type.Optional(
				Type.Boolean({
					description: "Pin for higher relevance.",
					default: false,
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
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
			}, ctx);
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
		description: "LIST all stored memories.",
		promptSnippet: "List available memories",
		promptGuidelines: [
			"Explore what knowledge is stored. Good for planning.",
		],
		parameters: Type.Object({
			...controlSchema,
			limit: Type.Optional(
				Type.Number({ description: "Max results. Default 20.", default: 20 }),
			),
			offset: Type.Optional(
				Type.Number({ description: "Offset.", default: 0 }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { limit = 20, offset = 0 } = params as any;
			const result = await withMuninClient(params, async (client, projectId) => {
				return callMunin(client, projectId, "list", { limit, offset });
			}, ctx);
			return {
				content: [{ type: "text" as const, text: toTextResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "munin_recent",
		label: "Munin Recent Memories",
		description: "CHECK recently updated memories.",
		promptSnippet: "Show recent updates",
		promptGuidelines: [
			"See what was added or modified recently.",
		],
		parameters: Type.Object({
			...controlSchema,
			limit: Type.Optional(
				Type.Number({ description: "Max results. Default 10.", default: 10 }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { limit = 10 } = params as any;
			const result = await withMuninClient(params, async (client, projectId) => {
				return callMunin(client, projectId, "recent", { limit });
			}, ctx);
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
			"DELETE memory — only when user explicitly asks.",
		promptSnippet: "Delete a memory from storage",
		promptGuidelines: [
			"Only delete when user explicitly asks. Confirm first.",
		],
		parameters: Type.Object({
			...controlSchema,
			key: Type.String({ description: "Key to delete." }),
			force: Type.Optional(
				Type.Boolean({ description: "Skip confirm.", default: false }),
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
			}, ctx);
			return {
				content: [{ type: "text" as const, text: `Deleted memory \`${key}\`.` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "munin_capabilities",
		label: "Munin Capabilities",
		description: "CHECK available Munin server features.",
		promptSnippet: "Show Munin capabilities",
		promptGuidelines: [
			"Check what server features are available.",
		],
		parameters: Type.Object({
			...controlSchema,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await withMuninClient(params, async (client, projectId) => {
				return callMunin(client, projectId, "capabilities", {});
			}, ctx);
			return {
				content: [{ type: "text" as const, text: formatCapabilities(result as Record<string, unknown>) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "munin_share",
		label: "Munin Share Memory",
		description: "SHARE memories between projects.",
		promptSnippet: "Share memories between projects",
		promptGuidelines: [
			"Share memories between projects.",
			"Source and target must be accessible with API key.",
		],
		parameters: Type.Object({
			...controlSchema,
			memory_ids: Type.Array(Type.String(), { description: "Memory IDs to share." }),
			target_project_ids: Type.Array(Type.String(), { description: "Target project IDs." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { memory_ids, target_project_ids } = params as any;
			const result = await withMuninClient(params, async (client, projectId) => {
				return callMunin(client, projectId, "share", { memoryIds: memory_ids, targetProjectIds: target_project_ids });
			}, ctx);
			return {
				content: [{ type: "text" as const, text: toTextResult(result) }],
				details: result,
			};
		},
	});

	// ponytail: acknowledge_setup, encrypt, decrypt, versions, diff, rollback — speculative server features, cut until needed
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

	// ====================================================================
	// Event hooks
	// ====================================================================

	pi.on("before_agent_start", async (event) => {
		try {
			getMuninConfig({});
		} catch {
			return; // skip header if Munin not configured
		}
		return {
			systemPrompt: `## Munin Memory Protocol\n\nALWAYS search Munin before non-trivial work. ALWAYS store verified knowledge at end.\n\n---\n\n${event.systemPrompt}`,
		};
	});

	pi.on("tool_result", async (event) => {
		if (!event.toolName.startsWith("munin_") || !event.isError) return;
		const text = event.content.map((part: any) => part?.text ?? "").join("\n");
		// Strip any existing "Munin <type> error:" prefix to avoid double-wrapping.
		// classifyError may add this prefix on a previous pass.
		const cleanText = text.replace(/^Munin \w+ error: /, "");
		const classified = classifyError(new Error(cleanText));
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
