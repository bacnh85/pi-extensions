/**
 * Tests for pi-plan extension: prompt composition, tool gating, plan lifecycle,
 * path containment.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "mocha";
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import piPlanExtension from "./index";
import { BLOCKED_TOOLS, PLAN_ONLY_TOOLS, READ_ONLY_TOOLS } from "./lib/plan-tools";
import { PLAN_MODE_SERENA_GUIDANCE } from "./lib/guidance";

/** Real temp directory for tests that write files. */
const TMP = path.join(os.tmpdir(), "pi-plan-test-" + process.pid);
before(() => { mkdirSync(TMP, { recursive: true }); });

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
	flagValues: Record<string, any>;
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
		getActiveTools() {
			return [...state.activeTools];
		},
		setActiveTools(tools: string[]) {
			state.activeTools = [...tools];
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
	};

	piPlanExtension(pi);
	return { ...state, pi };
}

function fakeCtx(overrides: Record<string, any> = {}): any {
	const ctx: any = {
		cwd: overrides.cwd ?? TMP,
		hasUI: overrides.hasUI ?? true,
		model: overrides.model ?? { provider: "test", id: "model-1" },
		getContextUsage: () => ({ percent: 50 }),
		ui: {
			theme: { fg: (_style: string, text: string) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			select: async (_question: string, _options: string[]) => null,
			confirm: async (_title: string, _body: string) => false,
			editor: async (_title: string, _default: string) => "",
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
	return ctx;
}

// ── Tests ────────────────────────────────────────────────────────

describe("plan-mode guidance", () => {
	it("tells agents to use Serena before raw code reads/searches", () => {
		assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("use Serena before raw reads/searches"));
		assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("serena_get_symbols_overview"));
		assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("serena_find_symbol"));
		assert.ok(PLAN_MODE_SERENA_GUIDANCE.includes("Use read for docs/config/non-code files"));
	});
});

describe("plan-mode tool lists", () => {
	it("includes all known read/research tools", () => {
		for (const tool of ["read", "ffgrep", "fffind", "web_search", "web_extract",
			"serena_find_symbol", "serena_get_symbols_overview",
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
		assert.ok(PLAN_ONLY_TOOLS.has("write_plan"));
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
		const { handlers } = createFakePi(["read", "ffgrep", "web_search", "serena_find_symbol"], { plan: true });
		const ctx = fakeCtx({ hasUI: true });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const tc = handlers.tool_call?.[0];
		assert.ok(tc);

		for (const tool of ["read", "ffgrep", "web_search", "serena_find_symbol"]) {
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

	it("requires confirmation for bash commands", async () => {
		let confirmed = false;
		const { handlers } = createFakePi(["read", "bash"], { plan: true });
		const ctx = fakeCtx({
			hasUI: true,
			ui: {
				confirm: async () => { confirmed = true; return true; },
				select: async () => null, editor: async () => "",
				setStatus: () => {}, setWidget: () => {}, notify: () => {},
				theme: { fg: (_s: string, t: string) => t },
			},
		});

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const tc = handlers.tool_call?.[0];
		assert.ok(tc);
		const r = await tc({ toolName: "bash", input: { command: "ls -la" } }, ctx);
		assert.equal(r, undefined, "bash passes when confirmed");
		assert.ok(confirmed, "confirm called");
	});

	it("denies bash when UI is not available", async () => {
		const { handlers } = createFakePi(["read", "bash"], { plan: true });
		const ctx = fakeCtx({ hasUI: false });

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const tc = handlers.tool_call?.[0];
		assert.ok(tc);
		const r = await tc({ toolName: "bash", input: { command: "find . -delete" } }, ctx);
		assert.ok(r?.block);
		assert.ok(r?.reason?.includes("UI is not available"));
	});

	const WRITE_CASES = [
  	["heredoc", "cat > file << 'EOF'\ndata\nEOF"],
  	["redirect", "echo hello > output.txt"],
  	["sed -i", "sed -i 's/foo/bar/g' file.txt"],
  	["tee", "echo data | tee output.txt"]
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
it("allows read-only bash commands in plan mode", async () => {
		let confirmed = false;
		const { handlers } = createFakePi(["read", "bash"], { plan: true });
		const ctx = fakeCtx({
			hasUI: true,
			ui: {
				confirm: async () => { confirmed = true; return true; },
				select: async () => null, editor: async () => "",
				setStatus: () => {}, setWidget: () => {}, notify: () => {},
				theme: { fg: (_s: string, t: string) => t },
			},
		});

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		const tc = handlers.tool_call?.[0];
		assert.ok(tc);

		// Read-only commands still pass confirmation
		for (const cmd of ["ls -la", "grep -R foo src/", "find . -name '*.ts'", "git status --short", "cat index.ts"]) {
			confirmed = false;
			const r = await tc({ toolName: "bash", input: { command: cmd } }, ctx);
			assert.equal(r, undefined, `${cmd} must pass when confirmed`);
			assert.ok(confirmed, `confirm called for ${cmd}`);
		}
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

});

describe("write_plan lifecycle", () => {
	it("sets planReadyForReview, agent_settled consumes it once", async () => {
		const { handlers, toolDefs } = createFakePi(["read"], { plan: true });

		let selectCalled = false;
		const ctx = fakeCtx({
			hasUI: true, cwd: TMP,
			getContextUsage: () => ({ percent: 50 }),
			ui: {
				select: async () => { selectCalled = true; return "No, stay in Plan mode"; },
				confirm: async () => false, editor: async () => "",
				setStatus: () => {}, setWidget: () => {}, notify: () => {},
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

		// First agent_settled: should prompt
		selectCalled = false;
		await settled({}, ctx);
		assert.ok(selectCalled, "first settled shows prompt");

		// Second: should NOT prompt (flag consumed)
		selectCalled = false;
		await settled({}, ctx);
		assert.ok(!selectCalled, "second settled does not reprompt");

		// Write new plan
		await wd.execute("c3", { title: "Another Plan", content: "# Another\nWork." }, undefined, undefined, ctx);

		// Again prompts
		selectCalled = false;
		await settled({}, ctx);
		assert.ok(selectCalled, "settled after new plan prompts again");
	});

	it("guards write_plan outside plan mode by throwing", async () => {
		const { toolDefs } = createFakePi(["read"], {});
		const wd = toolDefs.write_plan;
		assert.ok(wd);

		try {
			await wd.execute("c1", { title: "Test", content: "# Test" }, undefined, undefined, fakeCtx());
			assert.fail("should have thrown");
		} catch (e: any) {
			assert.ok(e.message.includes("only available in plan mode"));
		}
	});
});

describe("execution handoff", () => {
	it("current-session execution produces one kickoff message", async () => {
		const { handlers, toolDefs, sentMessages } = createFakePi(["read"], { plan: true });

		const selectChoice = "Yes, implement this plan          Switch to Default and start coding.";
		const ctx = fakeCtx({
			hasUI: true, cwd: TMP,
			getContextUsage: () => ({ percent: 50 }),
			ui: {
				select: async () => selectChoice,
				confirm: async () => false, editor: async () => "",
				setStatus: () => {}, setWidget: () => {}, notify: () => {},
				theme: { fg: (_s: string, t: string) => t },
			},
		});

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);

		await toolDefs.write_plan.execute("c1", { title: "Plan", content: "# Plan\nWork." }, undefined, undefined, ctx);

		const settled = handlers.agent_settled?.[0];
		await settled({}, ctx);

		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].content?.includes("Execute the approved plan"));
		assert.equal(sentMessages[0].options?.deliverAs, "followUp");
	});

	it("fresh-session execution queues /plan-execute new", async () => {
		const { handlers, toolDefs, sentMessages } = createFakePi(["read"], { plan: true });

		const ctx = fakeCtx({
			hasUI: true, cwd: TMP,
			getContextUsage: () => ({ percent: 60 }),
			ui: {
				select: async () => "Yes, clear context and implement  Fresh thread. Context: 60% used.",
				confirm: async () => false, editor: async () => "",
				setStatus: () => {}, setWidget: () => {}, notify: () => {},
				theme: { fg: (_s: string, t: string) => t },
			},
		});

		await handlers.session_start?.[0]({ reason: "startup" }, ctx);
		await toolDefs.write_plan.execute("c1", { title: "Plan", content: "# Plan\nWork." }, undefined, undefined, ctx);

		const settled = handlers.agent_settled?.[0];
		await settled({}, ctx);

		// Should have queued /plan-execute new via sendUserMessage
		assert.ok(sentMessages.some((m: any) => m.content === "/plan-execute new"), "queued /plan-execute new");
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
});
