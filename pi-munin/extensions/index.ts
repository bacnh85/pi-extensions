import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MuninClient } from "@kalera/munin-sdk";
import { Type } from "typebox";

import {
  formatCapabilities,
  parseTags,
  toTextResult,
  truncateText,
  validateMemoryTags,
  validateMemoryKey,
  validateSearchQuery,
  classifyError,
  sanitizeErrorMessage,
  getMuninConfig,
  extractRemediation,
  formatRemediation,
} from "./lib/helpers";
import { withRetry } from "./lib/retry";

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
// Always-on condensed Memory Protocol (injected only when Munin is configured)
// ---------------------------------------------------------------------------

// Portable home for the Munin Memory Protocol. Previously forced always-on via
// ~/.pi/agent/AGENTS.md; now self-injected by this extension so the protocol
// travels with the package and disappears when pi-munin is absent. The full
// deep reference lives in skills/munin/SKILL.md; this is the condensed
// always-on form covering the durable rules.
const MUNIN_PROTOCOL_HEADER = `## Munin Memory Protocol

Use Munin to recover and preserve verified project knowledge, not as a task log.
If Munin is unavailable, state that briefly when it matters and continue from
repository evidence.

### Before acting

- Search at the start of non-trivial work and before changing architecture,
  dependencies, public behavior, setup, or a previously fixed subsystem.
- For bugs, search the exact error or symptom with \`type:bug-fix\` before
  attempting a new fix.
- Build focused 4-8 word queries from exact phrases, capitalized entities,
  subsystem names, file paths, error codes, and dependency names. Quote exact
  strings and use tags or temporal filters when they reduce noise.
- Use \`topK: 5\` for focused lookup and up to \`topK: 20\` for exploration. DO
  NOT use single-word queries unless the term is a genuinely rare error code.
- Search results are leads, not facts. Retrieve promising memories
  (\`munin_get\`), check validity and source anchors, and reconcile with current
  repository evidence before relying on them.

### What to store

Store only verified knowledge likely to help a future session: architecture or
product decisions (with rationale and rejected options); recurring bug root
causes (exact symptoms, fixes, verification); stable setup facts, conventions,
constraints, dependency choices; durable user/project identity facts that
materially guide work. Do NOT store temporary progress, routine completion
summaries, TODOs, raw logs, unverified hypotheses, transient file state,
generated output, or information easy to derive from authoritative files. Never
store secrets, credentials, private keys, tokens, or encryption keys.

### Memory shape

- One concept per memory. Batch independent memories instead of combining
  unrelated facts.
- Stable descriptive key; add a date when historical rather than continuously
  updated. Reuse a key only for an intentional upsert.
- Include the conclusion, why it matters, evidence/verification, and durable
  file/symbol anchors. Cross-reference related memories by mentioning their keys
  in \`content\` (e.g. "See also: architecture/cache-policy").
- Lowercase namespaced tags with at least one \`type:\`
  (\`decision\`|\`bug-fix\`|\`fact\`|\`dependency\`) and one \`domain:\`
  (\`auth\`|\`frontend\`|\`backend\`|\`infra\`|\`memory\`). Add \`status:\` or
  \`priority:\` only when they improve retrieval.
- Use \`validFrom\`/\`validTo\` for time-bound facts so stale information is
  filtered automatically. Pin only durable, high-value anchors.

### Lifecycle and safety

- At task end, store only newly established durable knowledge. Before context
  compaction, batch-store any outstanding memories.
- Update or supersede stale memories when current evidence changes; delete only
  with explicit authorization.
- Before memory operations in an E2EE project, verify the encryption key is
  configured. Never print or store the key. For E2EE Elite, use the official
  Munin crypto helper.
- Share memories across projects only when explicitly useful and when encryption
  compatibility is confirmed.`;

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
  const client = new MuninClient({ apiKey, baseUrl });
  return callback(client, projectId);
}

/**
 * Core Munin invocation with retry and error sanitization.
 * Some actions like 'delete' are not advertised in server capabilities
 * but are still supported. Pass ensureCapability: false for those.
 */
export async function callMunin(
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
    return await withRetry(async () => invokeMuninAction(client, projectId, directAction, payload, invokeOptions));
  } catch (error) {
    // Layer 1: auto-recover from ERR_STALE_PROTOCOL via the server's
    // acknowledge_setup handshake, then retry the original call exactly once.
    // ponytail: single retry — no loop; ack is idempotent and server-side remembered.
    const err = error instanceof Error ? error : new Error(String(error));
    const remediation = extractRemediation(err);
    const ack = remediation?.acknowledge_after_reading;
    const isStale =
      classifyError(err).type === "stale_protocol" &&
      !!ack?.payload?.version;
    if (isStale && typeof client.invoke === "function") {
      const version = ack!.payload.version;
      // Server directs the action name (default acknowledge_setup if absent).
      const ackAction = ack!.action || "acknowledge_setup";
      try {
        // ack is a real action even when not advertised in capabilities.
        // Inspect the result: some servers return a non-throwing failure
        // (e.g. {ok:false} or {acknowledged:false}) that the SDK does not throw on.
        const ackResult = await client.invoke(projectId, ackAction, { version }, { ensureCapability: false });
        if (ackResult && typeof ackResult === "object" &&
            ((ackResult as any).ok === false || (ackResult as any).success === false || (ackResult as any).acknowledged === false)) {
          err.message = sanitizeErrorMessage(new Error(err.message + formatRemediation(remediation)));
          throw err;
        }
      } catch {
        // ack failed (thrown or resolved-failure) → surface remediation, do NOT retry (no infinite loop).
        err.message = sanitizeErrorMessage(new Error(err.message + formatRemediation(remediation)));
        throw err;
      }
      // Retry the original action exactly once. Wrap in withRetry so a transient
      // network blip during the retry (after ack already succeeded) is tolerated —
      // same as the initial call. Safe: withRetry never retries stale_protocol.
      try {
        return await withRetry(async () => invokeMuninAction(client, projectId, directAction, payload, invokeOptions));
      } catch (retryErr) {
        const r = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
        // Only fall back to the original stale remediation when the retry error is itself stale.
        // A non-stale retry failure (e.g. VALIDATION_ERROR) must surface its own cause, not a
        // handshake that already succeeded.
        const retryIsStale = classifyError(r).type === "stale_protocol";
        r.message = sanitizeErrorMessage(new Error(r.message + formatRemediation(extractRemediation(r) ?? (retryIsStale ? remediation : undefined))));
        throw r;
      }
    }
    // Layer 2: surface remediation in the error message even when auto-ack is skipped.
    const err2 = error instanceof Error ? error : new Error(String(error));
    err2.message = sanitizeErrorMessage(new Error(err2.message + formatRemediation(remediation)));
    throw err2;
  }
}

/** Dispatch a single Munin action (direct method or client.invoke). Extracted for one-shot retry reuse. */
function invokeMuninAction(
  client: any,
  projectId: string,
  directAction: string,
  payload: Record<string, unknown>,
  invokeOptions: { ensureCapability: boolean },
): Promise<unknown> {
  if (directAction === "capabilities") return client.capabilities(true);
  // ponytail: share() has different signature — skip direct call, use invoke
  if (typeof client[directAction] === "function" && directAction !== "share") {
    return client[directAction](projectId, payload);
  }
  if (typeof client.invoke === "function") {
    return client.invoke(projectId, directAction, payload, invokeOptions);
  }
  throw new Error(`Munin SDK does not support action: ${directAction}`);
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
      "Use munin_search before non-trivial work when prior context matters.",
      "Give munin_search exact errors, subsystem names, file paths, and dependencies.",
      "Use munin_search tags for targeting and topK 5-20.",
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
        if (tags) searchParams.tags = parseTags(tags);
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
      "Use munin_get after search to retrieve full content of promising results.",
      "Verify munin_get results against current repository evidence before using them.",
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
      "Use munin_store at the end of a session for future sessions.",
      "Give munin_store one type:(decision|bug-fix|fact|dependency) tag and one domain:(auth|frontend|backend|infra|memory) tag.",
      "Include a conclusion, why it matters, evidence, and anchors in munin_store content.",
      "Never use munin_store for secrets, credentials, raw logs, or TODOs.",
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
      if (!tagValidation.ok) throw new Error(tagValidation.message);
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
      "Use munin_list to explore stored knowledge while planning.",
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
      "Use munin_recent to see what was added or modified recently.",
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
      "Use munin_delete only when the user explicitly asks; it always requires confirmation.",
    ],
    parameters: Type.Object({
      ...controlSchema,
      key: Type.String({ description: "Key to delete." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { key } = params as any;
      validateMemoryKey(key);
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
      "Use munin_capabilities to check which server features are available.",
    ],
    parameters: Type.Object({
      ...controlSchema,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await withMuninClient(params, async (client, projectId) => {
        return callMunin(client, projectId, "capabilities", {});
      }, ctx);
      return {
        content: [{ type: "text" as const, text: truncateText(formatCapabilities(result as Record<string, unknown>)) }],
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
      "Use munin_share to share memories between projects; it always requires confirmation.",
      "The munin_share source and target projects must be accessible with the API key.",
    ],
    parameters: Type.Object({
      ...controlSchema,
      memory_ids: Type.Array(Type.String(), { description: "Memory IDs to share." }),
      target_project_ids: Type.Array(Type.String(), { description: "Target project IDs." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { memory_ids, target_project_ids } = params as any;
      const confirmed = await ctx.ui.confirm(
        "Share Munin memories?",
        `Share ${memory_ids.length} memories with ${target_project_ids.length} target projects?`,
      );
      if (!confirmed) {
        return {
          content: [{ type: "text" as const, text: "Memory sharing cancelled." }],
          details: { cancelled: true },
        };
      }
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
        const { apiKey, projectId, baseUrl } = getMuninConfig(
          {},
          ctx.cwd,
          ctx.isProjectTrusted() === true,
        );
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

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      getMuninConfig({}, ctx.cwd, ctx.isProjectTrusted() === true);
    } catch {
      return; // skip header if Munin not configured
    }
    return {
      systemPrompt: `${MUNIN_PROTOCOL_HEADER}\n\n---\n\n${event.systemPrompt}`,
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
    // Error messages are also bounded — a malicious server can balloon agent context
    // via oversized remediation fields (url/version), so truncate like success paths.
    const bounded = truncateText(`Munin ${classified.type} error: ${sanitized}`);
    return {
      content: [
        {
          type: "text" as const,
          text: bounded,
        },
      ],
      details: { errorType: classified.type, message: sanitized },
    };
  });
}
