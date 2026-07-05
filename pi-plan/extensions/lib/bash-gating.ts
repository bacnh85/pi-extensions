/**
 * Bash command gating logic for pi-plan's read-only plan mode.
 * Extracted from index.ts so it can be tested without importing @earendil-works/pi-coding-agent.
 */

export const DESTRUCTIVE_BASH_PATTERNS = [
	// File-system modifying commands — match only at command start (^) or after
	// command separators (; && || | &), not after plain spaces within arguments.
	/(?:^|(?:;\s*|&&\s*|\|\|?\s*|&\s*))(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|tee)\b/i,
	/(?:^|(?:;\s*|&&\s*|\|\|?\s*|&\s*))sudo\b/i,
	/(?:^|(?:;\s*|&&\s*|\|\|?\s*|&\s*))(?:kill(?:all)?|pkill|rekill)\b/i,
	/(?:^|(?:;\s*|&&\s*|\|\|?\s*|&\s*))(?:vim?|nano|emacs|code|subl)\b/i,
	// File output redirects >, >>, 1>, 2> (NOT fd duplication like 2>&1)
	// Matches after whitespace or command separators since that's how shell redirects work
	/(?:^|[\s;|&])[0-9]*>(?!>|&\d)/,
	/>>/,
	// Package manager commands (\b prefix correctly checks first word)
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\b(yarn|pnpm)\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)/i,
];

export function isDestructiveBash(command: string): boolean {
	return DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

export function tokenizeSimpleCommand(command: string): string[] | undefined {
	const trimmed = command.trim();
	if (!trimmed) return [];
	if (/[;&|`$(){}<>]/.test(trimmed)) return undefined;
	// Only check the first word for interpreter names, not arguments.
	// e.g., "which node" is read-only (node is an argument), "node script.js" is not.
	const firstWord = trimmed.split(/\s+/)[0];
	if (firstWord && /\b(python|python3|node|ruby|perl|php|sh|bash|zsh|fish)\b/i.test(firstWord)) return undefined;
	if (/['"]/.test(trimmed)) {
		// Parse tokens respecting quotes so quoted paths like ls "C:\\path" work.
		const tokens: string[] = [];
		let current = "";
		let inQuote: '"' | "'" | null = null;
		for (const ch of trimmed) {
			if (inQuote) {
				if (ch === inQuote) {
					inQuote = null;
				} else {
					current += ch;
				}
			} else if (ch === '"' || ch === "'") {
				inQuote = ch;
			} else if (/\s/.test(ch)) {
				if (current) {
					tokens.push(current);
					current = "";
				}
			} else {
				current += ch;
			}
		}
		if (current) tokens.push(current);
		return tokens;
	}
	return trimmed.split(/\s+/).filter(Boolean);
}

export function sanitizeCommand(command: string): string[] {
	let sanitized = command;

	// Strip /dev/null redirects: 2>/dev/null, >/dev/null, >>/dev/null, &>/dev/null
	sanitized = sanitized.replace(/\d*>>?\s*\/dev\/null/g, "");
	sanitized = sanitized.replace(/&>\s*\/dev\/null/g, "");
	// Strip Windows nul redirects: 2>nul, >nul, >>nul, &>nul
	sanitized = sanitized.replace(/\d*>>?\s*nul\b/g, "");
	sanitized = sanitized.replace(/&>\s*nul\b/g, "");
	// Strip fd redirections: 2>&1, 1>&2, etc.
	sanitized = sanitized.replace(/\s*\d*>&\d+\s*/g, " ");

	// Strip cd <path> &&  /  cd <path> ;  prefix
	sanitized = sanitized.replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/i, "").trim();

	// Split on && and ; (chaining operators) to validate each segment independently.
	// || remains blocked because it introduces conditional/fallback execution paths.
	const chainSegments = sanitized.split(/\s*&&\s*|\s*;\s*/).map((s) => s.trim()).filter(Boolean);
	if (chainSegments.length === 0) return [];

	// Within each chain segment, further split on pipes for per-segment validation
	const allSegments: string[] = [];
	for (const segment of chainSegments) {
		if (segment.includes("|")) {
			allSegments.push(...segment.split("|").map((s) => s.trim()).filter(Boolean));
		} else {
			allSegments.push(segment);
		}
	}

	return allSegments;
}

function hasOptionValue(tokens: string[], index: number): boolean {
	return index + 1 < tokens.length && !tokens[index + 1].startsWith("-");
}

function isAllowedNpmMetadataCommand(tokens: string[]): boolean {
	if (tokens[0] !== "npm" || !["view", "info"].includes(tokens[1])) return false;
	let hasSpec = false;
	for (let index = 2; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (["--registry", "--tag"].includes(token)) {
			if (!hasOptionValue(tokens, index)) return false;
			index += 1;
			continue;
		}
		if (token.startsWith("--registry=") || token.startsWith("--tag=") || token === "--json" || token === "--parseable" || token === "--silent") continue;
		if (token.startsWith("-")) return false;
		hasSpec = true;
	}
	return hasSpec;
}

function isAllowedNpmPackDryRun(tokens: string[]): boolean {
	if (tokens[0] !== "npm" || tokens[1] !== "pack") return false;
	let hasSpec = false;
	let hasDryRun = false;
	let hasIgnoreScripts = false;
	for (let index = 2; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--registry") {
			if (!hasOptionValue(tokens, index)) return false;
			index += 1;
			continue;
		}
		if (token === "--dry-run") {
			hasDryRun = true;
			continue;
		}
		if (token === "--ignore-scripts") {
			hasIgnoreScripts = true;
			continue;
		}
		if (token === "--json" || token === "--silent" || token.startsWith("--registry=")) continue;
		if (token.startsWith("-")) return false;
		hasSpec = true;
	}
	return hasSpec && hasDryRun && hasIgnoreScripts;
}

function isAllowedGitCommand(tokens: string[]): boolean {
	if (tokens[0] !== "git" || !tokens[1]) return false;
	const subcommand = tokens[1];
	// -- is a standard POSIX argument separator; filter it out before subcommand-specific checks
	const args = tokens.slice(2).filter((arg) => arg !== "--");
	if (["add", "commit", "push", "pull", "merge", "rebase", "reset", "checkout", "switch", "restore", "stash", "cherry-pick", "revert", "tag", "init", "clone", "fetch", "remote", "config", "worktree"].includes(subcommand)) return false;

	if (subcommand === "status") {
		// Flags must match the allowlist; positional args (paths) are always read-only
		const flags = args.filter((arg) => arg.startsWith("-"));
		return flags.every((arg) => ["--short", "-s", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--branch", "-b", "--ignored", "--ignored=matching", "--ignored=traditional", "--ignored=no", "--untracked-files", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all", "-uno", "-unormal", "-uall"].includes(arg));
	}
	if (subcommand === "diff") return !args.some((arg) => arg === "--output" || arg.startsWith("--output=") || arg === "--ext-diff" || arg === "--textconv");
	if (["show", "log", "rev-parse", "ls-files"].includes(subcommand)) return true;
	if (subcommand === "branch") {
		const mutating = new Set(["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--set-upstream-to", "--track", "--unset-upstream", "--edit-description"]);
		return !args.some((arg) => mutating.has(arg) || arg.startsWith("--set-upstream-to=") || arg === "-u");
	}
	return false;
}

export function isReadOnlyBash(command: string): boolean {
	const segments = sanitizeCommand(command);
	if (segments.length === 0) return true;

	return segments.every((segment) => {
		const tokens = tokenizeSimpleCommand(segment);
		if (!tokens) return false;
		if (tokens.length === 0) return true;
		const normalized = tokens[0] === "rtk" ? tokens.slice(1) : tokens;
		if (normalized.length === 0) return false;
		if (isAllowedGitCommand(normalized)) return true;
		if (isAllowedNpmMetadataCommand(normalized)) return true;
		if (isAllowedNpmPackDryRun(normalized)) return true;
		return /^(rg|grep|find|fd|ls|pwd|cat|head|tail|sed|awk|wc|sort|uniq|cut|echo|read|where|which|findstr|type)$/.test(normalized[0]);
	});
}
