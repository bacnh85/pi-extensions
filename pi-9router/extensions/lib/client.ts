import type { NineRouterConfig } from "./config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface NineRouterModelRaw {
  id: string;
  object?: string;
  owned_by?: string;
  [key: string]: unknown;
}

export interface NineRouterModelsResponse {
  object: string;
  data: NineRouterModelRaw[];
}

/** Pi model shape with optional reasoning-level support. */
export type PiModel = {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: {
    supportsStore: boolean;
    supportsDeveloperRole: boolean;
    supportsReasoningEffort: boolean;
    maxTokensField: "max_tokens";
    thinkingFormat: "openai";
  };
};

// ── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 4_096;

// ── Public API ───────────────────────────────────────────────────────────────

export async function fetchModels(
  config: NineRouterConfig,
  signal?: AbortSignal,
): Promise<NineRouterModelRaw[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const url = `${config.baseUrl}/v1/models`;
  const response = await fetchWithTimeout(url, { headers, signal });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`9router returned ${response.status}: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as NineRouterModelsResponse;
  return payload.data ?? [];
}

/** Detect 9router thinkingFormat from model ID, matching the same patterns
 *  used in 9router's thinkingLevels.js and capabilities.js. Each format
 *  defines a distinct set of valid thinking levels. */
function detectThinkingFormat(modelId: string): string {
  const id = modelId.toLowerCase();

  // Pattern overrides (first match wins, matching 9router's PATTERN_THINKING)
  if (id.includes("gpt-5.6-sol")) return "openai-max";   // accepts max
  if (id.includes("codex")) return "codex-pattern";        // cannot disable thinking

  // Model-family detection (matching 9router's FORMAT_LEVELS keys)
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("claude")) {
    // Claude 4.6+ uses adaptive thinking (none, low, medium, high, max)
    if (/\b(4\.[6789]|[5-9]\d*)(\b|\-)/.test(id) || /\b(sonnet|opus)-5\b/.test(id)) {
      return "claude-adaptive";
    }
    return "claude-budget";
  }
  if (id.includes("gemini")) {
    if (/gemini-3/.test(id)) return "gemini-level";  // minimal required, no disable
    return "gemini-budget";
  }
  if (id.includes("kimi")) return "kimi";
  if (id.includes("qwen") || id.includes("qwq")) return "qwen";
  if (id.includes("glm")) return "zai";
  if (id.includes("minimax")) return "minimax";
  if (id.includes("hunyuan")) return "hunyuan";
  if (id.includes("step")) return "step";

  // Default: OpenAI format (GPT, o-series, generic models)
  return "openai";
}

/** Return the correct thinkingLevelMap for the model's thinking format.
 *  Mirroring 9router's FORMAT_LEVELS from thinkingLevels.js:
 *    openai:            none, minimal, low, medium, high, xhigh  (no max)
 *    claude-adaptive:   none, low, medium, high, max
 *    claude-budget:     none, low, medium, high, xhigh, max
 *    deepseek:          none, high, max  (hiMax — low/med→high, xhigh→max)
 *    gemini-level:      minimal, low, medium, high  (no disable)
 *    gemini-budget:     none, low, medium, high
 *    kimi:              none, low, medium, high, max  (levelMax)
 *    qwen/hunyuan/step: none, low, medium, high  (base)
 *    zai:               none, high, max  (low/med→high; mirrors native zai-coding-cn/glm-5.2)
 *    minimax:           none, low, medium, high, xhigh, max
 *  Levels not in the format's set map to null (disabled in Pi UI).
 *  Levels beyond the format's max cap at the highest available value
 *  (e.g. xhigh→max for deepseek, max→xhigh for openai). */
const FORMAT_TO_LEVEL_MAP: Record<string, Record<string, string | null>> = {
  "openai":      { off:"none", minimal:"minimal", low:"low", medium:"medium", high:"high", xhigh:"xhigh", max:"xhigh" },
  "openai-max":  { off:"none", minimal:"minimal", low:"low", medium:"medium", high:"high", xhigh:"xhigh", max:"max" },
  "codex-pattern": { off:null, minimal:null, low:"low", medium:"medium", high:"high", xhigh:"xhigh", max:"xhigh" },
  "claude-adaptive": { off:"none", minimal:null, low:"low", medium:"medium", high:"high", xhigh:"max", max:"max" },
  "claude-budget":   { off:"none", minimal:null, low:"low", medium:"medium", high:"high", xhigh:"xhigh", max:"max" },
  // hiMax: only none, high, max are valid levels — xhigh is not shown at all
  // (matches opencode-go native behavior where xhigh is absent from the map)
  "deepseek":  { off:"none", minimal:null, low:null, medium:null, high:"high", xhigh:null, max:"max" },
  "kimi":      { off:"none", minimal:null, low:"low", medium:"medium", high:"high", xhigh:"max", max:"max" },
  "gemini-level":  { off:null, minimal:"minimal", low:"low", medium:"medium", high:"high", xhigh:"high", max:"high" },
  "gemini-budget": { off:"none", minimal:null, low:"low", medium:"medium", high:"high", xhigh:"high", max:"high" },
  "qwen":     { off:"none", minimal:null, low:"low", medium:"medium", high:"high", xhigh:"high", max:"high" },
  "hunyuan":  { off:"none", minimal:null, low:"low", medium:"medium", high:"high", xhigh:"high", max:"high" },
  "step":     { off:"none", minimal:null, low:"low", medium:"medium", high:"high", xhigh:"high", max:"high" },
  // zai: mirrors native zai-coding-cn/glm-5.2 — low/medium/high all map to "high"
  // (GLM's single thinking-on tier), max→"max"; xhigh/minimal unsupported (hidden).
  "zai":      { off:"none", minimal:null, low:"high", medium:"high", high:"high", xhigh:null, max:"max" },
  "minimax":  { off:"none", minimal:null, low:"low", medium:"medium", high:"high", xhigh:"xhigh", max:"xhigh" },
};

function getThinkingLevelMap(modelId: string): Record<string, string | null> {
  const fmt = detectThinkingFormat(modelId);
  return FORMAT_TO_LEVEL_MAP[fmt] ?? FORMAT_TO_LEVEL_MAP["openai"];
}

export function mapModel(raw: NineRouterModelRaw, enableReasoning: boolean): PiModel {
  const isCombo = raw.owned_by === "combo";
  const caps = raw.capabilities as
    | { contextWindow?: unknown; maxOutput?: unknown; vision?: unknown }
    | undefined;
  const contextWindow = parsePositiveInt(caps?.contextWindow) ?? FALLBACK_CONTEXT_WINDOW;
  const maxTokens = parsePositiveInt(caps?.maxOutput) ?? FALLBACK_MAX_TOKENS;
  const inputTypes: ("text" | "image")[] = caps?.vision ? ["text", "image"] : ["text"];

  const compat = {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: enableReasoning,
    maxTokensField: "max_tokens" as const,
    thinkingFormat: "openai" as const,
  };

  return {
    id: raw.id,
    name: isCombo ? `🔀 ${raw.id}` : raw.id,
    reasoning: enableReasoning,
    ...(enableReasoning ? { thinkingLevelMap: getThinkingLevelMap(raw.id) } : {}),
    input: inputTypes,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat,
  };
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  return undefined;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  // Combine caller signal with timeout signal
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
