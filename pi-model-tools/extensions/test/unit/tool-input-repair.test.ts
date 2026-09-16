import assert from "node:assert";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { repairToolArguments, unwrapDegenerateMarkdownAutolink } from "../../lib/tool-input-repair.ts";

describe("repairToolArguments (no repair needed)", () => {
  it("returns args as-is when valid", () => {
    const schema = Type.Object({ path: Type.String(), offset: Type.Number() });
    const args = { path: "file.ts", offset: 10 };
    const result = repairToolArguments("read", schema, args);
    assert.strictEqual(result.repaired, false);
    assert.strictEqual(result.args, args);
  });
});

describe("repairToolArguments — JSON string repairs", () => {
  it("repairs JSON-string param that should be an object", () => {
    const schema = Type.Object({ data: Type.Object({ command: Type.String(), page_id: Type.String() }) });
    const args = { data: '{"command":"update","page_id":"abc"}' };
    const result = repairToolArguments("test", schema, args);
    assert.strictEqual(result.repaired, true);
    assert.deepStrictEqual(result.args, { data: { command: "update", page_id: "abc" } });
  });
  it("repairs JSON-string param that should be an array", () => {
    const schema = Type.Object({ items: Type.Array(Type.String()) });
    const result = repairToolArguments("test", schema, { items: '["a","b"]' });
    assert.strictEqual(result.repaired, true);
    assert.deepStrictEqual(result.args, { items: ["a", "b"] });
  });
  it("repairs empty-object as array", () => {
    const schema = Type.Object({ tags: Type.Array(Type.String()) });
    const result = repairToolArguments("test", schema, { tags: {} });
    assert.strictEqual(result.repaired, true);
    assert.deepStrictEqual(result.args, { tags: [] });
  });
  it("repairs bare string as array", () => {
    const schema = Type.Object({ files: Type.Array(Type.String()) });
    const result = repairToolArguments("test", schema, { files: "x.ts" });
    assert.strictEqual(result.repaired, true);
    assert.deepStrictEqual(result.args, { files: ["x.ts"] });
  });
});

describe("repairToolArguments — top-level JSON string (GLM-4.7 bug)", () => {
  it("repairs when entire args is a JSON string expecting object", () => {
    const schema = Type.Object({ command: Type.String(), page_id: Type.String() });
    const result = repairToolArguments("test", schema, '{"command":"update","page_id":"abc"}');
    assert.strictEqual(result.repaired, true);
    assert.ok(result.repairs.includes("top-level-json-string"));
    assert.deepStrictEqual(result.args, { command: "update", page_id: "abc" });
  });
  it("does not repair invalid JSON string", () => {
    const schema = Type.Object({ command: Type.String() });
    assert.strictEqual(repairToolArguments("test", schema, "not-json").repaired, false);
  });
});

describe("repairToolArguments — optional null deletion", () => {
  it("deletes null optional properties", () => {
    const schema = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()) });
    const result = repairToolArguments("read", schema, { path: "f.ts", offset: null });
    assert.strictEqual(result.repaired, true);
    assert.deepStrictEqual(result.args, { path: "f.ts" });
  });
});

describe("repairToolArguments — truncated JSON auto-close (DeepSeek)", () => {
  it("repairs a JSON-string param truncated mid-object", () => {
    const schema = Type.Object({ data: Type.Object({ command: Type.String(), page_id: Type.String() }) });
    const result = repairToolArguments("test", schema, { data: '{"command":"update","page_id":"abc"' });
    assert.strictEqual(result.repaired, true);
    assert.ok(result.repairs.includes("truncated-json-closed"));
    assert.deepStrictEqual(result.args, { data: { command: "update", page_id: "abc" } });
  });
  it("repairs a JSON-string param truncated mid-array", () => {
    const schema = Type.Object({ data: Type.Object({ items: Type.Array(Type.String()) }) });
    const result = repairToolArguments("test", schema, { data: '{"items":["a","b"' });
    assert.strictEqual(result.repaired, true);
    assert.ok(result.repairs.includes("truncated-json-closed"));
    assert.deepStrictEqual(result.args, { data: { items: ["a", "b"] } });
  });
  it("repairs truncation after a trailing comma in an array", () => {
    const schema = Type.Object({ data: Type.Object({ items: Type.Array(Type.String()) }) });
    const result = repairToolArguments("test", schema, { data: '{"items":["a","b",' });
    assert.strictEqual(result.repaired, true);
    assert.ok(result.repairs.includes("truncated-json-closed"));
    assert.deepStrictEqual(result.args, { data: { items: ["a", "b"] } });
  });
  it("repairs truncation after a trailing comma in an object", () => {
    const schema = Type.Object({ data: Type.Object({ a: Type.Number(), b: Type.Number() }) });
    const result = repairToolArguments("test", schema, { data: '{"a":1,"b":2,' });
    assert.strictEqual(result.repaired, true);
    assert.ok(result.repairs.includes("truncated-json-closed"));
    assert.deepStrictEqual(result.args, { data: { a: 1, b: 2 } });
  });
  it("repairs truncation inside an unterminated string value", () => {
    const schema = Type.Object({ data: Type.Object({ key: Type.String() }) });
    const result = repairToolArguments("test", schema, { data: '{"key":"partial_val' });
    assert.strictEqual(result.repaired, true);
    assert.ok(result.repairs.includes("truncated-json-closed"));
    assert.deepStrictEqual(result.args, { data: { key: "partial_val" } });
  });
  it("repairs a dangling escape backslash at end of a string value", () => {
    const schema = Type.Object({ data: Type.Object({ path: Type.String() }) });
    const result = repairToolArguments("test", schema, { data: '{"path":"C:\\' });
    assert.strictEqual(result.repaired, true);
    assert.ok(result.repairs.includes("truncated-json-closed"));
    assert.deepStrictEqual(result.args, { data: { path: "C:\\" } });
  });
  it("repairs a field-level truncated array (not wrapped in an object)", () => {
    const schema = Type.Object({ items: Type.Array(Type.String()) });
    const result = repairToolArguments("test", schema, { items: '["a","b"' });
    assert.strictEqual(result.repaired, true);
    assert.ok(result.repairs.includes("truncated-json-closed"));
    assert.deepStrictEqual(result.args, { items: ["a", "b"] });
  });
  it("repairs a truncated top-level JSON string", () => {
    const schema = Type.Object({ command: Type.String(), page_id: Type.String() });
    const result = repairToolArguments("test", schema, '{"command":"update","page_id":"abc"');
    assert.strictEqual(result.repaired, true);
    assert.ok(result.repairs.includes("truncated-json-closed"));
    assert.deepStrictEqual(result.args, { command: "update", page_id: "abc" });
  });
  it("ignores closing brackets inside string literals", () => {
    const schema = Type.Object({ data: Type.Object({ path: Type.String(), flag: Type.Boolean() }) });
    const result = repairToolArguments("test", schema, { data: '{"path":"a}b","flag":true' });
    assert.strictEqual(result.repaired, true);
    assert.ok(result.repairs.includes("truncated-json-closed"));
    assert.deepStrictEqual(result.args, { data: { path: "a}b", flag: true } });
  });
  it("does not repair non-JSON garbage", () => {
    const schema = Type.Object({ data: Type.Object({ x: Type.String() }) });
    const result = repairToolArguments("test", schema, { data: "not json at all" });
    assert.strictEqual(result.repaired, false);
  });
});

describe("repairToolArguments — param-name aliases (cross-harness)", () => {
  const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });

  it("repairs Claude-Code-style file_path → path", () => {
    const result = repairToolArguments("write", writeSchema, { file_path: "src/new.ts", content: "export {}\n" });
    assert.strictEqual(result.repaired, true);
    assert.ok(result.repairs.includes("param-alias"));
    assert.deepStrictEqual(result.args, { path: "src/new.ts", content: "export {}\n" });
  });

  it("repairs file_text → content", () => {
    const result = repairToolArguments("write", writeSchema, { path: "a.txt", file_text: "hello" });
    assert.strictEqual(result.repaired, true);
    assert.ok(result.repairs.includes("param-alias"));
    assert.deepStrictEqual(result.args, { path: "a.txt", content: "hello" });
  });

  it("does not repair when both alias and target are present", () => {
    const strict = Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false });
    const result = repairToolArguments("write", strict, { path: "a.txt", file_path: "b.txt", content: "x" });
    assert.strictEqual(result.repaired, false);
    assert.deepStrictEqual(result.args, { path: "a.txt", file_path: "b.txt", content: "x" });
  });

  it("does not rename wrong-typed alias values (repaired stays false, args unchanged)", () => {
    const args = { file_path: 123, content: "x" };
    const result = repairToolArguments("write", writeSchema, args);
    assert.strictEqual(result.repaired, false);
    assert.deepStrictEqual(result.args, args);
  });

  it("does not alias for non-built-in tools", () => {
    const result = repairToolArguments("some_extension_tool", writeSchema, { file_path: "a.txt", content: "x" });
    assert.strictEqual(result.repaired, false);
  });

  it("does not alias when the target is not a required schema property", () => {
    // `content` absent from schema entirely → alias map is schema-guarded
    const result = repairToolArguments("write", Type.Object({ path: Type.String() }), { file_text: "x", path: "a" });
    assert.strictEqual(result.repaired, false);
  });
});

describe("unwrapDegenerateMarkdownAutolink", () => {
  it("unwraps when text and normalized url match", () => {
    assert.strictEqual(unwrapDegenerateMarkdownAutolink("[readme.md](https://readme.md)"), "readme.md");
  });
  it("does NOT unwrap when url differs", () => {
    const input = "[click](https://example.com)";
    assert.strictEqual(unwrapDegenerateMarkdownAutolink(input), input);
  });
});
