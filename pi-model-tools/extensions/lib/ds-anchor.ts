/**
 * ds-anchor.ts — DeepSeek v4 Pro "minimal-mode anchor" (two-phase bootstrap).
 *
 * DeepSeek v4 Pro GA appears overfitted to DeepSeek Harness (DSH) "minimal
 * mode": a byte-stable system prompt of one line + only bash/str_replace_editor
 * tools on the first request. Anchoring request #1 to that distribution
 * unlocks the model's benchmark-level capability; after the first durable
 * assistant signal, the session promotes back to Pi's full prompt + catalog.
 *
 * Two-phase design ported from hank9999/pi-ds-anchored (MIT), itself from
 * xiaobright/dsh-anchored-standard (Project2 benchmark: 98/99).
 *
 * Fail-open by design: any surprise (no session access, malformed payload,
 * missing bash/str_replace_editor) disables filtering and exposes the full
 * catalog rather than breaking the session.
 */

declare const process: { env: Record<string, string | undefined> };

/** Byte-identical to the DeepSeek Harness Minimal persona (do not edit). */
export const MINIMAL_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

/** Tools exposed during bootstrap request #1 — the REAL DSH Minimal pair.
 * Not bash+read: dsh-anchored-standard issue #11 measured the Minimal schema
 * (bash + str_replace_editor) anchoring "we need…" first lines 5/5, while
 * pwsh/read and bash/read variants anchored standard-like 11/11. */
export const BOOTSTRAP_TOOLS: readonly string[] = ["bash", "str_replace_editor"];

/** Byte-exact DSH Minimal tool definitions (from the captured minimal-mode
 * request payload; str_replace_editor description matches DSH source
 * DEFAULT_DESCRIPTION). Injected wholesale for request #1 — the tool SCHEMA
 * is the decisive anchor lever, so Pi's own serialization (strict flags,
 * TypeBox enums, Pi bash description) must not leak into the bootstrap
 * request. Descriptions are conditioning text for the training distribution,
 * even where they describe DSH's environment (apt mirror, no internet). */
export const DSH_BOOTSTRAP_TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        'Run commands in a bash shell\n* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.\n* You don\'t have access to the internet via this tool.\n* You do have access to a mirror of common linux and python packages via apt and pip.\n* State is persistent across command calls and discussions with the user.\n* To inspect a particular line range of a file, e.g. lines 10-25, try \'sed -n 10,25p /path/to/the/file\'.\n* Please avoid commands that may produce a very large amount of output.\n* Please run long lived commands in the background, e.g. \'sleep 10 &\' or start a server in the background.',
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to run. Relative path is preferred in the command." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "str_replace_editor",
      description:
        "Custom editing tool for viewing, creating and editing files\n* State is persistent across command calls and discussions with the user\n* If `path` is a file, `view` displays the result of applying `cat -n`. If `path` is a directory, `view` lists non-hidden files and directories up to 2 levels deep\n* The `create` command cannot be used if the specified `path` already exists as a file\n* If a `command` generates a long output, it will be truncated and marked with ```\n\nNotes for using the `str_replace` command:\n* The `old_str` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!\n* If the `old_str` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in `old_str` to make it unique\n* The `new_str` parameter should contain the edited lines that should replace the `old_str`",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
            enum: ["view", "create", "str_replace", "insert"],
          },
          path: { type: "string", description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`." },
          file_text: { type: "string", description: "Required parameter of `create` command, with the content of the file to be created." },
          insert_line: { type: "integer", description: "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`." },
          new_str: { type: "string", description: "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert." },
          old_str: { type: "string", description: "Required parameter of `str_replace` command containing the string in `path` to replace." },
          view_range: {
            type: "array",
            description: "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
            items: { type: "integer" },
          },
        },
        required: ["command", "path"],
      },
    },
  },
] as const;

const TARGET_FRAGMENT = "deepseek-v4-pro";

/** Whether the anchor is enabled (default on; 0/off/false/no disables). */
export function anchorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.PI_MODEL_TOOLS_DS_ANCHOR ?? "");
}

/**
 * Opt-in: prepend the community's portable thinking directive to the bootstrap
 * system prompt ("when you thought, start with 'we need...'"). OFF by default
 * — the byte-identical DSH minimal persona is the verified recipe; this is an
 * A/B knob for routes where the pure prompt alone doesn't reproduce the
 * "We need…" trajectory.
 */
export function weNeedDirectiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.PI_MODEL_TOOLS_DS_ANCHOR_WE_NEED ?? "");
}

/** The directive block, prepended verbatim when weNeedDirectiveEnabled(). */
export const WE_NEED_DIRECTIVE = "When you think, start each thinking paragraph with \"We need…\".\n\n";

/** Target = model ids containing "deepseek-v4-pro" (case-insensitive). */
export function isAnchorTarget(modelId?: string): boolean {
  return typeof modelId === "string" && modelId.toLowerCase().includes(TARGET_FRAGMENT);
}

export interface AnchorEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
}

/**
 * Policy "either": any durable assistant message (tool call or text) promotes.
 * Append-only — matches upstream semantics.
 */
export function hasPromotionSignal(entries: readonly AnchorEntry[]): boolean {
  return entries.some((entry) => {
    if (entry?.type !== "message" || entry.message?.role !== "assistant") return false;
    const content = entry.message.content;
    if (Array.isArray(content)) {
      // Any block (toolCall or text) counts.
      return content.length > 0 && content.some((b: any) => b?.type);
    }
    return false;
  });
}

export interface BootstrapFilterResult {
  ok: boolean;
  tools: unknown[];
  reason?: string;
}

interface ToolDefLike {
  name?: unknown;
  function?: { name?: unknown };
  parameters?: unknown;
  description?: unknown;
}

function toolDefinitionName(tool: ToolDefLike): string | undefined {
  if (typeof tool?.name === "string") return tool.name;
  if (typeof tool?.function?.name === "string") return tool.function.name;
  return undefined;
}

/**
 * Replace the payload's tools array with the byte-exact DSH Minimal pair,
 * preserving the payload's tool serialization shape (flat {name,…} vs OpenAI
 * function-wrapped {function:{name,…}}) so the provider never receives a
 * shape it didn't ask for. Requires bash + str_replace_editor to be present
 * first (registration/active proof — execution routes to the registered
 * tools). Fail-open on any problem (missing pair, ambiguous shape).
 */
export function dshBootstrapTools(tools: unknown): BootstrapFilterResult {
  const check = filterBootstrapTools(tools);
  if (!check.ok) return check;
  const first = Array.isArray(tools) ? (tools[0] as ToolDefLike | undefined) : undefined;
  const flat = first !== undefined && typeof first.function?.name !== "string";
  const defs = flat
    ? DSH_BOOTSTRAP_TOOL_DEFS.map((t) => ({
        type: t.type,
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }))
    : DSH_BOOTSTRAP_TOOL_DEFS.map((t) => ({ ...t }));
  return { ok: true, tools: defs };
}

/**
 * Narrow a provider payload's tools array to the bootstrap set without
 * introducing tools that were not already present. Fail-open: on any problem
 * returns the original array with ok: false.
 */
export function filterBootstrapTools(tools: unknown): BootstrapFilterResult {
  if (!Array.isArray(tools)) return { ok: false, tools: [], reason: "tools array unavailable" };
  const names = tools.map((t) => toolDefinitionName(t as ToolDefLike));
  const available = new Set(names.filter((n): n is string => n !== undefined));
  if (!available.has("bash") || !available.has("str_replace_editor")) {
    return { ok: false, tools, reason: `missing bash/str_replace_editor (found: ${[...available].join(", ") || "none"})` };
  }
  const keep = new Set<string>(BOOTSTRAP_TOOLS);
  return { ok: true, tools: tools.filter((t) => { const n = toolDefinitionName(t as ToolDefLike); return n !== undefined && keep.has(n); }) };
}
