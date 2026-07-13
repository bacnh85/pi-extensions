import { commandLooksLikeSemanticCodeSearch, pathLooksLikeCode, pathLooksNonSemantic } from "./detect";

export const SERENA_FIRST_GUIDANCE = "Serena-first code navigation: before reading whole code files for code navigation, call Serena first. For named source files, start with serena_get_symbols_overview(relative_path=...). For named functions/classes/methods/variables, use serena_find_symbol. Use serena_find_referencing_symbols before behavior changes or renames, and serena_find_declaration / serena_find_implementations for definitions, interfaces, and implementations. Use read/grep/find for docs, configs, non-code files, exact text checks, or narrow code ranges after Serena identifies the target.";

export const SERENA_MISS_GUIDANCE = "Use serena_get_symbols_overview for source-file outlines or serena_find_symbol for named symbols before reading/searching code. Use read after Serena identifies the relevant region, or for docs/config/non-code files.";

const BLOCKED_TOOLS = new Set(["read", "bash"]);

export function shouldBlockSemanticMiss(toolName: string, input: Record<string, unknown>): boolean {
	if (!BLOCKED_TOOLS.has(toolName)) return false;
	if (toolName === "read") return pathLooksLikeCode(input.path) && !pathLooksNonSemantic(input.path);
	if (toolName === "bash") {
		const command = input.command;
		return typeof command === "string" && commandLooksLikeSemanticCodeSearch(command);
	}
	return false;
}
