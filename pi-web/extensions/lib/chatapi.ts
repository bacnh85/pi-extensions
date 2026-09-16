// Generic OpenAI-compatible chat client for web_chat — one-off Q&A against
// any OpenAI-compatible /chat/completions gateway (WEB_CHAT_API_BASE_URL):
// a ChatGPT web bridge, official OpenAI, or any web2api gateway.

import { findEnvValue } from "./config";
import { raceGuard } from "./gemini";
import type { FetchLike } from "./imageapi";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ChatConfig {
  baseUrl: string;
  apiKey?: string;
  source: string;
}

export function loadChatConfig(cwd = process.cwd(), includeCwdEnv = false): ChatConfig | null {
  const base = findEnvValue("WEB_CHAT_API_BASE_URL", cwd, includeCwdEnv);
  if (!base.value) return null;
  const key = findEnvValue("WEB_CHAT_API_KEY", cwd, includeCwdEnv);
  return {
    baseUrl: base.value.replace(/\/+$/, ""),
    ...(key.value ? { apiKey: key.value } : {}),
    source: base.source,
  };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

export class ChatApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function describeChatApiError(err: unknown): string {
  if (err instanceof ChatApiError) {
    if (err.status === 401 || err.status === 403) return `gateway rejected the API key (HTTP ${err.status}): ${err.message}`;
    if (err.status === 429) return `gateway rate limit/quota exhausted (HTTP 429): ${err.message}`;
    if (err.status === 502) return `gateway returned 502 — likely an empty account pool (add an account via the gateway's admin panel): ${err.message}`;
    if (err.status >= 500) return `gateway server error (HTTP ${err.status}): ${err.message}`;
    return `gateway error (HTTP ${err.status}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Single non-streaming completion
// ---------------------------------------------------------------------------

export interface ChatResult {
  text: string;
  model?: string;
}

export async function chatgptChat(opts: {
  baseUrl: string;
  apiKey?: string;
  prompt: string;
  model?: string;
  system?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<ChatResult> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const messages = [
    ...(opts.system ? [{ role: "system", content: opts.system }] : []),
    { role: "user", content: opts.prompt },
  ];
  const res = await raceGuard(
    fetchImpl(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: opts.model, messages, stream: false }),
      signal: opts.signal,
    }),
    { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 120_000, label: "web_chat" },
  );
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const errObj = payload?.error as { message?: string } | undefined;
    const msg =
      errObj?.message ??
      (typeof payload?.message === "string" ? payload.message : undefined) ??
      (payload ? JSON.stringify(payload).slice(0, 300) : res.statusText ?? "");
    throw new ChatApiError(res.status, String(msg));
  }
  const choices = Array.isArray(payload?.choices) ? (payload!.choices as Array<{ message?: { content?: unknown } }>) : [];
  const text = String(choices[0]?.message?.content ?? "");
  if (!text) throw new Error(`gateway returned an empty completion${opts.model ? ` (model ${opts.model})` : ""}`);
  return { text, model: typeof payload?.model === "string" ? payload.model : opts.model };
}
