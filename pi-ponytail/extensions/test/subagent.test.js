import assert from "node:assert/strict";
import test from "node:test";

import { getSubagentInstructions, shouldInjectSubagentInstructions } from "../../hooks/ponytail-subagent.js";

test("getSubagentInstructions includes the ladder, mode name, and full-output carve-out", () => {
  const block = getSubagentInstructions("ultra");
  assert.match(block, /level: ultra \(inherited from parent\)/);
  assert.match(block, /The ladder \(stop at the first rung that holds\)/);
  assert.match(block, /Already in this codebase\? Reuse it/);
  assert.match(block, /`ponytail:` comment/);
  assert.match(block, /ONE runnable check/);
  assert.match(block, /deliver in full/);
  // Output-format rules must NOT squash planner/reviewer reports.
  assert.doesNotMatch(block, /Code first/);
});

test("shouldInjectSubagentInstructions defaults on and honors PONYTAIL_SUBAGENT_SCOPE=off", () => {
  const prev = process.env.PONYTAIL_SUBAGENT_SCOPE;
  try {
    delete process.env.PONYTAIL_SUBAGENT_SCOPE;
    assert.equal(shouldInjectSubagentInstructions(), true);
    process.env.PONYTAIL_SUBAGENT_SCOPE = "off";
    assert.equal(shouldInjectSubagentInstructions(), false);
    process.env.PONYTAIL_SUBAGENT_SCOPE = "OFF ";
    assert.equal(shouldInjectSubagentInstructions(), false);
    process.env.PONYTAIL_SUBAGENT_SCOPE = "all";
    assert.equal(shouldInjectSubagentInstructions(), true);
  } finally {
    if (prev === undefined) delete process.env.PONYTAIL_SUBAGENT_SCOPE;
    else process.env.PONYTAIL_SUBAGENT_SCOPE = prev;
  }
});
