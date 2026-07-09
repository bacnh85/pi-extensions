#!/usr/bin/env node
/**
 * eval-serena-tools.mjs — Verify Serena tool improvements:
 * 1. Block message prescribes exact Serena tools
 * 2. bash cat/sed/head on code files blocked
 * 3. One-shot Serena suggestion on first block
 * 4. serena_read_file tool registered
 */
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

function mockPi(activeTools = []) {
	const handlers = {};
	const messages = [];
	const commands = {};
	const tools = {};
	return {
		pi: {
			on(e, h) { (handlers[e] ??= []).push(h); },
			registerTool(t) { tools[t.name] = t; },
			registerCommand(n, d) { commands[n] = d; },
			getActiveTools() { return activeTools; },
			sendMessage(msg, opts) { messages.push({ msg, opts }); },
		},
		handlers, tools, commands, messages,
	};
}

async function main() {
	const mod = await import(`${root}/index.ts`);
	const ext = mod.default;
	const lib = await import(`${root}/lib/deepseek-tools.ts`);

	console.log("=== Serena Tool Fixes: Live Verification ===\n");

	let passed = 0;
	let total = 0;

	function check(label, fn) {
		total++;
		try { fn(); passed++; console.log(`  ✓ ${label}`); }
		catch (e) { console.log(`  ✗ ${label}: ${e.message}`); }
	}

	// ── Item 1: Block message prescribes exact Serena tools ──
	{
		const { pi, handlers, messages } = mockPi(["read", "serena_find_symbol"]);
		ext(pi);
		handlers.session_start[0]({}, { cwd: process.cwd() });

		const result = handlers.tool_call[0](
			{ toolName: "read", input: { path: "src/index.ts" } },
			{ model: { provider: "opencode-go", id: "deepseek-v4-flash" } },
		);

		check("block message includes serena_get_symbols_overview", () => {
			assert.ok(result?.block, "should block");
			assert.match(result.reason, /serena_get_symbols_overview/, "should name exact tool");
			assert.match(result.reason, /serena_find_symbol/, "should name second tool");
		});

		check("one-shot Serena suggestion sent on first block", () => {
			assert.equal(messages.length, 1, "one message sent");
			assert.match(messages[0].msg.content, /serena_get_symbols_overview/, "lists overview tool");
			assert.match(messages[0].msg.content, /serena_find_symbol/, "lists find tool");
			assert.match(messages[0].msg.content, /serena_find_referencing_symbols/, "lists referencing tool");
		});
	}

	// ── Item 1b: Second block does NOT send another suggestion ──
	{
		const { pi, handlers, messages } = mockPi(["read", "serena_find_symbol"]);
		ext(pi);
		handlers.session_start[0]({}, { cwd: process.cwd() });

		// First block — suggestion sent
		handlers.tool_call[0](
			{ toolName: "read", input: { path: "src/index.ts" } },
			{ model: { provider: "opencode-go", id: "deepseek-v4-flash" } },
		);
		// Second block — no suggestion (one-shot)
		handlers.tool_call[0](
			{ toolName: "read", input: { path: "src/app.ts" } },
			{ model: { provider: "opencode-go", id: "deepseek-v4-flash" } },
		);

		check("only one suggestion sent across multiple blocks", () => {
			assert.equal(messages.length, 1, "still only one message");
		});
	}

	// ── Item 2: bash cat/head/tail on code files flagged as semantic miss ──
	{
		check("bash cat on .ts file is semantic miss", () => {
			assert.equal(lib.isSemanticMissToolCall("bash", { command: "cat index.ts" }), true);
		});
		check("bash cat on .go file is semantic miss", () => {
			assert.equal(lib.isSemanticMissToolCall("bash", { command: "cat main.go" }), true);
		});
		check("bash head on .py file is semantic miss", () => {
			assert.equal(lib.isSemanticMissToolCall("bash", { command: "head -n 20 app.py" }), true);
		});
		check("bash tail on code file is semantic miss", () => {
			assert.equal(lib.isSemanticMissToolCall("bash", { command: "tail -50 src/lib.rs" }), true);
		});
		check("bash sed -n on code file is semantic miss", () => {
			assert.equal(lib.isSemanticMissToolCall("bash", { command: "sed -n '1,20p' main.ts" }), true);
		});
		check("bash cat on README is NOT a miss (docs bypass)", () => {
			assert.equal(lib.isSemanticMissToolCall("bash", { command: "cat README.md" }), false);
		});
		check("bash cat on package.json is NOT a miss (config bypass)", () => {
			assert.equal(lib.isSemanticMissToolCall("bash", { command: "cat package.json" }), false);
		});
		check("bash ls is NOT a miss", () => {
			assert.equal(lib.isSemanticMissToolCall("bash", { command: "ls -la" }), false);
		});
	}

	// ── Item 2b: bashReadCommandPath function ──
	{
		check("bashReadCommandPath cat file", () => {
			assert.equal(lib.bashReadCommandPath("cat index.ts"), "index.ts");
		});
		check("bashReadCommandPath head with flags", () => {
			assert.equal(lib.bashReadCommandPath("head -n 20 main.ts"), "main.ts");
		});
		check("bashReadCommandPath tail with flags", () => {
			assert.equal(lib.bashReadCommandPath("tail -50 app.py"), "app.py");
		});
		check("bashReadCommandPath sed -n", () => {
			assert.equal(lib.bashReadCommandPath("sed -n '1,20p' main.ts"), "main.ts");
		});
		check("bashReadCommandPath rejects redirects", () => {
			assert.equal(lib.bashReadCommandPath("cat file.ts > out.txt"), undefined);
		});
		check("bashReadCommandPath rejects pipes", () => {
			assert.equal(lib.bashReadCommandPath("cat file.ts | head -5"), undefined);
		});
	}

	// ── Item 3: serenaSuggestionMessage ──
	{
		const msg = lib.serenaSuggestionMessage();
		check("serenaSuggestionMessage contains all 5 tools", () => {
			for (const tool of lib.SERENA_CODE_TOOLS) {
				assert.ok(msg.includes(tool), `${tool} in message`);
			}
		});
		check("serenaSuggestionMessage is multiline", () => {
			assert.ok(msg.includes("\n"), "contains newlines");
		});
	}

	// ── Item 3b: SERENA_CODE_TOOLS ──
	{
		check("SERENA_CODE_TOOLS has 5 entries", () => {
			assert.equal(lib.SERENA_CODE_TOOLS.length, 5);
		});
		check("SERENA_CODE_TOOLS is frozen", () => {
			const threw = () => { try { lib.SERENA_CODE_TOOLS.push("x"); return false; } catch { return true; } };
			assert.ok(threw(), "frozen array throws on mutation");
		});
	}

	// ── Item 4: serena_read_file tool registered ──
	// Need to trigger session_start to register tools
	{
		const { pi, handlers, tools } = mockPi(["read", "serena_find_symbol"]);
		ext(pi);
		handlers.session_start[0]({}, { cwd: process.cwd() });

		check("serena_read_file tool registered", () => {
			assert.ok(tools["serena_read_file"], "serena_read_file exists in tools");
		});
		check("serena_read_file has name starting with serena_", () => {
			assert.ok(tools["serena_read_file"].name.startsWith("serena_"), "name starts with serena_");
		});
		check("serena_read_file has execute function", () => {
			assert.equal(typeof tools["serena_read_file"].execute, "function");
		});
		check("serena_read_file has parameters with path required", () => {
			const params = tools["serena_read_file"].parameters;
			assert.ok(params, "has parameters");
			assert.ok(params.properties?.path, "has path property");
			assert.ok(params.required?.includes("path"), "path is required");
		});
	}

	// ── Item 4b: serena_read_file reads actual files ──
	{
		const { pi, handlers, tools } = mockPi(["serena_read_file", "serena_get_symbols_overview"]);
		ext(pi);
		handlers.session_start[0]({}, { cwd: process.cwd() });

		const readTool = tools["serena_read_file"];
		check("serena_read_file can read a text file", async () => {
			const result = await readTool.execute(
				"call_1",
				{ path: fileURLToPath(import.meta.url), offset: 1, limit: 5 },
				undefined, undefined, undefined,
			);
			assert.ok(result, "got result");
			const text = result.content?.[0]?.text ?? result.text ?? "";
			assert.ok(text.includes("serena"), "contains script content");
		});
	}

	console.log(`\n=== Results: ${passed}/${total} passed ===`);
	if (passed < total) process.exit(1);
}

main().catch(e => {
	console.error("FATAL:", e.message);
	process.exit(1);
});
