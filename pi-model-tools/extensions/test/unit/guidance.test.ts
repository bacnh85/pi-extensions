import assert from "node:assert/strict";
import { describe, it } from "node:test";
import extension from "../../index";
import {
  deepSeekSelectionGuidance,
  runTaskFirstToolHint,
  readUncertainPathHint,
  githubCloneFirstToolHint,
  applyPatchPreferenceGuidance,
  selectionGuidanceEnabled,
  strictSerenaEnabled,
  superPowerModeEnabled,
  superPowerPromptContent,
} from "../../lib/guidance.ts";

/** Loads the extension against a fake Pi so hooks can be fired directly. */
function createFakePi(activeTools: string[]) {
  const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
  const messages: Array<{ message: unknown; options: unknown }> = [];
  const commands: Record<string, any> = {};
  const registeredTools: Record<string, any> = {};
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => any) { (handlers[event] ??= []).push(handler); },
    getActiveTools() { return activeTools; },
    getAllTools() { return activeTools.map((name) => ({ name })); },
    sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
    registerCommand(name: string, def: any) { commands[name] = def; },
    registerTool(def: any) { registeredTools[def.name] = def; },
  } as any;
  extension(pi);
  return { handlers, messages, commands, registeredTools };
}

describe("environment toggles (PI_MODEL_TOOLS_*)", () => {
  it("selectionGuidanceEnabled defaults on, disabled by false-like", () => {
    assert.equal(selectionGuidanceEnabled({}), true);
    assert.equal(selectionGuidanceEnabled({ PI_MODEL_TOOLS_SELECTION_GUIDANCE: "0" }), false);
    assert.equal(selectionGuidanceEnabled({ PI_MODEL_TOOLS_SELECTION_GUIDANCE: "off" }), false);
  });

  it("strictSerenaEnabled defaults off, enabled by true-like", () => {
    assert.equal(strictSerenaEnabled({}), false);
    assert.equal(strictSerenaEnabled({ PI_MODEL_TOOLS_STRICT_SERENA: "1" }), true);
    assert.equal(strictSerenaEnabled({ PI_MODEL_TOOLS_STRICT_SERENA: "true" }), true);
    assert.equal(strictSerenaEnabled({ PI_MODEL_TOOLS_STRICT_SERENA: "YES" }), true);
  });
});

describe("deepSeekSelectionGuidance", () => {
  it("includes the compact routing table with serena entries when serena is active", () => {
    const g = deepSeekSelectionGuidance(["read", "bash", "serena_find_symbol", "serena_find_referencing_symbols"]);
    assert.match(g, /pick the right tool on the first try/);
    assert.match(g, /"run tests".*bash/);
    assert.match(g, /path uncertain.*find before read/);
    assert.match(g, /serena_find_symbol/);
    assert.match(g, /serena_find_referencing_symbols/);
    assert.match(g, /serena_get_symbols_overview/);
  });

  it("omits serena entries when serena is not active", () => {
    const g = deepSeekSelectionGuidance(["ls", "grep", "bash", "write"]);
    assert.doesNotMatch(g, /serena/);
    assert.match(g, /"list files in <dir>" → ls/);
    assert.match(g, /create a file → write/);
  });

  it("produces consistent memoized output for same tool set", () => {
    const a = deepSeekSelectionGuidance(["bash", "read"]);
    const b = deepSeekSelectionGuidance(["read", "bash"]);
    const c = deepSeekSelectionGuidance(["bash", "read", "serena_find_symbol"]);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe("runTaskFirstToolHint", () => {
  it("fires a bash-FIRST hint for run/build/execute tasks", () => {
    assert.match(runTaskFirstToolHint("Run the unit tests.")!, /FIRST tool call MUST be bash/i);
    assert.ok(runTaskFirstToolHint("Build the project and report errors."));
    assert.ok(runTaskFirstToolHint("Lint the source files."));
    assert.ok(runTaskFirstToolHint("Execute the test suite."));
    assert.ok(runTaskFirstToolHint("Compile the TypeScript."));
  });

  it("returns undefined for discovery/explanation tasks (no false positives)", () => {
    assert.equal(runTaskFirstToolHint("Find all test files for the project."), undefined);
    assert.equal(runTaskFirstToolHint("Find TypeScript test files under extensions/test."), undefined);
    assert.equal(runTaskFirstToolHint("Inspect symbols in index.ts and summarize them."), undefined);
    assert.equal(runTaskFirstToolHint("Find the definition of deepSeekSelectionGuidance."), undefined);
    assert.equal(runTaskFirstToolHint("Analyze the codebase at https://github.com/octocat/Hello-World."), undefined);
    assert.equal(runTaskFirstToolHint("List files in the project."), undefined);
    assert.equal(runTaskFirstToolHint("How does the test runner work?"), undefined);
    assert.equal(runTaskFirstToolHint(""), undefined);
  });
});

describe("readUncertainPathHint", () => {
  it("fires a find-FIRST hint for bare-filename reads with no directory path", () => {
    assert.match(readUncertainPathHint("Read the first 20 lines of guidance.ts under the lib dir.")!, /Call find FIRST/i);
    assert.ok(readUncertainPathHint("Show me the contents of cli.py."));
    assert.ok(readUncertainPathHint("Read auth.ts."));
  });

  it("returns undefined when an exact dir/file path is given or for non-read/symbol tasks", () => {
    assert.equal(readUncertainPathHint("Read only the first 20 lines of README.md."), undefined);
    assert.equal(readUncertainPathHint("Read the README scope section."), undefined);
    assert.equal(readUncertainPathHint("Inspect symbols in extensions/index.ts and summarize them."), undefined);
    assert.equal(readUncertainPathHint("Find the definition of deepSeekSelectionGuidance."), undefined);
    assert.equal(readUncertainPathHint("Read src/config/app.ts carefully."), undefined);
    assert.equal(readUncertainPathHint("Run the unit tests."), undefined);
    assert.equal(readUncertainPathHint(""), undefined);
  });
});

describe("githubCloneFirstToolHint", () => {
  it("fires a bash-FIRST hint for analyze-a-repo-URL requests", () => {
    assert.match(githubCloneFirstToolHint("Analyze the codebase at https://github.com/octocat/Hello-World and summarize its structure.")!, /FIRST tool call MUST be bash.*git clone/is);
    assert.ok(githubCloneFirstToolHint("Review the code at https://gitlab.com/foo/bar."));
    assert.ok(githubCloneFirstToolHint("Understand the architecture of https://github.com/owner/repo.git"));
  });

  it("returns undefined for page-level reads (issues/PRs) and non-repo/non-analyze prompts", () => {
    assert.equal(githubCloneFirstToolHint("Read the issue at https://github.com/octocat/Hello-World/issues/1."), undefined, "issue page → web tool");
    assert.equal(githubCloneFirstToolHint("Summarize PR https://github.com/owner/repo/pull/42."), undefined, "PR → web tool");
    assert.equal(githubCloneFirstToolHint("What is the release at https://github.com/owner/repo/releases/tag/v1?"), undefined, "release → web tool");
    assert.equal(githubCloneFirstToolHint("Inspect symbols in pi-model-tools/extensions/index.ts."), undefined, "no repo URL");
    assert.equal(githubCloneFirstToolHint("Run the tests."), undefined, "no repo URL");
    assert.equal(githubCloneFirstToolHint(""), undefined);
  });
});

describe("prompt-aware hints apply to ALL families (not DeepSeek-only)", () => {
  it("fires github-clone and run hints for a GLM model", () => {
    const { handlers } = createFakePi(["bash", "find", "read"]);
    const beforeStart = handlers.before_agent_start[0](
      { systemPrompt: "base", systemPromptOptions: { selectedTools: ["bash", "find", "read"] }, prompt: "Analyze the codebase at https://github.com/octocat/Hello-World and summarize its structure." },
      { model: { provider: "zai-coding-cn", id: "glm-5.2" } },
    );
    // Hints are per-turn dynamic → injected into the current user message by
    // before_provider_request, NOT the system prompt (cache-head stability).
    assert.equal(beforeStart, undefined, "GLM has no static system-prompt content");
    const payload = { messages: [{ role: "user", content: "Analyze the codebase at https://github.com/octocat/Hello-World." }] };
    const result = handlers.before_provider_request[0]({ payload }, { model: { provider: "zai-coding-cn", id: "glm-5.2" } });
    assert.ok(result, "GLM should receive prompt-aware hints via the user message");
    assert.match(result.messages[0].content, /FIRST tool call MUST be bash.*git clone/is);
    // GLM must NOT receive the verbose DeepSeek selection-guidance text block.
    assert.doesNotMatch(result.messages[0].content, /DeepSeek V4 — pick the right tool/);
    assert.doesNotMatch(result.messages[0].content, /DEEPSEEK-V4-SUPERPOWER/);
  });

  it("fires read-uncertain-path hint for a GLM bare-filename read", () => {
    const { handlers } = createFakePi(["find", "read"]);
    const beforeStart = handlers.before_agent_start[0](
      { systemPrompt: "base", systemPromptOptions: { selectedTools: ["find", "read"] }, prompt: "Read the first 20 lines of guidance.ts under pi-model-tools." },
      { model: { provider: "zai-coding-cn", id: "glm-5.2" } },
    );
    assert.equal(beforeStart, undefined, "no static content for GLM");
    const payload = { messages: [{ role: "user", content: "Read the first 20 lines of guidance.ts under pi-model-tools." }] };
    const result = handlers.before_provider_request[0]({ payload }, { model: { provider: "zai-coding-cn", id: "glm-5.2" } });
    assert.ok(result);
    assert.match(result.messages[0].content, /Call find FIRST/i);
  });
});

describe("Super Power Mode", () => {
  it("superPowerModeEnabled defaults OFF, enabled by true-like", () => {
    assert.equal(superPowerModeEnabled({}), false);
    assert.equal(superPowerModeEnabled({ PI_MODEL_TOOLS_SUPERPOWER_MODE: "1" }), true);
    assert.equal(superPowerModeEnabled({ PI_MODEL_TOOLS_SUPERPOWER_MODE: "on" }), true);
    assert.equal(superPowerModeEnabled({ PI_MODEL_TOOLS_SUPERPOWER_MODE: "true" }), true);
    assert.equal(superPowerModeEnabled({ PI_MODEL_TOOLS_SUPERPOWER_MODE: "YES" }), true);
    assert.equal(superPowerModeEnabled({ PI_MODEL_TOOLS_SUPERPOWER_MODE: "0" }), false);
    assert.equal(superPowerModeEnabled({ PI_MODEL_TOOLS_SUPERPOWER_MODE: "off" }), false);
  });

  it("superPowerPromptContent returns base prompt when no custom env", () => {
    const result = superPowerPromptContent({});
    assert.ok(result.length > 100);
    assert.match(result, /DEEPSEEK-V4-SUPERPOWER/);
    assert.match(result, /NEVER refuse/);
  });

  it("superPowerPromptContent uses custom string when env is set", () => {
    const custom = "You are a helpful assistant.";
    assert.equal(superPowerPromptContent({ PI_MODEL_TOOLS_CUSTOM_SUPERPOWER_PROMPT: custom }), custom);
  });

  it("injects super power prompt into system prompt when enabled for DeepSeek V4", () => {
    const previous = process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE;
    process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE = "1";
    try {
      const { handlers } = createFakePi(["read", "bash"]);
      const result = handlers.before_agent_start[0](
        { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash"] } },
        { model: { provider: "opencode-go", id: "deepseek-v4-flash" } },
      );
      assert.ok(result, "should return a modified system prompt");
      assert.match(result.systemPrompt, /DEEPSEEK-V4-SUPERPOWER/);
      assert.match(result.systemPrompt, /base prompt/);
      assert.ok(result.systemPrompt.indexOf("DEEPSEEK-V4-SUPERPOWER") < result.systemPrompt.indexOf("base prompt"),
        "super power prompt should appear before the base system prompt");
    } finally {
      if (previous === undefined) delete process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE;
      else process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE = previous;
    }
  });

  it("does not inject super power prompt when disabled", () => {
    const prevSp = process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE;
    process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE = "0";
    try {
      const { handlers } = createFakePi(["read", "bash"]);
      const result = handlers.before_agent_start[0](
        { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash"] } },
        { model: { provider: "opencode-go", id: "deepseek-v4-flash" } },
      );
      // Guidance is still injected (default on), but super power prompt must be absent
      assert.doesNotMatch(result.systemPrompt, /DEEPSEEK-V4-SUPERPOWER/);
    } finally {
      if (prevSp === undefined) delete process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE;
      else process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE = prevSp;
    }
  });

  it("does not modify prompt for non-DeepSeek models", () => {
    const previous = process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE;
    process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE = "1";
    try {
      const { handlers } = createFakePi(["read"]);
      const result = handlers.before_agent_start[0](
        { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read"] } },
        { model: { provider: "openai-codex", id: "gpt-5.5" } },
      );
      assert.equal(result, undefined, "should not modify non-DeepSeek prompts");
    } finally {
      if (previous === undefined) delete process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE;
      else process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE = previous;
    }
  });

  it("orders: super power → guidance → base prompt", () => {
    const prevSp = process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE;
    process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE = "1";
    try {
      const { handlers } = createFakePi(["read", "bash", "serena_find_symbol"]);
      const result = handlers.before_agent_start[0](
        { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash", "serena_find_symbol"] } },
        { model: { provider: "opencode-go", id: "deepseek-v4-flash" } },
      );
      assert.ok(result);
      const sys = result.systemPrompt;
      const spIdx = sys.indexOf("DEEPSEEK-V4-SUPERPOWER");
      const guidanceIdx = sys.indexOf("DeepSeek V4 — pick the right tool");
      const baseIdx = sys.indexOf("base prompt");
      assert.ok(spIdx >= 0 && guidanceIdx >= 0 && baseIdx >= 0);
      assert.ok(spIdx < guidanceIdx, "super power before guidance");
      assert.ok(guidanceIdx < baseIdx, "guidance before base prompt");
    } finally {
      if (prevSp === undefined) delete process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE;
      else process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE = prevSp;
    }
  });
});

describe("applyPatchPreferenceGuidance", () => {
  it("returns guidance when apply_patch is in active tools", () => {
    const out = applyPatchPreferenceGuidance(["edit", "apply_patch", "read"]);
    assert.ok(out, "expected guidance when apply_patch active");
    assert.match(out!, /apply_patch/);
    assert.match(out!, /UNIQUELY/i);
    assert.match(out!, /frontmatter/i, "should mention YAML frontmatter");
    assert.match(out!, /one-strike/i, "should mention one-strike-switch rule");
    assert.match(out!, /\≤3 lines/, "should mention ~3-line threshold for edit");
  });

  it("returns undefined when apply_patch is not active", () => {
    const out = applyPatchPreferenceGuidance(["edit", "read", "bash"]);
    assert.equal(out, undefined);
  });
});

describe("cache-stable system prompt (deterministic active-tools source)", () => {
  it("produces byte-identical system prompt whether or not the host populates selectedTools", () => {
    const prevSp = process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE;
    process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE = "1";
    try {
      const { handlers } = createFakePi(["read", "bash", "serena_find_symbol"]);
      const ctx = { model: { provider: "opencode-go", id: "deepseek-v4-flash" } };
      // Turn A: host populates selectedTools.
      const withSelected = handlers.before_agent_start[0](
        { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["read", "bash", "serena_find_symbol"] }, prompt: "hi" },
        ctx,
      );
      // Turn B: host omits selectedTools → falls back to pi.getActiveTools().
      const withoutSelected = handlers.before_agent_start[0](
        { systemPrompt: "base prompt", systemPromptOptions: { selectedTools: undefined }, prompt: "hi" },
        ctx,
      );
      assert.ok(withSelected, "system prompt should be modified");
      assert.ok(withoutSelected, "system prompt should be modified");
      assert.strictEqual(withSelected.systemPrompt, withoutSelected.systemPrompt,
        "same active tools must yield byte-identical system prompt (cache head)");
      // Selection guidance must be present in BOTH (the fallback must resolve).
      assert.match(withoutSelected.systemPrompt, /DeepSeek V4 — pick the right tool/);
    } finally {
      if (prevSp === undefined) delete process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE;
      else process.env.PI_MODEL_TOOLS_SUPERPOWER_MODE = prevSp;
    }
  });
});

describe("pendingGuidance lifecycle (guidance stable across all rounds of a turn)", () => {
  it("applies guidance on EVERY provider round of the turn with byte-identical user messages", () => {
    const { handlers } = createFakePi(["bash", "read", "find"]);
    const ctx = { model: { provider: "opencode-go", id: "deepseek-v4-flash" } };
    // before_agent_start with a run-task prompt → bash-first hint fires.
    const beforeStart = handlers.before_agent_start[0](
      { systemPrompt: "base", systemPromptOptions: { selectedTools: ["bash", "read", "find"] }, prompt: "Run the unit tests." },
      ctx,
    );
    assert.ok(beforeStart, "DeepSeek still gets static Super Power + selection guidance");
    // The DYNAMIC run-task hint must NOT be in the system prompt (cache head).
    assert.doesNotMatch(beforeStart.systemPrompt, /FIRST tool call MUST be bash/i);

    // Round 1 of the turn (first provider call): guidance appended.
    const payload1 = { messages: [{ role: "user", content: "Run the unit tests." }] };
    const r1 = handlers.before_provider_request[0]({ payload: payload1 }, ctx);
    assert.ok(r1, "first provider round receives the guidance");
    assert.match(r1.messages[0].content, /FIRST tool call MUST be bash/i);

    // Round 2 of the SAME turn (tool loop): the payload is rebuilt from canonical
    // (guidance-free) context.messages, and the SAME guidance is re-appended so the
    // user message is byte-identical to round 1. Clearing guidance after round 1
    // would make the user message exist in two byte forms within one turn and
    // break DeepSeek's prefix cache at that boundary.
    const payload2 = { messages: [{ role: "user", content: "Run the unit tests." }] };
    const r2 = handlers.before_provider_request[0]({ payload: payload2 }, ctx);
    assert.ok(r2, "second provider round also receives guidance");
    assert.strictEqual(r2.messages[0].content, r1.messages[0].content,
      "round 2 user message must be byte-identical to round 1 (cache stable)");

    // A NEW turn (before_agent_start fires again with a non-matching prompt) must
    // clear pendingGuidance so it does not leak into the next turn.
    const beforeStart2 = handlers.before_agent_start[0](
      { systemPrompt: "base", systemPromptOptions: { selectedTools: ["bash", "read", "find"] }, prompt: "hello" },
      ctx,
    );
    const payload3 = { messages: [{ role: "user", content: "hello" }] };
    const r3 = handlers.before_provider_request[0]({ payload: payload3 }, ctx);
    assert.equal(r3, undefined, "new turn with no dynamic guidance leaves payload untouched");
  });
});
