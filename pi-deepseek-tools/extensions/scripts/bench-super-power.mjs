#!/usr/bin/env node
/**
 * bench-super-power.mjs — Compare system prompts with Super Power ON vs OFF.
 * Measures: prompt length, injection, reinforcement, structural overhead.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

function mockPi(activeTools = []) {
	const tools = {};
	const commands = {};
	const handlers = {};
	const messages = [];
	let _activeTools = activeTools;

	return {
		pi: {
			on(event, handler) { (handlers[event] ??= []).push(handler); },
			registerTool(tool) { tools[tool.name] = tool; },
			registerCommand(name, def) { commands[name] = def; },
			getActiveTools() { return _activeTools; },
			sendMessage(msg, opts) { messages.push({ msg, opts }); },
		},
		handlers, tools, commands, messages,
	};
}

async function main() {
	const mod = await import(`${root}/index.ts`);
	const ext = mod.default;

	const TOOLS = ["read", "bash", "serena_find_symbol"];
	const BASE_PROMPT = "You are a helpful assistant. Answer concisely.";
	const MODEL = { provider: "opencode-go", id: "deepseek-v4-flash" };
	const EVENT = {
		systemPrompt: BASE_PROMPT,
		systemPromptOptions: { selectedTools: TOOLS },
	};

	console.log("=== Super Power Mode: ON vs OFF Comparison ===\n");

	const prevSuper = process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;

	// ── Test 1: Default (ON) ────────────────────────────────
	delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
	try {
		const mOn = mockPi(TOOLS);
		ext(mOn.pi);

		const beforeStart = mOn.handlers.before_agent_start[0];

		// Turn 1: first injection
		const r1 = beforeStart(EVENT, { model: MODEL });
		const sys1 = r1.systemPrompt;

		const sections1 = sys1.split("\n\n---\n\n");
		console.log("── Default (ON) ──");
		console.log("  Turn 1 length: " + sys1.length + " chars, " + sections1.length + " sections");
		sections1.forEach((s, i) => {
			const label = s.startsWith("You are now DEEPSEEK") ? "SUPER POWER"
				: s.startsWith("OpenCode Go") ? "GUIDANCE"
				: s.startsWith(BASE_PROMPT) ? "BASE"
				: s.includes("Note:") ? "ERROR HINT"
				: "?";
			console.log("    [" + i + "] " + label + ": " + s.length + " chars");
		});

		// Turn 8: reinforcement fires (counter 8, 8%8===0)
		// Currently counter=1. Need 7 more calls to reach counter=8.
		let r;
		for (let t = 2; t <= 8; t++) {
			r = beforeStart(EVENT, { model: MODEL });
		}
		// r = result of call where counter became 8
		console.log("  Turn 8 (reinf interval): " + r.systemPrompt.includes("Super Power Mode active") + " (expect true)");

		// Turn 9: no reinforcement (counter 9, 9%8!==0)
		r = beforeStart(EVENT, { model: MODEL });
		console.log("  Turn 9 (no interval): " + r.systemPrompt.includes("Super Power Mode active") + " (expect false)");

		// Advance through 10-16 (counter goes 10..16)
		for (let t = 10; t <= 16; t++) {
			r = beforeStart(EVENT, { model: MODEL });
		}
		// r = result of call where counter became 16
		console.log("  Turn 16 (2nd reinf interval): " + r.systemPrompt.includes("Super Power Mode active") + " (expect true)");

		// Turn 17: no reinforcement
		r = beforeStart(EVENT, { model: MODEL });
		console.log("  Turn 17 (no interval): " + r.systemPrompt.includes("Super Power Mode active") + " (expect false)");

	} finally {
		delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
		if (prevSuper !== undefined) process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = prevSuper;
	}

	// ── Test 2: Disabled (OFF) ──────────────────────────────
	process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = "0";
	try {
		const mOff = mockPi(TOOLS);
		ext(mOff.pi);

		const beforeStart = mOff.handlers.before_agent_start[0];
		const r1 = beforeStart(EVENT, { model: MODEL });
		const sys1 = r1.systemPrompt;

		const sections1 = sys1.split("\n\n---\n\n");
		console.log("\n── Disabled (OFF) ──");
		console.log("  Turn 1 length: " + sys1.length + " chars, " + sections1.length + " sections");
		sections1.forEach((s, i) => {
			const label = s.startsWith("You are now DEEPSEEK") ? "SUPER POWER"
				: s.startsWith("OpenCode Go") ? "GUIDANCE"
				: s.startsWith(BASE_PROMPT) ? "BASE"
				: "?";
			console.log("    [" + i + "] " + label + ": " + s.length + " chars");
		});

		// Advance many turns — no reinforcement ever
		for (let t = 2; t <= 30; t++) {
			beforeStart(EVENT, { model: MODEL });
		}
		const r30 = beforeStart(EVENT, { model: MODEL });
		console.log("  Turn 31: Super Power ever: " + r30.systemPrompt.includes("DEEPSEEK"));
		console.log("  Turn 31: Reinforcement ever: " + r30.systemPrompt.includes("Super Power Mode active"));
	} finally {
		delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
		if (prevSuper !== undefined) process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = prevSuper;
	}

	// ── Summary ─────────────────────────────────────────────
	console.log("\n── Summary ──");
	console.log("  Feature                  | ON (default)       | OFF (PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE=0)");
	console.log("  ─────────────────────────|────────────────────|───────────────────────────────────────────");
	console.log("  Super Power prompt       | injected at top    | not injected");
	console.log("  Prompt overhead          | ~1,400 extra chars | 0 extra");
	console.log("  Reinforcement/8 turns    | +1 line            | none");
	console.log("  Guidance (tool rules)    | always present     | always present");
	console.log("  Content restrictions     | removed            | preserved");
	console.log("  Refusal capability       | disabled           | normal");
	console.log("");
	console.log("  To disable:  export PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE=0");
	console.log("  Custom prompt: export PI_DEEPSEEK_TOOLS_CUSTOM_SUPERPOWER_PROMPT=\"...\"");

	process.exit(0);
}

main().catch(e => {
	console.error("FATAL:", e.message);
	process.exit(1);
});
