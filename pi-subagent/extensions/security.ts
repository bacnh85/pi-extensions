/**
 * Security and validation helpers for pi-subagent.
 *
 * Centralizes all trust-boundary checks so that internal callers (tool handler,
 * service/event path, parallel executor, chain executor) cannot bypass them.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tools that child agents may use. The subagent tool is never included. */
export const ALLOWED_CHILD_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
] as const;

export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
export const MUTATION_TOOLS: readonly string[] = ["edit", "write"];
export const EXECUTION_TOOLS: readonly string[] = ["bash"];

/**
 * Default inactivity timeout. Real SDK lifecycle activity resets this window;
 * the runner separately enforces a fixed 20-minute absolute cap.
 */
export const DEFAULT_TIMEOUT_MS = 3 * 60 * 1_000; // 3 minutes

/**
 * Absolute maximum timeout. Any requested value above this cap is rejected
 * at validation time rather than silently clamped.
 */
export const MAX_TIMEOUT_MS = 60 * 60 * 1_000; // 60 minutes

// ---------------------------------------------------------------------------
// Canonical result status
// ---------------------------------------------------------------------------

export type SubagentStatus = "success" | "partial" | "error" | "aborted" | "timeout";

/** Pi SDK stop reasons that indicate successful completion. */
const SUCCESS_REASONS = new Set(["stop", "end_turn", "completed"]);

/** Pi SDK stop reasons that indicate a partial / truncated response. */
const PARTIAL_REASONS = new Set(["length", "max_tokens", "context_limit"]);

/** Pi SDK stop reasons that indicate a provider or tool error. */
const ERROR_REASONS = new Set([
	"error",
	"tool_error",
	"authentication_error",
	"provider_error",
	"content_filter",
]);

/**
 * Map a raw stop reason string to a canonical SubagentStatus.
 *
 * `isAborted` and `isTimeout` take precedence because the Pi SDK may emit
 * "aborted" or "error" for both cases. Callers should pass the flags derived
 * from their own abort controllers.
 */
export function classifyStopReason(
	reason: string | undefined,
	isAborted: boolean,
	isTimeout: boolean,
): SubagentStatus {
	if (isAborted) return "aborted";
	if (isTimeout) return "timeout";
	if (!reason) return "success";
	if (SUCCESS_REASONS.has(reason)) return "success";
	if (PARTIAL_REASONS.has(reason)) return "partial";
	if (ERROR_REASONS.has(reason)) return "error";
	// Unknown stop reason — classify conservatively.
	return "error";
}

// ---------------------------------------------------------------------------
// Safe working-directory resolver
// ---------------------------------------------------------------------------

export interface SafeCwdOptions {
	/** The workspace root (parent session's cwd). Must be an absolute path. */
	workspaceRoot: string;
	/** The child's requested working directory, if any. */
	childCwd?: string;
	/**
	 * Trusted user setting that allows child cwd outside the workspace.
	 * Must never come from the tool-calling model.
	 */
	allowExternalCwd?: boolean;
}

export interface SafeCwdResult {
	path: string;
	error?: string;
}

/**
 * Resolve a child working directory that is guaranteed to be inside the
 * workspace root.
 *
 * Rules:
 * - No childCwd → return workspaceRoot.
 * - Relative paths are resolved relative to workspaceRoot.
 * - Absolute paths outside workspaceRoot are rejected unless allowExternalCwd.
 * - `..` traversal that escapes workspaceRoot is rejected.
 * - Symlinks are resolved via realpath and checked against workspaceRoot.
 * - Non-existent directories are rejected.
 * - Paths that are files instead of directories are rejected.
 */
export function resolveSafeCwd(options: SafeCwdOptions): SafeCwdResult {
	const { workspaceRoot, childCwd, allowExternalCwd } = options;

	// Normalise workspace root to an absolute canonical path.
	const resolvedRoot = resolveCanonical(workspaceRoot);
	if (!resolvedRoot) {
		return { path: "", error: `Workspace root does not exist: ${workspaceRoot}` };
	}
	if (!isDirectorySync(resolvedRoot)) {
		return { path: "", error: `Workspace root is not a directory: ${workspaceRoot}` };
	}

	// No child cwd → use workspace root.
	if (!childCwd) {
		return { path: resolvedRoot };
	}

	// Resolve the child path.
	const absPath = path.resolve(resolvedRoot, childCwd);

	// If the resolved path escapes the workspace via `..`, the resolved path
	// will differ from the canonical workspace root prefix. We check by
	// resolving the canonical absolute path.
	const canonicalPath = resolveCanonical(absPath);
	if (!canonicalPath) {
		return { path: "", error: `Child working directory does not exist: ${childCwd}` };
	}

	if (!isDirectorySync(canonicalPath)) {
		return { path: "", error: `Child working directory is a file, not a directory: ${childCwd}` };
	}

	// Check if the child path is inside the workspace.
	if (!isPathInside(canonicalPath, resolvedRoot)) {
		if (allowExternalCwd) {
			return { path: canonicalPath };
		}
		return {
			path: "",
			error:
				`Child working directory "${childCwd}" is outside the workspace root "${workspaceRoot}". ` +
				`Paths outside the workspace are rejected by default.`,
		};
	}

	return { path: canonicalPath };
}

/**
 * Check if `child` is inside `parent` or equal to it, after resolving both
 * to canonical paths. Rejects `..` traversal that escapes `parent`.
 */
function isPathInside(child: string, parent: string): boolean {
	// Both must be absolute.
	if (!path.isAbsolute(child) || !path.isAbsolute(parent)) return false;

	const relative = path.relative(parent, child);
	// relative must not start with ".." and must not be an absolute path.
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Resolve a path to its canonical real path, or return null if it doesn't exist.
 */
function resolveCanonical(p: string): string | null {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}

/**
 * Synchronously check if a path is a directory.
 */
function isDirectorySync(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Tool allowlist validation
// ---------------------------------------------------------------------------

export interface ValidateToolsOptions {
	/** Tool names from the agent definition or service override. */
	tools: string[];
	/** When true, only read-only tools are permitted. Mutation/execution tools are rejected. */
	readOnly?: boolean;
}

export interface ValidateToolsResult {
	/** Deduplicated and validated tool names. */
	tools: string[];
	/** Validation errors, if any. Empty array means valid. */
	errors: string[];
}

/**
 * Validate agent tool names against the allowlist.
 *
 * Always strips or rejects `subagent` to prevent recursive delegation.
 * Deduplicates tool names.
 * When `readOnly` is true, only READ_ONLY_TOOLS are permitted.
 */
export function validateAgentTools(options: ValidateToolsOptions): ValidateToolsResult {
	const { readOnly = false } = options;
	const seen = new Set<string>();
	const tools: string[] = [];
	const errors: string[] = [];

	for (const raw of options.tools) {
		const tool = raw.trim();
		if (!tool) continue;

		// Reject subagent regardless of casing (Pi tool names are case-sensitive
		// but "subagent" should never pass through).
		if (tool.toLowerCase() === "subagent") {
			errors.push(`Tool "subagent" is not allowed in child agents (recursive delegation is prevented).`);
			continue;
		}

		// Check against allowlist
		if (!ALLOWED_CHILD_TOOLS.includes(tool as any)) {
			errors.push(`Unknown tool "${tool}". Allowed tools: ${ALLOWED_CHILD_TOOLS.join(", ")}.`);
			continue;
		}

		// Check read-only constraint
		if (readOnly && !READ_ONLY_TOOLS.includes(tool)) {
			errors.push(
				`Tool "${tool}" is not allowed in read-only mode. Read-only tools: ${READ_ONLY_TOOLS.join(", ")}.`,
			);
			continue;
		}

		// Deduplicate
		if (seen.has(tool)) continue;
		seen.add(tool);
		tools.push(tool);
	}

	return { tools, errors };
}

// ---------------------------------------------------------------------------
// Timeout validation
// ---------------------------------------------------------------------------

export interface NormalizeTimeoutOptions {
	/** Requested timeout value from tool params, if any. */
	requested?: number;
	/** Global default when no timeout is specified. */
	defaultValue?: number;
	/** Absolute maximum allowed value. */
	maxValue?: number;
}

export interface NormalizeTimeoutResult {
	/** The validated timeout in milliseconds, or undefined if none was set and no default applies. */
	timeoutMs: number | undefined;
	/** Error message if the value is invalid. */
	error?: string;
}

/**
 * Validate and normalise a timeout value.
 *
 * Rules:
 * - Must be a finite integer if provided.
 * - Must be positive (> 0).
 * - Must not exceed maxValue.
 * - If no value is provided, defaultValue is used.
 * - Returns undefined only when no value and no default are configured.
 */
export function normalizeTimeout(options: NormalizeTimeoutOptions): NormalizeTimeoutResult {
	const { requested, defaultValue = DEFAULT_TIMEOUT_MS, maxValue = MAX_TIMEOUT_MS } = options;

	if (requested === undefined || requested === null) {
		// No explicit timeout — apply default.
		return { timeoutMs: defaultValue };
	}

	if (typeof requested !== "number" || !Number.isFinite(requested)) {
		return { timeoutMs: undefined, error: "Timeout must be a finite number." };
	}

	if (!Number.isInteger(requested)) {
		return { timeoutMs: undefined, error: "Timeout must be an integer (milliseconds)." };
	}

	if (requested <= 0) {
		return { timeoutMs: undefined, error: "Timeout must be a positive integer." };
	}

	if (requested > maxValue) {
		return {
			timeoutMs: undefined,
			error: `Timeout ${requested}ms exceeds maximum allowed ${maxValue}ms (${maxValue / 60_000} minutes).`,
		};
	}

	return { timeoutMs: requested };
}

// ---------------------------------------------------------------------------
// Abort signal composition
// ---------------------------------------------------------------------------

/**
 * Combine multiple abort signals into one, with correct listener cleanup.
 *
 * Works as a polyfill for AbortSignal.any() with proper cleanup semantics:
 * - If any input signal is already aborted, the returned signal aborts immediately.
 * - All event listeners are removed after the first abort or when `cleanup()` is called.
 *
 * Returns an object with the combined signal and a cleanup function.
 * Callers MUST call `cleanup()` in a `finally` block.
 */
export function createCombinedAbortSignal(
	signals: (AbortSignal | undefined | null | false)[],
): { signal: AbortSignal; cleanup: () => void } {
	const valid = signals.filter(Boolean) as AbortSignal[];

	if (valid.length === 0) {
		const controller = new AbortController();
		return { signal: controller.signal, cleanup: () => {} };
	}

	if (valid.length === 1) {
		return { signal: valid[0], cleanup: () => {} };
	}

	// Check if any is already aborted.
	for (const sig of valid) {
		if (sig.aborted) {
			const controller = new AbortController();
			controller.abort(sig.reason);
			return { signal: controller.signal, cleanup: () => {} };
		}
	}

	// Use native AbortSignal.any when available.
	if (typeof (AbortSignal as any).any === "function") {
		const combined = (AbortSignal as any).any(valid);
		return { signal: combined, cleanup: () => {} };
	}

	// Manual fallback: create a controller and forward all signals.
	const controller = new AbortController();
	const listeners: Array<() => void> = [];

	for (const sig of valid) {
		const handler = () => {
			controller.abort(sig.reason);
		};
		sig.addEventListener("abort", handler, { once: true });
		listeners.push(() => sig.removeEventListener("abort", handler));
	}

	const cleanup = () => {
		for (const remove of listeners) {
			try {
				remove();
			} catch {
				// Best-effort cleanup.
			}
		}
	};

	return { signal: controller.signal, cleanup };
}

// ---------------------------------------------------------------------------
// Execution request validation
// ---------------------------------------------------------------------------

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const MAX_CHAIN_LENGTH = 50;
export const PER_TASK_OUTPUT_CAP = 50 * 1024; // 50 KB
export const MAX_INSTRUCTIONS_LENGTH = 16 * 1024; // 16 KB

export interface ValidateExecutionRequestOptions {
	agentName?: string;
	task?: string;
	tasks?: unknown[];
	chain?: unknown[];
	timeout?: number;
}

export interface ValidationError {
	field: string;
	message: string;
}

/**
 * Generic validation for execution requests.
 * Enforces limits that TypeBox schemas may not cover, and defends against
 * internal callers that bypass the public tool schema.
 */
export function validateExecutionRequest(
	options: ValidateExecutionRequestOptions,
): ValidationError[] {
	const errors: ValidationError[] = [];

	// Agent name
	if (options.agentName !== undefined) {
		if (typeof options.agentName !== "string" || options.agentName.trim().length === 0) {
			errors.push({ field: "agent", message: "Agent name must be a non-empty string." });
		}
	}

	// Task
	if (options.task !== undefined) {
		if (typeof options.task !== "string") {
			errors.push({ field: "task", message: "Task must be a string." });
		}
	}

	// Parallel tasks
	if (options.tasks !== undefined) {
		if (!Array.isArray(options.tasks)) {
			errors.push({ field: "tasks", message: "Tasks must be an array." });
		} else {
			if (options.tasks.length > MAX_PARALLEL_TASKS) {
				errors.push({
					field: "tasks",
					message: `Too many parallel tasks (${options.tasks.length}). Maximum is ${MAX_PARALLEL_TASKS}.`,
				});
			}
			for (let i = 0; i < options.tasks.length; i++) {
				const t = options.tasks[i] as Record<string, unknown>;
				if (!t || typeof t.agent !== "string" || !t.agent.trim()) {
					errors.push({ field: `tasks[${i}].agent`, message: "Agent name must be a non-empty string." });
				}
				if (typeof t.task !== "string") {
					errors.push({ field: `tasks[${i}].task`, message: "Task must be a string." });
				}
			}
		}
	}

	// Chain
	if (options.chain !== undefined) {
		if (!Array.isArray(options.chain)) {
			errors.push({ field: "chain", message: "Chain must be an array." });
		} else {
			if (options.chain.length > MAX_CHAIN_LENGTH) {
				errors.push({
					field: "chain",
					message: `Too many chain steps (${options.chain.length}). Maximum is ${MAX_CHAIN_LENGTH}.`,
				});
			}
			for (let i = 0; i < options.chain.length; i++) {
				const s = options.chain[i] as Record<string, unknown>;
				if (!s || typeof s.agent !== "string" || !s.agent.trim()) {
					errors.push({ field: `chain[${i}].agent`, message: "Agent name must be a non-empty string." });
				}
				if (typeof s.task !== "string") {
					errors.push({ field: `chain[${i}].task`, message: "Task must be a string." });
				}
			}
		}
	}

	return errors;
}

/**
 * Truncate parallel task output to the per-task cap.
 */
export function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

// ---------------------------------------------------------------------------
// Rate-limit error detection
// ---------------------------------------------------------------------------

const RATE_LIMIT_PATTERNS = [
	/\b429\b/,
	/\b529\b/,
	/rate[\s_]limit/i,
	/ratelimit/i,
	/too[\s_]many[\s_]requests/i,
	/quota[\s_]exhausted/i,
	/quota[\s_]exceeded/i,
	/exceeded[\s_](?:your[\s_])?(?:current[\s_])?quota/i,
	/insufficient_quota/i,
	/resource[\s_]exhausted/i,
	/capacity[\s_]exceeded/i,
	/usage[\s_]limit/i,
	/overloaded/i,
];

/**
 * Check if an error message indicates a rate-limit / quota-exhaustion condition.
 *
 * Used by the sub-agent runtime to trigger automatic model fallback when the
 * primary model candidate hits a 429 or similar server-side capacity error.
 */
export function isRateLimitError(message: string): boolean {
	return RATE_LIMIT_PATTERNS.some(p => p.test(message));
}
