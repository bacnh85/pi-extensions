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
  return /^(1|true|yes|on)$/i.test(env.PI_MODEL_TOOLS_STRIP_REASONING ?? "");
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
