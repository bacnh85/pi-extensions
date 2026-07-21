import assert from "node:assert/strict";
import test from "node:test";
import { hasUnsupportedRtkFind } from "../findFallback.js";

test("suppresses compound/action rtk find rewrites", () => {
  assert.equal(hasUnsupportedRtkFind('rtk find . -type f -name "*.ts" -o -name "*.tsx"'), true);
  assert.equal(hasUnsupportedRtkFind('rtk find . -name "*.js" -exec wc -l {} \\;'), true);
  assert.equal(hasUnsupportedRtkFind("rtk find . -type f '(' -name '*.ts' ')'"), true);
});

test("allows simple rtk find and non-find rewrites", () => {
  assert.equal(hasUnsupportedRtkFind('rtk find . -name "*.ts" -type f'), false);
  assert.equal(hasUnsupportedRtkFind('rtk grep foo .'), false);
  assert.equal(hasUnsupportedRtkFind('rtk find . -name "*.ts" | head -20'), false);
});
