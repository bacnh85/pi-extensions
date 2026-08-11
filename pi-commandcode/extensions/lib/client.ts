import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────────

/** Raw entry from GET /provider/v1/models (OpenAI shape). */
export interface CommandCodeModelRaw {
  id: string;
  object?: string;
  owned_by?: string;
  name?: string;
  context_length?: number;
  capabilities?: { vision?: unknown; reasoning?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

export interface CommandCodeModelsResponse {
  object: string;
  data: CommandCodeModelRaw[];
}

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1";
const REQUEST_TIMEOUT_MS = 15_000;
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 8_192;

// Verified context-window overrides for models Command Code under-reports.
// Source: https://commandcode.ai/docs/reference/cli/models (context column).
// ponytail: overrides are GATED on the API under-reporting (no/zero context_length),
// so a model that truthfully reports its window is never inflated.
const CONTEXT_OVERRIDES: { pattern: RegExp; contextWindow: number; maxTokens?: number }[] = [
  { pattern: /glm-5\.2/i, contextWindow: 1_000_000, maxTokens: 131_072 },
  { pattern: /glm-5/i, contextWindow: 200_000 },
  { pattern: /deepseek-v[34]/i, contextWindow: 1_000_000 },
  { pattern: /kimi-k3|kimi-k2\.7/i, contextWindow: 1_000_000 },
  { pattern: /kimi-k2\.6|kimi-k2\.5/i, contextWindow: 256_000 },
  { pattern: /qwen-?3\.[78]/i, contextWindow: 1_000_000 },
  { pattern: /muse-spark/i, contextWindow: 1_000_000 },
  { pattern: /nemotron/i, contextWindow: 1_000_000 },
  { pattern: /grok-4\.5/i, contextWindow: 500_000 },
  { pattern: /gpt-5\.6/i, contextWindow: 1_100_000 },
  // Claude 5 / Opus 5 ship 1M context; earlier Sonnet/Opus are 200K.
  { pattern: /claude-(?:opus-5|fable-5|sonnet-5)/i, contextWindow: 1_000_000 },
];

// Verified vision/reasoning capabilities per model. The Provider API returns
// NO capabilities field (only id/name/context_length), so this table is the
// authoritative fallback. Source: https://commandcode.ai/docs/reference/cli/models
// — the docs page embeds a caps:{text,vision,reasoning} registry (the same one
// backing `cmd --list-models` and the `/model` picker).
// ponytail: flat Record keyed by normalized id, not regex — 52 known models,
// zero ordering pitfalls (vision/reasoning combos cluster across families in
// ways that make regex fragile), and trivially diffable against the docs table.
const CAPABILITIES: Record<string, { vision: boolean; reasoning: boolean }> = {
  "claude-fable-5": { vision: true, reasoning: true },
  "claude-haiku-4-5": { vision: true, reasoning: false },
  "claude-opus-4-7": { vision: true, reasoning: true },
  "claude-opus-4-8": { vision: true, reasoning: true },
  "claude-opus-5": { vision: true, reasoning: true },
  "claude-sonnet-4-6": { vision: true, reasoning: false },
  "claude-sonnet-5": { vision: true, reasoning: true },
  "deepseek/deepseek-v4-flash": { vision: false, reasoning: true },
  "deepseek/deepseek-v4-pro": { vision: false, reasoning: true },
  "google/gemini-3.1-flash-lite": { vision: true, reasoning: true },
  "google/gemini-3.5-flash": { vision: true, reasoning: true },
  "google/gemini-3.5-flash-lite": { vision: true, reasoning: true },
  "google/gemini-3.6-flash": { vision: true, reasoning: true },
  "gpt-5.3-codex": { vision: true, reasoning: true },
  "gpt-5.4": { vision: true, reasoning: true },
  "gpt-5.4-mini": { vision: true, reasoning: true },
  "gpt-5.5": { vision: true, reasoning: true },
  "gpt-5.6-luna": { vision: true, reasoning: true },
  "gpt-5.6-sol": { vision: true, reasoning: true },
  "gpt-5.6-terra": { vision: true, reasoning: true },
  "meta/muse-spark-1.1": { vision: true, reasoning: true },
  "meta/muse-spark-1.2": { vision: true, reasoning: true },
  "meta/muse-spark-1.2-contributor": { vision: true, reasoning: true },
  "minimaxai/minimax-m2.5": { vision: false, reasoning: false },
  "minimaxai/minimax-m2.7": { vision: false, reasoning: false },
  "minimaxai/minimax-m3": { vision: true, reasoning: true },
  "moonshotai/kimi-k2.5": { vision: true, reasoning: false },
  "moonshotai/kimi-k2.6": { vision: true, reasoning: false },
  "moonshotai/kimi-k2.7-code": { vision: true, reasoning: true },
  "moonshotai/kimi-k2.7-code-highspeed": { vision: true, reasoning: true },
  "moonshotai/kimi-k3": { vision: true, reasoning: true },
  "nvidia/nemotron-3-ultra-550b-a55b": { vision: false, reasoning: true },
  "poolside/laguna-s-2.1-free": { vision: false, reasoning: true },
  "qwen/qwen3.6-max-preview": { vision: false, reasoning: true },
  "qwen/qwen3.6-plus": { vision: true, reasoning: true },
  "qwen/qwen3.7-flash": { vision: true, reasoning: true },
  "qwen/qwen3.7-max": { vision: false, reasoning: true },
  "qwen/qwen3.7-plus": { vision: true, reasoning: true },
  "qwen/qwen3.8-max": { vision: true, reasoning: true },
  "sakana/fugu-ultra": { vision: true, reasoning: true },
  "stepfun/step-3.5-flash": { vision: false, reasoning: true },
  "stepfun/step-3.7-flash": { vision: true, reasoning: true },
  "tencent/hy3-paid": { vision: false, reasoning: true },
  "thinkingmachines/inkling": { vision: true, reasoning: true },
  "thinkingmachines/inkling-small": { vision: true, reasoning: true },
  "xai/grok-4.5": { vision: true, reasoning: true },
  "xiaomi/mimo-v2.5": { vision: true, reasoning: false },
  "xiaomi/mimo-v2.5-pro": { vision: false, reasoning: false },
  "zai-org/glm-5": { vision: false, reasoning: false },
  "zai-org/glm-5.1": { vision: false, reasoning: false },
  "zai-org/glm-5.2": { vision: false, reasoning: true },
  "zai-org/glm-5.2-fast": { vision: false, reasoning: false },
};

// ── Public API ───────────────────────────────────────────────────────────────

/** Fetch raw model list from GET /provider/v1/models.
 *  apiKey is optional: Command Code's catalog endpoint accepts unauthenticated
 *  reads, so model discovery works even before /login completes. */
export async function fetchModels(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<CommandCodeModelRaw[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const response = await fetchWithTimeout(url, { headers, signal });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`commandcode returned ${response.status}: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as CommandCodeModelsResponse;
  return payload.data ?? [];
}

/** Map a raw /v1/models entry into a Pi ProviderModelConfig.
 *  Command Code is OpenAI-compatible; cost comes from the response usage field
 *  at runtime, so static cost is 0 (matches pi-9router). */
export function mapModel(raw: CommandCodeModelRaw): ProviderModelConfig {
  const override = lookupContextOverride(raw.id);
  // ponytail: override is a floor, not a replacement — trust the API when it
  // reports a positive context_length larger than the override (e.g. a model
  // upgraded to a bigger window), only fill gaps the API leaves blank/zero.
  const apiContext = parsePositiveInt(raw.context_length);
  const contextWindow = apiContext && apiContext >= (override.contextWindow ?? 0)
    ? apiContext
    : (override.contextWindow ?? apiContext ?? FALLBACK_CONTEXT_WINDOW);
  const maxTokens = override.maxTokens ?? FALLBACK_MAX_TOKENS;
  const input: ("text" | "image")[] = resolveVision(raw) ? ["text", "image"] : ["text"];

  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    reasoning: resolveReasoning(raw),
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve vision: trust an explicit API capabilities.vision when present
 *  (forward-compat), else the documented override table, else text-only.
 *  Never over-advertise image input the upstream may reject. */
function resolveVision(raw: CommandCodeModelRaw): boolean {
  if (raw.capabilities && typeof raw.capabilities.vision === "boolean") return raw.capabilities.vision;
  return lookupCapabilities(raw.id)?.vision ?? false;
}

/** Resolve reasoning: trust an explicit API capabilities.reasoning when
 *  present (forward-compat), else the documented override table; default to
 *  true for unknown models (most coding models support thinking). */
function resolveReasoning(raw: CommandCodeModelRaw): boolean {
  if (raw.capabilities && typeof raw.capabilities.reasoning === "boolean") return raw.capabilities.reasoning;
  return lookupCapabilities(raw.id)?.reasoning ?? true;
}

/** Normalize a model id for table lookup: lowercase + strip a trailing
 *  -YYYYMMDD date suffix (e.g. the API's `claude-haiku-4-5-20251001`). */
function normalizeId(id: string): string {
  return id.toLowerCase().replace(/-\d{8}$/, "");
}

function lookupCapabilities(id: string): { vision: boolean; reasoning: boolean } | undefined {
  return CAPABILITIES[normalizeId(id)];
}

function lookupContextOverride(modelId: string): { contextWindow?: number; maxTokens?: number } {
  for (const entry of CONTEXT_OVERRIDES) {
    if (entry.pattern.test(modelId)) {
      return { contextWindow: entry.contextWindow, ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}) };
    }
  }
  return {};
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  return undefined;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  const signal = init.signal;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
