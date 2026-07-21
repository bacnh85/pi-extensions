import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import extension from "../../index";
import { repairDeepSeekToolArguments, unwrapDegenerateMarkdownAutolink } from "../../lib/tool-input-repair";
import { DEEPSEEK_V4_FLASH_MODEL, OPENCODE_GO_PROVIDER } from "../../lib/deepseek-tools";

const schema = Type.Object({
  path: Type.String(),
  optionalText: Type.Optional(Type.String()),
  items: Type.Array(Type.String()),
  objects: Type.Array(Type.Object({ name: Type.String() })),
  content: Type.String(),
});

function createFakePi(activeTools: string[] = ["read", "write", "edit", "grep", "find", "ls", "bash"]) {
  const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
  const tools: Record<string, any> = {};
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      (handlers[event] ??= []).push(handler);
    },
    getActiveTools() {
      return activeTools;
    },
    sendMessage() {},
    registerTool(tool: any) {
      tools[tool.name] = tool;
    },
    registerCommand() {},
  } as any;

  extension(pi);
  return { handlers, tools };
}

describe("tool input repair", () => {
  it("leaves already valid arguments unchanged", () => {
    const args = { path: "notes.md", items: ["a"], objects: [{ name: "n" }], content: "[1,2]" };
    const repaired = repairDeepSeekToolArguments("demo", schema, args);

    assert.equal(repaired.repaired, false);
    assert.equal(repaired.args, args);
  });

  it("removes null optional fields", () => {
    const repaired = repairDeepSeekToolArguments("demo", schema, {
      path: "notes.md",
      optionalText: null,
      items: ["a"],
      objects: [{ name: "n" }],
      content: "x",
    });

    assert.deepEqual(repaired.args, { path: "notes.md", items: ["a"], objects: [{ name: "n" }], content: "x" });
    assert.deepEqual(repaired.repairs, ["optional-null"]);
  });

  it("parses stringified arrays before wrapping bare strings", () => {
    const repaired = repairDeepSeekToolArguments("demo", schema, {
      path: "notes.md",
      items: '["a","b"]',
      objects: '[{"name":"n"}]',
      content: "x",
    });

    assert.deepEqual((repaired.args as any).items, ["a", "b"]);
    assert.deepEqual((repaired.args as any).objects, [{ name: "n" }]);
    assert.deepEqual(repaired.repairs, ["json-string", "json-string"]);
  });

  it("wraps bare strings and converts empty placeholders for arrays", () => {
    const repaired = repairDeepSeekToolArguments("demo", schema, {
      path: "notes.md",
      items: "foo",
      objects: {},
      content: "x",
    });

    assert.deepEqual((repaired.args as any).items, ["foo"]);
    assert.deepEqual((repaired.args as any).objects, []);
    assert.deepEqual(repaired.repairs, ["bare-string-array", "empty-object-array"]);
  });

  it("wraps stringified JSON object in array when array is expected", () => {
    const repaired = repairDeepSeekToolArguments("demo", schema, {
      path: "notes.md",
      items: '{"key":"val"}',
      objects: [],
      content: "x",
    });

    assert.deepEqual((repaired.args as any).items, [{ key: "val" }]);
    assert.deepEqual(repaired.repairs, ["json-object-wrapped-array"]);
  });

  it("does not parse JSON-looking string content unless the schema expects a container there", () => {
    const args = { path: "notes.md", items: ["a"], objects: [], content: '["keep as text"]' };
    const repaired = repairDeepSeekToolArguments("demo", schema, args);

    assert.equal(repaired.args, args);
    assert.equal((repaired.args as any).content, '["keep as text"]');
  });

  it("unwraps only degenerate markdown path auto-links", () => {
    // Degenerate: text matches URL (whitespace in URL)
    assert.equal(unwrapDegenerateMarkdownAutolink("/tmp/[notes.md](http://notes. md)"), "/tmp/notes.md");
    // Non-degenerate: real hyperlink, not a path
    assert.equal(unwrapDegenerateMarkdownAutolink("[click](https://x.com)"), "[click](https://x.com)");
    // Non-degenerate: URL has real path prefix (different resource)
    assert.equal(unwrapDegenerateMarkdownAutolink("[nested.md](http://github.com/project/nested.md)"), "[nested.md](http://github.com/project/nested.md)");

    const repaired = repairDeepSeekToolArguments("demo", schema, {
      path: "/tmp/[notes.md](http://notes. md)",
      items: ["a"],
      objects: [],
      content: "x",
    });
    assert.equal((repaired.args as any).path, "/tmp/notes.md");
    assert.deepEqual(repaired.repairs, ["path-markdown-autolink"]);

    // Real URL with path prefix should NOT be unwrapped
    const notUnwrapped = repairDeepSeekToolArguments("demo", schema, {
      path: "[nested.md](http://github.com/project/nested.md)",
      items: ["a"],
      objects: [],
      content: "x",
    });
    assert.equal(notUnwrapped.repaired, false);
    assert.equal((notUnwrapped.args as any).path, "[nested.md](http://github.com/project/nested.md)");
  });
});

describe("DeepSeek Flash built-in wrappers", () => {
  it("registers wrappers that default read limit/offset only during Flash turns", () => {
    const { handlers, tools } = createFakePi();
    handlers.session_start[0]({}, { cwd: process.cwd() });

    const read = tools.read;
    assert.ok(read);
    assert.deepEqual(read.prepareArguments({ path: "README.md", limit: 5 }), { path: "README.md", limit: 5 });

    handlers.before_agent_start[0]({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["read"] } }, { model: { provider: OPENCODE_GO_PROVIDER, id: DEEPSEEK_V4_FLASH_MODEL } });
    assert.deepEqual(read.prepareArguments({ path: "README.md", limit: 5 }), {
      path: "README.md",
      limit: 5,
      offset: 1,
      __deepseekReadNote: "Note: offset was not provided; defaulted to 1. To read a different range, retry with both offset and limit.",
    });
    assert.deepEqual(read.prepareArguments({ path: "README.md", offset: 10 }), {
      path: "README.md",
      offset: 10,
      limit: 2000,
      __deepseekReadNote: "Note: limit was not provided; defaulted to 2000 lines. To read a different range, retry with both offset and limit.",
    });

    handlers.agent_end[0]({}, {});
    assert.deepEqual(read.prepareArguments({ path: "README.md", limit: 5 }), { path: "README.md", limit: 5 });
  });

  it("enables wrapper repairs for Pro but not for direct DeepSeek or OpenAI turns", () => {
    const { handlers, tools } = createFakePi();
    handlers.session_start[0]({}, { cwd: process.cwd() });
    const read = tools.read;

    // Pro now gets repairs
    handlers.before_agent_start[0]({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["read"] } }, { model: { provider: OPENCODE_GO_PROVIDER, id: "deepseek-v4-pro" } });
    assert.notDeepEqual(read.prepareArguments({ path: "README.md", limit: 5 }), { path: "README.md", limit: 5 });
    handlers.agent_end[0]({}, {});

    for (const model of [
      { provider: "deepseek", id: DEEPSEEK_V4_FLASH_MODEL },
      { provider: "openai-codex", id: "gpt-5.5" },
    ]) {
      handlers.before_agent_start[0]({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["read"] } }, { model });
      assert.deepEqual(read.prepareArguments({ path: "README.md", limit: 5 }), { path: "README.md", limit: 5 });
      handlers.agent_end[0]({}, {});
    }
  });
});
