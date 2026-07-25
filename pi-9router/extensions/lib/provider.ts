import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NineRouterConfig } from "./config.js";
import type { PiModel } from "./client.js";

/** Register the 9router provider with an eagerly-fetched model list.
 *  Using `models` directly instead of `refreshModels` ensures models are
 *  visible synchronously — Pi checks the model catalog at registration time
 *  for session restore and thinking-level queries. */
export function registerProvider(pi: ExtensionAPI, config: NineRouterConfig, models: PiModel[]): void {
  pi.registerProvider("9router", {
    name: "9router",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey || "9router-no-key",
    api: "openai-completions",
    models,
  });
}

export function unregisterProvider(pi: ExtensionAPI): void {
  pi.unregisterProvider("9router");
}
