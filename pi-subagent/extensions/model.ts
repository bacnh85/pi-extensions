/**
 * Shared model resolution for pi-subagent.
 *
 * Provides a single canonical resolveModel() used by both the tool handler
 * (index.ts) and the event-driven service path (service.ts), ensuring
 * consistent error reporting across all sub-agent invocation paths.
 *
 * Selects the first authenticated candidate reported by the parent
 * ModelRegistry, then falls back to the authenticated parent model.
 * For unqualified names (no provider prefix), known naming conventions
 * are tried before assuming Anthropic.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface ResolvedModel {
	model: Model<any> | null;
	attempted: string[];
	/** The raw candidate name that matched, if a candidate resolved. Undefined for parent fallback. */
	matchedCandidate?: string;
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

export async function resolveModel(
	modelNames: readonly string[],
	parentModel: Model<any> | undefined,
	modelRegistry?: ModelRegistry,
): Promise<ResolvedModel> {
	const attempted: string[] = [];
	const available = modelRegistry?.getAvailable() ?? [];
	const byName = new Map(available.map((model) => [`${model.provider}/${model.id}`, model]));
	const tryAvailable = (qualifiedName: string): Model<any> | undefined => {
		if (!attempted.includes(qualifiedName)) attempted.push(qualifiedName);
		return byName.get(qualifiedName);
	};

	for (const modelName of [...new Set(modelNames.map((name) => name.trim()).filter(Boolean))]) {
		const idx = modelName.indexOf("/");
		if (idx > 0) {
			const found = tryAvailable(modelName);
			if (found) return { model: found, attempted, matchedCandidate: modelName };
			continue;
		}
		for (const [provider, pattern] of KNOWN_PROVIDERS) {
			if (!pattern.test(modelName)) continue;
			const found = tryAvailable(`${provider}/${modelName}`);
			if (found) return { model: found, attempted, matchedCandidate: modelName };
		}
		const found = tryAvailable(`anthropic/${modelName}`);
		if (found) return { model: found, attempted, matchedCandidate: modelName };
	}

	if (parentModel) {
		const found = tryAvailable(`${parentModel.provider}/${parentModel.id}`);
		if (found) return { model: found, attempted };
	}
	return { model: null, attempted };
}
