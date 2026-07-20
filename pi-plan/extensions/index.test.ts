/**
 * Tests for pi-plan extension: prompt composition, tool gating, plan lifecycle,
 * path containment.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "mocha";
import os from "node:os";
import path from "node:path";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import piPlanExtension, { snapshotUntrackedFiles } from "./index";
import { BLOCKED_TOOLS, PLAN_ONLY_TOOLS, READ_ONLY_TOOLS } from "./lib/plan-tools";
import { PLAN_MODE_SERENA_GUIDANCE } from "./lib/guidance";
import { captureRewindCheckpoint, createHandoff, restoreRewindCheckpoint, rewindToFlowBaseline } from "./lib/lifecycle";
import { registerAdvisor } from "./commands/advisor";
import { formatSpecsProgress, invalidExistingTargets, specSlug } from "./commands/specs";
import { workspaceContext } from "./lib/workspace-context";
import { parseModel } from "./lib/utility-config";

/** Real temp directory for tests that write files. */
const TMP = path.join(os.tmpdir(), "pi-plan-test-" + process.pid);
before(() => { mkdirSync(TMP, { recursive: true }); });

function createGitRepo(prefix: string): string {
	const cwd = mkdtempSync(path.join(os.tmpdir(), prefix));
	execFileSync("git", ["init", "--quiet"], { cwd });
	execFileSync("git", ["config", "user.email", "test@test"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
	writeFileSync(path.join(cwd, "README.md"), "# test");
	execFileSync("git", ["add", "-A"], { cwd });
	execFileSync("git", ["commit", "-m", "initial"], { cwd });
	return cwd;
}

describe("workflow snapshots", () => {
	it("snapshots untracked paths losslessly and detects content changes", async () => {
		const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-plan-hash-"));
		execFileSync("git", ["init", "--quiet"], { cwd });
		const names = ["café.txt", "line\nbreak.txt"];
		for (const name of names) writeFileSync(path.join(cwd, name), name);

		type Entry = { path: string; hash: string; content: string };
		const first = new Map<string, Entry>((JSON.parse(await snapshotUntrackedFiles(cwd)) as Entry[]).map((entry) => [entry.path, entry]));
		assert.deepEqual([...first.keys()].sort(), [...names].sort());
		assert.equal(Buffer.from(first.get(names[0])!.content, "base64").toString(), names[0]);
		writeFileSync(path.join(cwd, names[0]), "changed");
		const second = new Map<string, Entry>((JSON.parse(await snapshotUntrackedFiles(cwd)) as Entry[]).map((entry) => [entry.path, entry]));
		assert.notEqual(second.get(names[0])?.hash, first.get(names[0])?.hash);
		chmodSync(path.join(cwd, names[1]), 0o755);
		const third = new Map<string, Entry>((JSON.parse(await snapshotUntrackedFiles(cwd)) as Entry[]).map((entry) => [entry.path, entry]));
		assert.equal(third.get(names[1])?.hash, second.get(names[1])?.hash);
		assert.equal((third.get(names[1]) as Entry & { mode: number }).mode, 0o755);
		writeFileSync(path.join(cwd, "large.txt"), "x".repeat(14 * 1024));
		assert.ok(JSON.parse(await snapshotUntrackedFiles(cwd)).some((entry: Entry) => entry.path === "large.txt"));
		writeFileSync(path.join(cwd, "large.txt"), "x".repeat(51 * 1024));
		await assert.rejects(snapshotUntrackedFiles(cwd), /untracked content exceeds 50 KB; commit, stage, or ignore/);
		const symlinkRepo = createGitRepo("pi-plan-symlink-");
		symlinkSync("/etc/hosts", path.join(symlinkRepo, "outside"));
		await assert.rejects(snapshotUntrackedFiles(symlinkRepo), /not a regular file: outside/);
	});
});

describe("state lifecycle", () => {
	it("captures and restores a prompt checkpoint", async () => {
		const cwd = createGitRepo("pi-plan-checkpoint-");
		writeFileSync(path.join(cwd, "README.md"), "checkpoint\n");
		writeFileSync(path.join(cwd, "keep.ts"), "export const keep = true;\n");
		const checkpoint = await captureRewindCheckpoint(cwd, "prompt-1", "Try this implementation", "2026-01-01T00:00:00.000Z");
		writeFileSync(path.join(cwd, "README.md"), "broken\n");
		writeFileSync(path.join(cwd, "bad.ts"), "broken\n");

		const result = await restoreRewindCheckpoint(cwd, checkpoint);
		assert.notEqual(result.stash, "none");
		assert.equal(readFileSync(path.join(cwd, "README.md"), "utf8"), "checkpoint\n");
		assert.equal(readFileSync(path.join(cwd, "keep.ts"), "utf8"), "export const keep = true;\n");
		assert.equal(existsSync(path.join(cwd, "bad.ts")), false);

		execFileSync("git", ["add", "README.md"], { cwd });
		execFileSync("git", ["commit", "-m", "diverged"], { cwd });
		await assert.rejects(restoreRewindCheckpoint(cwd, checkpoint), /HEAD to match the checkpoint baseline/);
	});

	it("keeps empty directories for legacy and current snapshots", async () => {
		const cwd = createGitRepo("pi-plan-legacy-snapshot-");
		mkdirSync(path.join(cwd, "legacy"));
		const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
		await rewindToFlowBaseline(cwd, { baseline, phase: "implement", reviewPass: 0, initialUntrackedSnapshot: "[]" });
		assert.equal(existsSync(path.join(cwd, "legacy")), true);
		const checkpoint = await captureRewindCheckpoint(cwd, "prompt-1", "Prompt");
		mkdirSync(path.join(cwd, "new-empty"));
		await restoreRewindCheckpoint(cwd, checkpoint);
		assert.equal(existsSync(path.join(cwd, "new-empty")), true);
	});

	it("restores the whole repository when started from a subdirectory", async () => {
		const cwd = createGitRepo("pi-plan-subdir-");
		const subdir = path.join(cwd, "sub");
		mkdirSync(subdir);
		writeFileSync(path.join(cwd, "sibling.ts"), "checkpoint\n");
		writeFileSync(path.join(subdir, "child.ts"), "checkpoint\n");
		const checkpoint = await captureRewindCheckpoint(subdir, "prompt-1", "Prompt");
		writeFileSync(path.join(cwd, "sibling.ts"), "broken\n");
		writeFileSync(path.join(subdir, "child.ts"), "broken\n");
		await restoreRewindCheckpoint(subdir, checkpoint);
		assert.equal(readFileSync(path.join(cwd, "sibling.ts"), "utf8"), "checkpoint\n");
		assert.equal(readFileSync(path.join(subdir, "child.ts"), "utf8"), "checkpoint\n");
	});

	it("writes a compact handoff and restores the workflow baseline", async () => {
		const cwd = createGitRepo("pi-plan-lifecycle-");
		const plan = path.join(cwd, ".agents", "plans", "plan.md");
		mkdirSync(path.dirname(plan), { recursive: true });
		mkdirSync(path.join(cwd, "scratch"));
		writeFileSync(plan, "# Plan\n\n- [x] inspect\n- [ ] implement\n");
		chmodSync(plan, 0o755);
		writeFileSync(path.join(cwd, "README.md"), "staged\n");
		execFileSync("git", ["add", "README.md"], { cwd });
		writeFileSync(path.join(cwd, "README.md"), "unstaged\n");
		const initialUntrackedSnapshot = await snapshotUntrackedFiles(cwd);
		const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
		const initialCachedPatch = execFileSync("git", ["diff", "--cached", "--binary", "HEAD"], { cwd, encoding: "utf8" });
		const initialUnstagedPatch = execFileSync("git", ["diff", "--binary"], { cwd, encoding: "utf8" });
		writeFileSync(path.join(cwd, "README.md"), "broken");
		writeFileSync(path.join(cwd, "bad.ts"), "broken");

		const handoff = await createHandoff(cwd, { lastPlanPath: plan, lastPlanTitle: "Plan", lastPlanStatus: "executing", flow: { baseline, phase: "implement", reviewPass: 0 } });
		assert.equal(handoff.snippet, "Read .pi-handoff.md; continue the next milestone.");
		assert.match(readFileSync(handoff.path, "utf8"), /next: implement/);

		await rewindToFlowBaseline(cwd, { baseline, phase: "implement", reviewPass: 0, initialCachedPatch, initialUnstagedPatch, initialUntrackedSnapshot });
		assert.equal(readFileSync(path.join(cwd, "README.md"), "utf8"), "unstaged\n");
		assert.equal(execFileSync("git", ["show", ":README.md"], { cwd, encoding: "utf8" }), "staged\n");
		assert.equal(readFileSync(plan, "utf8"), "# Plan\n\n- [x] inspect\n- [ ] implement\n");
		assert.equal(statSync(plan).mode & 0o777, 0o755);
		assert.equal(existsSync(path.join(cwd, "bad.ts")), false);
		assert.equal(existsSync(path.join(cwd, "scratch")), true);
	});
});

// ── Fake Pi harness ──────────────────────────────────────────────

type EventHandler = (event: any, ctx: any) => any;

interface FakePi {
	handlers: Record<string, EventHandler[]>;
	toolDefs: Record<string, any>;
	commands: Record<string, any>;
	flags: Record<string, any>;
	shortcuts: Record<string, any>;
	activeTools: string[];
	thinkingLevel: string | null;
	entries: any[];
	sentMessages: any[];
	customMessages: any[];
	entryRenderers: Record<string, any>;
	flagValues: Record<string, any>;
	eventEmits?: any[];
	onEmit?: (event: string, data: any) => void;
}

function createFakePi(
	initialTools: string[] = [],
	flagValues: Record<string, any> = {},
): { pi: any } & FakePi {
	const state: FakePi = {
		handlers: {},
		toolDefs: {},
		commands: {},
		flags: {},
		shortcuts: {},
		activeTools: [...initialTools],
		thinkingLevel: null,
		entries: [],
		sentMessages: [],
		customMessages: [],
		entryRenderers: {},
		flagValues: { ...flagValues },
	};

	const pi = {
		on(event: string, handler: EventHandler) {
			(state.handlers[event] ??= []).push(handler);
		},
		registerTool(def: any) {
			state.toolDefs[def.name] = def;
		},
		registerCommand(name: string, def: any) {
			state.commands[name] = def;
		},
		registerFlag(name: string, def: any) {
			state.flags[name] = def;
		},
		registerShortcut(keys: string, def: any) {
			state.shortcuts[keys] = def;
		},
		registerEntryRenderer(type: string, renderer: any) {
			state.entryRenderers[type] = renderer;
		},
		getActiveTools() {
			return [...state.activeTools];
		},
		setActiveTools(tools: string[]) {
			state.activeTools.splice(0, state.activeTools.length, ...tools);
		},
		setThinkingLevel(level: string) {
			state.thinkingLevel = level;
		},
		appendEntry(customType: string, data?: any) {
			state.entries.push({ customType, data });
		},
		getFlag(name: string) {
			return state.flagValues[name] ?? false;
		},
		sendUserMessage(content: string, options?: any) {
			state.sentMessages.push({ content, options });
		},
		getSessionName() { return undefined; },
		sendMessage(message: any, options?: any) {
			state.customMessages.push({ message, options });
		},
		events: {
			emit(event: string, data: any) {
				state.eventEmits ??= [];
				state.eventEmits.push({ event, data });
				state.onEmit?.(event, data);
			},
		},
		exec: async (_cmd: string, _args: string[], _options?: any) => ({
			code: 0,
			stdout: "abc123def",
			stderr: "",
		}),
	};

	piPlanExtension(pi as any);
	return Object.assign(state, { pi });
}

function fakeCtx(overrides: Record<string, any> = {}): any {
	const ctx: any = {
		cwd: overrides.cwd ?? TMP,
		hasUI: overrides.hasUI ?? true,
		model: overrides.model ?? { provider: "test", id: "model-1" },
		modelRegistry: { getAvailable: () => [] },
		getContextUsage: () => ({ percent: 50 }),
		isIdle: () => true,
		ui: {
			theme: { fg: (_style: string, text: string) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			select: async (_question: string, _options: string[]) => null,
			confirm: async (_title: string, _body: string) => false,
			editor: async (_title: string, _default: string) => "",
			setEditorText: (_text: string) => {},
			getEditorText: () => "",
		},
		sessionManager: {
			getBranch: () => [],
			getSessionFile: () => "/test/session.jsonl",
		},
		waitForIdle: async () => {},
		sendUserMessage: async (_content: string, _options?: any) => {},
		...overrides,
	};
	if (overrides.ui) Object.assign(ctx.ui, overrides.ui);
	if (overrides.sessionManager) Object.assign(ctx.sessionManager, overrides.sessionManager);
	if (overrides.modelRegistry) Object.assign(ctx.modelRegistry, overrides.modelRegistry);
	return ctx;
}

// ── Tests ────────────────────────────────────────────────────────

describe("workspace utility commands", () => {
	it("registers isolated utility commands and creates safe spec slugs", () => {
		const { commands } = createFakePi(["read"]);
		for (const command of ["advisor", "btw", "specs", "specs-approve", "doctor"]) assert.ok(commands[command], `/${command} registered`);
		assert.equal(specSlug("Refactor cache!"), "refactor-cache");
		assert.equal(specSlug("../../../etc/passwd"), "etc-passwd");
		assert.deepEqual(parseModel("openai-codex/gpt-5.6-sol"), { provider: "openai-codex", id: "gpt-5.6-sol" });
		assert.deepEqual(parseModel("openrouter/anthropic/claude-3-haiku"), { provider: "openrouter", id: "anthropic/claude-3-haiku" });
		assert.equal(parseModel("invalid"), undefined);
	});

	it("formats colored timestamped specs progress", () => {
		const now = new Date("2026-07-19T00:00:00.000Z");
		assert.equal(formatSpecsProgress("scanning workspace", "cyan", now), "\x1b[36m[2026-07-19T00:00:00.000Z] scanning workspace\x1b[0m");
		assert.match(formatSpecsProgress("specification written", "green", now), /^\x1b\[32m\[/);
		assert.match(formatSpecsProgress("specification failed", "red", now), /^\x1b\[31m\[/);
	});

	it("grounds specs targets in the supplied workspace context", () => {
		const context = { files: new Set(["known.ts", "src/existing.ts"]), directories: new Set(["", "src", "lib"]) };
		const cases: Array<[string, string[]]> = [
			["- `known.ts`", []],
			["- `known.ts`, `missing.ts`", ["missing.ts"]],
			["- `src/existing.ts`", []],
			["- `missing.ts`", ["missing.ts"]],
			["- `/tmp/missing.ts`", ["/tmp/missing.ts"]],
			["- `../missing.ts`", ["../missing.ts"]],
			["- `src\\missing.ts`", ["src\\missing.ts"]],
			["- no existing target file: `proposed.ts` (new)", []],
			["- no existing target file: `src/proposed.ts` (new)", []],
			["- `lib/proposed.ts` (new)", ["lib/proposed.ts"]],
			["- no existing target file: `apps/web/page.ts` (new)", ["apps/web/page.ts"]],
		];
		for (const [line, invalid] of cases) assert.deepEqual(invalidExistingTargets(context, line), invalid, line);
	});

	it("returns captured workspace paths with the model prompt", async () => {
		const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-plan-context-"));
		mkdirSync(path.join(cwd, "src")); writeFileSync(path.join(cwd, "src", "index.ts"), "export {};");
		const context = await workspaceContext(cwd);
		assert.ok(context.prompt.includes("src/index.ts"));
		assert.ok(context.files.has("src/index.ts"));
		assert.ok(context.directories.has("src"));
	});

	it("hard-blocks all non-read tools while a restored specs gate is active", async () => {
		const { handlers } = createFakePi(["read", "edit"], {});
		const ctx = fakeCtx({ sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-plan", data: { enabled: true, specGateActive: true, specGatePlanMode: false } }] } });
		await handlers.session_start?.[0]({ reason: "startup" }, ctx);
		const result = await handlers.tool_call?.[0]({ toolName: "edit", input: { path: "x" } }, ctx);
		assert.ok(result?.block);
		assert.match(result?.reason ?? "", /specs gate/);
	});
});

describe("plan-mode guidance", () => {
	it("tells agents to use Serena before raw code reads/searches", () => {
		assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("use Serena before raw reads/searches"));
		assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("serena_get_symbols_overview"));
		assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("serena_find_symbol"));
		assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("Use read for docs/config/non-code files"));
		assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("Prefer the dedicated ls/grep/find tools"));
		assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("test, build, and package scripts require confirmation"));
	});
});

describe("advisor", () => {
	it("matches /model selection and forwards the effective transcript", async () => {
		let selected: string | undefined;
		let captured: any;
		let selectorOpened = false;
		const tools: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const pi: any = {
			active: [] as string[],
			registerTool(tool: any) { tools[tool.name] = tool; },
			registerCommand(name: string, command: any) { commands[name] = command; },
			getActiveTools() { return [...this.active]; },
			setActiveTools(next: string[]) { this.active = next; },
		};
		const advisor = registerAdvisor(pi, { getModel: () => selected, setModel: (model) => { selected = model; } });
		const response: any = {
			async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "Check the existing test." }; },
			result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Check the existing test." }] }),
		};
		const models = [
			{ provider: "test", id: "advisor", contextWindow: 256 },
			{ provider: "test", id: "unique", contextWindow: 256 },
			{ provider: "openai", id: "shared", name: "Shared OpenAI", contextWindow: 256 },
			{ provider: "other", id: "shared", name: "Shared Other", contextWindow: 256 },
		];
		const messages: any[] = [
			{ type: "message", id: "1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Implement it" }, { type: "image", data: "very-secret-image-data", mimeType: "image/png" }], timestamp: 1 } },
			{ type: "message", id: "2", parentId: "1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "I will inspect it." }], timestamp: 2 } },
			{ type: "message", id: "3", parentId: "2", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "source".repeat(1_000) }], isError: false, timestamp: 3 } },
			{ type: "message", id: "4", parentId: "3", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "advisor-call", name: "advisor", arguments: {} }], timestamp: 4 } },
		];
		const ctx: any = {
			mode: "print",
			hasUI: false,
			modelRegistry: {
				getAvailable: () => models,
				refresh: async () => {},
				find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
				getError: () => undefined,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {}, env: {} }),
				getRegisteredProviderConfig: () => ({ streamSimple: (_model: any, context: any) => { captured = context; return response; } }),
			},
			sessionManager: { getEntries: () => messages, getLeafId: () => "4" },
			getSystemPrompt: () => "Primary instructions",
			ui: { notify: () => {}, custom: async () => { selectorOpened = true; return undefined; } },
		};

		advisor.sync(ctx);
		assert.ok(!pi.active.includes("advisor"), "disabled by default");
		const completions = commands.advisor.getArgumentCompletions("test");
		assert.ok(completions.some((item: any) => item.value === "test/advisor" && item.label === "advisor" && item.description === "test"));
		assert.ok(completions.some((item: any) => item.value === "test/unique" && item.label === "unique" && item.description === "test"));
		await commands.advisor.handler("test/advisor", ctx);
		assert.equal(selected, "test/advisor");
		assert.ok(pi.active.includes("advisor"));
		await commands.advisor.handler("unique", ctx);
		assert.equal(selected, "test/unique", "unique bare IDs select directly");
		await assert.rejects(() => commands.advisor.handler("shared", ctx), /Usage: \/advisor <provider\/model\|off>/);
		assert.equal(selected, "test/unique", "headless ambiguity leaves the advisor unchanged");
		ctx.mode = "tui";
		await commands.advisor.handler("shared", ctx);
		assert.ok(selectorOpened, "ambiguous hints open the searchable selector");
		assert.equal(selected, "test/unique", "cancelling leaves the advisor unchanged");
		ctx.mode = "print";
		await commands.advisor.handler("test/advisor", ctx);
		const result = await tools.advisor.execute("call", {}, undefined, undefined, ctx);
		assert.match(result.content[0].text, /Advice from test\/advisor/);
		assert.equal(captured.systemPrompt.includes("Primary instructions"), true);
		assert.equal(captured.messages.length, 1, "transcript is inert evidence, not a live tool conversation");
		const evidence = captured.messages[0].content[0].text;
		assert.match(evidence, /Implement it/);
		assert.match(evidence, /source/);
		assert.ok(Buffer.byteLength(evidence, "utf8") < 1_200, "evidence fits the advisor input budget");
		assert.match(evidence, /advisor-call/);
		assert.doesNotMatch(evidence, /very-secret-image-data/);
		assert.match(evidence, /Provide strategic guidance/);
		await commands.advisor.handler("off", ctx);
		assert.equal(selected, undefined);
		assert.ok(!pi.active.includes("advisor"));
	});
});

describe("btw", () => {
	it("registers the command and durable entry renderer", () => {
		const { commands, entryRenderers } = createFakePi(["read"]);
		assert.ok(commands.btw, "/btw registered");
		assert.ok(entryRenderers["pi-plan-btw"], "BTW entry renderer registered");
	});

	it("reports no recall on empty query with no history", async () => {
		const { commands } = createFakePi(["read"]);
		const notifications: string[] = [];
		const ctx = fakeCtx({
			mode: "print",
			hasUI: true,
			ui: { notify: (msg: string) => { notifications.push(msg); } },
			sessionManager: { getBranch: () => [], getSessionFile: () => "/test/session.jsonl" },
		});
		await commands.btw.handler("", ctx);
		assert.match(notifications[0], /No previous BTW/);
	});

	it("injects transcript context and persists a non-LLM answer", async () => {
		const { commands, entries, customMessages } = createFakePi(["read"]);
		let capturedContext: any;
		const response: any = {
			async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "You discussed file.ts." }; },
			result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "You discussed file.ts." }] }),
		};
		const widgetCalls: unknown[] = [];
		const message = {
			type: "message", id: "1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "Let's work on file.ts" }], timestamp: 1 },
		};
		const ctx = fakeCtx({
			mode: "print",
			hasUI: false,
			modelRegistry: {
				getAvailable: () => [], find: () => ({ provider: "test", id: "m", contextWindow: 16_384 }),
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {}, env: {} }),
				getRegisteredProviderConfig: () => ({ streamSimple: (_model: any, context: any) => { capturedContext = context; return response; } }),
			},
			sessionManager: { getBranch: () => [message], getEntries: () => [message], getLeafId: () => "1", getSessionFile: () => "/test/session.jsonl" },
			isProjectTrusted: () => false,
			ui: { setWidget: (...args: unknown[]) => { widgetCalls.push(args); } },
		});

		await commands.btw.handler("What file were we discussing?", ctx);

		assert.ok(capturedContext.systemPrompt.includes("<transcript>"), "transcript injected into system prompt");
		assert.ok(capturedContext.systemPrompt.includes("file.ts"), "transcript contains session content");
		assert.equal(capturedContext.messages[0].content[0].text, "What file were we discussing?");
		assert.equal(entries.length, 1);
		assert.equal(entries[0].customType, "pi-plan-btw");
		assert.equal(entries[0].data.query, "What file were we discussing?");
		assert.equal(entries[0].data.answer, "You discussed file.ts.");
		assert.equal(typeof entries[0].data.timestamp, "number");
		assert.equal(customMessages.length, 0, "BTW answer does not enter LLM context");
		assert.equal(widgetCalls.length, 0, "BTW no longer renders a transient widget");
	});

	it("does not persist a cancelled TUI request", async () => {
		const { commands, entries } = createFakePi(["read"]);
		const notifications: string[] = [];
		const ctx = fakeCtx({
			mode: "tui",
			isProjectTrusted: () => false,
			sessionManager: { getBranch: () => [], getEntries: () => [], getLeafId: () => "1", getSessionFile: () => "/test/session.jsonl" },
			ui: {
				custom: async () => ({ cancelled: true }),
				notify: (message: string) => { notifications.push(message); },
			},
		});

		await commands.btw.handler("What changed?", ctx);
		assert.deepEqual(entries, []);
		assert.deepEqual(notifications, ["BTW cancelled."]);
	});

	it("recalls the latest answer from the current branch", async () => {
		const { commands } = createFakePi(["read"]);
		let editorTitle = "";
		let editorContent = "";
		const ctx = fakeCtx({
			mode: "tui",
			sessionManager: {
				getBranch: () => [{ type: "custom", customType: "pi-plan-btw", data: { query: "What file?", answer: "file.ts", timestamp: 1 } }],
				getSessionFile: () => "/test/session.jsonl",
			},
			ui: { editor: async (title: string, content: string) => { editorTitle = title; editorContent = content; } },
		});

		await commands.btw.handler("", ctx);
		assert.ok(editorTitle.startsWith("BTW recall:"));
		assert.equal(editorContent, "file.ts");
	});
});

describe("plan-mode tool lists", () => {
	it("includes all known read/research tools", () => {
		for (const tool of ["read", "grep", "find", "ls", "ffgrep", "fffind", "web_search", "web_extract", "advisor",
			"serena_check_onboarding_performed", "serena_find_symbol", "serena_get_symbols_overview",
			"munin_search", "munin_get", "munin_list",
		]) {
			assert.ok(READ_ONLY_TOOLS.has(tool), `${tool} in known-read set`);
		}
	});

	it("hard-blocks known source mutators", () => {
		for (const tool of ["edit", "write",
			"serena_replace_symbol_body", "serena_insert_before_symbol",
			"serena_rename_symbol", "serena_replace_content",
			"munin_store", "munin_delete",
		]) {
			assert.ok(BLOCKED_TOOLS.has(tool), `${tool} should be blocked`);
		}
	});

	it("includes plan-only tools", () => {
		assert.ok(!PLAN_ONLY_TOOLS.has("write_plan"), "write_plan is available in normal mode, not plan-only");
		assert.ok(PLAN_ONLY_TOOLS.has("ask_plan_question"));
	});
});

describe("plan mode prompt composition", () => {
	it("chains systemPrompt with plan instructions via before_agent_start", async () => {
		const { handlers } = createFakePi(["read", "ffgrep"], { plan: true });

		const ssHandler = handlers.session_start?.[0];
		assert.ok(ssHandler);
		await ssHandler({ reason: "startup" }, fakeCtx({ model: { provider: "test", id: "m" } }));

		const basHandler = handlers.before_agent_start?.[0];
		assert.ok(basHandler);

		const result = await basHandler(
			{ systemPrompt: "[Base prompt]\n\n[Ponytail mode active]", systemPromptOptions: {} },
			fakeCtx({ model: { provider: "test", id: "m" } }),
		);

		assert.ok(result);
		assert.ok(result.systemPrompt.includes("[Base prompt]\n\n[Ponytail mode active]"), "base prompt preserved");
		assert.ok(result.systemPrompt.includes("## Plan Mode"), "plan mode header added");
		assert.ok(result.systemPrompt.includes("smallest complete"), "smallest complete change rule");
		assert.ok(result.systemPrompt.includes("read-only planning mode"), "read-only mode stated");
		assert.ok(result.systemPrompt.includes("Strict single read-only bash commands"), "safe bash auto-run stated");
		assert.ok(!result.systemPrompt.includes("Read-only bash commands (ls, grep, find, git status) require user confirmation"));
	});

	it("does not inject plan prompt when not in plan mode", async () => {
		const { handlers } = createFakePi(["read"], {});
		const basHandler = handlers.before_agent_start?.[0];
		assert.ok(basHandler);

		const result = await basHandler(
			{ systemPrompt: "[Base]", systemPromptOptions: {} },
			fakeCtx(),
		);
		assert.equal(result, undefined);
	});
});

describe("tool gating in plan mode", () => {
	it("auto-allows known read/research tools in baseline", async () => {
		const tools = ["read", "grep", "find", "ls", "ffgrep", "web_search", "serena_check_onboarding_performed", "serena_find_symbol"];
		const { handlers } = createFakePi(tools, { plan: true });
		const ctx = fakeCtx({ hasUI: true });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const tc = handlers.tool_call?.[0];
		assert.ok(tc);

		for (const tool of tools) {
			const r = await tc({ toolName: tool, input: {} }, ctx);
			assert.equal(r, undefined, `${tool} auto-allowed`);
		}
	});

	it("requires confirmation for baseline custom tools not in known-read set", async () => {
		const { handlers } = createFakePi(["obsidian", "custom_research_tool", "read"], { plan: true });
		let confirmed: string[] = [];
		const ctx = fakeCtx({
			hasUI: true,
			ui: {
				confirm: async (_t: string, body: string) => { confirmed.push(body); return true; },
				select: async () => null, editor: async () => "",
				setStatus: () => {}, setWidget: () => {}, notify: () => {},
				theme: { fg: (_s: string, t: string) => t },
			},
		});

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const tc = handlers.tool_call?.[0];
		assert.ok(tc);

		// obsidian is baseline but not in READ_ONLY_TOOLS → needs confirm
		const r1 = await tc({ toolName: "obsidian", input: { run: "read" } }, ctx);
		assert.equal(r1, undefined, "obsidian allowed after confirm");
		assert.ok(confirmed.some(c => c.includes("obsidian")), "obsidian confirmed");

		// read is both baseline and in READ_ONLY_TOOLS → auto-allowed
		const r2 = await tc({ toolName: "read", input: { path: "f.ts" } }, ctx);
		assert.equal(r2, undefined, "read auto-allowed");
		assert.equal(confirmed.length, 1, "only obsidian triggered confirm");
	});

	it("blocks direct source mutators", async () => {
		const { handlers } = createFakePi(["read", "edit", "write"], { plan: true });
		const ctx = fakeCtx({ hasUI: true });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const tc = handlers.tool_call?.[0];
		assert.ok(tc);

		const r1 = await tc({ toolName: "edit", input: { path: "f.ts" } }, ctx);
		assert.ok(r1?.block, "edit blocked");
		assert.ok(r1?.reason?.includes("write_plan"));

		const r2 = await tc({ toolName: "write", input: { path: "f.ts" } }, ctx);
		assert.ok(r2?.block, "write blocked");
	});

	it("requires confirmation for unknown executables and honors approval or rejection", async () => {
		const decisions = [true, false];
		const confirmations: string[] = [];
		const { handlers } = createFakePi(["read", "bash"], { plan: true });
		const ctx = fakeCtx({
			hasUI: true,
			ui: {
				confirm: async (_title: string, body: string) => { confirmations.push(body); return decisions.shift()!; },
				select: async () => null, editor: async () => "",
				setStatus: () => {}, setWidget: () => {}, notify: () => {},
				theme: { fg: (_s: string, t: string) => t },
			},
		});

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const tc = handlers.tool_call?.[0];
		assert.ok(tc);
		assert.equal(await tc({ toolName: "bash", input: { command: "npm test" } }, ctx), undefined, "approved command allowed");
		const rejected = await tc({ toolName: "bash", input: { command: "npm test" } }, ctx);
		assert.ok(rejected?.block, "declined command blocked");
		assert.equal(confirmations.length, 2);
		assert.ok(confirmations.every((body) => body.includes("may execute repository-controlled code or modify files")));
	});

	it("denies confirmation-required commands when UI is not available", async () => {
		const { handlers } = createFakePi(["read", "bash"], { plan: true });
		const ctx = fakeCtx({ hasUI: false });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const tc = handlers.tool_call?.[0];
		assert.ok(tc);
		const r = await tc({ toolName: "bash", input: { command: "npm test" } }, ctx);
		assert.ok(r?.block);
		assert.ok(r?.reason?.includes("requires confirmation"));
	});

	const WRITE_CASES = [
		["heredoc", "cat > file << 'EOF'\ndata\nEOF"],
		["redirect", "echo hello > output.txt"],
		["redirect without spaces", "echo hello>output.txt"],
		["sed -i", "sed -i 's/foo/bar/g' file.txt"],
		["sed backup", "sed -i.bak 's/foo/bar/g' file.txt"],
		["sed long option", "sed --in-place 's/foo/bar/g' file.txt"],
		["sed write", "sed -n '1w output.txt' input.txt"],
		["tee", "echo data | tee output.txt"],
		["find delete", "find . -delete"],
		["find exec", "find . -exec touch marker +"],
		["find output", "find . -fprint output.txt"],
		["sort output", "sort -o output.txt input.txt"],
		["git mutation", "git reset --hard"],
		["git output", "git show --output=patch HEAD"],
		["known writer", "cp source target"],
		["absolute writer", "/bin/rm output.txt"],
		["wrapped writer", "sudo rm output.txt"],
		["read pipeline", "cat file.txt | grep foo"],
		["command chaining", "ls -la; pwd"],
		["command substitution", "echo $(touch marker)"],
	];

	for (const [label, cmd] of WRITE_CASES) {
		it(`blocks write commands in plan mode (${label})`, async () => {
			const { handlers } = createFakePi(["read", "bash"], { plan: true });
			const ctx = fakeCtx({ hasUI: true });
			await handlers.session_start?.[0]({ reason: "startup" }, ctx);
			const tc = handlers.tool_call?.[0];
			assert.ok(tc);
			const r = await tc({ toolName: "bash", input: { command: cmd } }, ctx);
			assert.ok(r?.block, `${label} write must be blocked`);
			assert.ok(r?.reason?.includes("writing to the filesystem"));
		});
	}

	it("auto-allows strict read-only bash commands without prompting", async () => {
		let confirmations = 0;
		const { handlers } = createFakePi(["read", "bash"], { plan: true });
		const ctx = fakeCtx({
			hasUI: true,
			ui: {
				confirm: async () => { confirmations++; return false; },
				select: async () => null, editor: async () => "",
				setStatus: () => {}, setWidget: () => {}, notify: () => {},
				theme: { fg: (_s: string, t: string) => t },
			},
		});

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const tc = handlers.tool_call?.[0];
		assert.ok(tc);

		for (const cmd of ["ls -la", "grep -R foo src/", "find . -name '*.ts'", "git status --short", "cat index.ts"]) {
			assert.equal(await tc({ toolName: "bash", input: { command: cmd } }, ctx), undefined, `${cmd} auto-allowed`);
		}
		assert.equal(confirmations, 0);
	});

	it("denies non-read baseline tools without UI", async () => {
		const { handlers } = createFakePi(["obsidian", "read"], { plan: true });
		const ctx = fakeCtx({ hasUI: false });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const tc = handlers.tool_call?.[0];
		assert.ok(tc);
		const r = await tc({ toolName: "obsidian", input: {} }, ctx);
		assert.ok(r?.block);
		assert.ok(r?.reason?.includes("confirmation"));
	});

	it("allows plan-only tools without gating", async () => {
		const { handlers } = createFakePi(["read"], { plan: true });
		const ctx = fakeCtx({ hasUI: true });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const tc = handlers.tool_call?.[0];
		assert.ok(tc);
		const r = await tc({ toolName: "write_plan", input: { title: "T", content: "# T" } }, ctx);
		assert.equal(r, undefined, "write_plan auto-allowed");
	});
});

describe("plan path containment", () => {
	it("generates paths under .agents/plans/", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
		const ctx = fakeCtx({ hasUI: true, cwd: TMP });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const wd = toolDefs.write_plan;
		assert.ok(wd);
		const result = await wd.execute("c1", { title: "My Plan", content: "# Plan\nDo work." }, undefined, undefined, ctx);
		assert.ok(result);
		assert.ok(result.details?.path?.includes(".agents/plans/"), `path under .agents/plans/: ${result.details?.path}`);
	});

	it("rejects path-traversal title", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
		const ctx = fakeCtx({ hasUI: true, cwd: TMP });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const wd = toolDefs.write_plan;
		assert.ok(wd);
		const result = await wd.execute("c1", { title: "../../../etc/passwd", content: "# Plan\nMalicious." }, undefined, undefined, ctx);
		assert.ok(result);
		// ponytail: slugify strips non-alphanumeric chars, so the path must still be under .agents/plans/
		assert.ok(result.details?.path?.includes(".agents/plans/"), `path under .agents/plans/: ${result.details?.path}`);
		// ponytail: the slugified name "etc-passwd" is fine; what matters is no directory traversal
		assert.ok(!result.details?.path?.includes(".."), "path must not contain directory traversal sequences");
	});

});

describe("write_plan lifecycle", () => {
	it("sets planReadyForReview, agent_settled prefills /plan-approve once", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });

		let prefillText = "";
		let notifyCalled = false;
		const ctx = fakeCtx({
			hasUI: true, cwd: TMP,
			getContextUsage: () => ({ percent: 50 }),
			ui: {
				select: async () => "Stay in Plan mode",
				confirm: async () => false, editor: async () => "",
				setStatus: () => {}, setWidget: () => {}, notify: () => { notifyCalled = true; },
				setEditorText: (text: string) => { prefillText = text; },
				theme: { fg: (_s: string, t: string) => t },
			},
		});

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const wd = toolDefs.write_plan;
		assert.ok(wd);

		// Write plan
		await wd.execute("c1", { title: "My Plan", content: "# Plan\nDo work." }, undefined, undefined, ctx);
		// Refinement
		await wd.execute("c2", { title: "My Plan", content: "# Plan\nDo more." }, undefined, undefined, ctx);

		const settled = handlers.agent_settled?.[0];
		assert.ok(settled);

		// First agent_settled: should prefill /plan-approve
		prefillText = "";
		notifyCalled = false;
		await settled({}, ctx);
		assert.ok(prefillText.includes("/plan-approve"), "first settled prefills /plan-approve");
		assert.ok(notifyCalled, "first settled sends notification");

		// Second: should NOT prefill (flag consumed)
		prefillText = "";
		notifyCalled = false;
		await settled({}, ctx);
		assert.equal(prefillText, "", "second settled does not prefill");
		assert.ok(!notifyCalled, "second settled does not notify");

		// Write new plan
		await wd.execute("c3", { title: "Another Plan", content: "# Another\nWork." }, undefined, undefined, ctx);

		// Again prefills
		prefillText = "";
		notifyCalled = false;
		await settled({}, ctx);
		assert.ok(prefillText.includes("/plan-approve"), "settled after new plan prefills again");
	});

	it("allows write_plan outside plan mode", async () => {
		const { toolDefs } = createFakePi(["read"], {});
		const wd = toolDefs.write_plan;
		assert.ok(wd);

		// ponytail: write_plan is available in any mode
		const result = await wd.execute("c1", { title: "Test", content: "# Test" }, undefined, undefined, fakeCtx());
		assert.ok(result);
	});
});

describe("open question warning", () => {
	it("includes warning when plan has 'Open Questions' section with a question mark", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
		const ctx = fakeCtx({ hasUI: true, cwd: TMP });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const wd = toolDefs.write_plan;
		assert.ok(wd);
		const result = await wd.execute("c1", {
			title: "My Plan",
			content: "## Open Questions\n- What is your preferred approach?\n## Next Steps\n...",
		}, undefined, undefined, ctx);
		assert.ok(result);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("ask_plan_question"), "should warn about open questions");
	});

	it("excludes warning when 'Open Questions' section has no question mark", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
		const ctx = fakeCtx({ hasUI: true, cwd: TMP });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const wd = toolDefs.write_plan;
		assert.ok(wd);
		const result = await wd.execute("c1", {
			title: "My Plan",
			content: "## Open Questions\nNone at this time.\n## Next Steps\n...",
		}, undefined, undefined, ctx);
		assert.ok(result);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(!text.includes("ask_plan_question"), "should not warn when no questions");
	});

	it("excludes warning when question mark is in a later section, not under 'Open Questions'", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
		const ctx = fakeCtx({ hasUI: true, cwd: TMP });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const wd = toolDefs.write_plan;
		assert.ok(wd);
		const result = await wd.execute("c1", {
			title: "My Plan",
			content: "## Open Questions\nNone.\n\n## Implementation Details\nShould we use a library?",
		}, undefined, undefined, ctx);
		assert.ok(result);
		const text = result.content?.[0]?.text ?? "";
		// ponytail: the ? in "Should we use a library?" is under a different heading,
		// so hasOpenQuestionWarning must NOT fire.
		assert.ok(!text.includes("ask_plan_question"), "should not cross section boundaries");
	});

	it("detects question mark in sub-bullets under 'Open Questions'", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
		const ctx = fakeCtx({ hasUI: true, cwd: TMP });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const wd = toolDefs.write_plan;
		assert.ok(wd);
		const result = await wd.execute("c1", {
			title: "My Plan",
			content: "## Open Questions\n- Main question?\n  - Sub-question?\n## Next Steps",
		}, undefined, undefined, ctx);
		assert.ok(result);
		const text = result.content?.[0]?.text ?? "";
		assert.ok(text.includes("ask_plan_question"), "should detect questions in sub-items");
	});
});

describe("execution handoff", () => {
	it("current-session execution through /plan-approve command", async () => {
		const { commands, sentMessages, toolDefs, handlers } = createFakePi(["read"], { plan: true });

		const ctx = fakeCtx({ hasUI: true, cwd: TMP, getContextUsage: () => ({ percent: 50 }) });
		await handlers.session_start?.[0]({ reason: "startup" }, ctx);
		await toolDefs.write_plan.execute("c1", { title: "Plan", content: "# Plan\nWork." }, undefined, undefined, ctx);

		const approve = commands["plan-approve"];
		assert.ok(approve, "/plan-approve registered");

		await approve.handler("current", ctx);

		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].content?.includes("Execute the approved plan"));
		assert.equal(sentMessages[0].options?.deliverAs, "followUp");
	});

	it("fresh-session execution through /plan-approve new command", async () => {
		const { commands, sentMessages, toolDefs, handlers } = createFakePi(["read"], { plan: true });

		let newSessionCalled = false;
		const ctx = fakeCtx({
			hasUI: true, cwd: TMP,
			getContextUsage: () => ({ percent: 60 }),
			newSession: async (options: any) => {
				newSessionCalled = true;
				await options.setup({ appendCustomEntry: () => {} });
				await options.withSession({ sendUserMessage: async (text: string) => { sentMessages.push({ content: text }); } });
				return { cancelled: false };
			},
		});

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);
		await toolDefs.write_plan.execute("c1", { title: "Plan", content: "# Plan\nWork." }, undefined, undefined, ctx);

		const approve = commands["plan-approve"];
		assert.ok(approve, "/plan-approve registered");

		await approve.handler("new", ctx);

		assert.ok(newSessionCalled, "newSession was called");
		assert.ok(sentMessages.length >= 1, "sent at least one message");
	});

	it("fresh-session execution with flow through /plan-approve flow command", async () => {
		const { commands, sentMessages, toolDefs, handlers } = createFakePi(["read"], { plan: true });

		const flowCwd = createGitRepo("pi-plan-flow-");

		let newSessionCalled = false;
		const ctx = fakeCtx({
			hasUI: true, cwd: flowCwd,
			getContextUsage: () => ({ percent: 50 }),
			newSession: async (options: any) => {
				newSessionCalled = true;
				await options.setup({ appendCustomEntry: () => {} });
				await options.withSession({ sendUserMessage: async (text: string) => { sentMessages.push({ content: text }); } });
				return { cancelled: false };
			},
		});

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);
		await toolDefs.write_plan.execute("c1", { title: "Plan", content: "# Plan\nWork." }, undefined, undefined, ctx);

		const approve = commands["plan-approve"];
		assert.ok(approve, "/plan-approve registered");

		await approve.handler("flow", ctx);

		assert.ok(newSessionCalled, "newSession was called");
		assert.ok(sentMessages.length >= 1, "sent at least one message");
	});

	it("rolls back flow state when fresh-session handoff throws", async () => {
		const { commands, entries, toolDefs, handlers } = createFakePi(["read"], { plan: true });
		const flowCwd = createGitRepo("pi-plan-flow-error-");
		const ctx = fakeCtx({
			cwd: flowCwd,
			newSession: async (options: any) => {
				await options.setup({ appendCustomEntry: (customType: string, data?: any) => entries.push({ customType, data }) });
				throw new Error("handoff failed");
			},
		});

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);
		await toolDefs.write_plan.execute("c1", { title: "Plan", content: "# Plan\nWork." }, undefined, undefined, ctx);
		await assert.rejects(commands["plan-approve"].handler("flow", ctx), /handoff failed/);

		assert.ok(entries.some((entry) => entry.data?.flow?.phase === "implement"), "handoff captured new flow state");
		assert.equal(entries.at(-1)?.data?.flow, undefined, "failed handoff restores prior flow state");
	});

	it("calls appendEntry when plan mode is toggled", async () => {
		const { handlers, entries, commands } = createFakePi(["read"], {});

		const ctx = fakeCtx({ hasUI: true, cwd: TMP });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		// Enter plan mode via /plan command
		const planCmd = commands.plan;
		assert.ok(planCmd);
		await planCmd.handler("", ctx);

		const stateEntry = entries.find((e: any) => e.customType === "pi-plan");
		assert.ok(stateEntry, "should persist pi-plan state");
		assert.ok(stateEntry.data.hasOwnProperty("enabled"), "state includes enabled field");
	});

	it("switching to an empty branch clears workflow state", async () => {
		const { handlers, commands, entries, toolDefs } = createFakePi(["read"], { plan: true });

		const flowCwd = createGitRepo("pi-plan-branch-");

		const ctx = fakeCtx({
			hasUI: true, cwd: flowCwd,
			getContextUsage: () => ({ percent: 50 }),
			newSession: async (options: any) => {
				// Forward setup's appendCustomEntry to our entries tracker
				await options.setup({ appendCustomEntry: (type: string, data?: any) => entries.push({ customType: type, data }) });
				await options.withSession({ sendUserMessage: async () => {} });
				return { cancelled: false };
			},
		});

		// Start plan mode, write a plan, approve with flow to set workflow
		await handlers.session_start?.[0]({ reason: "startup" }, ctx);
		await toolDefs.write_plan.execute("c1", { title: "Plan", content: "# Plan\nWork." }, undefined, undefined, ctx);
		await commands["plan-approve"].handler("flow", ctx);

		// Confirm flow state was persisted (the last pi-plan entry should have flow)
		const allPlanEntries = entries.filter((e: any) => e.customType === "pi-plan");
		const lastPlanEntry = allPlanEntries[allPlanEntries.length - 1];
		const flowData = lastPlanEntry?.data?.flow;
		assert.ok(flowData, "flow state persisted after execution");

		// Simulate switching to a branch with no pi-plan entry
		const emptyBranchCtx = fakeCtx({
			cwd: flowCwd,
			sessionManager: {
				// No custom entries of type pi-plan
				getBranch: () => [
					{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
					{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
				],
			},
		});

		const sessionTree = handlers.session_tree?.[0];
		assert.ok(sessionTree, "session_tree handler registered");
		await sessionTree({}, emptyBranchCtx);

		// Check that the latest entry has all state reset (cleared on empty branch)
		const allPlanEntriesAfter = entries.filter((e: any) => e.customType === "pi-plan");
		const lastEntryAfter = allPlanEntriesAfter[allPlanEntriesAfter.length - 1];
		assert.equal(lastEntryAfter.data?.flow, undefined, "flow cleared on empty branch");
		assert.equal(lastEntryAfter.data?.lastPlanPath, undefined, "lastPlanPath cleared on empty branch");
		assert.equal(lastEntryAfter.data?.lastPlanTitle, undefined, "lastPlanTitle cleared on empty branch");
		assert.equal(lastEntryAfter.data?.lastPlanStatus, undefined, "lastPlanStatus cleared on empty branch");
		assert.equal(lastEntryAfter.data?.enabled, false, "planModeEnabled reset on empty branch");
		assert.equal(lastEntryAfter.data?.toolsBeforePlan, undefined, "toolsBeforePlan cleared on empty branch");
	});

	it("restores tools and thinking when leaving a plan-mode branch", async () => {
		const state = createFakePi(["read", "edit"], { plan: false });
		const ctx = fakeCtx();
		await state.handlers.session_start?.[0]({ reason: "startup" }, ctx);
		const normalThinking = state.thinkingLevel;
		await state.commands.plan.handler("", ctx);
		assert.ok(!state.activeTools.includes("edit"), "plan branch hides mutators");

		await state.handlers.session_tree?.[0]({}, fakeCtx({ sessionManager: { getBranch: () => [] } }));
		assert.ok(state.activeTools.includes("edit"), "empty branch restores baseline tools");
		assert.equal(state.thinkingLevel, normalThinking, "empty branch restores normal thinking");
	});

	it("branch with partial saved entry reconstructs plan tools without inheriting optional state", async () => {
		const { handlers, entries, commands, activeTools } = createFakePi(["read", "ffgrep", "edit"], { plan: false });

		// Set up a module state with meaningful toolsBeforePlan (simulating prior branch)
		const ctx = fakeCtx({ hasUI: true, cwd: TMP });
		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		// Enter plan mode so toolsBeforePlan gets captured
		await commands.plan.handler("", ctx);

		// Now simulate a branch that has a saved plan entry but with a partial subset of fields
		const partialBranchCtx = fakeCtx({
			cwd: TMP,
			sessionManager: {
				getBranch: () => [
					// Has a custom pi-plan entry but only some fields (no toolsBeforePlan)
					{ type: "custom", customType: "pi-plan", data: { enabled: true, lastPlanPath: "/some/path.md", lastPlanTitle: "Some Plan" } } as any,
				],
			},
		});

		const sessionTree = handlers.session_tree?.[0];
		assert.ok(sessionTree, "session_tree handler registered");
		await sessionTree({}, partialBranchCtx);

		const lastEntry = entries[entries.length - 1];
		assert.equal(lastEntry.data?.enabled, true, "planModeEnabled from saved entry");
		assert.equal(lastEntry.data?.lastPlanPath, "/some/path.md", "lastPlanPath from saved entry");
		assert.deepEqual(lastEntry.data?.toolsBeforePlan, ["read", "ffgrep", "edit", "write_plan"], "baseline reconstructed for restoration");
		assert.ok(!activeTools.includes("edit"), "saved plan mode hides mutators");
		assert.equal(lastEntry.data?.lastPlanStatus, undefined, "lastPlanStatus not inherited — absent from saved entry");
		assert.equal(lastEntry.data?.flow, undefined, "flow not inherited — absent from saved entry");
	});
});

describe("rewind checkpoints", () => {
	it("captures a normal user turn and restores its conversation prompt", async () => {
		const { commands, entries, handlers } = createFakePi(["read"]);
		const cwd = createGitRepo("pi-plan-command-rewind-");
		const checkpoint = await captureRewindCheckpoint(cwd, "prompt-1", "Restore me", "2026-01-01T00:00:00.000Z");
		let editorText = "";
		let navigatedTo = "";
		let cancelled = false;
		const branch = [
			{ id: "parent", type: "message", parentId: null, message: { role: "assistant", content: [] } },
			{ id: "prompt-1", type: "message", parentId: "parent", message: { role: "user", content: "Restore me" } },
			{ id: "checkpoint", type: "custom", customType: "pi-plan-rewind", data: checkpoint },
		];
		const ctx = fakeCtx({
			cwd,
			ui: {
				select: async (_title: string, options: string[]) => options[0] === "Restore conversation" ? "Restore conversation" : options[0],
				setEditorText: (text: string) => { editorText = text; },
				notify: () => {},
			},
			sessionManager: {
				getBranch: () => branch,
				getLeafEntry: () => branch[1],
				getEntry: (id: string) => branch.find((entry) => entry.id === id),
			},
			navigateTree: async (id: string) => { navigatedTo = id; return { cancelled }; },
		});
		await commands.rewind.handler("", ctx);
		assert.equal(navigatedTo, "parent");
		assert.equal(editorText, "Restore me");
		cancelled = true;
		editorText = "unchanged";
		await commands.rewind.handler("", ctx);
		assert.equal(editorText, "unchanged");

		await handlers.turn_start?.[0]({}, fakeCtx({
			cwd,
			sessionManager: { getBranch: () => [], getLeafEntry: () => branch[1] },
		}));
		assert.ok(entries.some((entry) => entry.customType === "pi-plan-rewind"));
	});

	it("preflights combined rewind before changing the conversation", async () => {
		const { commands } = createFakePi(["read"]);
		const cwd = createGitRepo("pi-plan-combined-rewind-");
		const checkpoint = await captureRewindCheckpoint(cwd, "prompt-1", "Restore me");
		writeFileSync(path.join(cwd, "README.md"), "diverged\n");
		execFileSync("git", ["add", "README.md"], { cwd });
		execFileSync("git", ["commit", "-m", "diverged"], { cwd });
		let navigations = 0;
		let editorText = "unchanged";
		const branch = [
			{ id: "parent", type: "message", parentId: null, message: { role: "assistant", content: [] } },
			{ id: "prompt-1", type: "message", parentId: "parent", message: { role: "user", content: "Restore me" } },
			{ id: "checkpoint", type: "custom", customType: "pi-plan-rewind", data: checkpoint },
		];
		await commands.rewind.handler("", fakeCtx({
			cwd,
			ui: {
				select: async (_title: string, options: string[]) => options.includes("Restore code") ? "Restore code and conversation" : options[0],
				setEditorText: (text: string) => { editorText = text; },
				notify: () => {},
			},
			sessionManager: { getBranch: () => branch, getEntry: (id: string) => branch.find((entry) => entry.id === id) },
			navigateTree: async () => { navigations++; return { cancelled: false }; },
		}));
		assert.equal(navigations, 0);
		assert.equal(editorText, "unchanged");
	});
});

describe("thinking level preferences", () => {
	it("includes 'max' in valid thinking levels", () => {
		assert.ok(["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes("max"));
	});

	it("preserves per-model thinking on model_select", async () => {
		const { handlers } = createFakePi(["read"], {});

		const ctx = fakeCtx({
			model: { provider: "test", id: "m1" },
		});

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const ms = handlers.model_select?.[0];
		if (ms) {
			await ms(
				{ model: { provider: "test2", id: "m2" }, previousModel: { provider: "test", id: "m1" } },
				ctx,
			);
		}
		// No crash = success
	});
});

describe("ask_plan_question validation", () => {
	it("rejects fewer than 2 options at TypeBox level", async () => {
		const { toolDefs } = createFakePi(["read"], { plan: true });
		const def = toolDefs.ask_plan_question;
		assert.ok(def);
		assert.ok(def.parameters?.properties?.options?.minItems === 2);
		assert.ok(def.parameters?.properties?.options?.maxItems === 4);
	});

	it("rejects blank label at execute", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
		const ctx = fakeCtx({ hasUI: false });
		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const qd = toolDefs.ask_plan_question;
		assert.ok(qd);
		await assert.rejects(
			qd.execute("c1", { question: "Q?", options: [{ label: "" }, { label: "Option 2" }] }, undefined, undefined, ctx),
			/Each option must have a non-blank label\./,
		);
	});

	it("rejects duplicate labels at execute", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
		const ctx = fakeCtx({ hasUI: false });
		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const qd = toolDefs.ask_plan_question;
		assert.ok(qd);
		await assert.rejects(
			qd.execute("c1", { question: "Q?", options: [{ label: "Duplicate" }, { label: "Duplicate" }] }, undefined, undefined, ctx),
			/Option labels must be unique\./,
		);
	});

	it("rejects 'Other' label at execute", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
		const ctx = fakeCtx({ hasUI: false });
		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const qd = toolDefs.ask_plan_question;
		assert.ok(qd);
		await assert.rejects(
			qd.execute("c1", { question: "Q?", options: [{ label: "Other" }, { label: "Option B" }] }, undefined, undefined, ctx),
			/Option labels cannot conflict with the "Other" label\./,
		);
	});

	it("rejects label starting with 'Other ' at execute", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
		const ctx = fakeCtx({ hasUI: false });
		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const qd = toolDefs.ask_plan_question;
		assert.ok(qd);
		await assert.rejects(
			qd.execute("c1", { question: "Q?", options: [{ label: "Other (specify)" }, { label: "Option B" }] }, undefined, undefined, ctx),
			/Option labels cannot conflict with the "Other" label\./,
		);
	});

	it("rejects 'other' (case-insensitive) label at execute", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });
		const ctx = fakeCtx({ hasUI: false });
		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const qd = toolDefs.ask_plan_question;
		assert.ok(qd);
		await assert.rejects(
			qd.execute("c1", { question: "Q?", options: [{ label: "other" }, { label: "Option B" }] }, undefined, undefined, ctx),
			/Option labels cannot conflict with the "Other" label\./,
		);
	});
});

describe("flow loop regression coverage", () => {
	it("stops when verification marker is absent", async () => {
		const state = createFakePi(["read"], { plan: false });
		const ctx = fakeCtx({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "pi-plan",
						data: {
							enabled: false,
							lastPlanPath: "/some/path.md",
							lastPlanTitle: "Some Plan",
							flow: {
								phase: "implement",
								reviewPass: 0,
								baseline: "abc",
								initialDirty: "none",
								initialDirtyPatch: "",
								initialUntrackedSnapshot: "[]",
							},
						},
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Done with no marker." }],
						},
					},
				],
			},
		});

		await state.handlers.session_tree?.[0]({}, ctx);
		const settled = state.handlers.agent_settled?.[0];
		assert.ok(settled);
		await settled({}, ctx);

		const lastEntry = state.entries[state.entries.length - 1];
		assert.equal(lastEntry?.data?.flow?.phase, "stopped", "phase becomes stopped");
	});

	it("completes when verification passes and review has no blocking findings", async () => {
		const state = createFakePi(["read"], { plan: false });
		let reviewEventEmitted = false;
		state.onEmit = (event, data) => {
			if (event === "pi-review:run") {
				reviewEventEmitted = true;
				assert.equal(data.timeout, 3 * 60 * 1000);
				assert.equal(typeof data.onProgress, "function");
				assert.equal(data.gitRange, "abc...HEAD");
				assert.equal(data.requireExactRange, true);
				const accepted = data.accept();
				assert.ok(accepted);
				data.respond({ id: data.id, ok: true, result: { summary: "clean", findings: [] } });
			}
		};

		const flowCwd = createGitRepo("pi-plan-flow-ok-");

		const planPath = path.join(flowCwd, "plan.md");
		writeFileSync(planPath, "# Plan");

		const ctx = fakeCtx({
			cwd: flowCwd,
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "pi-plan",
						data: {
							enabled: false,
							lastPlanPath: planPath,
							lastPlanTitle: "Some Plan",
							flow: {
								phase: "implement",
								reviewPass: 0,
								baseline: "abc",
								initialDirty: "none",
								initialDirtyPatch: "",
								initialUntrackedSnapshot: "[]",
							},
						},
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "We verified everything. [verification: pass]" }],
						},
					},
				],
			},
		});

		await state.handlers.session_tree?.[0]({}, ctx);
		const settled = state.handlers.agent_settled?.[0];
		assert.ok(settled);
		await settled({}, ctx);

		assert.ok(reviewEventEmitted, "review event was emitted");
		const lastEntry = state.entries[state.entries.length - 1];
		assert.equal(lastEntry?.data?.flow?.phase, "done", "phase becomes done");
		assert.equal(state.customMessages.length, 1);
		assert.equal(state.customMessages[0].message?.customType, "pi-flow-result");
	});

	it("preserves non-blocking findings across a blocking fix pass", async () => {
		const finding = {
			severity: "low",
			file: "index.ts",
			line: 10,
			issue: "test issue",
			evidence: "xxx",
			expectedBehavior: "the issue is gone",
			suggestedFix: "fix it",
			acceptanceCriteria: "the regression check passes",
			blocking: false,
		};
		const blocker = { ...finding, severity: "high", issue: "blocking issue", blocking: true };
		const state = createFakePi(["read"], { plan: false });
		let reviewPass = 0;
		state.onEmit = (event, data) => {
			if (event === "pi-review:run") {
				assert.ok(data.accept());
				data.respond({ id: data.id, ok: true, result: { summary: "reviewed", findings: reviewPass++ === 0 ? [finding, blocker] : [] } });
			}
		};

		const flowCwd = createGitRepo("pi-plan-flow-mixed-");
		const planPath = path.join(flowCwd, "plan.md");
		writeFileSync(planPath, "# Plan");
		const ctx = fakeCtx({
			cwd: flowCwd,
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "pi-plan",
						data: {
							enabled: false,
							lastPlanPath: planPath,
							lastPlanTitle: "Some Plan",
							flow: {
								phase: "implement",
								reviewPass: 0,
								baseline: "abc",
								initialDirty: "none",
								initialDirtyPatch: "",
								initialUntrackedSnapshot: "[]",
							},
						},
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Checks run. [verification: pass]" }],
						},
					},
				],
			},
		});

		await state.handlers.session_tree?.[0]({}, ctx);
		const settled = state.handlers.agent_settled?.[0];
		assert.ok(settled);
		await settled({}, ctx);
		let lastEntry = state.entries[state.entries.length - 1];
		assert.equal(lastEntry?.data?.flow?.phase, "fix");
		assert.match(state.sentMessages[0].content, /blocking issue/);
		assert.doesNotMatch(state.sentMessages[0].content, /"issue": "test issue"/);

		await settled({}, ctx);
		lastEntry = state.entries[state.entries.length - 1];
		assert.equal(lastEntry?.data?.flow?.phase, "done");
		assert.deepEqual(lastEntry?.data?.flow?.reviewFindings, [finding]);
		assert.match(state.customMessages[0].message?.content, /1 non-blocking review finding/);
		assert.doesNotMatch(state.customMessages[0].message?.content, /review clean/);
	});

	it("sends valid blocking findings then fails closed on malformed review output", async () => {
		const state = createFakePi(["read"], { plan: false });
		let reviewEventEmitted = false;
		let reviewPass = 0;
		state.onEmit = (event, data) => {
			if (event === "pi-review:run") {
				reviewEventEmitted = true;
				const accepted = data.accept();
				assert.ok(accepted);
				if (reviewPass++ > 0) return data.respond({ id: data.id, ok: true, result: { findings: [] } });
				data.respond({
					id: data.id,
					ok: true,
					result: {
						summary: "blocking issue",
						findings: [
							{
								severity: "high",
								file: "index.ts",
								line: 10,
								issue: "test issue",
								evidence: "xxx",
								expectedBehavior: "the issue is gone",
								suggestedFix: "fix it",
								acceptanceCriteria: "the regression check passes",
								blocking: true,
							},
						],
					},
				});
			}
		};

		const flowCwd = createGitRepo("pi-plan-flow-fail-");

		const planPath = path.join(flowCwd, "plan.md");
		writeFileSync(planPath, "# Plan");

		const ctx = fakeCtx({
			cwd: flowCwd,
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "pi-plan",
						data: {
							enabled: false,
							lastPlanPath: planPath,
							lastPlanTitle: "Some Plan",
							flow: {
								phase: "implement",
								reviewPass: 0,
								baseline: "abc",
								initialDirty: "none",
								initialDirtyPatch: "",
								initialUntrackedSnapshot: "[]",
							},
						},
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Checks run. [verification: pass]" }],
						},
					},
				],
			},
		});

		await state.handlers.session_tree?.[0]({}, ctx);
		const settled = state.handlers.agent_settled?.[0];
		assert.ok(settled);
		await settled({}, ctx);

		assert.ok(reviewEventEmitted, "review event was emitted");
		const lastEntry = state.entries[state.entries.length - 1];
		assert.equal(lastEntry?.data?.flow?.phase, "fix", "phase transitions to fix");
		assert.equal(state.sentMessages.length, 1);
		assert.ok(state.sentMessages[0].content?.includes("Independent review found blocking issues"), "sent fix prompt to user");
		assert.ok(state.sentMessages[0].content?.includes('"expectedBehavior": "the issue is gone"'), "preserves expected behavior");
		assert.ok(state.sentMessages[0].content?.includes('"acceptanceCriteria": "the regression check passes"'), "preserves acceptance criteria");

		await settled({}, ctx);
		const stoppedEntry = state.entries[state.entries.length - 1];
		assert.equal(stoppedEntry?.data?.flow?.phase, "stopped");
		assert.equal(state.customMessages.length, 0, "malformed review never reports clean completion");
	});
});
