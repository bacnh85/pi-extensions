import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	isToolCallEventType,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PLAN_MODE_SERENA_GUIDANCE } from "./lib/guidance";
import { BLOCKED_TOOLS, PLAN_ONLY_TOOLS, READ_ONLY_TOOLS } from "./lib/plan-tools";

const STATUS_KEY = "pi-plan";
const PLAN_DIR = ".agents/plans";
const PLAN_TOOL = "write_plan";
const PLAN_QUESTION_TOOL = "ask_plan_question";
const PLAN_EXECUTE_COMMAND = "plan-execute";
const PREFERENCES_FILE = path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "pi-plan", "preferences.json");
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type PlanStatus = "draft" | "approved" | "executing";

interface PlanState {
	enabled: boolean;
	planThinking: ThinkingLevel;
	normalThinking: ThinkingLevel;
	toolsBeforePlan?: string[];
	lastPlanPath?: string;
	lastPlanTitle?: string;
	lastPlanStatus?: PlanStatus;
	planReadyForReview?: boolean;
}

interface PlanPreferences {
	version: 2;
	defaults: { planThinking: ThinkingLevel; normalThinking: ThinkingLevel };
	perModel: Record<
		string,
		{ planThinking: ThinkingLevel; normalThinking: ThinkingLevel }
	>;
}

interface WritePlanParams {
	title: string;
	content: string;
	status?: PlanStatus;
}

interface PlanQuestionOption {
	label: string;
	description?: string;
}

interface PlanQuestionParams {
	question: string;
	options: PlanQuestionOption[];
	allowOther?: boolean;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

function isPlanStatus(value: string | undefined): value is PlanStatus {
	return value === "draft" || value === "approved" || value === "executing";
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return slug || "plan";
}

function normalizePlanContent(params: WritePlanParams): string {
	const title = params.title.trim() || "Plan";
	const body = params.content.trim();
	if (/^#\s+/m.test(body)) return `${body}\n`;
	return `# ${title}\n\n${body}\n`;
}

function planPath(cwd: string, title: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(cwd, PLAN_DIR, `${stamp}-${slugify(title)}.md`);
}

function relativeToCwd(cwd: string, absolutePath: string): string {
	return path.relative(cwd, absolutePath).split(path.sep).join("/");
}

function formatShortContextUsage(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	return usage?.percent === null || usage?.percent === undefined
		? "Context unknown."
		: `Context: ${Math.round(usage.percent)}% used.`;
}

function buildExecutionPrompt(relativePlan: string, mode: "current" | "new"): string {
	const prefix = mode === "new" ? "This is a fresh session created from an approved pi-plan. " : "";
	return `${prefix}Execute the approved plan in ${relativePlan}. Read the plan file if needed, keep the implementation scoped to the plan, update the plan if reality differs materially, and run the verification described there.`;
}

function hasOpenQuestionWarning(content: string): boolean {
	return /(^|\n)#{1,6}\s+.*open questions?.*\n[\s\S]*\?/i.test(content);
}

function modelKey(model: { provider?: string; id?: string } | undefined): string | undefined {
	if (!model?.provider || !model?.id) return undefined;
	return `${model.provider}/${model.id}`;
}

/** Check if a bash command writes to the filesystem. In plan mode, write commands are blocked regardless of confirmation. */
function isWriteCommand(cmd: string): boolean {
	const c = cmd.trim();

	// Shell redirect to file: > file, >> file, 2> file, &> file
	// Excludes fd-level redirects like 2>&1 (>& followed by digits)
	if (/>(?:>?)\s+(?!&|\|)/.test(c)) return true;

	if (/<<\s/.test(c)) return true;

	if (/\bsed\s+(?:-\S+\s+)*-i/.test(c)) return true;

	// tee writes to file (distinguish from tee --help)
	if (/\btee\s+(?:-[a-z]+\s+)*[^-]\S/.test(c)) return true;

	if (/\b(?:cp|mv|rm|install|dd)\s+/.test(c)) return true;

	if (/\b(?:touch|mkdir|ln|chmod|chown)\s+/.test(c)) return true;

	return false;
}

function getEffectiveThinking(prefs: PlanPreferences, model: { provider?: string; id?: string } | undefined): { plan: ThinkingLevel; normal: ThinkingLevel } {
	const key = modelKey(model);
	const stored = key ? prefs.perModel[key] : undefined;
	return {
		plan: stored?.planThinking ?? prefs.defaults.planThinking,
		normal: stored?.normalThinking ?? prefs.defaults.normalThinking,
	};
}

async function loadPreferences(): Promise<PlanPreferences | undefined> {
	try {
		const raw = await readFile(PREFERENCES_FILE, "utf8");
		const parsed = JSON.parse(raw) as Record<string, any>;
		if (parsed.version !== 2 || !isThinkingLevel(parsed.defaults?.planThinking) || !isThinkingLevel(parsed.defaults?.normalThinking) || typeof parsed.perModel !== "object" || parsed.perModel === null) {
			return undefined;
		}
		// ponytail: validate each persisted per-model entry
		const perModel: Record<string, { planThinking: ThinkingLevel; normalThinking: ThinkingLevel }> = {};
		for (const [key, val] of Object.entries(parsed.perModel)) {
			const m = val as Record<string, string>;
			if (isThinkingLevel(m.planThinking) && isThinkingLevel(m.normalThinking)) {
				perModel[key] = { planThinking: m.planThinking, normalThinking: m.normalThinking };
			}
		}
		return { version: 2, defaults: parsed.defaults, perModel };
	} catch {
		return undefined;
	}
}

async function savePreferences(preferences: PlanPreferences): Promise<void> {
	await mkdir(path.dirname(PREFERENCES_FILE), { recursive: true });
	const tmp = `${PREFERENCES_FILE}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
	await rename(tmp, PREFERENCES_FILE);
}

export default function piPlanExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let toolsBeforePlan: string[] | undefined;
	let planThinking: ThinkingLevel = "high";
	let normalThinking: ThinkingLevel = "medium";
	let lastPlanPath: string | undefined;
	let lastPlanTitle: string | undefined;
	let lastPlanStatus: PlanStatus | undefined;
	let applyingStoredThinking = false;
	/** Set on successful write_plan, cleared after first agent_settled prompt. */
	let planReadyForReview = false;
	/** Suppress --plan flag during fresh-session handoff. */
	let executionHandoff = false;
	let preferences: PlanPreferences | undefined;

	// ── UI helpers ──────────────────────────────────────────────

	function clearPlanWidget(ctx: ExtensionContext): void {
		ctx.ui.setWidget(STATUS_KEY, undefined);
	}

	function updateFooter(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			STATUS_KEY,
			planModeEnabled
				? ctx.ui.theme.fg("accent", "Plan mode")
				: undefined,
		);
	}

	function persistState(): void {
		pi.appendEntry("pi-plan", {
			enabled: planModeEnabled,
			planThinking,
			normalThinking,
			toolsBeforePlan,
			lastPlanPath,
			lastPlanTitle,
			lastPlanStatus,
			planReadyForReview,
		} satisfies PlanState);
	}

	function persistPreferences(): void {
		if (!preferences) return;
		void savePreferences(preferences).catch(() => undefined);
	}

	// ponytail: shared state restore — session_start and session_tree both need this
	function restoreStateFromBranch(ctx: ExtensionContext): void {
		const branch = ctx.sessionManager.getBranch();
		const saved = branch
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "pi-plan")
			.pop() as { data?: PlanState } | undefined;
		if (!saved?.data) return;
		planModeEnabled = saved.data.enabled ?? planModeEnabled;
		if (isThinkingLevel(saved.data.planThinking)) planThinking = saved.data.planThinking;
		if (isThinkingLevel(saved.data.normalThinking)) normalThinking = saved.data.normalThinking;
		toolsBeforePlan = saved.data.toolsBeforePlan ?? toolsBeforePlan;
		lastPlanPath = saved.data.lastPlanPath ?? lastPlanPath;
		lastPlanTitle = saved.data.lastPlanTitle ?? lastPlanTitle;
		lastPlanStatus = saved.data.lastPlanStatus ?? lastPlanStatus;
		if (typeof saved.data.planReadyForReview === "boolean") planReadyForReview = saved.data.planReadyForReview;
	}

	function enablePlanTools(): void {
		const baseline = toolsBeforePlan ?? pi.getActiveTools();
		toolsBeforePlan = baseline;
		// ponytail: preserve active read tools, remove mutators, add plan-only (no duplicates)
		pi.setActiveTools([
			...baseline.filter((t) => !BLOCKED_TOOLS.has(t) && !PLAN_ONLY_TOOLS.has(t)),
			...PLAN_ONLY_TOOLS,
		]);
	}

	function restoreTools(): void {
		if (toolsBeforePlan) pi.setActiveTools(toolsBeforePlan);
		toolsBeforePlan = undefined;
	}

	function applyThinking(level: ThinkingLevel): void {
		applyingStoredThinking = true;
		pi.setThinkingLevel(level);
		queueMicrotask(() => { applyingStoredThinking = false; });
	}

	function recordActiveThinkingLevel(
		level: ThinkingLevel,
		ctx: ExtensionContext,
	): void {
		if (planModeEnabled) {
			if (planThinking === level) return;
			planThinking = level;
		} else {
			if (normalThinking === level) return;
			normalThinking = level;
		}
		const key = modelKey(ctx.model);
		if (key && preferences) {
			preferences.perModel[key] = {
				planThinking,
				normalThinking,
			};
		}
		updateFooter(ctx);
		persistState();
		persistPreferences();
	}

	function enterPlanMode(ctx: ExtensionContext): void {
		planModeEnabled = true;
		// ponytail: after approval, start fresh plan path
		if (lastPlanStatus === "approved" || lastPlanStatus === "executing") {
			lastPlanPath = undefined;
			lastPlanTitle = undefined;
			lastPlanStatus = undefined;
		}
		enablePlanTools();
		applyThinking(planThinking);
		updateFooter(ctx);
		clearPlanWidget(ctx);
		persistState();
		ctx.ui.notify(
			`Plan mode enabled. Plans will be written to ${PLAN_DIR}/`,
			"info",
		);
	}

	function leavePlanMode(
		ctx: ExtensionContext,
		restoreThinking = true,
	): void {
		planModeEnabled = false;
		planReadyForReview = false;
		restoreTools();
		if (restoreThinking) applyThinking(normalThinking);
		updateFooter(ctx);
		clearPlanWidget(ctx);
		persistState();
		ctx.ui.notify("Plan mode disabled.", "info");
	}

	// ── Commands ────────────────────────────────────────────────

	async function handlePlanCommand(
		args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		if (args.trim().length > 0) {
			ctx.ui.notify(
				"/plan does not take arguments; use /plan or Ctrl+Alt+P to toggle plan mode.",
				"warning",
			);
			return;
		}
		if (planModeEnabled) leavePlanMode(ctx);
		else enterPlanMode(ctx);
	}

	function beginCurrentSessionExecution(
		ctx: ExtensionContext,
		relativePlan: string,
	): void {
		planModeEnabled = false;
		planReadyForReview = false;
		lastPlanStatus = "approved";
		restoreTools();
		applyThinking(normalThinking);
		updateFooter(ctx);
		clearPlanWidget(ctx);
		persistState();
		// ponytail: one-shot execution prompt, no persistent execution mode
		pi.sendUserMessage(
			buildExecutionPrompt(relativePlan, "current"),
			{ deliverAs: "followUp" },
		);
	}

	async function beginNewSessionExecution(
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (!lastPlanPath) {
			ctx.ui.notify(
				"No approved plan is available to execute.",
				"error",
			);
			return;
		}
		await ctx.waitForIdle();
		{
			const planPathToExecute = lastPlanPath;
			const planTitleToExecute = lastPlanTitle;
			const relativePlan = relativeToCwd(ctx.cwd, planPathToExecute);
			const parentSession = ctx.sessionManager.getSessionFile();
			// ponytail: persist handoff marker so replacement instance suppresses --plan
			const state: PlanState = {
				enabled: false,
				planThinking,
				normalThinking,
				lastPlanPath: planPathToExecute,
				lastPlanTitle: planTitleToExecute,
				lastPlanStatus: "approved",
				planReadyForReview: false,
			};

			executionHandoff = true;
			try {
				const result = await ctx.newSession({
					parentSession,
					setup: async (sessionManager) => {
						sessionManager.appendCustomEntry("pi-plan", state);
					},
					withSession: async (replacementCtx) => {
						await replacementCtx.sendUserMessage(
							buildExecutionPrompt(relativePlan, "new"),
						);
					},
				});
				if (result.cancelled) {
					ctx.ui.notify("New-session execution cancelled.", "info");
				}
			} finally {
				executionHandoff = false;
			}
		}
	}

	// ── Registration ────────────────────────────────────────────

	// ponytail: throw so Pi marks the tool result as an error
	function guardPlanMode(tool: string): void {
		if (!planModeEnabled) {
			throw new Error(`Error: ${tool} is only available in plan mode. Enable plan mode with /plan first.`);
		}
	}

	pi.registerFlag("plan", {
		description:
			"Start in pi-plan read-only planning mode",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: PLAN_TOOL,
		label: "Write Plan",
		description: `Write/replace plan as Markdown under ${PLAN_DIR}/. Use when plan is ready for review.`,
		promptSnippet: `Write plan to ${PLAN_DIR}/ as Markdown for user review`,
		promptGuidelines: [
			`Use ${PLAN_TOOL} in plan mode after exploration. No edit/write until plan approved.`,
			`Don't call ${PLAN_TOOL} while blocking questions remain; use ${PLAN_QUESTION_TOOL} first.`,
		],
		parameters: Type.Object({
			title: Type.String({
				description: "Short plan title",
			}),
			content: Type.String({
				description: "Markdown plan content",
			}),
			status: Type.Optional(
				Type.String({
					description: "draft, approved, or executing",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// ponytail: write_plan is available in normal mode too — agent updates plans during execution
			const typedParams = params as WritePlanParams;

			// ponytail: reuse draft path for refinements, new path for new plans
			let destination: string;
			if (
				lastPlanPath &&
				lastPlanStatus === "draft" &&
				typedParams.title.trim() === lastPlanTitle
			) {
				// ponytail: compare relative to resolved plan dir (portable, rejects siblings)
				const resolved = path.resolve(ctx.cwd, lastPlanPath);
				const planDir = path.resolve(ctx.cwd, PLAN_DIR);
				const rel = path.relative(planDir, resolved);
				if (rel.startsWith("..") || path.isAbsolute(rel)) {
					throw new Error(`Plan path is outside ${PLAN_DIR}/`);
				}
				destination = resolved;
			} else {
				destination = planPath(
					ctx.cwd,
					typedParams.title,
				);
			}

			const content = normalizePlanContent(typedParams);
			await withFileMutationQueue(
				destination,
				async () => {
					await mkdir(path.dirname(destination), {
						recursive: true,
					});
					await writeFile(
						destination,
						content,
						"utf8",
					);
				},
			);
			lastPlanPath = destination;
			lastPlanTitle =
				typedParams.title.trim() || "Plan";
			lastPlanStatus = isPlanStatus(typedParams.status)
				? typedParams.status
				: "draft";
			planReadyForReview = true;
			persistState();

			const warning = hasOpenQuestionWarning(content)
				? ` If the plan contains blocking user-answerable open questions, call ${PLAN_QUESTION_TOOL} before requesting approval.`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `Plan written to ${relativeToCwd(ctx.cwd, destination)}. If no blocking user-answerable questions remain, ask the user to approve, refine, execute in current session, execute in a new session, or keep planning.${warning}`,
					},
				],
				details: {
					path: destination,
					title: lastPlanTitle,
					status: lastPlanStatus,
				},
			};
		},
	});

	pi.registerTool({
		name: PLAN_QUESTION_TOOL,
		label: "Ask Plan Question",
		description:
			"Ask user a planning question with selectable options and optional free-form input.",
		promptSnippet:
			"Ask user a planning question with 2-4 concrete options when a decision affects the plan",
		promptGuidelines: [
			"Use only when repo research leaves a consequential ambiguity.",
			"Prefer 2-4 concrete options. Use short labels.",
			"Don't ask what's discoverable from repo.",
			"Respect user's stated preference.",
		],
		parameters: Type.Object({
			question: Type.String({
				description: "Planning question to ask",
			}),
			options: Type.Array(
				Type.Object({
					label: Type.String({
						description: "Option label",
					}),
					description: Type.Optional(
						Type.String({
							description:
								"Optional explanation",
						}),
					),
				}),
				{
					description:
						"Options to choose from (2-4 required)",
					minItems: 2,
					maxItems: 4,
				},
			),
			allowOther: Type.Optional(
				Type.Boolean({
					description:
						"Allow free-form user answer; default true",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			guardPlanMode(PLAN_QUESTION_TOOL);

			const typedParams = params as PlanQuestionParams;
			const options = typedParams.options ?? [];

			// ponytail: runtime validation since TypeBox minItems can't check blank/duplicate
			const labels = options.map((o) => o.label.trim());
			if (labels.some((l) => !l)) {
				throw new Error(
					"Each option must have a non-blank label.",
				);
			}
			if (new Set(labels).size !== labels.length) {
				throw new Error(
					"Option labels must be unique.",
				);
			}
			if (
				labels.some(
					(l) =>
						l.toLowerCase() === "other" ||
						l.toLowerCase().startsWith("other "),
				)
			) {
				throw new Error(
					'Option labels cannot conflict with the "Other" label.',
				);
			}

			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: "UI is not available. Ask this planning question directly in chat and wait for the user's answer.",
						},
					],
					details: {
						question: typedParams.question,
						options,
						answer: null,
					},
				};
			}

			const allowOther =
				typedParams.allowOther !== false;
			const displayLabels = options.map((option) =>
				option.description
					? `${option.label} — ${option.description}`
					: option.label,
			);
			const otherLabel = "Other / type my answer";
			const choice = await ctx.ui.select(
				typedParams.question,
				allowOther
					? [...displayLabels, otherLabel]
					: displayLabels,
			);
			if (!choice) {
				return {
					content: [
						{
							type: "text",
							text: "User cancelled the planning question.",
						},
					],
					details: {
						question: typedParams.question,
						options,
						answer: null,
						cancelled: true,
					},
				};
			}

			if (choice === otherLabel) {
				const answer = (
					await ctx.ui.editor(
						"Your answer",
						"",
					)
				)?.trim();
				if (!answer) {
					return {
						content: [
							{
								type: "text",
								text: "User cancelled the planning question.",
							},
						],
						details: {
							question: typedParams.question,
							options,
							answer: null,
							cancelled: true,
						},
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `User wrote: ${answer}`,
						},
					],
					details: {
						question: typedParams.question,
						options,
						answer,
						wasCustom: true,
					},
				};
			}

			const selectedIndex =
				displayLabels.indexOf(choice);
			const selected = options[selectedIndex];
			const answer = selected?.label ?? choice;
			return {
				content: [
					{
						type: "text",
						text: `User selected: ${answer}`,
					},
				],
				details: {
					question: typedParams.question,
					options,
					answer,
					selectedIndex: selectedIndex + 1,
					wasCustom: false,
				},
			};
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle pi-plan mode",
		handler: async (args, ctx) =>
			handlePlanCommand(args, ctx),
	});

	pi.registerCommand(PLAN_EXECUTE_COMMAND, {
		description: "Internal pi-plan execution bridge",
		handler: async (args, ctx) => {
			if (args.trim() !== "new") {
				ctx.ui.notify(
					`Usage: /${PLAN_EXECUTE_COMMAND} new`,
					"warning",
				);
				return;
			}
			await beginNewSessionExecution(ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "Toggle pi-plan mode",
		handler: async (ctx) => {
			if (planModeEnabled) leavePlanMode(ctx);
			else enterPlanMode(ctx);
		},
	});

	// ── Events ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		preferences = await loadPreferences();
		if (!preferences) {
			preferences = {
				version: 2,
				defaults: { planThinking, normalThinking },
				perModel: {},
			};
		}
		const effective = getEffectiveThinking(
			preferences,
			ctx.model,
		);
		planThinking = effective.plan;
		normalThinking = effective.normal;

		// ponytail: restore state from current branch (shared with session_tree)
		restoreStateFromBranch(ctx);

		// ponytail: ensure write_plan is always visible — covers --plan and normal-mode starts
		if (!pi.getActiveTools().includes(PLAN_TOOL))
			pi.setActiveTools([...pi.getActiveTools(), PLAN_TOOL]);

		// ponytail: skip plan mode re-entry during execution handoff
		if (
			pi.getFlag("plan") === true &&
			!executionHandoff
		) {
			planModeEnabled = true;
		}
		if (planModeEnabled) {
			enablePlanTools();
			applyThinking(planThinking);
		} else {
			applyThinking(normalThinking);
		}
		updateFooter(ctx);
		clearPlanWidget(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (!preferences) return;
		const effective = getEffectiveThinking(preferences, event.model);
		// ponytail: always update both stored levels, then apply active one
		planThinking = effective.plan;
		normalThinking = effective.normal;
		applyThinking(planModeEnabled ? planThinking : normalThinking);
		updateFooter(ctx);
		persistState();
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreStateFromBranch(ctx);
		updateFooter(ctx);
		persistState();
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (applyingStoredThinking) return;
		if (!isThinkingLevel(event.level)) return;
		recordActiveThinkingLevel(event.level, ctx);
	});

	/**
	 * Tool gating in plan mode:
	 *   - Blocked tools → deny with error
	 *   - Bash (write commands) → hard-blocked (no file mutations via bash)
	 *   - Bash (read commands) → require user confirmation
	 *   - Baseline tools NOT on the known-read list → require confirmation
	 *   - Unknown tools (outside baseline) → require confirmation
	 *   - Known-read tools → auto-allowed
	 */
	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled) return;

		// ponytail: hard-blocked mutators never available
		if (BLOCKED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `pi-plan: ${event.toolName} is not available in plan mode. Use ${PLAN_TOOL} to write the plan file.`,
			};
		}

		// Plan-only tools are always allowed
		if (PLAN_ONLY_TOOLS.has(event.toolName)) return;

		// Bash always requires confirmation
		if (isToolCallEventType("bash", event)) {
			// ponytail: block write commands outright — confirmation doesn't override read-only plan mode
			if (isWriteCommand(event.input.command || "")) {
				return {
					block: true,
					reason: `pi-plan: writing to the filesystem is not allowed in plan mode. "${event.input.command}" modifies files. Exit plan mode to run this command, or use ${PLAN_TOOL} to add file content to the plan.`,
				};
			}
			if (!ctx.hasUI) return { block: true, reason: `pi-plan: bash requires confirmation but UI is not available.\nCommand: ${event.input.command}` };
			if (!await ctx.ui.confirm("Allow bash command in plan mode?", `Command: ${event.input.command}`)) {
				return { block: true, reason: `pi-plan: bash command rejected by user.\nCommand: ${event.input.command}` };
			}
			return;
		}

		// ponytail: even baseline custom tools (e.g. obsidian) need confirm unless known-read
		if (toolsBeforePlan && !READ_ONLY_TOOLS.has(event.toolName)) {
			if (!ctx.hasUI) return { block: true, reason: `pi-plan: ${event.toolName} requires confirmation but UI is not available.` };
			if (!await ctx.ui.confirm(`Allow ${event.toolName} in plan mode?`, `Tool: ${event.toolName}`)) {
				return { block: true, reason: `pi-plan: ${event.toolName} rejected by user.` };
			}
			return;
		}
	});

	/**
	 * Inject planning instructions via systemPrompt chaining.
	 * This preserves Ponytail, project instructions, and other
	 * extensions regardless of load order.
	 */
	pi.on("before_agent_start", async (_event, ctx) => {
		if (planModeEnabled) {
			const relativePlan = lastPlanPath
				? relativeToCwd(ctx.cwd, lastPlanPath)
				: `${PLAN_DIR}/<timestamp>-<title>.md`;
			return {
				systemPrompt:
					_event.systemPrompt +
					`\n\n## Plan Mode\n\nYou are in read-only planning mode. Research the codebase and produce a reviewable implementation plan before making changes.\n\nRules:\n- Do not edit source files, configs, lockfiles, or git state.\n- You may read files, search, inspect git state, and use dedicated read/research tools.\n- Bash commands that write to files (redirect, heredoc, sed -i, tee, cp/mv/rm, etc.) are hard-blocked. Read-only bash commands (ls, grep, find, git status) require user confirmation.\n- ${PLAN_MODE_SERENA_GUIDANCE}\n- Ask concise clarifying questions if requirements are ambiguous. Use ${PLAN_QUESTION_TOOL} for consequential open decisions with 2-4 clear options and an Other/user-opinion path.\n- Do not ask about details you can discover from repository evidence. If the user already gave an opinion, incorporate it instead of asking again.\n- Before calling ${PLAN_TOOL}, if any consequential, user-answerable decision remains, call ${PLAN_QUESTION_TOOL} and wait for the answer. Do not place blocking user decisions in the final plan as open questions.\n- When the plan is ready, call ${PLAN_TOOL} with a complete Markdown plan.\n- The plan file must live in ${PLAN_DIR}/. Current/next plan path: ${relativePlan}\n- Goal: honor active system/project/skill constraints. Choose the smallest complete implementation — reuse existing code, stdlib, and native features before adding abstractions.\n\nPlan content should include:\n1. Goal and assumptions.\n2. Key findings with durable file/symbol paths.\n3. Proposed implementation steps.\n4. Verification plan.\n5. Risks, non-blocking open questions, and rejected alternatives if relevant.`,
			};
		}
	});

	/**
	 * One-shot approval prompt: fires only once after a successful
	 * write_plan, on agent_settled (not agent_end). Fresh-session
	 * execution is queued as a command handler to avoid using
	 * ExtensionCommandContext APIs from an event handler.
	 */
	pi.on("agent_settled", async (_event, ctx) => {
		if (
			!planModeEnabled ||
			!planReadyForReview ||
			!lastPlanPath ||
			!ctx.hasUI
		)
			return;

		planReadyForReview = false;
		persistState();
		const relativePlan = relativeToCwd(
			ctx.cwd,
			lastPlanPath,
		);
		const currentSessionChoice =
			"Yes, implement this plan          Switch to Default and start coding.";
		const newSessionChoice = `Yes, clear context and implement  Fresh thread. ${formatShortContextUsage(ctx)}`;
		const choice = await ctx.ui.select(
			"Implement this plan?",
			[
				currentSessionChoice,
				newSessionChoice,
				"No, stay in Plan mode             Continue planning with the model.",
			],
		);

		if (choice === currentSessionChoice) {
			beginCurrentSessionExecution(ctx, relativePlan);
		} else if (choice === newSessionChoice) {
			// ponytail: queue command handler instead of calling command-only APIs directly
			leavePlanMode(ctx, true);
			lastPlanStatus = "approved";
			persistState();
			pi.sendUserMessage(`/${PLAN_EXECUTE_COMMAND} new`, { deliverAs: "followUp" });
		}
		// "Stay in Plan mode" — do nothing, prompt was cleared
	});
}
