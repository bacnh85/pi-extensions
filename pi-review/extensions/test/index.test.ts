import assert from "node:assert/strict";
import { describe, it } from "mocha";
import piReviewExtension, { isReadOnlyBash, parseReviewArgs, parseReviewResult, resolveGitRange } from "../index.ts";

/** Flush pending microtasks and async I/O so review promise chain settles. */
async function flush(): Promise<void> {
	await new Promise((r) => setTimeout(r, 20));
}

const ACTIONABLE_REVIEW = JSON.stringify({
	summary: "one confirmed issue",
	findings: [{
		severity: "high", file: "src/auth.ts", line: 42, issue: "Expired sessions remain valid.",
		evidence: "The expiry branch returns the session at src/auth.ts:42.",
		expectedBehavior: "Expired sessions are rejected.", suggestedFix: "Return null from the expiry branch.",
		acceptanceCriteria: "The expired-session regression test passes.", blocking: true,
	}],
});

function harness(subagent = false, reviewOutput = '{"summary":"clean","findings":[]}', reviewEventResult?: unknown, subagentError?: string, abortError?: string) {
	const handlers: Record<string, Function[]> = {};
	const commands: Record<string, any> = {};
	const sent: any[] = [];
	const messages: any[] = [];
	const subagentRequests: any[] = [];
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
				if (name === "pi-review:run" && reviewEventResult !== undefined && value.accept()) value.respond({ id: value.id, ok: true, result: reviewEventResult });
				if (name === "pi-subagent:run") subagentRequests.push(value);
				if (subagent && name === "pi-subagent:run") {
					value.accept();
					if (abortError) value.signal.addEventListener("abort", () => value.respond({ id: value.id, ok: false, error: abortError }), { once: true });
					else value.respond(subagentError
						? { id: value.id, ok: false, error: subagentError }
						: { id: value.id, ok: true, result: { messages: [{ role: "assistant", content: [{ type: "text", text: reviewOutput }] }] } });
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
	return {
		handlers, commands, sent, messages, subagentRequests, ctx,
		emit: (name: string, value: any) => pi.events.emit(name, value),
		tools: () => activeTools,
		thinking: () => thinking,
	};
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
		assert.equal(isReadOnlyBash("awk -i inplace '1' tracked.txt"), false, "awk inplace");
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

	it('allows read-only git diff variants and rejects multiline commands', () => {
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
	});

	it("resolves git range for branch and custom presets", () => {
		assert.equal(resolveGitRange("branch", ""), "@{upstream}...HEAD");
		assert.equal(resolveGitRange("default", ""), "@{upstream}...HEAD");
		assert.equal(resolveGitRange("custom", "main...feature"), "main...feature");
		assert.equal(resolveGitRange("uncommitted", ""), undefined);
		assert.equal(resolveGitRange("custom", "auth bug"), undefined);
	});
	it("requires the actionable finding contract", () => {
		assert.equal(parseReviewResult(ACTIONABLE_REVIEW).findings[0].expectedBehavior, "Expired sessions are rejected.");
		for (const field of ["file", "issue", "evidence", "expectedBehavior", "suggestedFix", "acceptanceCriteria"]) {
			const incomplete = JSON.parse(ACTIONABLE_REVIEW);
			incomplete.findings[0][field] = " ";
			assert.equal(parseReviewResult(JSON.stringify(incomplete)).summary, "Reviewer returned malformed structured output", field);
		}
		for (const line of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const invalid = JSON.parse(ACTIONABLE_REVIEW);
			invalid.findings[0].line = line;
			assert.equal(parseReviewResult(JSON.stringify(invalid)).summary, "Reviewer returned malformed structured output", String(line));
		}
		assert.equal(parseReviewResult("").findings[0].evidence, "Reviewer returned no textual output.");
		assert.equal(parseReviewResult("").findings[0].line, 1);
		assert.equal(parseReviewResult('{"summary":"   ","findings":[]}').summary, "Reviewer returned malformed structured output");
		assert.match(parseReviewResult(`${" ".repeat(1000)}not json`).findings[0].evidence, /not json/);
	});
	it("treats malformed reviewer output as blocking", () => assert.equal(parseReviewResult("not json").findings[0].blocking, true));
});

describe("review lifecycle", () => {
	it("forwards review event timeouts to the isolated subagent", async () => {
		const h = harness(true);
		let response: any;
		h.emit("pi-review:run", {
			id: "review-1",
			cwd: process.cwd(),
			prompt: "Review this change",
			timeout: 600_000,
			accept: () => true,
			respond: (value: any) => { response = value; },
		});
		await flush();
		assert.equal(h.subagentRequests.length, 1);
		assert.equal(h.subagentRequests[0].timeout, 600_000);
		assert.equal(response?.ok, true);
	});

	it("preserves isolated reviewer failure reasons", async () => {
		const h = harness(true, undefined, undefined, "Idle timeout after 180000ms");
		let response: any;
		h.emit("pi-review:run", { id: "review-error", cwd: process.cwd(), prompt: "Review this change", accept: () => true, respond: (value: any) => { response = value; } });
		await flush();
		assert.equal(h.subagentRequests.length, 1);
		assert.equal(response?.ok, false);
		assert.equal(response?.error, "Idle timeout after 180000ms");
	});

	it("keeps the idle-timeout reason when abort synchronously responds", async () => {
		const h = harness(true, undefined, undefined, undefined, "Sub-agent aborted");
		let response: any;
		h.emit("pi-review:run", { id: "review-timeout", cwd: process.cwd(), prompt: "Review this change", timeout: 25, accept: () => true, respond: (value: any) => { response = value; } });
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(response?.ok, false);
		assert.equal(response?.error, "Reviewer idle timeout");
	});

	it("uses isolated review when available without changing parent tools", async () => {
		const h = harness(true);
		await h.commands.review.handler("changes", h.ctx);
		await flush();
		assert.equal(h.messages.length, 0, "no sendMessage calls");
		assert.equal(h.sent.length, 1, "result via sendUserMessage");
		assert.equal(h.sent[0].content.startsWith("No findings"), true);
		assert.deepEqual(h.tools(), ["read", "edit", "ffgrep", "serena_find_symbol"]);
	});

	it("formats actionable findings for the parent", async () => {
		const h = harness(true, ACTIONABLE_REVIEW);
		await h.commands.review.handler("changes", h.ctx);
		await flush();
		assert.match(h.sent[0].content, /high · blocking/);
		assert.match(h.sent[0].content, /Expected: Expired sessions are rejected\./);
		assert.match(h.sent[0].content, /Acceptance: The expired-session regression test passes\./);
	});

	it("shows non-blocking status and fails closed on invalid review-event results", async () => {
		const nonBlocking = JSON.parse(ACTIONABLE_REVIEW);
		nonBlocking.findings[0].blocking = false;
		const formatted = harness(true, JSON.stringify(nonBlocking));
		await formatted.commands.review.handler("changes", formatted.ctx);
		await flush();
		assert.match(formatted.sent[0].content, /high · non-blocking/);

		const malformed = harness(false, undefined, { summary: " ", findings: [] });
		await malformed.commands.review.handler("changes", malformed.ctx);
		await flush();
		assert.match(malformed.sent[0].content, /The independent review result could not be parsed/);
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
