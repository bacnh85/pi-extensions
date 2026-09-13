import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import { buildModelsPanelCfg, buildRows, cfgToModels, invalidThinkingSlots } from "../lib/models-panel";

describe("models-panel", () => {
  it("builds model + thinking rows per slot plus add/remove actions", () => {
    const cfg = buildModelsPanelCfg(["prov/a", "prov/b"]);
    const rows = buildRows(cfg, undefined, {
      addModel: { label: "+ Add model slot", run: () => {} },
      removeLast: { label: "− Remove last slot", run: () => {} },
    });
    const group = rows[0];
    assert.equal(group.key, "models");
    const strings = group.rows.filter((r) => r.kind === "string");
    assert.equal(strings.length, 4); // 2 slots × (ref + thinking)
    assert.match(strings[0].label, /primary/);
    assert.match(strings[1].label, /thinking/);
    const actions = group.rows.filter((r) => r.kind === "action");
    assert.equal(actions.length, 2);
  });

  it("row setters mutate the working config and completions expose model refs", () => {
    const cfg = buildModelsPanelCfg(["prov/a"]);
    const rows = buildRows(cfg, { models: () => ["prov/x", "prov/y"] });
    const slot = rows[0].rows.find((r) => r.kind === "string")!;
    assert.deepEqual((slot as any).completions().map((c: any) => c.value), ["prov/x", "prov/y"]);
    slot.set("prov/replaced ");
    assert.deepEqual(cfg.models[0].ref, "prov/replaced", "setter trims the entry");
  });

  it("cfgToModels drops blanks and keeps order", () => {
    const cfg = { models: [{ ref: "prov/a", thinking: "" }, { ref: "", thinking: "" }, { ref: "prov/c", thinking: "" }] };
    assert.deepEqual(cfgToModels(cfg), ["prov/a", "prov/c"]);
    assert.deepEqual(cfgToModels(buildModelsPanelCfg([])), []);
  });

  it("round-trip: chain → panel → save preserves plain and pinned entries", () => {
    const original = ["zai/glm", "opencode/deepseek:high"];
    const cfg = buildModelsPanelCfg(original);
    assert.equal(cfg.models[1].thinking, "high");
    const rows = buildRows(cfg);
    for (const r of rows[0].rows) if (r.kind === "string") r.set(r.value); // simulate save-applied setters
    assert.deepEqual(cfgToModels(cfg), original);
  });

  it("cfgToModels serializes thinking edits and drops invalid levels; invalidThinkingSlots reports them", () => {
    const cfg = buildModelsPanelCfg(["prov/a"]);
    const rows = buildRows(cfg);
    const thinkingRow = rows[0].rows.find((r) => r.key === "model.0.thinking")!;
    thinkingRow.set("low");
    assert.deepEqual(cfgToModels(cfg), ["prov/a:low"]);
    thinkingRow.set("hgh"); // typo
    assert.deepEqual(invalidThinkingSlots(cfg), [0]);
    assert.deepEqual(cfgToModels(cfg), ["prov/a"]);
    thinkingRow.set("off"); // expressible as no explicit level
    assert.deepEqual(invalidThinkingSlots(cfg), []);
    assert.deepEqual(cfgToModels(cfg), ["prov/a"]);
  });
});
