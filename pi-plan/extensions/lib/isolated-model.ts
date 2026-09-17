import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModel } from "./utility-config";

export interface IsolatedContext {
  systemPrompt: string;
  messages: any[];
}

/** OpenCode routes and caches per session; Console Go rejects requests without
 *  the header. pi's main loop attaches it in ModelRuntime.prepareRequest via
 *  `transformHeaders`, but that option is only honoured there — the compat /
 *  registered-provider stream path this file uses drops it, so isolated calls
 *  must merge the header into `options.headers` themselves. */
export function opencodeSessionHeaders(
  model: { provider?: string; baseUrl?: string },
  sessionId: string | undefined,
): Record<string, string> | undefined {
  if (!sessionId) return undefined;
  let host = "";
  try { host = new URL(model.baseUrl ?? "").hostname; } catch { /* non-URL baseUrl: provider check decides */ }
  const isOpenCode = model.provider === "opencode" || model.provider === "opencode-go" || host === "opencode.ai";
  return isOpenCode ? { "x-opencode-session": sessionId, "x-opencode-client": "pi" } : undefined;
}

export function text(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

export async function runIsolated(
  ctx: ExtensionContext,
  modelId: string | undefined,
  context: IsolatedContext,
  onDelta?: (delta: string) => void,
  signal?: AbortSignal,
  reasoning?: string,
): Promise<string> {
  const parsed = modelId ? parseModel(modelId) : undefined;
  if (modelId && !parsed) throw new Error(`Invalid model: ${modelId}`);
  const model = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : ctx.model;
  if (!model) throw new Error(`Model unavailable: ${modelId ?? "active"}`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const provider = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
  // Session headers first so explicitly configured auth headers still win (matches
  // pi's mergeProviderAttributionHeaders precedence).
  const headers = { ...opencodeSessionHeaders(model, ctx.sessionManager?.getSessionId?.()), ...auth.headers };
  const options: Record<string, unknown> = { apiKey: auth.apiKey, headers, env: auth.env, signal, reasoning };
  // ponytail: providers accept SimpleStreamOptions which expects ThinkingLevel for reasoning
  const streamOptions = options as any;
  const response = provider?.streamSimple
    ? provider.streamSimple(model, context, streamOptions)
    : streamSimple(model, context, streamOptions);
  for await (const event of response) if (event.type === "text_delta") onDelta?.(event.delta);
  const result = await response.result();
  if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `Model stopped: ${result.stopReason}`);
  return text(result);
}
