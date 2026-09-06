/**
 * zai-anthropic.ts — GLM Coding Plan via the Anthropic Messages API.
 *
 * ZCode (Z.ai's desktop agent) reaches GLM-5.x through the Anthropic-compatible
 * endpoint (`/api/anthropic`), not the OpenAI-compatible `/api/coding/paas/v4`
 * that Pi's built-in `zai`/`zai-coding-cn` providers use. The Anthropic surface
 * gives three levers the OpenAI surface lacks:
 *
 *   1. Explicit prompt caching — `cache_control: {type:"ephemeral"}` markers
 *      (Z.ai bills cache reads ~0.1x input; live-verified 2026-09-05:
 *      2867 input → 2816 cache_read + 51 input on the second identical request).
 *   2. Fast mode — `speed: "fast"` body field + `anthropic-beta:
 *      fast-mode-2026-02-01` header (the same toggle ZCode exposes).
 *   3. Effort-based reasoning — `output_config: {effort: low|high|max}`, which
 *      Pi's anthropic adapter emits when `compat.forceAdaptiveThinking` is set
 *      (live-verified: endpoint accepts `thinking:{type:"adaptive"}` +
 *      `output_config.effort`).
 *
 * Auth: API-key via `$ZAI_ANTHROPIC_API_KEY` env or /login (pi-ai's Anthropic
 * client sends `x-api-key` + `anthropic-version`). Never hardcode keys.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "zai-anthropic";

/** Default endpoint: Z.ai Coding Plan (what ZCode's `builtin:zai-coding-plan` uses). */
export const DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";

/** Documented alternates (same Anthropic shape, different plans): */
export const KNOWN_BASE_URLS = [
  DEFAULT_BASE_URL,
  "https://open.bigmodel.cn/api/anthropic", // BigModel Coding Plan
  "https://zcode.z.ai/api/v1/zcode-plan/anthropic", // ZCode Start Plan (JWT)
  "https://zcode.z.ai/api/v1/ultra-zai/anthropic", // ZCode ultra route (coding-plan, V4-signed)
] as const;

/** Beta header enabling the fast serving tier (mirrors ZCode). */
export const FAST_MODE_BETA = "fast-mode-2026-02-01";

export function zaiAnthropicBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.ZAI_ANTHROPIC_BASE_URL?.trim();
  return raw && raw.length > 0 ? raw.replace(/\/+$/, "") : DEFAULT_BASE_URL;
}

/** Fast mode on by default (ZCode parity); ZAI_ANTHROPIC_SPEED=standard to disable. */
export function zaiAnthropicSpeed(env: Record<string, string | undefined> = process.env): "fast" | "standard" {
  return /^(standard|normal|slow)$/i.test(env.ZAI_ANTHROPIC_SPEED ?? "") ? "standard" : "fast";
}

function glmAnthropicModel(
  id: string,
  name: string,
  opts: { contextWindow: number; input: ("text" | "image")[]; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } },
) {
  return {
    id,
    name,
    api: "anthropic-messages" as const,
    reasoning: true,
    // ZCode GLM-5.3/Flash reasoning variants: low | high | max.
    thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: null, max: "max" },
    input: opts.input,
    cost: opts.cost,
    contextWindow: opts.contextWindow,
    maxTokens: 131072,
    compat: {
      // Pi's anthropic adapter then sends thinking:{type:"adaptive"} +
      // output_config:{effort} — the shape the endpoint live-verified OK.
      forceAdaptiveThinking: true,
    },
  };
}

/** Model catalog mirroring ZCode's (limits from ~/.zcode config; costs from Z.ai published rates). */
export function zaiAnthropicModels() {
  return [
    glmAnthropicModel("glm-5.3", "GLM-5.3", {
      contextWindow: 1_000_000,
      input: ["text"],
      cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    }),
    glmAnthropicModel("glm-5.3-flash", "GLM-5.3-Flash", {
      contextWindow: 1_000_000,
      input: ["text", "image"],
      cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
    }),
    glmAnthropicModel("glm-5-turbo", "GLM-5-Turbo", {
      contextWindow: 200_000,
      input: ["text"],
      cost: { input: 1.2, output: 4, cacheRead: 0.24, cacheWrite: 0 },
    }),
  ];
}

/**
 * Register the provider. Registers UNCONDITIONALLY (pi-router/pi-commandcode
 * pattern) — `apiKey: "$ZAI_ANTHROPIC_API_KEY"` makes /login auto-available and
 * resolves the key from auth.json or env at request time. Gating registration
 * on the env var would hide the provider from /model AND /login, so the key
 * could never be entered.
 */
export function registerZaiAnthropicProvider(pi: ExtensionAPI): void {
  // Minimal fake-pi test harnesses don't stub registerProvider — skip silently.
  if (typeof (pi as unknown as { registerProvider?: unknown }).registerProvider !== "function") return;

  pi.registerProvider(PROVIDER_ID, {
    name: "Z.AI Coding Plan (Anthropic)",
    baseUrl: zaiAnthropicBaseUrl(),
    apiKey: "$ZAI_ANTHROPIC_API_KEY",
    api: "anthropic-messages",
    models: zaiAnthropicModels() as never,
  });
}

export function unregisterZaiAnthropicProvider(pi: ExtensionAPI): void {
  pi.unregisterProvider(PROVIDER_ID);
}

/** Case-insensitive provider match (pi may surface provider ids with different casing). */
function isZaiAnthropicProvider(provider?: string): boolean {
  return (provider?.toLowerCase() ?? "") === PROVIDER_ID;
}

/**
 * Header mutation for fast mode: merge our beta into any existing
 * `anthropic-beta` list (pi-ai may already carry fine-grained-tool-streaming).
 * Mutates `headers` in place per the SDK contract; value may be null to delete.
 */
export function applyFastModeHeaders(
  headers: Record<string, string | null | undefined>,
  opts: { provider?: string; speed?: "fast" | "standard"; env?: Record<string, string | undefined> } = {},
): void {
  const speed = opts.speed ?? zaiAnthropicSpeed(opts.env);
  if (speed !== "fast" || !isZaiAnthropicProvider(opts.provider)) return;
  const existing = headers["anthropic-beta"] ?? headers["Anthropic-Beta"];
  headers["anthropic-beta"] = existing && existing.length > 0 ? `${existing},${FAST_MODE_BETA}` : FAST_MODE_BETA;
}

/** Body mutation for fast mode: top-level `speed` field (zcode: `...U?.speed&&{speed:U.speed}`).
 *  Shallow copy by contract — the payload's nested objects are shared with the original. */
export function applyFastModeBody(payload: unknown, opts: { provider?: string; speed?: "fast" | "standard"; env?: Record<string, string | undefined> } = {}): unknown {
  const speed = opts.speed ?? zaiAnthropicSpeed(opts.env);
  if (speed !== "fast" || !isZaiAnthropicProvider(opts.provider)) return payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), speed: "fast" };
  }
  return payload;
}
