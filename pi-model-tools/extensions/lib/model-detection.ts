/**
 * model-detection.ts — detect which model family is active.
 *
 * Two families: "deepseek-v4" and "glm". Provider-agnostic.
 * Add a third family when a third family exists — no premature abstraction.
 */

declare const process: { env: Record<string, string | undefined> };

export type ModelFamily = "deepseek-v4" | "glm";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detect the model family from a model ref.
 * Returns null for unrecognized models (no repair/steering applied).
 */
export function detectFamily(model?: { provider?: string; id?: string }): ModelFamily | null {
  const id = (model?.id ?? "").toLowerCase();
  if (!id) return null;
  // ponytail: provider-agnostic substring + word-boundary — robust across id formats
  if (id.includes("deepseek") && /\bv4\b/.test(id)) return "deepseek-v4";
  if (id.includes("glm")) return "glm";
  return null;
}

// ── Config helpers ──

export function repairEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.PI_MODEL_TOOLS_REPAIR_ENABLED ?? "");
}

export function reasoningStripEnabled(env: Record<string, string | undefined> = process.env): boolean {
  // Default ON: reasoning_content in assistant history is non-deterministic and
  // breaks DeepSeek's prefix cache turn-over-turn. DeepSeek accepts an empty
  // string for the key (stripReasoningContent replaces, not deletes). Set
  // PI_MODEL_TOOLS_STRIP_REASONING=0/off/false/no to disable.
  return !/^(0|false|no|off)$/i.test(env.PI_MODEL_TOOLS_STRIP_REASONING ?? "");
}

export function maxErrorHistory(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_MODEL_TOOLS_MAX_ERROR_HISTORY;
  if (raw === undefined || raw === "") return 100;
  const val = parseInt(raw, 10);
  return Number.isFinite(val) && val > 0 ? val : 100;
}

export function autoBlockAfterReminders(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_MODEL_TOOLS_AUTO_BLOCK_AFTER_REMINDERS;
  if (raw === undefined || raw === "") return 0;
  const val = parseInt(raw, 10);
  return Number.isFinite(val) && val >= 1 ? val : 0;
}

export function blockDangerousEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.PI_MODEL_TOOLS_BLOCK_DANGEROUS_COMMANDS ?? "");
}

/**
 * Whether the `apply_patch` tool may be registered. Default ON. Set to
 * 0/false/off to skip registration entirely (belt-and-suspenders on top of the
 * runtime sandbox gate: apply_patch writes raw node:fs anywhere and is blocked
 * when a sandboxing extension owns the host file tools).
 */
export function applyPatchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.PI_MODEL_TOOLS_APPLY_PATCH ?? "");
}

// ── Sandbox detection ──

/**
 * Host built-in tools that a VM-style sandboxing extension re-registers to
 * route calls through its sandbox. If an extension owns any of these names, the
 * host tools are sandboxed.
 */
const SANDBOXED_HOST_TOOLS = new Set(["read", "write", "edit", "bash"]);

/** Minimal tool shape needed by isSandboxed (subset of the host's ToolInfo). */
export interface ToolSourceInfoLike {
  name: string;
  sourceInfo?: { source?: string } | null;
}

/**
 * Whether the host's built-in file tools are sandboxed (VM-wrapped) by another
 * extension.
 *
 * `PI_TOOLS_ARE_SANDBOXED` is the shared declared-override convention — set it
 * in a sandbox extension's module top-level (all extension modules load before
 * `session_start`, so the value is visible regardless of load order):
 *   - 1/true/yes/on  → sandboxed
 *   - 0/false/no/off → not sandboxed (overrides auto-detection)
 *   - unset          → auto-detect: a sandboxing extension re-registers a host
 *     built-in tool name and wins the host's first-registration-per-name
 *     resolution, so `read`/`write`/`edit`/`bash` then carry a non-"builtin"
 *     `sourceInfo.source`.
 */
export function isSandboxed(
  env: Record<string, string | undefined> = process.env,
  tools?: readonly ToolSourceInfoLike[],
): boolean {
  const declared = env.PI_TOOLS_ARE_SANDBOXED;
  if (declared !== undefined && declared !== "") {
    if (/^(1|true|yes|on)$/i.test(declared)) return true;
    if (/^(0|false|no|off)$/i.test(declared)) return false;
  }
  if (!tools) return false;
  return tools.some(
    (t) => SANDBOXED_HOST_TOOLS.has(t.name) && t.sourceInfo?.source !== undefined && t.sourceInfo.source !== "builtin",
  );
}
