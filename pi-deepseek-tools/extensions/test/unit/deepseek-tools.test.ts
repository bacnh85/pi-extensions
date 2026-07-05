import assert from "node:assert/strict";
import { describe, it } from "mocha";
import extension, {
	deepSeekSelectionGuidance,
	isOpenCodeGoDeepSeekV4FlashModel,
	isSemanticMissToolCall,
	missedDedicatedTool,
	selectionGuidanceEnabled,
	strictSerenaEnabled,
} from "../../index";
import {
	dedicatedToolForShellCommand,
	isDeepSeekV4Model,
	isOpenCodeGoDeepSeekV4Model,
	looksLikeDocsOrConfigPath,
	OPENCODE_GO_PROVIDER,
	DEEPSEEK_V4_FLASH_MODEL,
} from "../../lib/deepseek-tools";

function createFakePi(activeTools: string[]) {
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const messages: Array<{ message: unknown; options: unknown }> = [];
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
	} as any;

	extension(pi);
	return { handlers, messages };
}

describe("OpenCode Go DeepSeek V4 Flash model detection", () => {
	it("recognizes only OpenCode Go DeepSeek V4 Flash", () => {
		assert.equal(isOpenCodeGoDeepSeekV4FlashModel({ provider: OPENCODE_GO_PROVIDER, id: DEEPSEEK_V4_FLASH_MODEL }), true);
		assert.equal(isOpenCodeGoDeepSeekV4FlashModel({ provider: "opencode-go", id: "deepseek-v4-pro" }), false);
		assert.equal(isOpenCodeGoDeepSeekV4FlashModel({ provider: "deepseek", id: "deepseek-v4-flash" }), false);
		assert.equal(isOpenCodeGoDeepSeekV4FlashModel({ provider: "deepseek", id: "deepseek-v4-pro" }), false);
		assert.equal(isOpenCodeGoDeepSeekV4FlashModel({ provider: "openai-codex", id: "gpt-5.5" }), false);
	});

	it("keeps deprecated broad helpers Flash-only", () => {
		assert.equal(isDeepSeekV4Model("opencode-go", "deepseek-v4-flash"), true);
		assert.equal(isDeepSeekV4Model("opencode-go", "deepseek-v4-pro"), false);
		assert.equal(isDeepSeekV4Model("deepseek", "deepseek-v4-flash"), false);
		assert.equal(isOpenCodeGoDeepSeekV4Model({ provider: "opencode-go", id: "deepseek-v4-flash" }), true);
		assert.equal(isOpenCodeGoDeepSeekV4Model({ provider: "opencode-go", id: "deepseek-v4-pro" }), false);
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
});

describe("deepSeekSelectionGuidance", () => {
	it("uses Flash-only procedural wording with explicit Serena rules", () => {
		const guidance = deepSeekSelectionGuidance(["read", "bash", "serena_find_symbol", "serena_find_referencing_symbols"]);

		assert.match(guidance, /OpenCode Go DeepSeek V4 Flash tool-selection rules for Pi/);
		assert.match(guidance, /never invent tool names such as read_file/);
		assert.match(guidance, /first use Serena/);
		assert.match(guidance, /serena_find_referencing_symbols before public behavior changes or renames/);
	});

	it("includes dedicated file-tool rules when file tools are active", () => {
		const guidance = deepSeekSelectionGuidance(["ls", "grep", "find", "bash"]);

		assert.match(guidance, /use ls, find, grep, or read rather than shelling out/i);
		assert.match(guidance, /Use bash only for real commands/);
	});
});

describe("semantic miss detection", () => {
	it("flags reads of code files", () => {
		assert.equal(isSemanticMissToolCall("read", { path: "pi-deepseek-tools/extensions/index.ts" }), true);
		assert.equal(isSemanticMissToolCall("read", { path: "src/app.py?x=1" }), true);
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
		const active = ["bash", "ls", "find", "grep", "read"];
		assert.equal(dedicatedToolForShellCommand("ls pi-deepseek-tools", active), "ls");
		assert.equal(dedicatedToolForShellCommand("find pi-deepseek-tools -name '*.ts'", active), "find");
		assert.equal(dedicatedToolForShellCommand("grep -R PI_DEEPSEEK README.md", active), "grep");
		assert.equal(dedicatedToolForShellCommand("cat README.md", active), "read");
		assert.equal(dedicatedToolForShellCommand("sed -n '1,20p' README.md", active), "read");
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

describe("extension runtime scoping", () => {
	const activeTools = ["read", "bash", "grep", "find", "ls", "serena_get_symbols_overview", "serena_find_symbol"];

	it("injects guidance only for opencode-go DeepSeek V4 Flash", () => {
		const previous = process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
		delete process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
		try {
			const { handlers } = createFakePi(activeTools);
			const beforeAgentStart = handlers.before_agent_start[0];
			const event = { systemPrompt: "base", systemPromptOptions: { selectedTools: activeTools } };

			const flash = beforeAgentStart(event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
			assert.match(flash.systemPrompt, /OpenCode Go DeepSeek V4 Flash/);

			const pro = beforeAgentStart(event, { model: { provider: "opencode-go", id: "deepseek-v4-pro" } });
			assert.equal(pro, undefined);

			const direct = beforeAgentStart(event, { model: { provider: "deepseek", id: "deepseek-v4-flash" } });
			assert.equal(direct, undefined);

			const gpt = beforeAgentStart(event, { model: { provider: "openai-codex", id: "gpt-5.5" } });
			assert.equal(gpt, undefined);
		} finally {
			if (previous === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
			else process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE = previous;
		}
	});

	it("sends reminders only for opencode-go DeepSeek V4 Flash", () => {
		const { handlers, messages } = createFakePi(activeTools);
		const toolCall = handlers.tool_call[0];
		const event = { toolName: "read", input: { path: "pi-deepseek-tools/extensions/index.ts" } };

		toolCall(event, { model: { provider: "opencode-go", id: "deepseek-v4-pro" } });
		assert.equal(messages.length, 0);

		toolCall(event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
		assert.equal(messages.length, 1);
		assert.match(String((messages[0].message as any).content), /DeepSeek V4 Flash/);
		assert.deepEqual(messages[0].options, { deliverAs: "steer" });
		assert.equal((messages[0].options as any).triggerTurn, undefined);
	});

	it("blocks only Flash scoped misses when strict mode is enabled", () => {
		const previous = process.env.PI_DEEPSEEK_TOOLS_STRICT_SERENA;
		process.env.PI_DEEPSEEK_TOOLS_STRICT_SERENA = "1";
		try {
			const { handlers } = createFakePi(activeTools);
			const toolCall = handlers.tool_call[0];
			const event = { toolName: "bash", input: { command: "ls pi-deepseek-tools" } };

			assert.equal(toolCall(event, { model: { provider: "opencode-go", id: "deepseek-v4-pro" } }), undefined);
			const blocked = toolCall(event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
			assert.equal(blocked.block, true);
			assert.match(blocked.reason, /dedicated ls tool/);
		} finally {
			if (previous === undefined) delete process.env.PI_DEEPSEEK_TOOLS_STRICT_SERENA;
			else process.env.PI_DEEPSEEK_TOOLS_STRICT_SERENA = previous;
		}
	});
});
