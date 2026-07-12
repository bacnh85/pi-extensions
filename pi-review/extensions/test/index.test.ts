import assert from "node:assert/strict";
import { describe, it } from "mocha";
import piReviewExtension, { isReadOnlyBash, parseReviewArgs, parseReviewResult, resolveGitRange } from "../index.ts";

/** Flush pending microtasks and async I/O so review promise chain settles. */
async function flush(): Promise<void> {
	await new Promise((r) => setTimeout(r, 20));
}

function harness(subagent = false) {
	const handlers: Record<string, Function[]> = {};
	const commands: Record<string, any> = {};
	const sent: any[] = [];
	const messages: any[] = [];
	let activeTools = ["read", "edit", "ffgrep", "serena_find_symbol"];
	let thinking = "medium";
	const bus = new Map<string, Function[]>();
	const pi: any = {
		on(name: string, fn: Function) { (handlers[name] ??= []).push(fn); },
		registerCommand(name: string, def: any) { commands[name] = def; },
		getActiveTools: () => [...activeTools],
		setActiveTools: (tools: string[]) => { activeTools = [...tools]; },
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: string) => { thinking = level; },
		sendUserMessage: (content: string, options: any) => sent.push({ content, options }),
		sendMessage: (message: any) => messages.push(message),
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		events: {
			on(name: string, fn: Function) { const list = bus.get(name) ?? []; list.push(fn); bus.set(name, list); },
			emit(name: string, value: any) {
				if (subagent && name === "pi-subagent:run") {
					value.accept();
					value.respond({ id: value.id, ok: true, result: { messages: [{ role: "assistant", content: [{ type: "text", text: '{"summary":"clean","findings":[]}' }] }] } });
				}
				for (const fn of bus.get(name) ?? []) fn(value);
			},
		},
	};
	piReviewExtension(pi);
	const ctx: any = {
		cwd: process.cwd(), hasUI: false,
		waitForIdle: async () => {},
		ui: { theme: { fg: (_: string, text: string) => text }, setStatus() {}, notify() {}, select: async () => undefined, editor: async () => undefined },
	};
	return { handlers, commands, sent, messages, ctx, tools: () => activeTools, thinking: () => thinking };
}

describe("review parsing and shell gate", () => {
	it("parses effort and target", () => assert.deepEqual(parseReviewArgs("xhigh auth only"), { thinking: "xhigh", target: "auth only" }));
	it("allows RTK inspection and blocks mutation/metacharacters", () => {
		assert.equal(isReadOnlyBash("rtk git diff --stat"), true);
		assert.equal(isReadOnlyBash("rtk git reset --hard"), false);
		assert.equal(isReadOnlyBash("find . -delete"), false);
		assert.equal(isReadOnlyBash("git diff | tee out"), false);
	});

	it("blocks destructive git commands", () => {
		assert.equal(isReadOnlyBash("git branch new-feature"), false, "branch create");
		assert.equal(isReadOnlyBash("git branch -d old-branch"), false, "branch delete");
		assert.equal(isReadOnlyBash("git branch --list"), true, "branch list");
		assert.equal(isReadOnlyBash("git branch --show-current"), true, "branch show-current");
		assert.equal(isReadOnlyBash("git show --output=/tmp/out HEAD"), false, "show --output");
		assert.equal(isReadOnlyBash("git log --oneline --output=/tmp/log"), false, "log --output");
		assert.equal(isReadOnlyBash("git diff --output=/tmp/patch"), false, "diff --output");
		assert.equal(isReadOnlyBash("git show HEAD"), true, "show ok");
		assert.equal(isReadOnlyBash("git log --oneline -5"), true, "log ok");
		assert.equal(isReadOnlyBash("sed -n 'w output.txt' input.txt"), false, "sed w command");
		assert.equal(isReadOnlyBash("sed 'w /tmp/out' input"), false, "sed w path");
		assert.equal(isReadOnlyBash("sed -n -e \"w output.txt\" input.txt"), false, "sed -e w");
		assert.equal(isReadOnlyBash("sed -n '1w output.txt' input.txt"), false, "sed addr w");
		assert.equal(isReadOnlyBash("sed 's/a/b/w output.txt' input.txt"), false, "sed s///w");
		assert.equal(isReadOnlyBash("sed -n 'p' input.txt"), false, "sed no-w blocked");
		assert.equal(isReadOnlyBash("sed -n '1,10p' input.txt"), false, "sed print blocked");
		assert.equal(isReadOnlyBash("find . -fprint output.txt"), false, "find fprint");
		assert.equal(isReadOnlyBash("find . -fls output.txt"), false, "find fls");
		assert.equal(isReadOnlyBash("find . -fprintf output.txt '%p'"), false, "find fprintf");
		assert.equal(isReadOnlyBash("find . -name '*.ts'"), true, "find ok");
		// Package managers can execute repository-controlled lifecycle scripts.
		for (const command of ["npm test", "npm pack --dry-run", "npm audit", "yarn test", "pnpm test"]) {
			assert.equal(isReadOnlyBash(command), false, `${command} blocked`);
		}
	});

	// All git diff variants are read-only (--output already blocked above)
	assert.equal(isReadOnlyBash("git diff --name-status @{u}"), true, "diff name-status");
	assert.equal(isReadOnlyBash("git diff --stat @{u}"), true, "diff stat");
	assert.equal(isReadOnlyBash("git diff --name-only HEAD~5..HEAD"), true, "diff name-only range");
	assert.equal(isReadOnlyBash("git diff --cached --name-status"), true, "diff cached name-status");
	assert.equal(isReadOnlyBash("git diff --diff-filter=M --name-only"), true, "diff filter");
	assert.equal(isReadOnlyBash("git diff --no-index a b"), true, "diff no-index");
	// Multiline attempts are rejected
	assert.equal(isReadOnlyBash("git diff\nrm -rf ."), false, "multiline diff newline");
	assert.equal(isReadOnlyBash("git diff\r\nrm -rf ."), false, "multiline diff crlf");
	assert.equal(isReadOnlyBash("rtk git diff --stat\r\ngit reset --hard"), false, "rtk multiline");

	it("resolves git range for branch and custom presets", () => {
		assert.equal(resolveGitRange("branch", ""), "@{upstream}...HEAD");
		assert.equal(resolveGitRange("default", ""), "@{upstream}...HEAD");
		assert.equal(resolveGitRange("custom", "main...feature"), "main...feature");
		assert.equal(resolveGitRange("uncommitted", ""), undefined);
		assert.equal(resolveGitRange("custom", "auth bug"), undefined);
	});
	it("treats malformed reviewer output as blocking", () => assert.equal(parseReviewResult("not json").findings[0].blocking, true));
});

describe("review lifecycle", () => {
	it("uses isolated review when available without changing parent tools", async () => {
		const h = harness(true);
		await h.commands.review.handler("changes", h.ctx);
		await flush();
		assert.equal(h.messages.length, 0, "no sendMessage calls");
		assert.equal(h.sent.length, 1, "result via sendUserMessage");
		assert.equal(h.sent[0].content.startsWith("No findings"), true);
		assert.deepEqual(h.tools(), ["read", "edit", "ffgrep", "serena_find_symbol"]);
	});

	it("falls back locally, composes one-turn prompt, and restores once on agent_settled", async () => {
		const h = harness(false);
		await h.commands.review.handler("changes", h.ctx);
		await flush();
		assert.equal(h.messages.length, 0, "no sendMessage calls");
		assert.equal(h.sent.length, 1, "one user message triggered by fallback");
		assert.deepEqual(h.tools(), ["read", "ffgrep", "serena_find_symbol", "bash", "grep", "find", "ls"]);
		const prompt = await h.handlers.before_agent_start[0]({ systemPrompt: "BASE" }, h.ctx);
		assert.equal(prompt.systemPrompt.startsWith("BASE"), true);
		assert.equal("message" in prompt, false);
		await h.handlers.agent_settled[0]({}, h.ctx);
		await h.handlers.agent_settled[0]({}, h.ctx);
		assert.deepEqual(h.tools(), ["read", "edit", "ffgrep", "serena_find_symbol"]);
		assert.equal(h.thinking(), "medium");
	});
});
