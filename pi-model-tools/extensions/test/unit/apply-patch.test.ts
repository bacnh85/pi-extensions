import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePatch,
  seekSequence,
  applyPatchToFiles,
  PatchParseError,
} from "../../lib/apply-patch.ts";

describe("parsePatch", () => {
  it("parses an update op with context/removed/added", () => {
    const p = parsePatch(
      "*** Begin Patch\n*** Update File: a.ts\n@@ ctx\n-old\n+new\n*** End Patch",
    );
    assert.strictEqual(p.ops.length, 1);
    assert.strictEqual(p.ops[0].kind, "update");
    assert.strictEqual(p.ops[0].path, "a.ts");
  });

  it("parses an add op", () => {
    const p = parsePatch("*** Add File: new.txt\n+line 1\n+line 2\n*** End Patch");
    assert.strictEqual(p.ops[0].kind, "add");
    assert.strictEqual(p.ops[0].path, "new.txt");
  });

  it("parses a delete op", () => {
    const p = parsePatch("*** Delete File: old.txt\n*** End Patch");
    assert.strictEqual(p.ops[0].kind, "delete");
    assert.strictEqual(p.ops[0].path, "old.txt");
  });

  it("parses a rename (update with →)", () => {
    const p = parsePatch("*** Update File: a.ts → b.ts\n@@ ctx\n-x\n+y\n*** End Patch");
    assert.strictEqual(p.ops[0].movePath, "b.ts");
  });

  it("parses a rename (-> ascii)", () => {
    const p = parsePatch("*** Update File: a.ts -> b.ts\n*** End Patch");
    assert.strictEqual(p.ops[0].movePath, "b.ts");
  });

  it("throws on payload outside a file section", () => {
    assert.throws(() => parsePatch("+foo\n*** End Patch"), PatchParseError);
  });

  it("throws on no file ops", () => {
    assert.throws(() => parsePatch("*** Begin Patch\n*** End Patch"), PatchParseError);
  });

  it("throws on '-' in an Add File section", () => {
    assert.throws(
      () => parsePatch("*** Add File: x\n+a\n-b\n*** End Patch"),
      PatchParseError,
    );
  });

  it("treats a bare context line (no leading space) as context", () => {
    // DeepSeek/gpt-oss frequently omit the leading-space context marker.
    const p = parsePatch(
      "*** Update File: a.ts\n@@ alpha\n}\n-x\n+y\n*** End Patch",
    );
    // The '}' is context, not an error.
    assert.strictEqual(p.ops[0].kind, "update");
    assert.doesNotThrow(() => parsePatch("*** Update File: a.ts\n}\n-x\n+y\n*** End Patch"));
  });
});

describe("seekSequence", () => {
  it("exact match", () => {
    const r = seekSequence(["foo", "bar", "baz"], ["bar", "baz"]);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.firstIndex, 1);
    assert.strictEqual(r.exact, true);
  });
  it("rstrip match when trailing whitespace differs", () => {
    const r = seekSequence(["foo ", "bar\t"], ["foo", "bar"]);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.exact, false);
  });
  it("trim match when leading whitespace differs", () => {
    const r = seekSequence(["  foo", "\tbar"], ["foo", "bar"]);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.exact, false);
  });
  it("unicode-normalize match for smart quotes/dashes", () => {
    // file has a smart dash, pattern has ASCII hyphen
    const r = seekSequence(["cost \u2013 low"], ["cost - low"]);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.exact, false);
  });
  it("returns 0 when not found", () => {
    const r = seekSequence(["a", "b"], ["z"]);
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.firstIndex, -1);
  });
  it("returns 0 when pattern longer than lines", () => {
    const r = seekSequence(["a"], ["a", "b", "c"]);
    assert.strictEqual(r.count, 0);
  });
  it("counts multiple matches", () => {
    const r = seekSequence(["x", "x", "x"], ["x"]);
    assert.strictEqual(r.count, 3);
  });
});

// ── End-to-end apply against a real temp dir ──

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "apply-patch-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("applyPatchToFiles — update", () => {
  it("applies a single update hunk", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "a.ts");
      await writeFile(file, "alpha\nbeta\ngamma\n", "utf-8");
      // anchor on the unchanged line above the change (alpha stays)
      const parsed = parsePatch(
        "*** Update File: a.ts\n@@ alpha\n-beta\n+BETA\n*** End Patch",
      );
      const res = await applyPatchToFiles(parsed, dir);
      const out = (await readFile(file, "utf-8")).toString();
      assert.strictEqual(out, "alpha\nBETA\ngamma\n");
      assert.strictEqual(res.exact, true);
      assert.match(res.diff, /BETA/);
    });
  });

  it("applies multiple hunks in one file", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "a.ts");
      await writeFile(file, "one\nX\ntwo\nX\nthree\n", "utf-8");
      const parsed = parsePatch(
        "*** Update File: a.ts\n@@ one\n-X\n+1\n@@ two\n-X\n+2\n*** End Patch",
      );
      await applyPatchToFiles(parsed, dir);
      const out = (await readFile(file, "utf-8")).toString();
      assert.strictEqual(out, "one\n1\ntwo\n2\nthree\n");
    });
  });

  it("errors when context is not found", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "a.ts");
      await writeFile(file, "alpha\nbeta\n", "utf-8");
      const parsed = parsePatch(
        "*** Update File: a.ts\n@@ nope\n-alpha\n+ALPHA\n*** End Patch",
      );
      await assert.rejects(() => applyPatchToFiles(parsed, dir), /not found/);
    });
  });

  it("errors when context is ambiguous", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "a.ts");
      await writeFile(file, "dup\nA\ndup\nA\n", "utf-8");
      // anchor ["dup","A"] genuinely appears twice.
      const parsed = parsePatch(
        "*** Update File: a.ts\n@@ dup\n-A\n+AA\n*** End Patch",
      );
      await assert.rejects(() => applyPatchToFiles(parsed, dir), /ambiguous/);
    });
  });

  it("preserves BOM and CRLF", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "a.ts");
      await writeFile(file, "\uFEFFalpha\r\nbeta\r\n", "utf-8");
      // anchor on the unchanged line above (alpha stays)
      const parsed = parsePatch(
        "*** Update File: a.ts\n@@ alpha\n-beta\n+BETA\n*** End Patch",
      );
      await applyPatchToFiles(parsed, dir);
      const out = (await readFile(file, "utf-8")).toString();
      assert.strictEqual(out, "\uFEFFalpha\r\nBETA\r\n");
      assert.ok(out.startsWith("\uFEFF"), "BOM preserved");
      assert.ok(out.includes("\r\n"), "CRLF preserved");
    });
  });

  it("collapses @@ anchor repeated as context line", async () => {
    // Model writes `@@ alpha /  alpha` treating @@ as a locator header.
    // The duplicate context line is collapsed so only one "alpha" is matched.
    await withTempDir(async (dir) => {
      const file = join(dir, "a.ts");
      await writeFile(file, "alpha\nbeta\n", "utf-8");
      const parsed = parsePatch(
        "*** Update File: a.ts\n@@ alpha\n alpha\n-beta\n+BETA\n*** End Patch",
      );
      await applyPatchToFiles(parsed, dir);
      const out = (await readFile(file, "utf-8")).toString();
      assert.strictEqual(out, "alpha\nBETA\n");
    });
  });

  it("collapses @@ anchor repeated as removed line", async () => {
    // Anchor text equals the first removed line (e.g. @@ line1 / -line1).
    await withTempDir(async (dir) => {
      const file = join(dir, "a.ts");
      await writeFile(file, "X\nfoo\n", "utf-8");
      const parsed = parsePatch(
        "*** Update File: a.ts\n@@ X\n-X\n+Y\n*** End Patch",
      );
      await applyPatchToFiles(parsed, dir);
      const out = (await readFile(file, "utf-8")).toString();
      assert.strictEqual(out, "Y\nfoo\n");
    });
  });
});

describe("applyPatchToFiles — add / delete / multi-file", () => {
  it("adds a new file", async () => {
    await withTempDir(async (dir) => {
      const parsed = parsePatch(
        "*** Add File: new.txt\n+hello\n+world\n*** End Patch",
      );
      await applyPatchToFiles(parsed, dir);
      const out = (await readFile(join(dir, "new.txt"), "utf-8")).toString();
      assert.strictEqual(out, "hello\nworld");
    });
  });

  it("deletes a file", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "old.txt");
      await writeFile(file, "bye\n", "utf-8");
      const parsed = parsePatch("*** Delete File: old.txt\n*** End Patch");
      await applyPatchToFiles(parsed, dir);
      await assert.rejects(() => readFile(file, "utf-8"));
    });
  });

  it("applies a multi-file patch", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.ts"), "x\n1\n", "utf-8");
      await writeFile(join(dir, "b.ts"), "y\n2\n", "utf-8");
      const parsed = parsePatch(
        "*** Update File: a.ts\n@@ x\n-1\n+A\n*** Update File: b.ts\n@@ y\n-2\n+B\n*** End Patch",
      );
      const res = await applyPatchToFiles(parsed, dir);
      assert.strictEqual(res.files.length, 2);
      assert.strictEqual((await readFile(join(dir, "a.ts"), "utf-8")).toString(), "x\nA\n");
      assert.strictEqual((await readFile(join(dir, "b.ts"), "utf-8")).toString(), "y\nB\n");
    });
  });

  it("renames a file (update →)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "old.ts"), "ctx\n1\n", "utf-8");
      const parsed = parsePatch(
        "*** Update File: old.ts → new.ts\n@@ ctx\n-1\n+2\n*** End Patch",
      );
      await applyPatchToFiles(parsed, dir);
      assert.strictEqual((await readFile(join(dir, "new.ts"), "utf-8")).toString(), "ctx\n2\n");
      await assert.rejects(() => readFile(join(dir, "old.ts"), "utf-8"));
    });
  });

  it("honors an absolute path outside cwd (like pi built-in tools)", async () => {
    await withTempDir(async (dir) => {
      // An absolute path that is NOT under cwd must still work (pi's resolveToCwd
      // allows absolute paths anywhere; apply_patch must match that).
      const outside = join(tmpdir(), "apply-patch-outside-" + Date.now() + ".ts");
      try {
        await writeFile(outside, "ctx\n1\n", "utf-8");
        const parsed = parsePatch(`*** Add File: ${outside}\n+x\n*** End Patch`);
        await assert.rejects(() => applyPatchToFiles(parsed, dir), /already exists/);
      } finally {
        await rm(outside, { force: true });
      }
    });
  });
});
