import assert from "node:assert/strict";
import { test } from "node:test";
import { computeTokPerSec, readThinkingTokens } from "../lib/tok-per-sec.ts";

test("tok/s includes thinking tokens in withThinking", () => {
  // 200 output + 300 thinking tokens over 10s: out=20, out+think=50.
  const tps = computeTokPerSec(200, 300, 10_000);
  assert.equal(tps.out, 20);
  assert.equal(tps.withThinking, 50);
});

test("readThinkingTokens accepts known usage spellings", () => {
  assert.equal(readThinkingTokens({ thinking: 7 }), 7);
  assert.equal(readThinkingTokens({ reasoning: 6 }), 6); // Pi SDK field name
  assert.equal(readThinkingTokens({ reasoning_tokens: 8 }), 8);
  assert.equal(readThinkingTokens({ output_tokens_details: { reasoning_tokens: 9 } }), 9);
  assert.equal(readThinkingTokens({ output: 5 }), 0);
  assert.equal(readThinkingTokens(undefined), 0);
});
