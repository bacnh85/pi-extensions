import assert from "node:assert/strict";
import test from "node:test";

import { getUxInstructions } from "../../hooks/ux-instructions.js";

test("getUxInstructions returns banner + SKILL.md body with frontmatter stripped", () => {
  const out = getUxInstructions("strict");
  assert.ok(out.startsWith("UX DISCIPLINE ACTIVE — level: strict."));
  assert.ok(out.includes("DESIGN.md")); // body content present, not the fallback
  // Frontmatter delimiters are gone (first line is the banner).
  assert.ok(!out.slice(0, out.indexOf("\n", out.indexOf("\n") + 1)).includes("---"));
});

test("getUxInstructions lite banner + stable output across calls (memoized read)", () => {
  const a = getUxInstructions("lite");
  const b = getUxInstructions("lite");
  assert.ok(a.startsWith("UX DISCIPLINE ACTIVE — level: lite."));
  assert.equal(a, b); // unchanged file ⇒ cached body, identical output
});
