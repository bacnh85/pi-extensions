import assert from "node:assert";
import { describe, it } from "node:test";
import {
  MINIMAL_SYSTEM_PROMPT,
  BOOTSTRAP_TOOLS,
  anchorEnabled,
  isAnchorTarget,
  hasPromotionSignal,
  filterBootstrapTools,
  dshBootstrapTools,
  DSH_BOOTSTRAP_TOOL_DEFS,
  weNeedDirectiveEnabled,
  WE_NEED_DIRECTIVE,
} from "../../lib/ds-anchor.ts";
import { createStrReplaceEditorToolDefinition } from "../../lib/str-replace-editor.ts";

describe("ds-anchor env toggle", () => {
  it("anchorEnabled defaults on, disabled by false-like", () => {
    assert.equal(anchorEnabled({}), true);
    assert.equal(anchorEnabled({ PI_MODEL_TOOLS_DS_ANCHOR: "" }), true);
    assert.equal(anchorEnabled({ PI_MODEL_TOOLS_DS_ANCHOR: "0" }), false);
    assert.equal(anchorEnabled({ PI_MODEL_TOOLS_DS_ANCHOR: "off" }), false);
    assert.equal(anchorEnabled({ PI_MODEL_TOOLS_DS_ANCHOR: "no" }), false);
    assert.equal(anchorEnabled({ PI_MODEL_TOOLS_DS_ANCHOR: "false" }), false);
    assert.equal(anchorEnabled({ PI_MODEL_TOOLS_DS_ANCHOR: "1" }), true);
  });

  it("weNeedDirectiveEnabled defaults off, on by true-like", () => {
    assert.equal(weNeedDirectiveEnabled({}), false);
    assert.equal(weNeedDirectiveEnabled({ PI_MODEL_TOOLS_DS_ANCHOR_WE_NEED: "1" }), true);
    assert.equal(weNeedDirectiveEnabled({ PI_MODEL_TOOLS_DS_ANCHOR_WE_NEED: "on" }), true);
    assert.equal(weNeedDirectiveEnabled({ PI_MODEL_TOOLS_DS_ANCHOR_WE_NEED: "0" }), false);
    assert.match(WE_NEED_DIRECTIVE, /We need/);
  });
});

describe("isAnchorTarget", () => {
  it("matches v4-pro ids in any case/format, rejects everything else", () => {
    assert.equal(isAnchorTarget("deepseek-v4-pro"), true);
    assert.equal(isAnchorTarget("deepseek-v4-pro-0813"), true);
    assert.equal(isAnchorTarget("OCG/DeepSeek-V4-Pro"), true);
    assert.equal(isAnchorTarget("deepseek-v4-flash"), false);
    assert.equal(isAnchorTarget("deepseek-chat"), false);
    assert.equal(isAnchorTarget("deepseek-v3"), false);
    assert.equal(isAnchorTarget("glm-5.2"), false);
    assert.equal(isAnchorTarget(""), false);
    assert.equal(isAnchorTarget(undefined), false);
  });
});

describe("hasPromotionSignal", () => {
  it("assistant message with tool call promotes", () => {
    const entries = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1" }] } },
    ];
    assert.equal(hasPromotionSignal(entries), true);
  });

  it("text-only assistant message promotes", () => {
    const entries = [
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ];
    assert.equal(hasPromotionSignal(entries), true);
  });

  it("user-only entries do not promote", () => {
    const entries = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message", message: { role: "toolResult", content: [] } },
    ];
    assert.equal(hasPromotionSignal(entries), false);
  });

  it("empty entries do not promote", () => {
    assert.equal(hasPromotionSignal([]), false);
  });
});

describe("filterBootstrapTools", () => {
  const mixed = [
    { name: "bash", parameters: {} },
    { name: "str_replace_editor", parameters: {} },
    { name: "edit", parameters: {} },
    { name: "read", parameters: {} },
    { type: "function", function: { name: "grep" } },
  ];

  it("keeps only bash+str_replace_editor from a mixed catalog", () => {
    const res = filterBootstrapTools(mixed);
    assert.equal(res.ok, true);
    assert.deepEqual(res.tools.map((t: any) => t.name ?? t.function?.name), ["bash", "str_replace_editor"]);
  });

  it("OpenAI function.name shape is recognized", () => {
    const openaiShape = [
      { type: "function", function: { name: "str_replace_editor", parameters: {} } },
      { type: "function", function: { name: "bash", parameters: {} } },
    ];
    const res = filterBootstrapTools(openaiShape);
    assert.equal(res.ok, true);
    assert.equal(res.tools.length, 2);
  });

  it("missing str_replace_editor fails open with the original array", () => {
    const noEditor = [{ name: "bash" }, { name: "read" }];
    const res = filterBootstrapTools(noEditor);
    assert.equal(res.ok, false);
    assert.equal(res.tools, noEditor); // same reference — original returned
  });

  it("missing bash fails open", () => {
    const noBash = [{ name: "str_replace_editor" }];
    const res = filterBootstrapTools(noBash);
    assert.equal(res.ok, false);
    assert.equal(res.tools, noBash);
  });

  it("non-array tools fails open", () => {
    const res = filterBootstrapTools(undefined);
    assert.equal(res.ok, false);
    assert.deepEqual(res.tools, []);
  });
});

describe("dshBootstrapTools shape preservation", () => {
  it("flat payload shape in → flat DSH defs out", () => {
    const flat = [{ name: "bash", parameters: {} }, { name: "str_replace_editor", parameters: {} }, { name: "edit" }];
    const res = dshBootstrapTools(flat);
    assert.equal(res.ok, true);
    assert.equal(res.tools.length, 2);
    assert.equal((res.tools[0] as any).function, undefined, "no function wrapper for flat shape");
    assert.equal((res.tools[0] as any).name, "bash");
    assert.equal((res.tools[1] as any).name, "str_replace_editor");
    assert.equal((res.tools[1] as any).parameters.properties.command.enum.length, 4);
  });

  it("function-wrapped payload shape in → function-wrapped defs out", () => {
    const wrapped = [
      { type: "function", function: { name: "bash", parameters: {} } },
      { type: "function", function: { name: "str_replace_editor", parameters: {} } },
    ];
    const res = dshBootstrapTools(wrapped);
    assert.equal(res.ok, true);
    assert.equal((res.tools[0] as any).function.name, "bash");
    assert.equal((res.tools[1] as any).function.name, "str_replace_editor");
    assert.equal((res.tools[0] as any).name, undefined, "function-wrapped defs keep the wrapper");
  });

  it("missing pair still fails open", () => {
    const res = dshBootstrapTools([{ name: "bash" }, { name: "edit" }]);
    assert.equal(res.ok, false);
  });
});

describe("constants", () => {
  it("minimal prompt is byte-stable and bootstrap set is the real Minimal pair", () => {
    assert.equal(MINIMAL_SYSTEM_PROMPT, "You are a helpful software engineer assistant.");
    assert.deepEqual([...BOOTSTRAP_TOOLS], ["bash", "str_replace_editor"]);
  });

  it("DSH str_replace_editor def stays byte-identical to the registered tool", () => {
    // The bootstrap injects DSH_BOOTSTRAP_TOOL_DEFS; the tool the model then
    // calls routes to createStrReplaceEditorToolDefinition. Both carry the
    // SAME description + schema — drift here silently breaks the anchor's
    // "byte-exact schema" lever. (The registered TypeBox schema serializes
    // differently — this asserts the DESCRIPTION and semantic fields.)
    const dshEditor = DSH_BOOTSTRAP_TOOL_DEFS[1].function;
    const registered = createStrReplaceEditorToolDefinition("/tmp");
    assert.equal(dshEditor.description, registered.description, "editor description identical");
    assert.equal(dshEditor.parameters.required.join(","), "command,path", "DSH def requires command+path");
    assert.equal(dshEditor.parameters.properties.command.enum.length, 4, "command enum intact");
    assert.equal(dshEditor.parameters.properties.insert_line.type, "integer", "insert_line is integer in DSH def");
    // No strict/extra fields in the injected def (byte fidelity).
    assert.equal((DSH_BOOTSTRAP_TOOL_DEFS[1] as any).strict, undefined);
    assert.equal((DSH_BOOTSTRAP_TOOL_DEFS[0] as any).strict, undefined);
  });
});
