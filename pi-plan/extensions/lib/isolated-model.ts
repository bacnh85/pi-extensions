import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModel } from "./utility-config";

export interface IsolatedContext {
	systemPrompt: string;
	messages: any[];
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
): Promise<string> {
	const parsed = modelId ? parseModel(modelId) : undefined;
	if (modelId && !parsed) throw new Error(`Invalid model: ${modelId}`);
	const model = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : ctx.model;
	if (!model) throw new Error(`Model unavailable: ${modelId ?? "active"}`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	const provider = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
	const options = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal };
	const response = provider?.streamSimple
		? provider.streamSimple(model, context, options)
		: streamSimple(model, context, options);
	for await (const event of response) if (event.type === "text_delta") onDelta?.(event.delta);
	const result = await response.result();
	if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `Model stopped: ${result.stopReason}`);
	return text(result);
}
