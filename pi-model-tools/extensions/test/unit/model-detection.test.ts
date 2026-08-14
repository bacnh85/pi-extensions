import assert from "node:assert";
import { describe, it } from "node:test";
import { detectFamily, isRecord, repairEnabled, reasoningStripEnabled, blockDangerousEnabled, maxErrorHistory, autoBlockAfterReminders, applyPatchEnabled, isSandboxed } from "../../lib/model-detection.ts";

describe("detectFamily", () => {
  const cases: Array<{ id: string; provider?: string; expected: string | null; label: string }> = [
    // DeepSeek V4
    { id: "deepseek-v4-flash", provider: "opencode-go", expected: "deepseek-v4", label: "deepseek-v4-flash" },
    { id: "deepseek-v4-pro", provider: "opencode-go", expected: "deepseek-v4", label: "deepseek-v4-pro" },
    { id: "ocg/deepseek-v4-flash", provider: "9router", expected: "deepseek-v4", label: "9router deepseek" },
    // GLM family
    { id: "glm-5.2", provider: "zai-coding-cn", expected: "glm", label: "glm-5.2" },
    { id: "glm-4.7", provider: "zai", expected: "glm", label: "glm-4.7" },
    { id: "z-ai/glm-5.2", provider: "openrouter", expected: "glm", label: "openrouter glm" },
    { id: "glm-5-turbo", provider: "zai", expected: "glm", label: "glm-5-turbo" },
    // Non-matching
    { id: "claude-opus-4.8", provider: "anthropic", expected: null, label: "claude" },
    { id: "gpt-5.5", provider: "openai", expected: null, label: "gpt" },
    { id: "deepseek-v3", provider: "deepseek", expected: null, label: "deepseek-v3 (not v4)" },
  ];
  for (const { id, provider, expected, label } of cases) {
    it(`detects ${label} as ${expected}`, () => {
      assert.strictEqual(detectFamily({ id, provider }), expected);
    });
  }
  it("returns null for empty/undefined", () => {
    assert.strictEqual(detectFamily(undefined), null);
    assert.strictEqual(detectFamily({}), null);
  });
});

describe("isRecord", () => {
  it("returns true for plain objects", () => { assert.strictEqual(isRecord({}), true); assert.strictEqual(isRecord({ a: 1 }), true); });
  it("returns false for null, arrays, primitives", () => { assert.strictEqual(isRecord(null), false); assert.strictEqual(isRecord([]), false); assert.strictEqual(isRecord("x"), false); });
});

describe("config helpers", () => {
  it("repairEnabled defaults to true", () => { assert.strictEqual(repairEnabled({}), true); assert.strictEqual(repairEnabled({ PI_MODEL_TOOLS_REPAIR_ENABLED: "0" }), false); });
  it("reasoningStripEnabled defaults to true (cache-stable for DeepSeek)", () => { assert.strictEqual(reasoningStripEnabled({}), true); assert.strictEqual(reasoningStripEnabled({ PI_MODEL_TOOLS_STRIP_REASONING: "0" }), false); assert.strictEqual(reasoningStripEnabled({ PI_MODEL_TOOLS_STRIP_REASONING: "off" }), false); });
  it("blockDangerousEnabled defaults to true", () => { assert.strictEqual(blockDangerousEnabled({}), true); assert.strictEqual(blockDangerousEnabled({ PI_MODEL_TOOLS_BLOCK_DANGEROUS_COMMANDS: "0" }), false); });
  it("applyPatchEnabled defaults to true (opt-out via 0/false/off)", () => {
    assert.strictEqual(applyPatchEnabled({}), true);
    assert.strictEqual(applyPatchEnabled({ PI_MODEL_TOOLS_APPLY_PATCH: "0" }), false);
    assert.strictEqual(applyPatchEnabled({ PI_MODEL_TOOLS_APPLY_PATCH: "false" }), false);
    assert.strictEqual(applyPatchEnabled({ PI_MODEL_TOOLS_APPLY_PATCH: "no" }), false);
    assert.strictEqual(applyPatchEnabled({ PI_MODEL_TOOLS_APPLY_PATCH: "off" }), false);
    assert.strictEqual(applyPatchEnabled({ PI_MODEL_TOOLS_APPLY_PATCH: "1" }), true);
    assert.strictEqual(applyPatchEnabled({ PI_MODEL_TOOLS_APPLY_PATCH: "true" }), true);
  });
  it("maxErrorHistory defaults to 100", () => {
    assert.strictEqual(maxErrorHistory({}), 100);
    assert.strictEqual(maxErrorHistory({ PI_MODEL_TOOLS_MAX_ERROR_HISTORY: "200" }), 200);
    assert.strictEqual(maxErrorHistory({ PI_MODEL_TOOLS_MAX_ERROR_HISTORY: "0" }), 100);
    assert.strictEqual(maxErrorHistory({ PI_MODEL_TOOLS_MAX_ERROR_HISTORY: "-5" }), 100);
    assert.strictEqual(maxErrorHistory({ PI_MODEL_TOOLS_MAX_ERROR_HISTORY: "abc" }), 100);
    assert.strictEqual(maxErrorHistory({ PI_MODEL_TOOLS_MAX_ERROR_HISTORY: "" }), 100);
  });
  it("autoBlockAfterReminders defaults to 0 (off)", () => {
    assert.strictEqual(autoBlockAfterReminders({}), 0);
    assert.strictEqual(autoBlockAfterReminders({ PI_MODEL_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "5" }), 5);
    assert.strictEqual(autoBlockAfterReminders({ PI_MODEL_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "1" }), 1);
    assert.strictEqual(autoBlockAfterReminders({ PI_MODEL_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "0" }), 0);
    assert.strictEqual(autoBlockAfterReminders({ PI_MODEL_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "-3" }), 0);
    assert.strictEqual(autoBlockAfterReminders({ PI_MODEL_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "abc" }), 0);
    assert.strictEqual(autoBlockAfterReminders({ PI_MODEL_TOOLS_AUTO_BLOCK_AFTER_REMINDERS: "" }), 0);
  });
});

describe("isSandboxed", () => {
  const hostTools = [
    { name: "read", sourceInfo: { source: "builtin" } },
    { name: "write", sourceInfo: { source: "builtin" } },
    { name: "edit", sourceInfo: { source: "builtin" } },
    { name: "bash", sourceInfo: { source: "builtin" } },
    { name: "ls", sourceInfo: { source: "builtin" } },
    { name: "grep", sourceInfo: { source: "builtin" } },
    { name: "find", sourceInfo: { source: "builtin" } },
    { name: "apply_patch", sourceInfo: { source: "@bacnh85/pi-model-tools" } },
  ];

  it("declared 1/true/yes/on → sandboxed regardless of tools", () => {
    assert.strictEqual(isSandboxed({ PI_TOOLS_ARE_SANDBOXED: "1" }), true);
    assert.strictEqual(isSandboxed({ PI_TOOLS_ARE_SANDBOXED: "true" }, hostTools), true);
    assert.strictEqual(isSandboxed({ PI_TOOLS_ARE_SANDBOXED: "yes" }), true);
    assert.strictEqual(isSandboxed({ PI_TOOLS_ARE_SANDBOXED: "on" }), true);
  });

  it("declared 0/false/no/off → not sandboxed even with extension-owned host tools", () => {
    const sandboxed = hostTools.map((t) => ({ ...t, sourceInfo: { source: "some-sandbox" } }));
    assert.strictEqual(isSandboxed({ PI_TOOLS_ARE_SANDBOXED: "0" }, sandboxed), false);
    assert.strictEqual(isSandboxed({ PI_TOOLS_ARE_SANDBOXED: "false" }, sandboxed), false);
    assert.strictEqual(isSandboxed({ PI_TOOLS_ARE_SANDBOXED: "no" }, sandboxed), false);
    assert.strictEqual(isSandboxed({ PI_TOOLS_ARE_SANDBOXED: "off" }, sandboxed), false);
  });

  it("unset + host-owned built-in tools → auto-detects the sandbox", () => {
    const sandboxed = hostTools.map((t) => ({ ...t, sourceInfo: { source: "some-sandbox" } }));
    assert.strictEqual(isSandboxed({}, sandboxed), true);
    assert.strictEqual(isSandboxed({ PI_TOOLS_ARE_SANDBOXED: "" }, sandboxed), true);
  });

  it("unset + builtin-source tools → not sandboxed", () => {
    assert.strictEqual(isSandboxed({}, hostTools), false);
  });

  it("unset + no tools or missing sourceInfo → not sandboxed", () => {
    assert.strictEqual(isSandboxed({}), false);
    assert.strictEqual(isSandboxed({}, [{ name: "read" }]), false);
    assert.strictEqual(isSandboxed({}, [{ name: "read", sourceInfo: null }]), false);
  });

  it("only host file tools (read/write/edit/bash) count, not auxiliary tools", () => {
    assert.strictEqual(isSandboxed({}, [{ name: "ls", sourceInfo: { source: "ext" } }]), false);
    assert.strictEqual(isSandboxed({}, [{ name: "request_access", sourceInfo: { source: "ext" } }]), false);
    assert.strictEqual(isSandboxed({}, [{ name: "bash", sourceInfo: { source: "ext" } }]), true);
  });
});
