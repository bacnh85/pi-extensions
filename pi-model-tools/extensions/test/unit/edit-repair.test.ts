import assert from "node:assert";
import { describe, it } from "node:test";
import {
  stripReadContamination,
  findTrimMatch,
  fileBytesForBlock,
  nearestBlock,
  parseFailedEditIndex,
  isEditMismatchError,
  computeRetryEdit,
  computePreflightEdits,
  editErrorEnrichment,
  stripBom,
  normalizeToLF,
} from "../../lib/edit-repair.ts";

describe("stripBom / normalizeToLF", () => {
  it("strips a BOM", () => {
    assert.strictEqual(stripBom("\uFEFFhello"), "hello");
    assert.strictEqual(stripBom("hello"), "hello");
  });
  it("normalizes CRLF and lone CR to LF", () => {
    assert.strictEqual(normalizeToLF("a\r\nb\rc\nd"), "a\nb\nc\nd");
  });
});

describe("stripReadContamination", () => {
  it("strips 'Showing lines' notice (lines limit)", () => {
    const code = "const x = 1;\nconst y = 2;";
    const contaminated = `${code}\n\n[Showing lines 1-2 of 50. Use offset=3 to continue.]`;
    const r = stripReadContamination(contaminated);
    assert.strictEqual(r.text, code);
    assert.strictEqual(r.changed, true);
  });
  it("strips 'Showing lines' notice (bytes limit)", () => {
    const code = "const x = 1;";
    const contaminated = `${code}\n\n[Showing lines 1-1 of 10 (50KB limit). Use offset=2 to continue.]`;
    assert.strictEqual(stripReadContamination(contaminated).text, code);
  });
  it("strips 'N more lines in file' notice", () => {
    const code = "const x = 1;";
    const contaminated = `${code}\n\n[48 more lines in file. Use offset=2 to continue.]`;
    assert.strictEqual(stripReadContamination(contaminated).text, code);
  });
  it("strips 'Line X is SIZE' bash-fallback notice", () => {
    const code = "const x = 1;";
    const contaminated = `${code}\n[Line 5 is 80KB, exceeds 50KB limit. Use bash: sed -n '5p' x.ts | head -c 51200]`;
    assert.strictEqual(stripReadContamination(contaminated).text, code);
  });
  it("is a no-op on clean code", () => {
    const code = "function f() {\n  return 1;\n}\n";
    const r = stripReadContamination(code);
    assert.strictEqual(r.text, code);
    assert.strictEqual(r.changed, false);
  });
  it("does NOT strip a literal '[Showing lines' that is not a read notice", () => {
    // A comment that merely mentions the words but lacks the exact notice shape.
    const code = "// [Showing lines is not enough info]\nconst x = 1;";
    const r = stripReadContamination(code);
    assert.strictEqual(r.text, code);
    assert.strictEqual(r.changed, false);
  });
});

describe("findTrimMatch", () => {
  it("matches exactly (count 1)", () => {
    const content = "a\nb\nc\nd";
    const r = findTrimMatch(content, "b\nc");
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.firstIndex, 1);
  });
  it("tolerates leading-whitespace drift (the Codex .trim() pass gap)", () => {
    const content = "  a\n    b\n  c\n    d";
    const oldText = "a\nb"; // model dropped indentation
    const r = findTrimMatch(content, oldText);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.firstIndex, 0);
  });
  it("counts multiple matches", () => {
    const content = "x\nx\nx";
    const r = findTrimMatch(content, "x");
    assert.strictEqual(r.count, 3);
    assert.strictEqual(r.firstIndex, 0);
  });
  it("returns count 0 when not found", () => {
    const r = findTrimMatch("a\nb", "z");
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.firstIndex, -1);
  });
  it("ignores a single trailing empty pattern line", () => {
    const content = "a\nb";
    const r = findTrimMatch(content, "a\nb\n");
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.firstIndex, 0);
  });
  it("returns 0 when pattern longer than file", () => {
    const r = findTrimMatch("a", "a\nb\nc");
    assert.strictEqual(r.count, 0);
  });
});

describe("fileBytesForBlock", () => {
  it("returns actual file lines with real indentation", () => {
    const content = "  a\n    b\n  c";
    // matched block starts at line 0, length 2
    assert.strictEqual(fileBytesForBlock(content, 0, 2), "  a\n    b");
  });
});

describe("nearestBlock", () => {
  it("returns a numbered region with the most overlap", () => {
    const content = "alpha\nbeta\ngamma\ndelta\nepsilon";
    const oldText = "beta\ngamma";
    const out = nearestBlock(content, oldText, 2);
    assert.match(out, /Nearest matching region/);
    assert.match(out, /\| beta/);
    assert.match(out, /\| gamma/);
    // includes line numbers
    assert.match(out, /\d+ \|/);
  });
  it("returns empty string for empty oldText", () => {
    assert.strictEqual(nearestBlock("a\nb", ""), "");
  });
});

describe("parseFailedEditIndex", () => {
  it("parses edits[N] index", () => {
    assert.strictEqual(parseFailedEditIndex("Could not find edits[2] in foo."), 2);
  });
  it("defaults to 0 for single-edit errors", () => {
    assert.strictEqual(parseFailedEditIndex("Could not find the exact text in foo."), 0);
  });
});

describe("isEditMismatchError", () => {
  it("matches could-not-find", () => {
    assert.ok(isEditMismatchError("Could not find the exact text in x.ts."));
  });
  it("matches duplicate occurrences", () => {
    assert.ok(isEditMismatchError("Found 3 occurrences of the text in x.ts."));
  });
  it("matches uniqueness", () => {
    assert.ok(isEditMismatchError("The oldText must match exactly including all whitespace."));
  });
  it("rejects unrelated errors", () => {
    assert.ok(!isEditMismatchError("Operation aborted"));
    assert.ok(!isEditMismatchError("Error code: ENOENT"));
  });
});

describe("computeRetryEdit", () => {
  it("rebuilds oldText from the file's real bytes when there is one trim match (indentation drift)", () => {
    // File uses 4-space indent; model's oldText dropped indentation.
    const fileContent = "  a\n    b\n  c";
    const edits = [{ oldText: "a\nb", newText: "A\nB" }];
    const r = computeRetryEdit(fileContent, edits, 0);
    assert.ok(r, "expected a retry result");
    // corrected oldText must use the FILE's real indentation so the core exact matcher passes
    assert.equal(r!.fixedEdits[0].oldText, "  a\n    b");
    assert.equal(r!.fixedEdits[0].newText, "A\nB");
  });

  it("returns null when the trim match is ambiguous (count > 1)", () => {
    const fileContent = "x\nx\nx";
    const r = computeRetryEdit(fileContent, [{ oldText: "x", newText: "y" }], 0);
    assert.equal(r, null);
  });

  it("returns null when there is no trim match (count 0)", () => {
    const r = computeRetryEdit("a\nb", [{ oldText: "zzz", newText: "y" }], 0);
    assert.equal(r, null);
  });

  it("only rebuilds the failing edit index in a multi-edit array", () => {
    const fileContent = "one\ntwo\nthree";
    const edits = [
      { oldText: "one", newText: "ONE" },
      { oldText: "two", newText: "TWO" },
    ];
    const r = computeRetryEdit(fileContent, edits, 1);
    assert.ok(r);
    assert.equal(r!.fixedEdits[0].oldText, "one");   // untouched
    assert.equal(r!.fixedEdits[1].oldText, "two");   // rebuilt (verbatim here, exact match)
    assert.equal(r!.fixedEdits[1].newText, "TWO");
  });

  it("clamps failIdx past the array length to the last edit", () => {
    const r = computeRetryEdit("a", [{ oldText: "a", newText: "A" }], 9);
    assert.ok(r);
    assert.equal(r!.fixedEdits[0].oldText, "a");
  });

  it("drops a single trailing empty pattern line (stays in sync with findTrimMatch)", () => {
    const fileContent = "a\nb";
    const r = computeRetryEdit(fileContent, [{ oldText: "a\nb\n", newText: "A\nB\n" }], 0);
    assert.ok(r);
    assert.equal(r!.fixedEdits[0].oldText, "a\nb");
  });
});

describe("computePreflightEdits", () => {
  it("rewrites indentation-drifted oldText to the file's real bytes when exactly one trim match exists", () => {
    const fileContent = "  a\n    b\n  c";
    const edits = [{ oldText: "a\nb", newText: "A\nB" }];
    const r = computePreflightEdits(fileContent, edits);
    assert.ok(r, "expected a pre-flight result");
    assert.equal(r!.fixedEdits[0].oldText, "  a\n    b");
    assert.equal(r!.fixedEdits[0].newText, "A\nB");
  });

  it("returns null when nothing needs fixing (exact match)", () => {
    const r = computePreflightEdits("  a\n  b", [{ oldText: "  a", newText: "A" }]);
    assert.equal(r, null);
  });

  it("returns null when the trim match is ambiguous (count > 1)", () => {
    const r = computePreflightEdits("x\nx\nx", [{ oldText: "x", newText: "y" }]);
    assert.equal(r, null);
  });

  it("returns null when there is no trim match (count 0)", () => {
    const r = computePreflightEdits("a\nb", [{ oldText: "zzz", newText: "y" }]);
    assert.equal(r, null);
  });

  it("returns null when oldText is missing/empty", () => {
    const r = computePreflightEdits("a\nb", [{ oldText: "", newText: "y" }]);
    assert.equal(r, null);
  });

  it("only rewrites the edits that drifted, leaving exact edits untouched", () => {
    const fileContent = "one\n  two\nthree";
    const edits = [
      { oldText: "one", newText: "ONE" },
      { oldText: "two", newText: "TWO" }, // indentation drifted vs file's "  two"
    ];
    const r = computePreflightEdits(fileContent, edits);
    assert.ok(r);
    assert.equal(r!.fixedEdits[0].oldText, "one");      // untouched
    assert.equal(r!.fixedEdits[1].oldText, "  two");    // rebuilt
    assert.equal(r!.fixedEdits[1].newText, "TWO");
  });
});

describe("editErrorEnrichment", () => {
  const content = "alpha\nbeta\ngamma\ndelta";

  it("returns undefined for non-mismatch errors", () => {
    assert.equal(editErrorEnrichment(content, "Operation aborted", [{ oldText: "beta", newText: "B" }]), undefined);
  });

  it("returns undefined for empty edits array", () => {
    assert.equal(editErrorEnrichment(content, "Could not find the exact text in x.", []), undefined);
  });

  it("returns undefined when the failing edit has no oldText", () => {
    const r = editErrorEnrichment(content, "Could not find the exact text in x.", [{ oldText: "", newText: "B" }]);
    assert.equal(r, undefined);
  });

  it("appends the nearest numbered region to a mismatch error", () => {
    const enriched = editErrorEnrichment(content, "Could not find the exact text in x.", [{ oldText: "beta\ngamma", newText: "B\nG" }]);
    assert.ok(enriched);
    assert.match(enriched!, /Could not find the exact text/);
    assert.match(enriched!, /Nearest matching region/);
    assert.match(enriched!, /\| beta/);
  });

  it("uses the edits[N] index from the error for multi-edit arrays", () => {
    const edits = [
      { oldText: "alpha", newText: "A" },
      { oldText: "gamma", newText: "G" },
    ];
    const enriched = editErrorEnrichment(content, "Could not find edits[1] in x.", edits);
    assert.ok(enriched);
    assert.match(enriched!, /\| gamma/);
  });

  it("clamps an out-of-range index to the last edit", () => {
    const edits = [{ oldText: "beta", newText: "B" }];
    const enriched = editErrorEnrichment(content, "Could not find edits[9] in x.", edits);
    assert.ok(enriched);
    assert.match(enriched!, /\| beta/);
  });
});
