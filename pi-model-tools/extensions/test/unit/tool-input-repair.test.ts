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

describe("unwrapDegenerateMarkdownAutolink", () => {
  it("unwraps when text and normalized url match", () => {
    assert.strictEqual(unwrapDegenerateMarkdownAutolink("[readme.md](https://readme.md)"), "readme.md");
  });
  it("does NOT unwrap when url differs", () => {
    const input = "[click](https://example.com)";
    assert.strictEqual(unwrapDegenerateMarkdownAutolink(input), input);
  });
});
