import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────────

/** Raw entry from GET /provider/v1/models (OpenAI shape). */
export interface CommandCodeModelRaw {
  id: string;
  object?: string;
  owned_by?: string;
  context_length?: number;
  capabilities?: { vision?: unknown; [key: string]: unknown };
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
  const input: ("text" | "image")[] = supportsVision(raw) ? ["text", "image"] : ["text"];

  return {
    id: raw.id,
    name: raw.id,
    reasoning: true,
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

/** Command Code's /v1/models may or may not advertise capabilities.vision.
 *  Default to text-only when absent (safer than advertising image input the
 *  upstream may reject); advertise vision only when the API says so. */
function supportsVision(raw: CommandCodeModelRaw): boolean {
  return raw.capabilities?.vision === true;
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
