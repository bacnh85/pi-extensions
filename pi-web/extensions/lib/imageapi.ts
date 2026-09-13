// Generic OpenAI-compatible images client + fallback chain for web_image.
// Serves the `zai` preset (official api.z.ai, GLM-Image) and any `custom`
// OpenAI-images endpoint — direct-to-upstream plain fetch, no self-host.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { findEnvValue } from "./config";
import {
  describeGeminiError,
  geminiGenerateImage,
  raceGuard,
  type GeminiClientFactory,
  type GeminiWebConfig,
} from "./gemini";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const ZAI_PRESET = { baseUrl: "https://api.z.ai/api/paas/v4", defaultModel: "glm-image" } as const;

export interface ImageApiConfig {
  zai?: { apiKey: string; source: string };
  custom?: { baseUrl: string; apiKey?: string; label: string; source: string };
}

export function loadImageApiConfig(cwd = process.cwd(), includeCwdEnv = false): ImageApiConfig {
  const zaiKey = findEnvValue("ZAI_API_KEY", cwd, includeCwdEnv);
  const zaiFound = zaiKey.value ? zaiKey : findEnvValue("Z_AI_API_KEY", cwd, includeCwdEnv);
  const base = findEnvValue("WEB_IMAGE_API_BASE_URL", cwd, includeCwdEnv);
  const key = findEnvValue("WEB_IMAGE_API_KEY", cwd, includeCwdEnv);
  const label = findEnvValue("WEB_IMAGE_API_LABEL", cwd, includeCwdEnv);
  const cfg: ImageApiConfig = {};
  if (zaiFound.value) cfg.zai = { apiKey: zaiFound.value, source: zaiFound.source };
  if (base.value) {
    cfg.custom = {
      baseUrl: base.value.replace(/\/+$/, ""),
      ...(key.value ? { apiKey: key.value } : {}),
      label: label.value || hostOf(base.value),
      source: base.source,
    };
  }
  return cfg;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface ImageRateConfig {
  minIntervalMs: number;
  dailyCap: number; // applies to the gemini web tier only — keyed APIs stay uncapped
}

export function loadImageRateConfig(cwd = process.cwd(), includeCwdEnv = false): ImageRateConfig {
  const interval = findEnvValue("WEB_IMAGE_MIN_INTERVAL_MS", cwd, includeCwdEnv);
  const cap = findEnvValue("WEB_IMAGE_DAILY_CAP", cwd, includeCwdEnv);
  const intervalNum = Number(interval.value);
  const capNum = Number(cap.value);
  return {
    minIntervalMs: interval.value && Number.isFinite(intervalNum) ? Math.max(0, Math.trunc(intervalNum)) : 5000,
    dailyCap: cap.value && Number.isFinite(capNum) ? Math.max(1, Math.trunc(capNum)) : 20,
  };
}

// ---------------------------------------------------------------------------
// Soft rate guardrails (in-memory, reset on restart). Successful generations
// only — failures don't consume quota.
// ---------------------------------------------------------------------------

interface RateState {
  lastAt: number;
  day: string;
  count: number;
}

const rate = new Map<string, RateState>();
let nowMs = () => Date.now();

/** @internal test hooks */
export function __setImageRateClock(fn: () => number): void {
  nowMs = fn;
}

/** @internal test hooks */
export function __resetImageRate(): void {
  rate.clear();
  nowMs = () => Date.now();
}

const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

function msUntilUtcRoll(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - ts;
}

export type RateVerdict = { ok: true } | { ok: false; reason: string; retryAfterMs: number };

export function imageRateCheck(provider: "gemini" | "zai" | "custom", rateCfg: ImageRateConfig): RateVerdict {
  const state = rate.get(provider);
  const ts = nowMs();
  if (state && rateCfg.minIntervalMs > 0) {
    const elapsed = ts - state.lastAt;
    if (elapsed < rateCfg.minIntervalMs) {
      return {
        ok: false,
        reason: `min interval ${rateCfg.minIntervalMs}ms between calls (elapsed ${elapsed}ms, WEB_IMAGE_MIN_INTERVAL_MS)`,
        retryAfterMs: rateCfg.minIntervalMs - elapsed,
      };
    }
  }
  if (provider === "gemini" && state && state.day === utcDay(ts) && state.count >= rateCfg.dailyCap) {
    return {
      ok: false,
      reason: `daily soft cap reached (${rateCfg.dailyCap}/day, WEB_IMAGE_DAILY_CAP)`,
      retryAfterMs: msUntilUtcRoll(ts),
    };
  }
  return { ok: true };
}

export function imageRateRecord(provider: "gemini" | "zai" | "custom", count = 1): void {
  const ts = nowMs();
  const day = utcDay(ts);
  const prev = rate.get(provider);
  const sameDay = prev?.day === day;
  rate.set(provider, { lastAt: ts, day, count: (sameDay ? prev!.count : 0) + count });
}

export function imageRateSnapshot(): Record<string, { count: number; day: string; msSinceLast: number }> {
  const ts = nowMs();
  const out: Record<string, { count: number; day: string; msSinceLast: number }> = {};
  for (const [provider, s] of rate) {
    out[provider] = { count: s.day === utcDay(ts) ? s.count : 0, day: s.day, msSinceLast: Math.max(0, ts - s.lastAt) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Single-provider OpenAI-images call (POST {base}/images/generations)
// ---------------------------------------------------------------------------

export interface FetchLike {
  (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<{ ok: boolean; status: number; statusText?: string; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;
}

export interface ApiImageResult {
  paths: string[];
  /** Image URLs that could not be downloaded (e.g. CDN unreachable) — the generation still happened. */
  urls: string[];
  model?: string;
}

export class ImageApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function describeImageApiError(err: unknown): string {
  if (err instanceof ImageApiError) {
    if (err.status === 401 || err.status === 403) return `upstream rejected the API key (HTTP ${err.status}): ${err.message}`;
    if (err.status === 429) return `upstream rate limit/quota exhausted (HTTP 429): ${err.message}`;
    if (err.status >= 500) return `upstream server error (HTTP ${err.status}): ${err.message}`;
    return `upstream error (HTTP ${err.status}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function apiGenerateImage(opts: {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  prompt: string;
  n?: number;
  outDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<ApiImageResult> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/images/generations`;
  const res = await raceGuard(
    fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: opts.model, prompt: opts.prompt, n: opts.n ?? 1 }),
      signal: opts.signal,
    }),
    { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 180_000, label: "web_image api" },
  );
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const errObj = payload?.error as { message?: string } | undefined;
    const msg =
      errObj?.message ??
      (typeof payload?.message === "string" ? payload.message : undefined) ??
      (payload ? JSON.stringify(payload).slice(0, 300) : res.statusText ?? "");
    throw new ImageApiError(res.status, String(msg));
  }
  const items = Array.isArray(payload?.data) ? (payload!.data as Array<Record<string, unknown>>) : [];
  if (!items.length) throw new Error(`upstream returned no image data (model ${opts.model ?? "default"})`);
  fs.mkdirSync(opts.outDir, { recursive: true });
  const paths: string[] = [];
  const urls: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item?.b64_json === "string" && item.b64_json) {
      paths.push(writeB64(opts.outDir, item.b64_json, i));
    } else if (typeof item?.url === "string" && item.url) {
      // A failed download must not waste the generation: surface the URL.
      try {
        paths.push(await downloadImage(fetchImpl, item.url, opts.outDir, i, opts.signal, opts.timeoutMs));
      } catch (err) {
        urls.push(item.url);
        void err;
      }
    } else {
      throw new Error(`image item ${i} had neither b64_json nor url`);
    }
  }
  if (!paths.length && !urls.length) throw new Error(`upstream returned no image data (model ${opts.model ?? "default"})`);
  return { paths, urls, model: typeof payload?.model === "string" ? payload.model : opts.model };
}

function writeB64(outDir: string, b64: string, i: number): string {
  const file = path.join(outDir, `pi-web-image-${randomUUID().slice(0, 8)}-${i}.png`);
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  return file;
}

async function downloadImage(
  fetchImpl: FetchLike,
  url: string,
  outDir: string,
  i: number,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string> {
  const res = await raceGuard(fetchImpl(url, { method: "GET", signal }), {
    signal,
    timeoutMs: timeoutMs ?? 120_000,
    label: "web_image download",
  });
  if (!res.ok) throw new ImageApiError(res.status, `image download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(outDir, `pi-web-image-${randomUUID().slice(0, 8)}-${i}${extFor(url)}`);
  fs.writeFileSync(file, buf);
  return file;
}

function extFor(url: string): string {
  const m = /\.(png|jpe?g|webp|gif)(\?|$)/i.exec(url);
  const ext = (m?.[1] ?? "png").toLowerCase();
  return `.${ext === "jpeg" ? "jpg" : ext}`;
}

// ---------------------------------------------------------------------------
// Fallback chain: gemini (free web tier) → zai (official API) → custom
// ---------------------------------------------------------------------------

export type ImageProvider = "gemini" | "zai" | "custom";

export interface ImageChainResult {
  provider: ImageProvider;
  model?: string;
  paths: string[];
  urls: string[];
  attempts: string[];
}

export interface ImageChainParams {
  prompt: string;
  model?: string;
  n?: number;
  outDir: string;
  provider: "auto" | ImageProvider;
  geminiConfig: GeminiWebConfig;
  apiConfig: ImageApiConfig;
  rateConfig: ImageRateConfig;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** @internal test injection */
  geminiFactory?: GeminiClientFactory;
  /** @internal test injection */
  fetchImpl?: FetchLike;
}

function chainFor(provider: "auto" | ImageProvider): ImageProvider[] {
  // Auto includes ALL providers: unconfigured ones contribute "not configured
  // (set …)" hints to the aggregated error instead of vanishing silently.
  return provider === "auto" ? ["gemini", "zai", "custom"] : [provider];
}

export async function generateImageWithFallback(params: ImageChainParams): Promise<ImageChainResult> {
  const chain = chainFor(params.provider);
  const attempts: string[] = [];
  for (const provider of chain) {
    // Cancelled calls skip fallback entirely — before any provider client
    // construction or fetch invocation.
    if (params.signal?.aborted) {
      const abortErr = new Error("web_image aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    const configured =
      provider === "gemini" ? true : provider === "zai" ? Boolean(params.apiConfig.zai) : Boolean(params.apiConfig.custom);
    if (!configured) {
      attempts.push(`${provider}: not configured${provider === "zai" ? " (set ZAI_API_KEY)" : " (set WEB_IMAGE_API_BASE_URL)"}`);
      continue;
    }
    const rate = imageRateCheck(provider, params.rateConfig);
    if (!rate.ok) {
      attempts.push(`${provider}: skipped — ${rate.reason}`);
      continue;
    }
    try {
      let result: { paths: string[]; urls?: string[]; model?: string };
      if (provider === "gemini") {
        result = await geminiGenerateImage(params.prompt, {
          config: params.geminiConfig,
          outDir: params.outDir,
          model: params.model,
          timeoutMs: params.timeoutMs,
          signal: params.signal,
          factory: params.geminiFactory,
        });
      } else if (provider === "zai") {
        result = await apiGenerateImage({
          baseUrl: ZAI_PRESET.baseUrl,
          apiKey: params.apiConfig.zai!.apiKey,
          model: params.model ?? ZAI_PRESET.defaultModel,
          prompt: params.prompt,
          n: params.n,
          outDir: params.outDir,
          timeoutMs: params.timeoutMs,
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
      } else {
        result = await apiGenerateImage({
          baseUrl: params.apiConfig.custom!.baseUrl,
          apiKey: params.apiConfig.custom!.apiKey,
          model: params.model,
          prompt: params.prompt,
          n: params.n,
          outDir: params.outDir,
          timeoutMs: params.timeoutMs,
          signal: params.signal,
          fetchImpl: params.fetchImpl,
        });
      }
      imageRateRecord(provider);
      if (provider === "gemini" && params.n && params.n > 1 && result.paths.length < params.n) {
        attempts.push(`gemini: n=${params.n} requested — the gemini web tier returns its own image count (${result.paths.length}); n applies to zai/custom`);
      }
      return { provider, model: result.model, paths: result.paths, urls: result.urls ?? [], attempts };
    } catch (err) {
      // Cancellation is not a provider failure: rethrow so aborted tool calls
      // surface as AbortError instead of an "all providers failed" listing —
      // even when a genuine provider error (AuthError, a failed save, …) was
      // the error in flight when the abort landed.
      if (params.signal?.aborted) {
        if ((err as Error)?.name === "AbortError") throw err;
        // cause keeps the in-flight provider error for diagnostics.
        const abortErr = new Error("web_image aborted", { cause: err });
        abortErr.name = "AbortError";
        throw abortErr;
      }
      // A foreign AbortError-named error (not from the caller's signal) is a
      // provider failure like any other — record it and keep the chain going.
      attempts.push(`${provider}: ${provider === "gemini" ? describeGeminiError(err) : describeImageApiError(err)}`);
    }
  }
  throw new Error(`All image providers failed:\n${attempts.map((a) => `- ${a}`).join("\n")}`);
}
