import assert from "node:assert/strict";
import { describe, it } from "node:test";
import extension from "../../index";
import {
  deepSeekSelectionGuidance,
  isOpenCodeGoDeepSeekV4Model,
  isSemanticMissToolCall,
  missedDedicatedTool,
  selectionGuidanceEnabled,
  strictSerenaEnabled,
  DEEPSEEK_V4_FLASH_MODEL,
  superPowerModeEnabled,
  superPowerPromptContent,
  suggestBestSerenaCommand,
  dedicatedToolForShellCommand,
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
  const registeredTools: Record<string, any> = {};
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      (handlers[event] ??= []).push(handler);
    },
    getActiveTools() {
      return activeTools;
    },
    getAllTools() {
      return activeTools.map((name) => ({ name }));
    },
    sendMessage(message: unknown, options: unknown) {
      messages.push({ message, options });
    },
    registerCommand(name: string, def: any) {
      commands[name] = def;
    },
    registerTool(def: any) { registeredTools[def.name] = def; },
  } as any;

  extension(pi);
  return { handlers, messages, commands, registeredTools };
}

describe("OpenCode Go DeepSeek V4 model detection", () => {
  it("matches only OpenCode Go Flash and Pro", () => {
    assert.equal(isOpenCodeGoDeepSeekV4Model({ provider: OPENCODE_GO_PROVIDER, id: DEEPSEEK_V4_FLASH_MODEL }), true);
    assert.equal(isOpenCodeGoDeepSeekV4Model({ provider: "opencode-go", id: "deepseek-v4-pro" }), true);
    assert.equal(isOpenCodeGoDeepSeekV4Model({ provider: "deepseek", id: "deepseek-v4-flash" }), false);
    assert.equal(isOpenCodeGoDeepSeekV4Model({ provider: "openai-codex", id: "gpt-5.5" }), false);
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
    assert.match(g, /GitHub repository\/codebase URL.*git clone.*local checkout/);
    assert.match(g, /File location uncertain.*find before read.*external temporary clones.*Never guess subdirectories/);
    assert.match(g, /exact path is verified.*read/);
    assert.match(g, /serena_get_symbols_overview/);
    assert.match(g, /serena_find_symbol/);
    assert.match(g, /serena_find_referencing_symbols/);
    assert.match(g, /edit oldText.*match exactly once/);
    assert.match(g, /Do NOT invent tool names/);
  });

  it("omits serena lookup entries when serena is not active", () => {
    const g = deepSeekSelectionGuidance(["ls", "grep", "bash", "write"]);

    // serena_get_symbols_overview appears in the NEVER section as recommended alternative,
    // but the dedicated lookup entries (find where..., find implementations...) are omitted
    assert.doesNotMatch(g, /Find where a function/);
    assert.doesNotMatch(g, /Find implementations/);
    assert.doesNotMatch(g, /Find all usages/);
    // Verified-path read boundary is always present
    assert.match(g, /exact path is verified.*read/);
    assert.doesNotMatch(g, /Do NOT use read for code files/);
    assert.match(g, /bash for file ops/);
  });

  it("routes vault work to obsidian without contradicting generic file guidance", () => {
    const g = deepSeekSelectionGuidance(["obsidian"]);
    assert.match(g, /Obsidian vault operation.*obsidian only/);
    assert.match(g, /Read a non-Obsidian file/);
    assert.match(g, /Write a new non-Obsidian file/);
  });

  it("produces consistent output for same tool set", () => {
    const a = deepSeekSelectionGuidance(["bash", "read"]);
    const b = deepSeekSelectionGuidance(["read", "bash"]);
    const c = deepSeekSelectionGuidance(["bash", "read", "serena_find_symbol"]);

    assert.equal(a, b); // same input → same output
    assert.notEqual(a, c); // different input → different output
    assert.match(deepSeekSelectionGuidance(["read", "resolve_file"]), /resolve_file before read/);
    assert.match(deepSeekSelectionGuidance(["read", "fffind"]), /fffind before read/);
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
    assert.equal(dedicatedToolForShellCommand("sed -n '1,20p' README.md", active), undefined, "sed -n is a real command");
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



  it("injects guidance when obsidian is the only relevant tool", () => {
    const { handlers } = createFakePi(["obsidian"]);
    const result = handlers.before_agent_start[0](
      { systemPrompt: "base", systemPromptOptions: { selectedTools: ["obsidian"] } },
      { model: { provider: "opencode-go", id: "deepseek-v4-flash" } },
    );
    assert.match(result.systemPrompt, /Obsidian vault operation.*obsidian only/);
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

    const { handlers: hPro } = createFakePi(activeTools);
    const resultPro = hPro.tool_call[0](event, { model: { provider: "opencode-go", id: "deepseek-v4-pro" } });
    assert.equal(resultPro, undefined, "Pro: read code file should NOT block");

    const { handlers: hFlash } = createFakePi(activeTools);
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

  it("allows find with a specific filename when the path is unknown", () => {
    const { handlers, messages } = createFakePi(activeTools);

    const result = handlers.tool_call[0](
      { toolName: "find", input: { pattern: "notebooklm_cli.py", path: "/tmp/notebooklm-py" } },
      { model: { provider: "opencode-go", id: "deepseek-v4-flash" } },
    );
    assert.equal(result, undefined);
    assert.equal(messages.length, 0);
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


describe("session scoping", () => {
  const model = { provider: "opencode-go", id: "deepseek-v4-flash" };
  const activeTools = ["read", "bash", "ls"];

  it("ignores other-model errors and clears DeepSeek errors at session start", () => {
    const { handlers } = createFakePi(activeTools);
    const event = { systemPrompt: "base", systemPromptOptions: { selectedTools: activeTools } };
    handlers.tool_execution_end[0]({ isError: true, toolName: "read", result: "ENOENT", toolCallId: "1" }, { model: { provider: "openai-codex", id: "gpt-5.5" } });
    assert.doesNotMatch(handlers.before_agent_start[0](event, { model }).systemPrompt, /Note: The file path/);

    handlers.tool_execution_end[0]({ isError: true, toolName: "read", result: "ENOENT", toolCallId: "2" }, { model });
    handlers.session_start[0]({}, { model, cwd: process.cwd() });
    assert.doesNotMatch(handlers.before_agent_start[0](event, { model }).systemPrompt, /Note: The file path/);
  });

  it("resets reminder escalation at session start", () => {
    const previous = process.env.PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS;
    process.env.PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS = "2";
    try {
      const { handlers } = createFakePi(activeTools);
      const event = { toolName: "bash", input: { command: "ls pi-deepseek-tools" } };
      assert.equal(handlers.tool_call[0](event, { model }), undefined);
      handlers.session_start[0]({}, { model, cwd: process.cwd() });
      assert.equal(handlers.tool_call[0](event, { model }), undefined);
    } finally {
      if (previous === undefined) delete process.env.PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS;
      else process.env.PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS = previous;
    }
  });


  it("keeps error counts isolated between extension instances", () => {
    const first = createFakePi(activeTools).handlers;
    const second = createFakePi(activeTools).handlers;
    const error = { isError: true, toolName: "read", result: "ENOENT", toolCallId: "1" };
    const event = { systemPrompt: "base", systemPromptOptions: { selectedTools: activeTools } };

    first.tool_execution_end[0](error, { model });
    first.before_agent_start[0](event, { model });
    second.tool_execution_end[0](error, { model });
    assert.doesNotMatch(second.before_agent_start[0](event, { model }).systemPrompt, /2 failures/);
  });

  it("injects error recovery when selection guidance is disabled", () => {
    const previousGuidance = process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
    const previousSuperPower = process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
    process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE = "0";
    process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = "0";
    try {
      const { handlers } = createFakePi(activeTools);
      handlers.tool_execution_end[0]({ isError: true, toolName: "read", result: "ENOENT", toolCallId: "1" }, { model });
      const result = handlers.before_agent_start[0]({ systemPrompt: "base", systemPromptOptions: { selectedTools: activeTools } }, { model });
      assert.match(result.systemPrompt, /Note: The file path/);
    } finally {
      if (previousGuidance === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
      else process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE = previousGuidance;
      if (previousSuperPower === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
      else process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = previousSuperPower;
    }
  });
});

describe("error categorization", () => {
  it("detects rate limit errors", () => {
    const info = categorizeToolError("bash", "429 Too Many Requests");
    assert.equal(info.category, "rate_limit");
    assert.match(info.hint, /rate-limited/i);
  });

  it("detects edit-mismatch errors — could not find edits", () => {
    const info = categorizeToolError("edit", "Could not find edits[1] in /path/to/file. The oldText must match exactly including all whitespace and newlines.");
    assert.equal(info.category, "edit_mismatch");
    assert.match(info.hint, /byte.for.byte|verbatim/i);
  });

  it("detects edit-mismatch errors — oldText must match", () => {
    const info = categorizeToolError("edit", "The oldText must match exactly including all whitespace and newlines.");
    assert.equal(info.category, "edit_mismatch");
    assert.match(info.hint, /byte.for.byte|verbatim/i);
  });

  it("detects ambiguous edit errors in the runtime tool-result shape", () => {
    const info = categorizeToolError("edit", {
      content: [{ type: "text", text: "Found 2 occurrences of the text in /path/to/file. The text must be unique. Please provide more context to make it unique." }],
      details: {},
    });
    assert.equal(info.category, "edit_mismatch");
    assert.match(info.hint, /match exactly once/i);
  });

  it("detects timeout errors", () => {
    const info = categorizeToolError("read", "timed out after 30000ms");
    assert.equal(info.category, "timeout");
    assert.match(info.hint, /timed out|timeout/i);
  });

  it("requires HTTP context before classifying a number as an API error", () => {
    assert.equal(categorizeToolError("read", "failed near line 500 in source").category, "unknown");
    assert.equal(categorizeToolError("web_search", "HTTP status 500: Internal Server Error").category, "api_error");
  });

  it("detects validation errors", () => {
    const info = categorizeToolError("edit", "Validation failed: missing required field 'oldText'");
    assert.equal(info.category, "validation");
    assert.match(info.hint, /required fields/i);
  });

  it("detects missing file paths", () => {
    for (const error of [
      "ENOENT: no such file or directory, access '/tmp/repo/guessed.py'",
      "Path not found: /tmp/repo",
    ]) {
      const info = categorizeToolError("read", error);
      assert.equal(info.category, "path_not_found");
      assert.match(info.hint, /discover the exact path/i);
    }
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

  it("blocks forced recursive deletion of quoted and unquoted absolute paths", () => {
    for (const command of [
      "rm -rf /",
      "rm -fr \"/\"",
      "rm -r -f -- '/tmp/path with spaces'",
      "rm --recursive --force /tmp",
    ]) {
      assert.match(checkDangerousCommand(command) ?? "", /recursive delete/i);
    }
  });

  it("blocks sudo rm -rf /tmp", () => {
    assert.ok(checkDangerousCommand("sudo rm -rf /tmp"));
  });

  it("blocks destructive writes to block devices without blocking device reads", () => {
    assert.ok(checkDangerousCommand("dd if=image.iso of=/dev/sda"));
    assert.ok(checkDangerousCommand("dd of=/dev/nvme0n1 if=image.iso"));
    assert.ok(checkDangerousCommand("dd if=/dev/zero of=\"/dev/sda\""));
    assert.equal(checkDangerousCommand("dd if=/dev/zero of=/tmp/disk.img"), undefined);
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
    const prevSp = process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
    const prevSg = process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
    process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = "0";
    delete process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
    try {
      const { handlers } = createFakePi(["read", "bash"]);
      const beforeAgentStart = handlers.before_agent_start[0];
      const event = { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash"] } };
      const result = beforeAgentStart(event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
      assert.ok(result, "should return guidance");
      assert.doesNotMatch(result.systemPrompt, /DEEPSEEK-V4-FLASH-SUPERPOWER/);
    } finally {
      if (prevSp === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
      else process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = prevSp;
      if (prevSg === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
      else process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE = prevSg;
    }
  });

  it("does not inject super power prompt when explicitly disabled with off", () => {
    const prevSp = process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
    const prevSg = process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
    process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = "off";
    delete process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
    try {
      const { handlers } = createFakePi(["read", "bash"]);
      const beforeAgentStart = handlers.before_agent_start[0];
      const event = { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash"] } };
      const result = beforeAgentStart(event, { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
      assert.ok(result, "should return guidance");
      assert.doesNotMatch(result.systemPrompt, /DEEPSEEK-V4-FLASH-SUPERPOWER/);
    } finally {
      if (prevSp === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
      else process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = prevSp;
      if (prevSg === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
      else process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE = prevSg;
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
    const prevSp = process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
    const prevSg = process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
    process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = "1";
    delete process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
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
      if (prevSp === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE;
      else process.env.PI_DEEPSEEK_TOOLS_SUPERPOWER_MODE = prevSp;
      if (prevSg === undefined) delete process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE;
      else process.env.PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE = prevSg;
    }
  });

  describe("tool cwd binding", () => {
    it("uses ctx.cwd at execution time, not process.cwd()", async () => {
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");
      const cwdA = mkdtempSync(path.join(os.tmpdir(), "pi-ds-cwd-a-"));
      const cwdB = mkdtempSync(path.join(os.tmpdir(), "pi-ds-cwd-b-"));
      writeFileSync(path.join(cwdA, "hello.txt"), "content-a");
      writeFileSync(path.join(cwdB, "hello.txt"), "content-b");

      const { registeredTools } = createFakePi(["read", "bash", "edit", "write", "grep", "find", "ls"]);
      const readTool = registeredTools.read;
      assert.ok(readTool, "read tool registered");

      // Execute with ctx pointing to cwdA
      const resultA = await readTool.execute("c1", { path: "hello.txt" }, undefined, undefined, { cwd: cwdA });
      assert.ok(resultA?.content, "content returned");
      const textA = resultA.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
      assert.ok(textA.includes("content-a"), "read from cwdA");

      // Execute with ctx pointing to cwdB
      const resultB = await readTool.execute("c2", { path: "hello.txt" }, undefined, undefined, { cwd: cwdB });
      const textB = resultB.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
      assert.ok(textB.includes("content-b"), "read from cwdB");
    });
  });

  describe("suggestBestSerenaCommand", () => {
    const tools = ["serena_get_symbols_overview", "serena_find_symbol", "serena_search_for_pattern"];

    it("extracts symbol from grep -rn command", () => {
      const result = suggestBestSerenaCommand({ command: "grep -rn \"wrapToolDefinition\" pi-deepseek-tools/" }, tools);
      assert.ok(result.includes("serena_find_symbol"), "should suggest serena_find_symbol for identifier search");
      assert.ok(result.includes("wrapToolDefinition"), "should include the symbol name");
    });

    it("extracts symbol from rg command", () => {
      const result = suggestBestSerenaCommand({ command: "rg 'DESTRUCTIVE_BASH_PATTERNS'" }, tools);
      assert.ok(result.includes("serena_find_symbol"));
      assert.ok(result.includes("DESTRUCTIVE_BASH_PATTERNS"));
    });

    it("extracts class search", () => {
      const result = suggestBestSerenaCommand({ command: "grep -rn 'class UserService' src/" }, tools);
      assert.ok(result.includes("serena_find_symbol"));
    });

    it("falls back to serena_get_symbols_overview for unrecognized patterns", () => {
      const result = suggestBestSerenaCommand({ command: "find src -name '*.ts' -exec grep 'something' {} \\;" }, tools);
      assert.ok(result.includes("serena_get_symbols_overview") || result.includes("serena_search_for_pattern"));
    });

    it("falls back for non-grep commands", () => {
      const result = suggestBestSerenaCommand({ command: "ls pi-deepseek-tools" }, tools);
      assert.ok(result.includes("serena_get_symbols_overview"));
    });

    it("handles missing command field", () => {
      const result = suggestBestSerenaCommand({}, tools);
      assert.ok(result.includes("serena_"), "should suggest some serena tool");
    });

    it("handles non-object input", () => {
      const result = suggestBestSerenaCommand("not an object", tools);
      assert.ok(result.includes("serena_"), "should suggest some serena tool");
    });
  });
});

