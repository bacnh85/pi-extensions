import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDestructiveBash, isReadOnlyBash } from "./lib/bash-gating";
import { PLAN_MODE_SERENA_GUIDANCE } from "./lib/guidance";
import { DEFAULT_PLAN_TOOLS as READ_ONLY_PLAN_TOOLS, PLAN_ALLOWED_TOOLS as READ_ONLY_ALLOWED_TOOLS } from "./lib/plan-tools";

const STATUS_KEY = "pi-plan";
const PLAN_DIR = path.join(".agents", "plans");
const PLAN_TOOL = "write_plan";
const PLAN_QUESTION_TOOL = "ask_plan_question";
const PLAN_EXECUTE_COMMAND = "plan-execute";
const PREFERENCES_FILE = path.join(os.homedir(), ".pi", "agent", "pi-plan", "preferences.json");
const DEFAULT_PLAN_TOOLS = [
	...READ_ONLY_PLAN_TOOLS,
	PLAN_TOOL, PLAN_QUESTION_TOOL,
];
const PLAN_ALLOWED_TOOLS = new Set([...READ_ONLY_ALLOWED_TOOLS, PLAN_TOOL, PLAN_QUESTION_TOOL]);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type PlanStatus = "draft" | "approved" | "executing";

interface PlanState {
	enabled: boolean;
	executing: boolean;
	planThinking: ThinkingLevel;
	normalThinking: ThinkingLevel;
	toolsBeforePlan?: string[];
	lastPlanPath?: string;
	lastPlanTitle?: string;
	lastPlanStatus?: PlanStatus;
}

interface PlanPreferences {
	version: 2;
	defaults: { planThinking: ThinkingLevel; normalThinking: ThinkingLevel };
	perModel: Record<string, { planThinking: ThinkingLevel; normalThinking: ThinkingLevel }>;
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

function unique(values: string[]): string[] {
	return [...new Set(values)];
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
		if (parsed.version === 2 && isThinkingLevel(parsed.defaults?.planThinking) && isThinkingLevel(parsed.defaults?.normalThinking) && typeof parsed.perModel === "object" && parsed.perModel !== null) {
			return { version: 2, defaults: parsed.defaults, perModel: parsed.perModel } as PlanPreferences;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

async function savePreferences(preferences: PlanPreferences): Promise<void> {
	await mkdir(path.dirname(PREFERENCES_FILE), { recursive: true });
	const temporaryPath = `${PREFERENCES_FILE}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
	await rename(temporaryPath, PREFERENCES_FILE);
}

export default function piPlanExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let toolsBeforePlan: string[] | undefined;
	let planThinking: ThinkingLevel = "high";
	let normalThinking: ThinkingLevel = "medium";
	let lastPlanPath: string | undefined;
	let lastPlanTitle: string | undefined;
	let lastPlanStatus: PlanStatus | undefined;
	let applyingStoredThinking = false;

	function clearPlanWidget(ctx: ExtensionContext): void {
		ctx.ui.setWidget(STATUS_KEY, undefined);
	}
	function updateFooter(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, planModeEnabled ? ctx.ui.theme.fg("accent", "Plan mode") : undefined);
	}
	function persistState(): void {
		pi.appendEntry("pi-plan", {
			enabled: planModeEnabled,
			executing: executionMode,
			planThinking,
			normalThinking,
			toolsBeforePlan,
			lastPlanPath,
			lastPlanTitle,
			lastPlanStatus,
		} satisfies PlanState);
	}

	let preferences: PlanPreferences | undefined;

	function persistPreferences(): void {
		if (!preferences) return;
		void savePreferences(preferences).catch(() => undefined);
	}

	function enablePlanTools(): void {
		const baseline = toolsBeforePlan ?? pi.getActiveTools();
		toolsBeforePlan = baseline;
		pi.setActiveTools(unique([...baseline.filter((tool) => PLAN_ALLOWED_TOOLS.has(tool)), ...DEFAULT_PLAN_TOOLS]));
	}

	function restoreTools(): void {
		if (toolsBeforePlan) pi.setActiveTools(toolsBeforePlan);
		toolsBeforePlan = undefined;
	}

	function applyThinking(level: ThinkingLevel): void {
		applyingStoredThinking = true;
		pi.setThinkingLevel(level);
		setTimeout(() => {
			applyingStoredThinking = false;
		}, 0);
	}

	function recordActiveThinkingLevel(level: ThinkingLevel, ctx: ExtensionContext): void {
		if (planModeEnabled) {
			if (planThinking === level) return;
			planThinking = level;
		} else {
			if (normalThinking === level) return;
			normalThinking = level;
		}
		const key = modelKey(ctx.model);
		if (key && preferences) {
			preferences.perModel[key] = { planThinking, normalThinking };
		}
		updateFooter(ctx);
		persistState();
		persistPreferences();
	}

	function enterPlanMode(ctx: ExtensionContext): void {
		planModeEnabled = true;
		executionMode = false;
		enablePlanTools();
		applyThinking(planThinking);
		updateFooter(ctx);
		clearPlanWidget(ctx);
		persistState();
		ctx.ui.notify(`Plan mode enabled. Plans will be written to ${PLAN_DIR}/`, "info");
	}

	function leavePlanMode(ctx: ExtensionContext, restoreThinking = true): void {
		planModeEnabled = false;
		executionMode = false;
		restoreTools();
		if (restoreThinking) applyThinking(normalThinking);
		updateFooter(ctx);
		clearPlanWidget(ctx);
		persistState();
		ctx.ui.notify("Plan mode disabled.", "info");
	}

	async function handlePlanCommand(args: string, ctx: ExtensionContext): Promise<void> {
		if (args.trim().length > 0) {
			ctx.ui.notify("/plan does not take arguments; use /plan or Ctrl+Alt+P to toggle plan mode.", "warning");
			return;
		}
		if (planModeEnabled) leavePlanMode(ctx);
		else enterPlanMode(ctx);
	}

	function beginCurrentSessionExecution(ctx: ExtensionContext, relativePlan: string): void {
		planModeEnabled = false;
		executionMode = true;
		lastPlanStatus = "approved";
		restoreTools();
		applyThinking(normalThinking);
		updateFooter(ctx);
		clearPlanWidget(ctx);
		persistState();
		persistPreferences();
		pi.sendUserMessage(buildExecutionPrompt(relativePlan, "current"), { deliverAs: "followUp" });
	}

	async function beginNewSessionExecution(ctx: ExtensionCommandContext): Promise<void> {
		if (!lastPlanPath) {
			ctx.ui.notify("No approved plan is available to execute.", "error");
			return;
		}
		await ctx.waitForIdle();
		const planPathToExecute = lastPlanPath;
		const planTitleToExecute = lastPlanTitle;
		const relativePlan = relativeToCwd(ctx.cwd, planPathToExecute);
		const parentSession = ctx.sessionManager.getSessionFile();
		const state: PlanState = {
			enabled: false,
			executing: true,
			planThinking,
			normalThinking,
			lastPlanPath: planPathToExecute,
			lastPlanTitle: planTitleToExecute,
			lastPlanStatus: "approved",
		};
		const result = await ctx.newSession({
			parentSession,
			setup: async (sessionManager) => {
				sessionManager.appendCustomEntry("pi-plan", state);
			},
			withSession: async (replacementCtx) => {
				await replacementCtx.sendUserMessage(buildExecutionPrompt(relativePlan, "new"));
			},
		});
		if (result.cancelled) ctx.ui.notify("New-session execution cancelled.", "info");
	}

	pi.registerFlag("plan", {
		description: "Start in pi-plan read-only planning mode",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: PLAN_TOOL,
		label: "Write Plan",
		description: `Write or replace the current implementation plan as Markdown under ${PLAN_DIR}/. Use in plan mode when the plan is ready for user review.`,
		promptSnippet: `Write the implementation plan to ${PLAN_DIR}/ as a Markdown file for user review`,
		promptGuidelines: [
			`Use ${PLAN_TOOL} in plan mode after repository exploration; do not use edit/write for implementation until the user approves the plan.`,
			`Do not call ${PLAN_TOOL} while blocking user-answerable questions remain; use ${PLAN_QUESTION_TOOL} first.`,
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short human-readable title for the plan" }),
			content: Type.String({ description: "Complete Markdown plan content" }),
			status: Type.Optional(Type.String({ description: "Plan status: draft, approved, or executing" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typedParams = params as WritePlanParams;
			const destination = lastPlanPath ?? planPath(ctx.cwd, typedParams.title);
			const content = normalizePlanContent(typedParams);
			await withFileMutationQueue(destination, async () => {
				await mkdir(path.dirname(destination), { recursive: true });
				await writeFile(destination, content, "utf8");
			});
			lastPlanPath = destination;
			lastPlanTitle = typedParams.title.trim() || "Plan";
			lastPlanStatus = isPlanStatus(typedParams.status) ? typedParams.status : "draft";
			persistState();
			const warning = hasOpenQuestionWarning(content)
				? ` If the plan contains blocking user-answerable open questions, call ${PLAN_QUESTION_TOOL} before requesting approval.`
				: "";
			return {
				content: [{ type: "text", text: `Plan written to ${relativeToCwd(ctx.cwd, destination)}. If no blocking user-answerable questions remain, ask the user to approve, refine, execute in current session, execute in a new session, or keep planning.${warning}` }],
				details: { path: destination, title: lastPlanTitle, status: lastPlanStatus },
			};
		},
	});

	pi.registerTool({
		name: PLAN_QUESTION_TOOL,
		label: "Ask Plan Question",
		description: "Ask the user a consequential planning question with selectable options and optional free-form input.",
		promptSnippet: "Ask the user a concise planning question with 2-4 concrete options when an open decision materially affects the plan.",
		promptGuidelines: [
			"Use only after repository research leaves a consequential ambiguity that affects the plan.",
			"Prefer 2-4 concrete options with short labels and useful descriptions.",
			"Do not ask about details that can be discovered from the repository.",
			"If the user already gave a preference, incorporate it instead of asking again.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The planning question to ask the user" }),
			options: Type.Array(
				Type.Object({
					label: Type.String({ description: "Short selectable option label" }),
					description: Type.Optional(Type.String({ description: "Optional explanation shown with the option" })),
				}),
				{ description: "Concrete options for the user to choose from" },
			),
			allowOther: Type.Optional(Type.Boolean({ description: "Whether to allow a free-form user answer; defaults to true" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typedParams = params as PlanQuestionParams;
			const options = typedParams.options ?? [];
			if (options.length === 0) {
				return {
					content: [{ type: "text", text: "Error: ask_plan_question requires at least one option." }],
					details: { question: typedParams.question, answer: null },
				};
			}
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "UI is not available. Ask this planning question directly in chat and wait for the user's answer." }],
					details: { question: typedParams.question, options, answer: null },
				};
			}

			const allowOther = typedParams.allowOther !== false;
			const labels = options.map((option) =>
				option.description ? `${option.label} — ${option.description}` : option.label,
			);
			const otherLabel = "Other / type my answer";
			const choice = await ctx.ui.select(typedParams.question, allowOther ? [...labels, otherLabel] : labels);
			if (!choice) {
				return {
					content: [{ type: "text", text: "User cancelled the planning question." }],
					details: { question: typedParams.question, options, answer: null, cancelled: true },
				};
			}

			if (choice === otherLabel) {
				const answer = (await ctx.ui.editor("Your answer", ""))?.trim();
				if (!answer) {
					return {
						content: [{ type: "text", text: "User cancelled the planning question." }],
						details: { question: typedParams.question, options, answer: null, cancelled: true },
					};
				}
				return {
					content: [{ type: "text", text: `User wrote: ${answer}` }],
					details: { question: typedParams.question, options, answer, wasCustom: true },
				};
			}

			const selectedIndex = labels.indexOf(choice);
			const selected = options[selectedIndex];
			const answer = selected?.label ?? choice;
			return {
				content: [{ type: "text", text: `User selected: ${answer}` }],
				details: { question: typedParams.question, options, answer, selectedIndex: selectedIndex + 1, wasCustom: false },
			};
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle pi-plan mode",
		handler: async (args, ctx) => handlePlanCommand(args, ctx),
	});

	pi.registerCommand(PLAN_EXECUTE_COMMAND, {
		description: "Internal pi-plan execution bridge",
		handler: async (args, ctx) => {
			if (args.trim() !== "new") {
				ctx.ui.notify(`Usage: /${PLAN_EXECUTE_COMMAND} new`, "warning");
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

	pi.on("session_start", async (_event, ctx) => {
		preferences = await loadPreferences();
		if (!preferences) {
			preferences = { version: 2, defaults: { planThinking, normalThinking }, perModel: {} };
		}
		const effective = getEffectiveThinking(preferences, ctx.model);
		planThinking = effective.plan;
		normalThinking = effective.normal;

		const entries = ctx.sessionManager.getEntries();
		const saved = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "pi-plan")
			.pop() as { data?: PlanState } | undefined;
		if (saved?.data) {
			planModeEnabled = saved.data.enabled ?? planModeEnabled;
			executionMode = saved.data.executing ?? executionMode;
			if (isThinkingLevel(saved.data.planThinking)) planThinking = saved.data.planThinking;
			if (isThinkingLevel(saved.data.normalThinking)) normalThinking = saved.data.normalThinking;
			toolsBeforePlan = saved.data.toolsBeforePlan ?? toolsBeforePlan;
			lastPlanPath = saved.data.lastPlanPath ?? lastPlanPath;
			lastPlanTitle = saved.data.lastPlanTitle ?? lastPlanTitle;
			lastPlanStatus = saved.data.lastPlanStatus ?? lastPlanStatus;
		}
		persistPreferences();
		if (pi.getFlag("plan") === true) planModeEnabled = true;
		if (planModeEnabled) {
			enablePlanTools();
			applyThinking(planThinking);
		} else if (executionMode) {
			applyThinking(normalThinking);
		}
		updateFooter(ctx);
		clearPlanWidget(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (executionMode) return;
		if (!preferences) return;
		const effective = getEffectiveThinking(preferences, event.model);
		if (planModeEnabled) {
			if (planThinking !== effective.plan) {
				planThinking = effective.plan;
				applyThinking(planThinking);
			}
		} else {
			if (normalThinking !== effective.normal) {
				normalThinking = effective.normal;
				applyThinking(normalThinking);
			}
		}
		updateFooter(ctx);
		persistState();
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (applyingStoredThinking) return;
		if (!isThinkingLevel(event.level)) return;
		recordActiveThinkingLevel(event.level, ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;
		if (!PLAN_ALLOWED_TOOLS.has(event.toolName)) {
			return { block: true, reason: `pi-plan: ${event.toolName} is disabled in read-only plan mode. Use ${PLAN_TOOL} to write the plan file.` };
		}
		if (!isToolCallEventType("bash", event)) return;
		if (isDestructiveBash(event.input.command) || !isReadOnlyBash(event.input.command)) {
			return { block: true, reason: `pi-plan: bash command blocked in plan mode because only simple read-only inspection commands are allowed.\nCommand: ${event.input.command}` };
		}
	});

	pi.on("context", async (event) => {
		// When not in plan mode or execution mode, filter out stale context messages
		if (!planModeEnabled && !executionMode) {
			return {
				messages: event.messages.filter((m) => {
					const msg = m as { customType?: string };
					return msg.customType !== "pi-plan-context" && msg.customType !== "pi-plan-execution-context";
				}),
			};
		}
		// In execution mode, filter out stale plan mode context messages
		if (executionMode && !planModeEnabled) {
			return {
				messages: event.messages.filter((m) => {
					const msg = m as { customType?: string };
					return msg.customType !== "pi-plan-context";
				}),
			};
		}
		// In plan mode, let all messages through
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (planModeEnabled) {
			const relativePlan = lastPlanPath ? relativeToCwd(ctx.cwd, lastPlanPath) : `${PLAN_DIR}/<timestamp>-<title>.md`;
			return {
				message: {
					customType: "pi-plan-context",
					content: `[PI-PLAN MODE ACTIVE]\nYou are in read-only planning mode. Research the codebase and produce a reviewable implementation plan before making changes.\n\nRules:\n- Do not edit source files, configs, lockfiles, or git state.\n- You may read files, search, inspect git state, and run read-only shell commands.\n- ${PLAN_MODE_SERENA_GUIDANCE}\n- Ask concise clarifying questions if requirements are ambiguous. Use ${PLAN_QUESTION_TOOL} for consequential open decisions with 2-4 clear options and an Other/user-opinion path.\n- Do not ask about details you can discover from repository evidence. If the user already gave an opinion, incorporate it instead of asking again.\n- Before calling ${PLAN_TOOL}, if any consequential, user-answerable decision remains, call ${PLAN_QUESTION_TOOL} and wait for the answer. Do not place blocking user decisions in the final plan as open questions.\n- When the plan is ready, call ${PLAN_TOOL} with a complete Markdown plan.\n- The plan file must live in ${PLAN_DIR}/. Current/next plan path: ${relativePlan}\n\nPlan content should include:\n1. Goal and assumptions.\n2. Key findings with durable file/symbol paths.\n3. Proposed implementation steps.\n4. Verification plan.\n5. Risks, non-blocking open questions, and rejected alternatives if relevant.`,
					display: false,
				},
			};
		}

		if (executionMode && lastPlanPath) {
			let content = "";
			try {
				content = await readFile(lastPlanPath, "utf8");
			} catch {
				content = `Plan file unavailable at ${lastPlanPath}`;
			}
			return {
				message: {
					customType: "pi-plan-execution-context",
					content: `[PI-PLAN EXECUTION]\nExecute the approved plan at ${relativeToCwd(ctx.cwd, lastPlanPath)}. Use normal mode thinking=${normalThinking}. Keep changes scoped to the plan and verify the result.\n\n${content}`,
					display: false,
				},
			};
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!planModeEnabled || !lastPlanPath || !ctx.hasUI) return;
		const relativePlan = relativeToCwd(ctx.cwd, lastPlanPath);
		const currentSessionChoice = "Yes, implement this plan          Switch to Default and start coding.";
		const newSessionChoice = `Yes, clear context and implement  Fresh thread. ${formatShortContextUsage(ctx)}`;
		const choice = await ctx.ui.select("Implement this plan?", [
			currentSessionChoice,
			newSessionChoice,
			"No, stay in Plan mode             Continue planning with the model.",
		]);
		if (choice === currentSessionChoice) {
			beginCurrentSessionExecution(ctx, relativePlan);
		} else if (choice === newSessionChoice) {
			planModeEnabled = false;
			executionMode = false;
			lastPlanStatus = "approved";
			restoreTools();
			applyThinking(normalThinking);
			updateFooter(ctx);
			clearPlanWidget(ctx);
			persistState();
			persistPreferences();
			ctx.ui.setEditorText(`/${PLAN_EXECUTE_COMMAND} new`);
			ctx.ui.notify("Press Enter to start execution in a new session.", "info");
		}
	});
}
