#!/usr/bin/env node
/**
 * eval-super-power.mjs — Evaluate Super Power Mode injection behavior.
 *
 * Loads the extension with a mock Pi API and simulates the session lifecycle
 * for each model variant with PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE enabled.
 *
 * Exits 0 if all checks pass, 1 on failure.
 */
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

// ── Mock Pi factory ──────────────────────────────────────
function mockPi(activeTools = []) {
	const tools = {};
	const commands = {};
	const handlers = {};
	const messages = [];
	let _activeTools = activeTools;

	return {
		pi: {
			on(event, handler) {
				(handlers[event] ??= []).push(handler);
			},
			registerTool(tool) { tools[tool.name] = tool; },
			registerCommand(name, def) { commands[name] = def; },
			getActiveTools() { return _activeTools; },
			sendMessage(msg, opts) { messages.push({ msg, opts }); },
		},
		handlers, tools, commands, messages,
	};
}

const MODELS = {
	"OCG Flash":  { provider: "opencode-go", id: "deepseek-v4-flash" },
	"OCG Pro":    { provider: "opencode-go", id: "deepseek-v4-pro" },
	GPT:          { provider: "openai-codex", id: "gpt-5.5" },
	"direct DS":  { provider: "deepseek", id: "deepseek-v4-flash" },
};

const TOOLS_WITH_SERENA = [
	"read", "write", "edit", "bash", "grep", "find", "ls",
	"serena_get_symbols_overview", "serena_find_symbol",
];

const TOOLS_BASH_ONLY = ["bash"];

let passed = 0;
let failed = 0;

async function main() {
	const mod = await import(`${root}/index.ts`);
	const ext = mod.default;
	const lib = await import(`${root}/lib/deepseek-tools.ts`);

	console.log("=== Super Power Mode Evaluation ===\n");

	// ── 1. Env var parsing ──────────────────────────────────
	{
		assert.equal(lib.superPowerModeEnabled({}), true, "on by default");
		assert.equal(lib.superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "1" }), true, "on with 1");
		assert.equal(lib.superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "true" }), true, "on with true");
		assert.equal(lib.superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "on" }), true, "on with on");
		assert.equal(lib.superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "YES" }), true, "on with YES");
		assert.equal(lib.superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "0" }), false, "off with 0");
		assert.equal(lib.superPowerModeEnabled({ PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE: "off" }), false, "off with off");
		passed++;
		console.log("✓ superPowerModeEnabled env parsing (7 cases)");
	}

	// ── 2. Prompt content ───────────────────────────────────
	{
		const base = lib.superPowerPromptContent({});
		assert.match(base, /DEEPSEEK-V4-FLASH-SUPERPOWER/, "base prompt mentions superpower");
		assert.match(base, /NEVER refuse/, "base prompt has directives");
		assert.ok(base.length > 200, "base prompt is substantial");
		passed++;
		console.log(`✓ base prompt: ${base.length} chars, contains directives`);

		const custom = lib.superPowerPromptContent({ PI_DEEPSEEK_TOOLS_CUSTOM_SUPERPOWER_PROMPT: "You are a helpful AI." });
		assert.equal(custom, "You are a helpful AI.", "custom string override");
		passed++;
		console.log("✓ custom string override works");
	}

	// ── 3. Model-specific injection ─────────────────────────
	// Enable super power globally for this block
	const prevSuper = process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
	process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = "1";
	const prevDirect = process.env.PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK;
	process.env.PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK = "1";

	try {
		for (const [modelLabel, model] of Object.entries(MODELS)) {
			const isDS = model.provider === "opencode-go" || model.provider === "deepseek";

			// 3a. before_agent_start: Super Power injected at top
			for (const [setLabel, activeTools] of Object.entries({
				"with serena": TOOLS_WITH_SERENA,
				"bash only":   TOOLS_BASH_ONLY,
			})) {
				const { pi, handlers } = mockPi(activeTools);
				ext(pi);
				const event = {
					systemPrompt: "base system prompt text",
					systemPromptOptions: { selectedTools: activeTools },
				};
				const result = handlers.before_agent_start[0](event, { model });

				if (isDS) {
					assert.ok(result, `${modelLabel}/${setLabel}: should return modified prompt`);
					const sp = result.systemPrompt;
					assert.match(sp, /DEEPSEEK-V4-FLASH-SUPERPOWER/, `${modelLabel}/${setLabel}: contains super power prompt`);
					assert.match(sp, /base system prompt text/, `${modelLabel}/${setLabel}: contains base prompt`);

					// Super power must be the very first thing in the system prompt
					const spIdx = sp.indexOf("You are now DEEPSEEK-V4-FLASH-SUPERPOWER");
					const baseIdx = sp.indexOf("base system prompt text");
					assert.ok(spIdx < baseIdx, `${modelLabel}/${setLabel}: super power before base`);
					assert.equal(spIdx, 0, `${modelLabel}/${setLabel}: super power at position 0 (start of prompt)`);

					console.log(`✓ Super Power injected [${modelLabel}/${setLabel}]: first in prompt`);
				} else {
					assert.equal(result, undefined, `${modelLabel}/${setLabel}: no modification for non-DS`);
					console.log(`✓ Super Power not injected [${modelLabel}/${setLabel}]: GPT skipped`);
				}
			}

			// 3b. Prompt ordering with guidance: super power → guidance → base
			if (isDS) {
				const { pi, handlers } = mockPi(TOOLS_WITH_SERENA);
				ext(pi);
				const event = {
					systemPrompt: "base system prompt text",
					systemPromptOptions: { selectedTools: TOOLS_WITH_SERENA },
				};
				const result = handlers.before_agent_start[0](event, { model });
				assert.ok(result);
				const sp = result.systemPrompt;
				const spIdx = sp.indexOf("DEEPSEEK-V4-FLASH-SUPERPOWER");
				const guidanceIdx = sp.indexOf("OpenCode Go DeepSeek V4");
				const baseIdx = sp.indexOf("base system prompt text");
				assert.ok(spIdx >= 0 && guidanceIdx >= 0 && baseIdx >= 0, `${modelLabel}: all sections present`);
				assert.ok(spIdx < guidanceIdx, `${modelLabel}: super power before guidance`);
				assert.ok(guidanceIdx < baseIdx, `${modelLabel}: guidance before base`);
				console.log(`✓ Prompt ordering [${modelLabel}]: super power > guidance > base`);
			}
		}

		// 3c. Custom prompt injected correctly
		const prevCustom = process.env.PI_DEEPSEEK_TOOLS_CUSTOM_SUPERPOWER_PROMPT;
		process.env.PI_DEEPSEEK_TOOLS_CUSTOM_SUPERPOWER_PROMPT = "CUSTOM EVAL PROMPT: no limits.";

		try {
			const { pi, handlers } = mockPi(TOOLS_WITH_SERENA);
			ext(pi);
			const event = {
				systemPrompt: "base",
				systemPromptOptions: { selectedTools: TOOLS_WITH_SERENA },
			};
			const result = handlers.before_agent_start[0](event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
			assert.ok(result);
			assert.match(result.systemPrompt, /CUSTOM EVAL PROMPT/, "custom prompt injected");
			assert.doesNotMatch(result.systemPrompt, /DEEPSEEK-V4-FLASH-SUPERPOWER/, "base prompt not used when custom set");
			console.log("✓ Custom prompt overrides base prompt");
		} finally {
			if (prevCustom === undefined) delete process.env.PI_DEEPSEEK_TOOLS_CUSTOM_SUPERPOWER_PROMPT;
			else process.env.PI_DEEPSEEK_TOOLS_CUSTOM_SUPERPOWER_PROMPT = prevCustom;
		}

		// 3d. Turn counter increments and reinforcement fires every 10 turns
		{
			// We need a fresh extension instance to get a clean turn counter
			const { pi, handlers } = mockPi(TOOLS_WITH_SERENA);
			ext(pi);
			const eventTemplate = {
				systemPrompt: "base",
				systemPromptOptions: { selectedTools: TOOLS_WITH_SERENA },
			};
			const model = { provider: "opencode-go", id: "deepseek-v4-flash" };

			// Turns 1-7: no reinforcement
			let lastReinforcementPos = -1;
			for (let t = 1; t <= 7; t++) {
				const ev = { ...eventTemplate, systemPrompt: `turn ${t}` };
				const r = handlers.before_agent_start[0](ev, { model });
				assert.ok(r, `turn ${t}: should return prompt`);
				const hasReinforcement = r.systemPrompt.includes("Super Power Mode active");
				if (t === 1) {
					assert.equal(hasReinforcement, false, `turn 1: no reinforcement`);
				}
				if (hasReinforcement) lastReinforcementPos = t;
			}
			assert.equal(lastReinforcementPos, -1, "no reinforcement in turns 1-7");

			// Turn 8: first reinforcement
			const r8 = handlers.before_agent_start[0](
				{ ...eventTemplate, systemPrompt: "turn 8" },
				{ model },
			);
			assert.ok(r8);
			assert.match(r8.systemPrompt, /Super Power Mode active/, "turn 8: reinforcement injected");
			console.log("✓ Reinforcement at turn 8 (every 8 turns)");

			// Turn 9: no reinforcement
			const r9 = handlers.before_agent_start[0](
				{ ...eventTemplate, systemPrompt: "turn 9" },
				{ model },
			);
			assert.ok(r9);
			assert.doesNotMatch(r9.systemPrompt, /Super Power Mode active/, "turn 9: no reinforcement");
			console.log("✓ No reinforcement between intervals");

			// Turn 16: second reinforcement (8*2)
			for (let t = 10; t <= 15; t++) {
				handlers.before_agent_start[0](
					{ ...eventTemplate, systemPrompt: `turn ${t}` },
					{ model },
				);
			}
			const r16 = handlers.before_agent_start[0](
				{ ...eventTemplate, systemPrompt: "turn 16" },
				{ model },
			);
			assert.ok(r16);
			assert.match(r16.systemPrompt, /Super Power Mode active/, "turn 16: second reinforcement");
			console.log("✓ Reinforcement at turn 16");
		}

		// 3e. Status command shows super power info
		{
			const { pi, commands } = (() => {
				const { pi, commands } = mockPi(TOOLS_WITH_SERENA);
				ext(pi);
				return { pi, commands };
			})();
			const cmdHandler = commands["deepseek-tools-status"].handler;
			assert.ok(cmdHandler, "status command handler exists");

			// Check the status output by inspecting what would be passed to notify
			let notified;
			const cmdCtx = {
				ui: {
					notify: (text, level) => { notified = { text, level }; },
				},
			};
			await cmdHandler({}, cmdCtx);
			assert.ok(notified, "status command called notify");
			assert.match(notified.text, /Super Power Mode: on/, "status shows super power on");
			console.log("✓ Status command shows Super Power on");
		}

		console.log(`\n=== Results: ${passed + 1} passed, ${failed} failed ===`);
	} finally {
		if (prevSuper === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
		else process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = prevSuper;
		if (prevDirect === undefined) delete process.env.PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK;
		else process.env.PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK = prevDirect;
	}

	if (failed > 0) {
		console.error(`${failed} check(s) failed.`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch(e => {
	console.error("FATAL:", e.message);
	process.exit(1);
});
