/**
 * Shared model resolution for pi-subagent.
 *
 * Provides a single canonical resolveModel() used by both the tool handler
 * (index.ts) and the event-driven service path (service.ts), ensuring
 * consistent error reporting across all sub-agent invocation paths.
 *
 * Queries the parent ModelRegistry first (catches custom-configured models
 * with overridden base URLs, headers, compatibility settings). Falls back
 * to the built-in registry for unconfigured models.
 * For unqualified names (no provider prefix), known naming conventions
 * are tried before assuming Anthropic.
 */

import { getModel } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface ResolvedModel {
	model: Model<any> | null;
	attempted: string[];
}

/** Known provider prefixes for unqualified model names. */
const KNOWN_PROVIDERS: [string, RegExp][] = [
	["openai", /^gpt-/i],
	["anthropic", /^claude-/i],
	["google", /^gemini-/i],
	["cohere", /^command-/i],
	["deepseek", /^(deepseek-|ds-)/i],
	["mistral", /^mistral-/i],
	["groq", /^(groq-|llama-)/i],
];

function tryGetModel(
	provider: string,
	id: string,
	modelRegistry?: ModelRegistry,
): Model<any> | null {
	// Query parent ModelRegistry first — it includes custom-configured models
	// (overridden base URLs, headers, compatibility settings, per-model overrides).
	// Fall back to built-in registry for unconfigured models.
	if (modelRegistry) {
		const found = modelRegistry.find(provider as any, id as any) ?? null;
		if (found) return found;
	}
	const builtIn = getModel(provider as any, id as any) ?? null;
	if (builtIn) return builtIn;
	return null;
}

export function resolveModel(
	modelName: string | undefined,
	parentModel: Model<any> | undefined,
	modelRegistry?: ModelRegistry,
): ResolvedModel {
	const attempted: string[] = [];
	if (modelName) {
		const idx = modelName.indexOf("/");
		if (idx > 0) {
			// Provider-qualified: "openai/gpt-4o" or "openrouter/anthropic/claude-3.5"
			const provider = modelName.slice(0, idx);
			const id = modelName.slice(idx + 1);
			attempted.push(modelName);
			const found = tryGetModel(provider, id, modelRegistry);
			if (found) return { model: found, attempted };
		} else {
			// Unqualified: try known providers by naming convention
			for (const [provider, pattern] of KNOWN_PROVIDERS) {
				if (pattern.test(modelName)) {
					attempted.push(`${provider}/${modelName}`);
					const found = tryGetModel(provider, modelName, modelRegistry);
					if (found) return { model: found, attempted };
				}
			}
			// Fall back to Anthropic shorthand (backward compat)
			attempted.push(`anthropic/${modelName}`);
			const found = tryGetModel("anthropic", modelName, modelRegistry);
			if (found) return { model: found, attempted };
		}
	} else if (parentModel) {
		attempted.push(`${parentModel.provider}/${parentModel.id}`);
		return { model: parentModel, attempted };
	}
	return { model: null, attempted };
}
