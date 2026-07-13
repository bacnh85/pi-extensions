/**
 * Pure detection logic for code-vs-non-code and semantic-search-vs-text-search decisions.
 * Extracted from index.ts so it can be tested without importing pi-coding-agent.
 */

export const CODE_FILE_EXTENSIONS = new Set([
	".c",
	".cc",
	".cpp",
	".cs",
	".css",
	".go",
	".java",
	".js",
	".jsx",
	".kt",
	".lua",
	".mjs",
	".php",
	".py",
	".rb",
	".rs",
	".scala",
	".sh",
	".swift",
	".ts",
	".tsx",
	".vue",
	".cjs",
]);

const NON_SEMANTIC_FILE_EXTENSIONS = new Set([
	".json", ".jsonl", ".jsonc", ".lock", ".md", ".txt", ".yaml", ".yml",
	".csv", ".log", ".env", ".ini", ".cfg", ".toml",
	".editorconfig", ".gitignore",
	".xml", ".graphql", ".svg",
]);


export function pathLooksLikeCode(value: unknown): boolean {
	const ext = normalizePathExtension(value);
	return ext !== undefined && CODE_FILE_EXTENSIONS.has(ext);
}

export function pathLooksNonSemantic(value: unknown): boolean {
	const ext = normalizePathExtension(value);
	return ext !== undefined && NON_SEMANTIC_FILE_EXTENSIONS.has(ext);
}

/** ponytail: shared guard/split for both path checks above */
function normalizePathExtension(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const cleanPath = value.split(/[?#]/, 1)[0].toLowerCase();
	const dotIndex = cleanPath.lastIndexOf(".");
	if (dotIndex < 0) return undefined;
	return cleanPath.slice(dotIndex);
}

const TODO_LIKE_PATTERNS = /\b(TODO|FIXME|HACK|NOTE|XXX|BUG|WORKAROUND|OPTIMIZE|REVIEW|TEMP|WARNING)\b/i;

export function commandLooksLikeSemanticCodeSearch(command: string): boolean {
	if (!/\b(rg|grep|fd|find|ag|ack|pt)\b/.test(command)) return false;
	// Non-semantic targets: docs, configs, and project files
	if (/\b(SKILL\.md|README\.md|AGENTS\.md|package\.json|skill-registry\.json|skill-history\.jsonl)\b/i.test(command)) return false;
	// Searching for TODO/FIXME/etc. is a non-semantic text search
	if (TODO_LIKE_PATTERNS.test(command)) return false;
	if (/\b(symbol|class|method|function|def|interface|references?|implementation|declaration|rename|refactor)\b/i.test(command)) return true;
	// ponytail: built from CODE_FILE_EXTENSIONS so the two lists stay in sync
	const codeExtPattern = [...CODE_FILE_EXTENSIONS].map(e => e.slice(1)).join("|");
	return new RegExp(`\\.(${codeExtPattern})\\b`, "i").test(command);
}