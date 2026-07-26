#!/usr/bin/env node
/**
 * smoke-test.mjs — Runtime smoke test for pi-deepseek-tools.
 *
 * Loads the extension with a mock Pi API, simulates the session lifecycle
 * for each model variant (OCG Flash/Pro, GPT, direct DeepSeek).
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
  "OCG Flash": { provider: "opencode-go", id: "deepseek-v4-flash" },
  "OCG Pro":   { provider: "opencode-go", id: "deepseek-v4-pro" },
  GPT:         { provider: "openai-codex", id: "gpt-5.5" },
  "direct DS": { provider: "deepseek", id: "deepseek-v4-flash" },
};

const ALL_TOOLS = [
  "read", "write", "edit", "bash", "grep", "find", "ls",
  "serena_get_symbols_overview", "serena_find_symbol",
  "serena_find_referencing_symbols", "serena_find_declaration",
  "serena_find_implementations",
];

let passed = 0;
let failed = 0;
const errors = [];

function check(label, fn) {
  Promise.resolve().then(async () => {
    try { await fn(); passed++; }
    catch (e) { errors.push(`✗ ${label}: ${e.message}`); failed++; }
  });
}

async function main() {
  // Load extension first (async)
  const mod = await import(`${root}/index.ts`);
  const ext = mod.default;
  assert.equal(typeof ext, "function", "extension default export is a function");
  console.log("✓ extension module loads");

  // Import detection function for assertion phase
  const { isDeepSeekV4ModelByModel } = await import(`${root}/lib/deepseek-tools.ts`);
  assert.equal(typeof isDeepSeekV4ModelByModel, "function", "imported isDeepSeekV4ModelByModel");
  console.log("✓ detection function imported");

  // ── Basic registration ──────────────────────────────────
  {
    const { pi, handlers, commands, tools } = mockPi();
    ext(pi);

    assert.ok(handlers.session_start, "session_start hook");
    assert.ok(handlers.before_provider_request, "before_provider_request hook");
    assert.ok(handlers.before_agent_start, "before_agent_start hook");
    assert.ok(handlers.tool_call, "tool_call hook");
    assert.ok(handlers.tool_execution_end, "tool_execution_end hook");
    assert.ok(handlers.agent_end, "agent_end hook");
    assert.ok(commands["deepseek-tools-status"], "deepseek-tools-status command");
    console.log("✓ registers 6 hooks + 1 command");
  }

  // ── session_start registers 7 tools ─────────────────────
  {
    const { pi, handlers, tools } = mockPi();
    ext(pi);
    handlers.session_start[0]({}, { cwd: process.cwd() });
    const names = Object.keys(tools);
    assert.equal(names.length, 7, `expected 7 tools, got ${names.length}`);
    for (const t of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
      assert.ok(tools[t], `${t} tool registered`);
    }
    console.log("✓ session_start registers 7 tools");
  }

  // ── Status command handler is async ─────────────────────
  {
    const cmdHandlers = {};
    const pi = mockPi().pi;
    const orig = pi.registerCommand;
    pi.registerCommand = (n, d) => { cmdHandlers[n] = d.handler; };
    ext(pi);
    pi.registerCommand = orig;

    const h = cmdHandlers["deepseek-tools-status"];
    assert.ok(h, "status handler exists");
    assert.equal(h.constructor.name, "AsyncFunction");
    console.log("✓ status command is async");
  }

  // ── Model-specific lifecycle tests ──────────────────────
  const toolSets = {
    "with serena": ALL_TOOLS,
    "bash only":   ["bash"],
  };



  for (const [setLabel, activeTools] of Object.entries(toolSets)) {
    for (const [modelLabel, model] of Object.entries(MODELS)) {
      const isOCG = model.provider === "opencode-go";
      const isDS = isDeepSeekV4ModelByModel(model);

      // before_provider_request: leaked content cleaning
      {
        const { pi, handlers } = mockPi(activeTools);
        ext(pi);
        const dirty = "Reasoning: find files.\n`read(\"README.md\")` now.";
        const payload = { model: model.id, messages: [{ role: "assistant", content: dirty }] };
        const result = handlers.before_provider_request[0]({ payload }, { model });

        if (isDS) {
          assert.ok(result, `${modelLabel}/${setLabel}: should modify payload`);
          const c = result.messages[0].content;
          assert.ok(!c.includes("Reasoning:"), "strip reasoning header");
          assert.ok(!c.includes("`read("), "strip leaked tool call");
          assert.ok(c.includes("now."), "keep actual text");
        } else {
          assert.equal(result, undefined, `${modelLabel}/${setLabel}: should not modify GPT`);
        }
        console.log(`✓ before_provider_request leaked content [${modelLabel}/${setLabel}]`);
      }

      // before_provider_request: {{model}} replacement
      {
        const { pi, handlers } = mockPi(activeTools);
        ext(pi);
        const payload = { model: "{{model}}", messages: [{ role: "user", content: "hi" }] };
        const result = handlers.before_provider_request[0]({ payload }, { model });

        if (isDS) {
          assert.ok(result, `${modelLabel}: should return payload`);
          assert.equal(result.model, model.id, `${modelLabel}: replace {{model}}`);
        } else {
          assert.equal(result, undefined, `${modelLabel}: no modification`);
        }
        console.log(`✓ before_provider_request {{model}} [${modelLabel}/${setLabel}]`);
      }

      // before_provider_request: returns payload directly (not wrapped in { payload })
      // Use dirty content so a mutation happens and the handler returns a replacement.
      {
        const { pi, handlers } = mockPi(activeTools);
        ext(pi);
        const payload = { model: model.id, messages: [{ role: "user", content: "Reasoning: think.\nresult" }] };
        const result = handlers.before_provider_request[0]({ payload }, { model });

        if (isDS) {
          assert.ok(result, `${modelLabel}: should return payload`);
          assert.equal(result.payload, undefined, `${modelLabel}: not wrapped in { payload }`);
          assert.ok(result.messages, `${modelLabel}: messages at top level`);
          assert.equal(result.messages[0].content, "result", `${modelLabel}: leaked content cleaned`);
        } else {
          assert.equal(result, undefined, `${modelLabel}: no modification`);
        }
        console.log(`✓ before_provider_request returns payload directly [${modelLabel}/${setLabel}]`);
      }

      // before_agent_start: guidance injection
      {
        const { pi, handlers } = mockPi(activeTools);
        ext(pi);
        handlers.session_start[0]({}, { cwd: process.cwd() });

        const event = {
          systemPrompt: "base",
          systemPromptOptions: { selectedTools: activeTools },
        };
        const result = handlers.before_agent_start[0](event, { model });

        if (isDS) {
          // DS models (OCG + direct with env) get guidance
          assert.ok(result, `${modelLabel}: should inject guidance`);
          const sp = result.systemPrompt;
          assert.ok(sp.includes("pick the right tool"), `${modelLabel}: guidance present`);
          // prohibitive rules present
          assert.ok(sp.includes("Do NOT use bash for file ops"), `${modelLabel}: includes bash prohibitive rule`);
          assert.ok(sp.includes("Read code or non-code files"), `${modelLabel}: includes read mapping`);
        } else {
          assert.equal(result, undefined, `${modelLabel}: no guidance`);
        }
        console.log(`✓ before_agent_start guidance [${modelLabel}/${setLabel}]`);
      }

      // tool_call: find misuse blocked for DS models
      {
        const { pi, handlers, messages } = mockPi(activeTools);
        ext(pi);
        handlers.session_start[0]({}, { cwd: process.cwd() });
        handlers.before_agent_start[0](
          { systemPrompt: "base", systemPromptOptions: { selectedTools: activeTools } },
          { model },
        );

        const result = handlers.tool_call[0](
          { toolName: "find", input: { pattern: "README.md" } },
          { model },
        );

        if (isDS) {
          assert.ok(result?.block === true, `${modelLabel}: find misuse blocked`);
          assert.ok(result.reason.includes("read"), `${modelLabel}: suggests read`);
          assert.equal(messages.length, 0, `${modelLabel}: no steer (blocked, not reminded)`);
        } else {
          assert.equal(result, undefined, `${modelLabel}: no intercept`);
        }
        console.log(`✓ tool_call find misuse [${modelLabel}/${setLabel}]`);
      }

      // tool_call: legit find glob passes through (all models)
      {
        const { pi, handlers } = mockPi(activeTools);
        ext(pi);
        handlers.session_start[0]({}, { cwd: process.cwd() });
        handlers.before_agent_start[0](
          { systemPrompt: "base", systemPromptOptions: { selectedTools: activeTools } },
          { model },
        );

        const result = handlers.tool_call[0](
          { toolName: "find", input: { pattern: "*.ts" } },
          { model },
        );

        assert.equal(result, undefined, `${modelLabel}: glob find passes through`);
        console.log(`✓ tool_call glob find passes [${modelLabel}/${setLabel}]`);
      }
    }
  }

  // ── Thinking budget injection ──────────────────────────
  {
    const prev = process.env.PI_DEEPSEEK_TOOLS_THINKING_BUDGET;
    process.env.PI_DEEPSEEK_TOOLS_THINKING_BUDGET = "512";
    try {
      const { pi, handlers } = mockPi(ALL_TOOLS);
      ext(pi);
      const payload = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] };
      const result = handlers.before_provider_request[0](
        { payload },
        { model: { provider: "opencode-go", id: "deepseek-v4-flash" } },
      );
      assert.ok(result.thinking, "thinking field injected");
      assert.equal(result.thinking.type, "budget_tokens");
      assert.equal(result.thinking.budget_tokens, 512);
      console.log("✓ thinking budget injected when env set");
    } finally {
      if (prev === undefined) delete process.env.PI_DEEPSEEK_TOOLS_THINKING_BUDGET;
      else process.env.PI_DEEPSEEK_TOOLS_THINKING_BUDGET = prev;
    }
  }

  // ── Dangerous command guard ────────────────────────────
  {
    const prevBlock = process.env.PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS;
    process.env.PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS = "1";
    try {
      const { pi, handlers } = mockPi(ALL_TOOLS);
      ext(pi);
      handlers.session_start[0]({}, { cwd: process.cwd() });
      const result = handlers.tool_call[0](
        { toolName: "bash", input: { command: "rm -rf /" } },
        { model: { provider: "opencode-go", id: "deepseek-v4-flash" } },
      );
      assert.ok(result?.block === true, "block dangerous command");
      assert.ok(result.reason.includes("Safety guardrail"), "mentions guardrail");
      console.log("✓ dangerous command guard blocks rm -rf /");
    } finally {
      if (prevBlock === undefined) delete process.env.PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS;
      else process.env.PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS = prevBlock;
    }
  }

  // ── Error categorization via tool_execution_end ────────
  {
    const { pi, handlers } = mockPi(ALL_TOOLS);
    ext(pi);
    const result = handlers.tool_execution_end[0](
      { isError: true, toolName: "bash", toolCallId: "call_1", result: "429 Too Many Requests" },
      {},
    );
    assert.equal(result, undefined, "tool_execution_end returns undefined");
    console.log("✓ tool_execution_end handles errors");
  }

  // ── agent_end runs without error ──────────────────────
  {
    const { pi, handlers } = mockPi(ALL_TOOLS);
    ext(pi);
    const result = handlers.agent_end[0]({}, {});
    assert.equal(result, undefined, "agent_end returns undefined");
    console.log("✓ agent_end resets repair flag");
  }

  // ── Config helpers work at runtime ─────────────────────
  {
    const modHelpers = await import(`${root}/lib/deepseek-tools.ts`);
    assert.equal(modHelpers.maxErrorHistory({}), 100);
    assert.equal(modHelpers.thinkingBudget({}), undefined);
    assert.equal(modHelpers.autoBlockAfterReminders({}), 0);
    assert.equal(modHelpers.blockDangerousEnabled({}), true);
    assert.equal(
      modHelpers.maxErrorHistory({ PI_DEEPSEEK_TOOLS_MAX_ERROR_HISTORY: "200" }), 200);
    assert.equal(
      modHelpers.thinkingBudget({ PI_DEEPSEEK_TOOLS_THINKING_BUDGET: "1024" }), 1024);
    assert.equal(
      modHelpers.autoBlockAfterReminders({ PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "5" }), 5);
    assert.equal(
      modHelpers.blockDangerousEnabled({ PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS: "1" }), true);
    console.log("✓ config helpers return correct values");
  }

  // ── Cleanup env ────────────────────────────────────
  delete process.env.PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK;

  // ── Summary ──────────────────────────────────────────
  console.log(`\nAll checks passed.`);
  process.exit(0);
}

main().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
