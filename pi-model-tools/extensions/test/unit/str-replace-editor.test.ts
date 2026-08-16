import assert from "node:assert";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createStrReplaceEditorToolDefinition } from "../../lib/str-replace-editor.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sre-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Params = {
  command: "view" | "create" | "str_replace" | "insert";
  path: string;
  file_text?: string;
  insert_line?: number;
  new_str?: string;
  old_str?: string;
  view_range?: number[];
};

async function call(dir: string, params: Params): Promise<{ text: string; isError?: boolean }> {
  const def = createStrReplaceEditorToolDefinition(dir);
  const res: any = await def.execute("t1", params as never, undefined as never, undefined as never, { cwd: dir } as any);
  const text = Array.isArray(res.content) ? res.content.map((b: any) => b?.text ?? "").join("") : String(res.content ?? "");
  return { text, isError: res.isError };
}

describe("str_replace_editor", () => {
  it("create writes a new file; view shows cat -n numbering", async () => {
    await withTmp(async (dir) => {
      const created = await call(dir, { command: "create", path: join(dir, "a.txt"), file_text: "hello\nworld" });
      assert.equal(created.isError, undefined);
      assert.match(created.text, /New file created successfully/);

      const viewed = await call(dir, { command: "view", path: join(dir, "a.txt") });
      assert.equal(viewed.isError, undefined);
      assert.match(viewed.text, /total of 2 lines/);
      assert.match(viewed.text, /1 hello/);
      assert.match(viewed.text, /2 world/);
    });
  });

  it("create refuses to overwrite an existing file", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "a.txt"), "x");
      const res = await call(dir, { command: "create", path: join(dir, "a.txt"), file_text: "y" });
      assert.equal(res.isError, true);
      assert.match(res.text, /already exists/);
    });
  });

  it("str_replace replaces a unique literal; errors on zero or multiple matches", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "a.txt"), "one\ntwo\none");
      const replaced = await call(dir, { command: "str_replace", path: join(dir, "a.txt"), old_str: "two", new_str: "TWO" });
      assert.equal(replaced.isError, undefined);
      assert.match(replaced.text, /edited successfully/);
      assert.equal(await readFile(join(dir, "a.txt"), "utf-8"), "one\nTWO\none");

      const missing = await call(dir, { command: "str_replace", path: join(dir, "a.txt"), old_str: "zzz", new_str: "x" });
      assert.equal(missing.isError, true);
      assert.match(missing.text, /did not appear verbatim/);

      const ambiguous = await call(dir, { command: "str_replace", path: join(dir, "a.txt"), old_str: "one", new_str: "1" });
      assert.equal(ambiguous.isError, true);
      assert.match(ambiguous.text, /Multiple occurrences/);
      assert.match(ambiguous.text, /lines \[1, 3\]/);
    });
  });

  it("insert inserts after the given line (0-based boundary)", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "a.txt"), "a\nb");
      const res = await call(dir, { command: "insert", path: join(dir, "a.txt"), insert_line: 1, new_str: "X" });
      assert.equal(res.isError, undefined);
      assert.equal(await readFile(join(dir, "a.txt"), "utf-8"), "a\nX\nb");
    });
  });

  it("insert validates the boundary", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "a.txt"), "a");
      const res = await call(dir, { command: "insert", path: join(dir, "a.txt"), insert_line: 5, new_str: "X" });
      assert.equal(res.isError, true);
      assert.match(res.text, /Invalid `insert_line`/);
    });
  });

  it("view with view_range shows the numbered slice; directory view lists 2 levels", async () => {
    await withTmp(async (dir) => {
      await writeFile(join(dir, "a.txt"), "l1\nl2\nl3\nl4");
      const ranged = await call(dir, { command: "view", path: join(dir, "a.txt"), view_range: [2, 3] });
      assert.equal(ranged.isError, undefined);
      assert.match(ranged.text, /view_range=\[2, 3\]/);
      assert.match(ranged.text, /2 l2/);
      assert.match(ranged.text, /3 l3/);

      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "sub", "b.txt"), "b");
      const listed = await call(dir, { command: "view", path: dir });
      assert.equal(listed.isError, undefined);
      assert.match(listed.text, /up to 2 levels deep/);
      assert.match(listed.text, /sub/);
    });
  });

  it("~ paths resolve to home, not a literal dir under cwd", async () => {
    await withTmp(async (dir) => {
      const name = `sre-home-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`;
      const created = await call(dir, { command: "create", path: `~/${name}`, file_text: "hi" });
      assert.equal(created.isError, undefined);
      const home = (await import("node:os")).homedir();
      const homeFile = await readFile(join(home, name), "utf-8");
      assert.equal(homeFile, "hi", "file created in home dir");
      await rm(join(home, name), { force: true });
      // and nothing under cwd
      const underCwd = await readFile(join(dir, `~`, name), "utf-8").then(() => true).catch(() => false);
      assert.equal(underCwd, false, "no literal ~ dir under cwd");
    });
  });

  it("unknown command / missing file errors surface clearly", async () => {
    await withTmp(async (dir) => {
      const missing = await call(dir, { command: "view", path: join(dir, "nope.txt") });
      assert.equal(missing.isError, true);
      assert.match(missing.text, /does not exist/);

      const noFileText = await call(dir, { command: "create", path: join(dir, "x.txt") });
      assert.equal(noFileText.isError, true);
      assert.match(noFileText.text, /file_text.*required/);
    });
  });
});
