import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import { canonicalEntry, exactModel, modelRef } from "../lib/model-picker";

const models = [
  { provider: "zai-coding-cn", id: "glm-5.3" },
  { provider: "opencode-go", id: "deepseek-v4-pro" },
  { provider: "openrouter", id: "nvidia/nemotron:free" },
] as never[];

describe("model-picker thinking suffix", () => {
  it("exactModel matches refs with a trailing :level", () => {
    assert.equal(exactModel(models, "zai-coding-cn/glm-5.3:high") !== undefined, true);
    assert.equal(modelRef(exactModel(models, "zai-coding-cn/glm-5.3:high")!), "zai-coding-cn/glm-5.3");
  });

  it("exactModel keeps openrouter :free ids matchable", () => {
    assert.equal(modelRef(exactModel(models, "openrouter/nvidia/nemotron:free")!), "openrouter/nvidia/nemotron:free");
  });

  it("canonicalEntry re-attaches a valid level; unknown entries return as typed", () => {
    assert.equal(canonicalEntry(models, "glm-5.3:high"), "zai-coding-cn/glm-5.3:high");
    assert.equal(canonicalEntry(models, "glm-5.3"), "zai-coding-cn/glm-5.3");
    assert.equal(canonicalEntry(models, "openrouter/nvidia/nemotron:free"), "openrouter/nvidia/nemotron:free");
    assert.equal(canonicalEntry(models, "no-such/model:high"), "no-such/model:high");
  });
});
