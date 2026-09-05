import assert from "node:assert/strict";
import { test } from "node:test";
import { supportedAdapter } from "../index.ts";

test("zai-anthropic model maps to the Z.ai (Anthropic) usage adapter", () => {
  const a = supportedAdapter({ provider: "zai-anthropic", id: "glm-5.3-flash" });
  assert.ok(a);
  assert.equal(a.id, "zai-anthropic");
  assert.equal(a.displayName, "Z.ai (Anthropic)");
  assert.equal(typeof a.fetchUsage, "function");
});

test("sibling zai legs unchanged (regression guard)", () => {
  assert.equal(supportedAdapter({ provider: "zai", id: "glm-5.3" })?.id, "zai");
  assert.equal(supportedAdapter({ provider: "zai-coding-cn", id: "glm-5.3" })?.id, "zai-coding-cn");
  assert.equal(supportedAdapter({ provider: "acme", id: "whatever" }), undefined);
});
