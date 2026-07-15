import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import path from "node:path";

const STATUS_KEY = "pi-review";
const SUBAGENT_EVENT = "pi-subagent:run";
// ponytail: keep in sync with pi-plan/extensions/index.ts REVIEW_EVENT
export const REVIEW_EVENT = "pi-review:run";
const MAX_STATUS_BYTES = 10 * 1024;
const MAX_LOG_BYTES = 10 * 1024;
const MAX_DIFF_BYTES = 50 * 1024;
const MAX_RANGE_DIFF_BYTES = 30 * 1024;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// ponytail: keep in sync with pi-plan/extensions/lib/plan-tools.ts READ_ONLY_TOOLS (additions there should be mirrored here)
export const SAFE_REVIEW_TOOLS = new Set([
	"read", "bash", "grep", "find", "ls",
	"ffgrep", "fffind", "resolve_file", "fff_multi_grep", "related_files",
	"web_search", "web_extract", "web_map", "web_crawl", "web_screenshot", "web_pdf", "web_status",
	"serena_status", "serena_list_tools", "serena_get_current_config", "serena_get_symbols_overview",
	"serena_find_symbol", "serena_find_declaration", "serena_find_implementations",
	"serena_find_referencing_symbols", "serena_search_for_pattern", "serena_get_diagnostics_for_file",
	"munin_search", "munin_get", "munin_list", "munin_recent", "munin_capabilities",
]);

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type ReviewPreset = "default" | "uncommitted" | "branch" | "custom";

export interface ReviewFinding {
	severity: "critical" | "high" | "medium" | "low";
	file: string;
	line: number;
	issue: string;
	evidence: string;
	suggestedFix: string;
	blocking: boolean;
}

export interface ReviewResult {
	summary: string;
	findings: ReviewFinding[];
}

export interface ReviewRunRequest {
	id: string;
	cwd: string;
	prompt: string;
	timeout?: number;
	signal?: AbortSignal;
	accept?: () => boolean;
	respond: (response: { id: string; ok: boolean; result?: ReviewResult; error?: string }) => void;
	/** Git diff range for branch/custom scopes (e.g. "@{upstream}...HEAD"). */
	gitRange?: string;
	/** When true, custom ranges must resolve exactly — no fallback to upstream/main. */
	requireExactRange?: boolean;
}

const DESTRUCTIVE_BASH_PATTERNS = [
	/\brm(dir)?\b/i, /\b(mv|cp|mkdir|touch|chmod|chown|tee)\b/i, /(^|[^<])>(?!>)|>>/,
	/\b(npm|yarn|pnpm|pip)\s+(install|uninstall|update|upgrade|add|remove|ci|link|publish|version)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone|clean|restore|notes|config)\b/i,
	/\bgit\s+branch\s+(?!--(?:list|all|remote|merged|no-merged|contains|show-current)\b)/i,
	/--output(?:=|\s)/i,
	/\bfind\b[^\n]*-(delete|exec|execdir|ok|okdir|fprint[f0]?|fls)\b/i,
	/\bsed\b[^\n]*\s-i(?:\s|$)/i,
	/\bsed\b[^\n]*(?:'w\s|\bw\s+\/[^\s]|'\s*w\s)/i,
	/\bsort\b[^\n]*\s-o(?:\s|$)/i,
	/\b(sudo|kill|killall|pkill|rekill|vim|vi|nano|emacs|code|subl)\b/i,
  /\bgit\s+(apply|am|format-patch|worktree)\b/i,
];

export function parseReviewArgs(args: string): { thinking: ThinkingLevel; target: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	return tokens[0] && (THINKING_LEVELS as readonly string[]).includes(tokens[0])
		? { thinking: tokens[0] as ThinkingLevel, target: tokens.slice(1).join(" ") }
		: { thinking: "high", target: args.trim() };
}

export function isReadOnlyBash(command: string): boolean {
	// Reject multiline commands — the classification regexes are single-line only
	if (/[\r\n]/.test(command)) return false;
	const inspection = command.trim().replace(/^rtk\s+/i, "");
	if (!inspection) return true;
	if (/[;&|`$()]/.test(inspection) || /\b(python|python3|node|ruby|perl|php|sh|bash|zsh|fish)\b/i.test(inspection)) return false;
	if (DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(inspection))) return false;
	// Read-only git subcommands
	if (/^git\s+/i.test(inspection)) {
		return /^git\s+(status|rev-parse|diff|show|log|ls-files)\b/i.test(inspection)
			|| /^git\s+branch\s+--(?:list|all|remote|merged|no-merged|contains|show-current)\b/i.test(inspection);
	}
	// Package-manager commands can run repository-controlled lifecycle scripts.
	if (/^(?:npm|yarn|pnpm)\s+/i.test(inspection)) return false;
	// Read-only non-git commands
	return /^(?:rg|grep|find|fd|ls|pwd|cat|head|tail|awk|wc|sort|uniq|cut)\b/i.test(inspection);
}

function reviewPresetPrompt(preset: ReviewPreset): string {
	if (preset === "uncommitted") return "Review staged, unstaged, and untracked changes.";
	if (preset === "branch") return "Review the current branch against its upstream or default base branch, plus local changes.";
	if (preset === "custom") return "Review the target or focus area supplied by the user.";
	return "Inspect Git state with read-only tools — branch commits ahead of upstream plus staged, unstaged, and untracked changes.";
}

export function buildReviewPrompt(preset: ReviewPreset, target: string): string {
	const rangeHint = preset === "branch" ? "\n\nCompare against upstream/base branch (commits ahead plus local changes)."
		: preset === "uncommitted" ? "\n\nStaged, unstaged, and untracked changes only."
		: "";
	return `${reviewPresetPrompt(preset)}${target ? `\n\nTarget or additional instructions:\n${target}` : ""}${rangeHint}\n\nInspect Git state and relevant source with read-only tools. Focus on correctness, security, data loss, regressions, API compatibility, and meaningful test gaps. Avoid style-only findings. Return the structured JSON contract from the reviewer role; every finding needs file/line evidence.`;
}

/** Resolve the git diff range for a review preset and target. */
export function resolveGitRange(preset: ReviewPreset, target: string): string | undefined {
	if (preset === "branch" || preset === "default") return "@{upstream}...HEAD";
	if (preset === "custom" && target && /[.][.][.]/.test(target)) {
		// Target looks like a git range (e.g. "main...feature")
		return target;
	}
	return undefined;
}

async function readReviewGuidance(cwd: string): Promise<string | undefined> {
	try { return (await readFile(path.join(cwd, "REVIEW.md"), "utf8")).trim() || undefined; }
	catch { return undefined; }
}

function finalOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content.filter((part: any): part is { type: "text"; text: string } => part.type === "text").map((part: { text: string }) => part.text).join("");
		if (text.trim()) return text;
	}
	return "";
}

export function parseReviewResult(output: string): ReviewResult {
	const candidate = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? output;
	try {
		const value = JSON.parse(candidate.trim()) as ReviewResult;
		if (typeof value.summary === "string" && Array.isArray(value.findings) && value.findings.every((finding) =>
			finding && typeof finding.file === "string" && finding.file.trim().length > 0 && typeof finding.line === "number" &&
			typeof finding.issue === "string" && finding.issue.trim().length > 0 && typeof finding.evidence === "string" && finding.evidence.trim().length > 0 &&
			typeof finding.suggestedFix === "string" && typeof finding.blocking === "boolean" &&
			["critical", "high", "medium", "low"].includes(finding.severity)
		)) return value;
	} catch { /* handled below */ }
	return {
		summary: "Reviewer returned malformed structured output",
		findings: [{ severity: "high", file: "(reviewer)", line: 0, issue: "The independent review result could not be parsed.", evidence: output.slice(0, 1000), suggestedFix: "Re-run the review.", blocking: true }],
	};
}

function formatReview(result: ReviewResult): string {
	if (!result.findings.length) return `No findings\n\n${result.summary}`;
	return result.findings.map((finding) => `- **${finding.severity}${finding.blocking ? " · blocking" : ""}** ${finding.file}:${finding.line} — ${finding.issue}\n  Evidence: ${finding.evidence}\n  Fix: ${finding.suggestedFix}`).join("\n");
}

async function isolatedReview(pi: ExtensionAPI, request: Omit<ReviewRunRequest, "id" | "respond" | "accept">): Promise<ReviewResult | undefined> {
	const id = crypto.randomUUID();
	let accepted = false;
	let settled = false;
	let resolve!: (value: ReviewResult | undefined) => void;
	const result = new Promise<ReviewResult | undefined>((done) => { resolve = done; });
	const timer = setTimeout(() => { if (!settled) { settled = true; resolve(undefined); } }, request.timeout ?? 180_000);
	pi.events.emit(SUBAGENT_EVENT, {
		id,
		agent: "reviewer",
		task: request.prompt,
		cwd: request.cwd,
		timeout: request.timeout ?? 180_000,
		signal: request.signal,
		instructions: "Read-only independent review. Follow repository REVIEW.md guidance supplied in the task contract. Return JSON only.",
		readOnly: true,
		accept: () => {
			if (accepted) return false;
			accepted = true;
			return true;
		},
		respond: (response: any) => {
			if (settled || response?.id !== id) return;
			settled = true;
			clearTimeout(timer);
			resolve(response.ok ? parseReviewResult(finalOutput(response.result?.messages ?? [])) : undefined);
		},
	});
	if (!accepted) { settled = true; clearTimeout(timer); return undefined; }
	return result;
}

export default function piReviewExtension(pi: ExtensionAPI): void {
	let reviewModeEnabled = false;
	let toolsBeforeReview: string[] | undefined;
	let thinkingBeforeReview: ThinkingLevel | undefined;
	let reviewThinking: ThinkingLevel = "high";
	let currentPrompt = "";
	let restorePending = false;

	function setStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, reviewModeEnabled ? ctx.ui.theme.fg("warning", `review:${reviewThinking}`) : undefined);
	}

	function enterLocalReview(ctx: ExtensionContext, prompt: string, thinking: ThinkingLevel): void {
		reviewModeEnabled = true;
		restorePending = true;
		currentPrompt = prompt;
		reviewThinking = thinking;
		toolsBeforeReview = pi.getActiveTools();
		pi.setActiveTools([...new Set(toolsBeforeReview.filter((tool) => SAFE_REVIEW_TOOLS.has(tool)).concat(["read", "bash", "grep", "find", "ls"]))]);
		const current = pi.getThinkingLevel();
		thinkingBeforeReview = (THINKING_LEVELS as readonly string[]).includes(current ?? "") ? current as ThinkingLevel : undefined;
		pi.setThinkingLevel(thinking);
		setStatus(ctx);
	}

	function leaveLocalReview(ctx: ExtensionContext): void {
		if (!restorePending) return;
		restorePending = false;
		reviewModeEnabled = false;
		if (toolsBeforeReview) pi.setActiveTools(toolsBeforeReview);
		if (thinkingBeforeReview) pi.setThinkingLevel(thinkingBeforeReview);
		toolsBeforeReview = undefined;
		thinkingBeforeReview = undefined;
		currentPrompt = "";
		setStatus(ctx);
	}

	async function choosePreset(ctx: ExtensionCommandContext): Promise<{ preset: ReviewPreset; target: string } | undefined> {
		if (!ctx.hasUI) return { preset: "default", target: "" };
		const choices = ["Review uncommitted changes", "Review current branch", "Review a specific target", "Cancel"];
		const choice = await ctx.ui.select("Select review scope", choices);
		if (!choice || choice === choices[3]) return undefined;
		if (choice === choices[1]) return { preset: "branch", target: "" };
		if (choice === choices[2]) {
			const target = (await ctx.ui.editor("Review target or instructions", ""))?.trim();
			return target ? { preset: "custom", target } : undefined;
		}
		return { preset: "uncommitted", target: "" };
	}

	async function runReview(prompt: string, cwd: string, signal?: AbortSignal, gitRange?: string, requireExactRange?: boolean, timeout?: number): Promise<ReviewResult | undefined> {
		const guidance = await readReviewGuidance(cwd);
		let status, diff, staged, aheadLog, rangeDiff, rangeFailed;
		try {
			[status, diff, staged] = await Promise.all([
				pi.exec("git", ["status", "--short"], { cwd, signal, timeout: 10_000 }),
				pi.exec("git", ["diff"], { cwd, signal, timeout: 30_000 }),
				pi.exec("git", ["diff", "--cached"], { cwd, signal, timeout: 30_000 }),
			]);
			// All primary git commands must succeed — nonzero exit produces empty evidence and a false-clean review
			if (status.code !== 0 || diff.code !== 0 || staged.code !== 0) return undefined;
		} catch { return undefined; }
		// Range commands are best-effort: try primary range, fall back to common bases.
		if (gitRange) {
			try {
				if (requireExactRange) {
					// Custom range: try exactly what was requested, no fallback.
					const [log, d] = await Promise.all([
						pi.exec("git", ["log", "--oneline", gitRange], { cwd, signal, timeout: 10_000 }),
						pi.exec("git", ["diff", gitRange], { cwd, signal, timeout: 15_000 }),
					]);
					if (log.code === 0 && d.code === 0) { aheadLog = log; rangeDiff = d; }
					else rangeFailed = true;
				} else {
					// Default/branch: try primary range, then fall back to common bases.
					const ranges = [gitRange, "@{push}...HEAD", "origin/main...HEAD", "origin/master...HEAD", "main...HEAD", "master...HEAD"];
					for (const range of ranges) {
						const [log, d] = await Promise.all([
							pi.exec("git", ["log", "--oneline", range], { cwd, signal, timeout: 10_000 }),
							pi.exec("git", ["diff", range], { cwd, signal, timeout: 15_000 }),
						]);
						if (log.code === 0 && d.code === 0) { aheadLog = log; rangeDiff = d; gitRange = range; break; }
					}
					if (!aheadLog) rangeFailed = true;
				}
			} catch { rangeFailed = true; }
		}
		// A required range that cannot be resolved is a hard failure.
		if (rangeFailed) return undefined;
		if (
			Buffer.byteLength(status.stdout, "utf8") > MAX_STATUS_BYTES ||
			Buffer.byteLength(diff.stdout, "utf8") > MAX_DIFF_BYTES ||
			Buffer.byteLength(staged.stdout, "utf8") > MAX_DIFF_BYTES ||
			Buffer.byteLength(aheadLog?.stdout ?? "", "utf8") > MAX_LOG_BYTES ||
			Buffer.byteLength(rangeDiff?.stdout ?? "", "utf8") > MAX_RANGE_DIFF_BYTES
		) return undefined;
		const rangeEvidence = gitRange && aheadLog?.code === 0
			? `\n\nCommits ahead (${gitRange}):\n${aheadLog.stdout}\n\nRange diff (${gitRange}):\n${rangeDiff?.stdout || ""}`
			: "";
		const statusSection = `\n\nGit status:\n${status.stdout}`;
		const diffSection = `\n\nGit diff:\n${diff.stdout}`;
		const stagedSection = `\n\nStaged diff:\n${staged.stdout}`;
		const evidence = `${rangeEvidence}${statusSection}${diffSection}${stagedSection}`;
		const task = `${prompt}${guidance ? `\n\nREVIEW.md guidance:\n${guidance.slice(0, 16 * 1024)}` : ""}${evidence}`;
		return isolatedReview(pi, { cwd, prompt: task, signal, timeout });
	}

	pi.registerCommand("review", {
		description: "Run an isolated read-only review, with local fallback",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (reviewModeEnabled) return ctx.ui.notify("A review is already running.", "warning");
			const parsed = parseReviewArgs(args);
			let preset: ReviewPreset = "default";
			let target = parsed.target;
			if (!target) {
				const selection = await choosePreset(ctx);
				if (!selection) return;
				({ preset, target } = selection);
			} else if (/[.][.][.]/.test(target)) {
				// Triple-dot targets (e.g. "main...feature") are custom git ranges
				preset = "custom";
			}
			const prompt = buildReviewPrompt(preset, target);
			const gitRange = resolveGitRange(preset, target);
			ctx.ui.notify("Starting isolated review...", "info");

			// Cover the async gap: enter review mode BEFORE emitting the event so user
			// input during the window is processed with review-mode tool restrictions.
			// If isolated review succeeds, leaveLocalReview undoes it. Otherwise we keep
			// review mode and send the follow-up prompt for local review.
			enterLocalReview(ctx, prompt, parsed.thinking);

			const id = crypto.randomUUID();
			let accepted = false;
			let settled = false;
			pi.events.emit(REVIEW_EVENT, {
				id,
				cwd: ctx.cwd,
				prompt,
				gitRange,
				requireExactRange: preset === "custom",
				timeout: 180_000,
				accept: () => {
					if (accepted) return false;
					accepted = true;
					ctx.ui.notify("Isolated review is running...", "info");
					return true;
				},
				respond: (response: any) => {
					if (settled || response?.id !== id) return;
					settled = true;
					if (response.ok && response.result) {
						// Isolated review succeeded — leave review mode, show readable result
						leaveLocalReview(ctx);
						pi.sendUserMessage(formatReview(response.result), { deliverAs: "followUp" });
					} else {
						// Fall back to local review — keep review mode, send prompt
						pi.sendUserMessage(prompt, { deliverAs: "followUp" });
					}
				},
			});
			if (!accepted) {
				// No one listening for REVIEW_EVENT — already in review mode, send prompt
				ctx.ui.notify("No isolated reviewer available, switching to local review...", "info");
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}
		},
	});

	pi.events.on(REVIEW_EVENT, (raw) => {
		const request = raw as ReviewRunRequest;
		if (!request?.id || typeof request.respond !== "function") return;
		if (request.accept && !request.accept()) return;
		void runReview(request.prompt, request.cwd, request.signal, request.gitRange, request.requireExactRange, request.timeout).then(
			(result) => request.respond(result ? { id: request.id, ok: true, result } : { id: request.id, ok: false, error: "Isolated reviewer unavailable" }),
			(error) => request.respond({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		reviewModeEnabled = false;
		restorePending = false;
		toolsBeforeReview = undefined;
		thinkingBeforeReview = undefined;
		setStatus(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!reviewModeEnabled) return;
		if (!SAFE_REVIEW_TOOLS.has(event.toolName)) return { block: true, reason: `pi-review: ${event.toolName} is disabled in read-only review mode.` };
		if (isToolCallEventType("bash", event) && !isReadOnlyBash(event.input.command)) return { block: true, reason: `pi-review: bash command blocked in read-only review mode.\nCommand: ${event.input.command}` };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!reviewModeEnabled) return;
		const guidance = await readReviewGuidance(ctx.cwd);
		return { systemPrompt: `${event.systemPrompt}\n\n## Read-only review mode\n${currentPrompt}\nDo not modify files or Git state. Report findings instead of fixing them.${guidance ? `\n\nREVIEW.md guidance:\n${guidance}` : ""}` };
	});

	pi.on("agent_settled", async (_event, ctx) => leaveLocalReview(ctx));
}
