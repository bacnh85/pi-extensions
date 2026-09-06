import type { RouterSettings } from "./config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RouterModelRaw {
  id: string;
  object?: string;
  owned_by?: string;
  context_length?: unknown;
  max_output_tokens?: unknown;
  [key: string]: unknown;
}

export interface RouterModelsResponse {
  object: string;
  data: RouterModelRaw[];
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

const REQUEST_TIMEOUT_MS = 30_000;
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 4_096;

// ── Public API ───────────────────────────────────────────────────────────────

export async function fetchModels(
  config: RouterSettings,
  signal?: AbortSignal,
  apiKey?: string,
): Promise<RouterModelRaw[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // RefreshModelsContext.credential (auth.json via /login) wins; env is the fallback.
  const key = apiKey ?? process.env.ROUTER_API_KEY ?? process.env.NINE_ROUTER_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;

  // baseUrl conventionally ends in /v1 (README + provider baseUrl for chat);
  // never double the segment — append only when missing.
  const url = /\/v1\/?$/.test(config.baseUrl)
    ? `${config.baseUrl.replace(/\/+$/, "")}/models`
    : `${config.baseUrl}/v1/models`;
  const response = await fetchWithTimeout(url, { headers, signal });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`router returned ${response.status}: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as RouterModelsResponse;
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
    // Claude 4.6+ uses adaptive thinking (none, low, medium, high, max).
    // Parse major[.-]minor so claude-3-5/3-7 aren't misread by the minor digit,
    // and dash forms like claude-4-6 resolve to 4.6.
    const v = id.match(/claude[^\d]*(\d+)(?:[-.](\d+))?/);
    const ver = v ? Number(v[1]) + (v[2] ? Number(v[2]) / 10 : 0) : 0;
    if (ver >= 4.6 || /\b(sonnet|opus)-5\b/.test(id)) {
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
// Verified context windows from models.dev (cited by 9router's capabilities.js
// as its authoritative source). 9router's capabilities.js applies a 200k
// DEFAULT_CAPABILITIES floor to models without an explicit pattern match,
// which under-reports models with larger windows (e.g. GLM-5.2 = 1M).
// This table corrects known gaps client-side.
// Source: https://models.dev/api.json
// Floor constants: 9router/omniroute's DEFAULT_CAPABILITIES pair (context 200000,
// output 128000) for unprofiled models. Anything ≤ these on a matched-override
// model is the router's default-floor stamp, not real metadata — `mapModel`
// uses these to de-poison without inflating truthful reports above the floor.
// Cited: 9router capabilities.js DEFAULT_CAPABILITIES (OmniRoute is a 9router fork).
const DEFAULT_CONTEXT_FLOOR = 200_000;
const DEFAULT_MAX_FLOOR = 128_000;
const CONTEXT_OVERRIDES: { pattern: RegExp; contextWindow: number; maxTokens?: number }[] = [
  // GLM-5.2/5.3 only: 1M context, 128K output (models.dev: zhipuai/glm-5.2; GLM-5.3[1m]
  // Coding Plan route + launch coverage report the same window). Lookahead keeps
  // future glm-5.4+ (unverified profile) off this override.
  { pattern: /glm-5\.[23](?!\d)/i, contextWindow: 1_000_000, maxTokens: 131_072 },
  // DeepSeek V4: 1M context (models.dev + 9router codebuddy/nvidia overrides)
  { pattern: /deepseek-v[34]/i, contextWindow: 1_000_000 },
  // GLM-5.1 / 5 / 5-turbo / 5v-turbo: ~200K context (models.dev zhipuai/zhipuai-coding-plan/opencode-go: 200000–204800),
  // 128K output. Routes on the user's omniroute (glm-cn/glmcn/opencode-go/aug/nvidia) lack
  // top-level metadata and fall to the 128K FALLBACK, which under-reports.
  // Lookahead keeps glm-5.[23] out (covered above) and variant suffixes with their
  // own distinct windows safe (live catalog reports them above the floor).
  { pattern: /glm-5(?:\.1|-turbo|v-turbo)?(?![0-9.v-])/i, contextWindow: 200_000, maxTokens: 131_072 },
  // GLM-4.6 / 4.7: 200K / 128K (models.dev zhipuai/glm-4.6 = 204800; opencode-go glm-4.x = 200000).
  // Same fallback-under-report pattern.
  { pattern: /glm-4\.[67](?![0-9.v-])/i, contextWindow: 200_000, maxTokens: 131_072 },
  // Kimi K3: 1M context (models.dev moonshotai/kimi-k3 = 1048576/131072 across opencode-go/
  // openrouter/moonshotai-cn). Specific pattern — `kimi-k2.7-code` real = 262K so a
  // blanket override would inflate it (pi-commandcode 0.1.6 bug class).
  { pattern: /kimi-k3(?![0-9.v-])/i, contextWindow: 1_048_576, maxTokens: 131_072 },
];

function lookupContextOverride(modelId: string): { contextWindow?: number; maxTokens?: number } {
  for (const entry of CONTEXT_OVERRIDES) {
    if (entry.pattern.test(modelId)) {
      return { contextWindow: entry.contextWindow, ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}) };
    }
  }
  return {};
}

// Transport-verified vision routes. OmniRoute's /v1/models omits
// capabilities.vision on most non-openrouter connections, and the flag lies in
// BOTH directions — some flagged routes strip image parts outbound, some
// unflagged routes pass them. Entries here are proven end-to-end with
// extensions/scripts/probe-vision.mjs (PASS = image tokens counted / large
// prompt-token delta + correct image-only answer); re-probe when the router
// image updates. 2026-09-06 probe: gemini-3.7-flash prompt 21→1092 (Δ1071);
// deepseek-v4-flash-vision-exp 104→319 (Δ215). combo/glm-5.3-flash also
// passed (Δ1060) but is excluded — combo failover can land on a stripping
// member.
const VISION_OVERRIDES: RegExp[] = [
  // Anchored + explicit effort-tier suffix group: -low…-max are 9router's
  // thinking-level variants of the probed base (same upstream + executor, so
  // same image transport). Sibling models (-preview, -lite, future versions)
  // stay unverified — mirroring CONTEXT_OVERRIDES lookahead discipline.
  /^(cmd|command-code)\/google\/gemini-3\.7-flash(?:-(?:low|medium|high|xhigh|max))?$/i,
  /^(cmd|command-code)\/deepseek\/deepseek-v4-flash-vision-exp(?:-(?:low|medium|high|xhigh|max))?$/i,
];
// Inverse lie, verified 2026-09-06: openrouter entries stamp vision:true but
// the openrouter upstream strips image parts (glm-5.3-flash probe: Δ16, model
// replied NOIMAGE). Surgical list — other vision:true rows are untouched.
const VISION_DOWNGRADES: RegExp[] = [
  /^openrouter\/z-ai\/glm-5\.3-flash/i,
];

/** Net vision for a model id given the router's metadata claim. Also applied
 *  to the persisted offline catalog (provider.ts) so stale models-store.json
 *  entries self-heal at restore. */
export function resolveVision(id: string, metadataVision: boolean): boolean {
  if (VISION_DOWNGRADES.some((re) => re.test(id))) return false;
  return metadataVision || VISION_OVERRIDES.some((re) => re.test(id));
}

// Upstream connection slugs (OmniRoute ids are "<connection>/<model>") whose
// reasoning_effort schema rejects "none" and "minimal". The `cmd` slug is an alias
// pi-sub memory maps to the same upstream.
const NO_DISABLE_PREFIX = /^(command-?code|cmd)[-/]/i;

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
  const map = FORMAT_TO_LEVEL_MAP[fmt] ?? FORMAT_TO_LEVEL_MAP["openai"];
  // Upstream connections whose reasoning_effort accepts only low|medium|high|xhigh|max
  // (Command Code) — "none"/"minimal" would be forwarded untranslated and rejected
  // with HTTP 400 (same bug class as pi-commandcode 0.1.4). null hides both levels
  // in the Pi UI; the SDK omits reasoning_effort entirely when offValue is not a
  // string (openai-completions buildParams no-level branch), so background calls
  // (/tree branch summary, /handoff, off-level compaction) stop sending an invalid
  // value. Mirrors 9router FORMAT_LEVELS otherwise — only these prefixes are scoped.
  return NO_DISABLE_PREFIX.test(modelId) ? { ...map, off: null, minimal: null } : map;
}

export function mapModel(raw: RouterModelRaw, enableReasoning: boolean): PiModel {
  const isCombo = raw.owned_by === "combo";
  const caps = raw.capabilities as
    | { contextWindow?: unknown; maxOutput?: unknown; vision?: unknown }
    | undefined;
  // Context/max-output resolution, single-tier provenance with floor-aware
  // override: top-level `context_length`/`max_output_tokens` are authoritative
  // for their own field UNLESS the value sits at/below 9router's
  // DEFAULT_CAPABILITIES floor (200000) for a model whose verified window
  // exceeds the floor — that signature is the router's registry default stamp,
  // not real metadata, and the curated override corrects it. Anything above
  // the floor is never overridden (preserves e.g. openrouter/z-ai/glm-5.2:free
  // = 256K from the inflation bug 1.1.1 fixed). See also:
  // pi-commandcode/extensions/lib/client.ts#mapModel (same ordering; no floor
  // rule there — commandcode reports vendor-official context_length).
  const topLevelContext = parsePositiveInt(raw.context_length);
  const topLevelMax = parsePositiveInt(raw.max_output_tokens);
  // Raw presence gate (kept for back-compat with the 1.1.1 test contract): a
  // gateway that emits a present-but-invalid value (0, "unknown") must still
  // suppress CONTEXT_OVERRIDES so the stale override never mixes with router
  // truth; the unparseable value itself falls through to caps/fallback below.
  const hasTopLevel =
    (raw.context_length !== undefined && raw.context_length !== null) ||
    (raw.max_output_tokens !== undefined && raw.max_output_tokens !== null);
  const override = lookupContextOverride(raw.id);
  // Floor-aware gate, per-field: the override fires for a field when (a) no
  // top-level field is present at all (absent), or (b) a parseable top-level
  // value sits at/below the known DEFAULT_CAPABILITIES floor AND the
  // override's value exceeds the floor (otherwise there is nothing to
  // correct). Per-field reasoning keeps the deepseek-v[34] entry (which
  // omits maxTokens) from collapsing max to the 4096 fallback when the
  // router reports a poisoned context alongside a real maxOutput, and keeps
  // a present-but-unparseable top-level from triggering the override (the
  // 1.1.1 guarantee: that signals garbage, not router truth).
  const ctxAbsent = raw.context_length === undefined || raw.context_length === null;
  const maxAbsent = raw.max_output_tokens === undefined || raw.max_output_tokens === null;
  const ctxUsable = !ctxAbsent && topLevelContext !== undefined;
  const maxUsable = !maxAbsent && topLevelMax !== undefined;
  // Pair-floor-poison gate: the override applies to the model when (a) no
  // top-level fields are present at all (the router signals nothing — override
  // fills both), OR (b) the top-level pair exactly matches the omniroute /
  // 9router DEFAULT_CAPABILITIES signature (context ≤ DEFAULT_CONTEXT_FLOOR
  // AND max ≤ DEFAULT_MAX_FLOOR, with a verified override at the floor or
  // above for each). `>=` (not strict `>`) so models whose verified window
  // equals the floor (e.g. glm-5.1 / glm-4.6 at 200000) still get the max
  // correction when the router stamps the floor pair — the override is the
  // verified truth (models.dev) and is never stale below the floor. In all
  // other cases (any present field carries a truthful router value, or the
  // pair is only partially the floor stamp), the override is fully bypassed
  // (1.1.1 single-tier back-compat: presence = "router is signaling, don't
  // override; fall through to caps"). Per-field rules would break Direction
  // A/B; the all-or-nothing pair rule preserves the 1.1.1 invariant while
  // correcting the user's exact case (glm-cn/glm-5.3 stamped with the
  // 200000/128000 default-floor pair).
  const ctxFloorPoisoned =
    ctxUsable &&
    (topLevelContext as number) <= DEFAULT_CONTEXT_FLOOR &&
    override.contextWindow !== undefined &&
    override.contextWindow >= DEFAULT_CONTEXT_FLOOR;
  const maxFloorPoisoned =
    maxUsable &&
    (topLevelMax as number) <= DEFAULT_MAX_FLOOR &&
    override.maxTokens !== undefined &&
    override.maxTokens >= DEFAULT_MAX_FLOOR;
  const pairFloorPoisoned = ctxFloorPoisoned && maxFloorPoisoned;
  const useOverride = (ctxAbsent && maxAbsent) || pairFloorPoisoned;
  const ctxFromRouter = !pairFloorPoisoned && ctxUsable ? topLevelContext : undefined;
  const maxFromRouter = !pairFloorPoisoned && maxUsable ? topLevelMax : undefined;
  const contextWindow =
    ctxFromRouter ??
    (useOverride ? override.contextWindow : undefined) ??
    parsePositiveInt(caps?.contextWindow) ??
    FALLBACK_CONTEXT_WINDOW;
  const maxTokens =
    maxFromRouter ??
    (useOverride ? override.maxTokens : undefined) ??
    parsePositiveInt(caps?.maxOutput) ??
    FALLBACK_MAX_TOKENS;
  const inputTypes: ("text" | "image")[] = resolveVision(raw.id, caps?.vision === true)
    ? ["text", "image"]
    : ["text"];

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
  // Accept numeric strings ("1048576") — heterogeneous OpenAI-compat gateways
  // may serialize context_length/max_output_tokens as strings. Invalid values
  // (NaN, <=0, non-numeric text, null) fall through to the next tier.
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
  return undefined;
}

/** Re-map an already-mapped model with a new enableReasoning flag — used by
 *  /router-reasoning to toggle thinking levels without re-fetching. */
export function applyReasoning(model: PiModel, enableReasoning: boolean): PiModel {
  return {
    ...model,
    reasoning: enableReasoning,
    ...(enableReasoning
      ? { thinkingLevelMap: getThinkingLevelMap(model.id) }
      : { thinkingLevelMap: undefined }),
    compat: { ...model.compat!, supportsReasoningEffort: enableReasoning },
  };
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
