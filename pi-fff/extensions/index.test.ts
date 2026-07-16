import { expect } from "chai";
import { FileFinder } from "@ff-labs/fff-node";
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fffExtension from "./index";

const originalCreate = FileFinder.create;
const originalMode = process.env.PI_FFF_MODE;

function item(relativePath: string, lineContent = "  match", lineNumber = 1) {
  return {
    relativePath,
    fileName: relativePath.split("/").pop() ?? relativePath,
    gitStatus: "clean",
    totalFrecencyScore: 0,
    accessFrecencyScore: 0,
    lineContent,
    lineNumber,
    contextBefore: [],
    contextAfter: [],
  };
}

function search(items: any[], totalMatched = items.length, scores?: any[]) {
  return {
    ok: true,
    value: {
      items,
      scores: scores ?? items.map(() => ({ total: 100 })),
      totalMatched,
      totalFiles: totalMatched,
    },
  };
}

function grep(items: any[], nextCursor: any = null) {
  return {
    ok: true,
    value: {
      items,
      totalMatched: items.length,
      totalFilesSearched: 1,
      totalFiles: 10,
      filteredFileCount: 10,
      nextCursor,
    },
  };
}

function fakeFinder(overrides: Record<string, any> = {}) {
  return {
    isDestroyed: false,
    destroy() { this.isDestroyed = true; },
    waitForScan: async () => ({ ok: true, value: true }),
    fileSearch: () => search([]),
    glob: () => search([]),
    grep: () => grep([]),
    multiGrep: () => grep([]),
    mixedSearch: () => ({ ok: true, value: { items: [] } }),
    ...overrides,
  };
}

function harness(
  finder: any,
  mode?: string,
  extraFlags: Record<string, unknown> = {},
  options: { cwd?: string; create?: (params: any) => any; excludedTools?: string[] } = {},
) {
  (FileFinder as any).create = (params: any) => ({
    ok: true,
    value: options.create?.(params) ?? finder,
  });
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, Function[]>();
  const flags = new Map<string, unknown>(Object.entries(extraFlags));
  let activeTools = ["read", "bash", "edit", "write"];
  if (mode) flags.set("fff-mode", mode);
  let flagsReady = false;
  const pi = {
    getFlag: (name: string) => flagsReady ? flags.get(name) : undefined,
    registerFlag: () => {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: Function) => events.set(name, [...(events.get(name) ?? []), handler]),
    getAllTools: () => [...tools.values()]
      .filter((tool) => !options.excludedTools?.includes(tool.name))
      .map((tool) => ({ name: tool.name })),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
  };
  fffExtension(pi as any);
  flagsReady = true;
  const ctx = { cwd: options.cwd ?? process.cwd(), ui: { notify: () => {}, addAutocompleteProvider: () => {} } };
  const started = events.get("session_start")?.[0]({}, ctx);
  return { tools, commands, events, flags, started, get activeTools() { return activeTools; } };
}

async function run(tool: any, params: any) {
  return tool.execute("test", params, undefined, undefined, {});
}

function text(result: any): string {
  return result.content[0].text;
}

describe("pi-fff tools", () => {
  afterEach(() => {
    (FileFinder as any).create = originalCreate;
    if (originalMode === undefined) delete process.env.PI_FFF_MODE;
    else process.env.PI_FFF_MODE = originalMode;
  });

  it("enforces a global grep limit and keeps scoped fuzzy pagination bound", async () => {
    const calls: Array<{ query: string; options: any }> = [];
    const cursor = { __brand: "GrepCursor", _offset: 1 };
    const finder = fakeFinder({
      grep(query: string, options: any) {
        calls.push({ query, options });
        if (calls.length === 1) return grep([]);
        if (calls.length === 2) {
          const match = { ...item("src/a.ts", "  needle", 10), isDefinition: true, contextAfter: ["  one", "  two", "  three"] };
          return grep([match], cursor);
        }
        return grep([{ ...item("src/b.ts", "  needle", 20) }]);
      },
    });
    const { tools } = harness(finder);
    const tool = tools.get("ffgrep");
    const first = await run(tool, { pattern: "needle", path: "src/", exclude: "test/", limit: 1, context: 1 });
    const cursorId = text(first).match(/cursor="([^"]+)"/)?.[1];

    expect(calls[0].query).to.equal("src/ !test/ needle");
    expect(calls[0].options.pageSize).to.equal(1);
    expect(calls[1].query).to.equal(calls[0].query);
    expect(calls[1].options.mode).to.equal("fuzzy");
    expect(text(first)).to.include("  one").and.not.include("  two");

    await run(tool, { pattern: "changed", path: "elsewhere/", cursor: cursorId });
    expect(calls[2].query).to.equal("src/ !test/ needle");
    expect(calls[2].options.mode).to.equal("fuzzy");
    expect(calls[2].options.cursor).to.equal(cursor);

    const crossed = await run(tools.get("fff_multi_grep"), { patterns: ["x"], cursor: cursorId });
    expect(text(crossed)).to.include("Invalid or expired multi-grep cursor");
  });

  it("keeps live find and grep cursors distinct and rejects cross-tool use", async () => {
    const nativeCursor = { __brand: "GrepCursor", _offset: 1 };
    const finder = fakeFinder({
      grep: () => grep([item("src/a.ts")], nativeCursor),
      fileSearch: () => search([item("src/a.ts")], 2, [{ total: 100 }]),
    });
    const { tools } = harness(finder);
    const grepResult = await run(tools.get("ffgrep"), { pattern: "a", limit: 1 });
    const findResult = await run(tools.get("fffind"), { pattern: "a", limit: 1 });
    const grepCursor = text(grepResult).match(/cursor="([^"]+)"/)?.[1];
    const findCursor = text(findResult).match(/cursor="([^"]+)"/)?.[1];
    expect(grepCursor).to.match(/^grep:/);
    expect(findCursor).to.match(/^find:/);
    expect(grepCursor).not.to.equal(findCursor);
    expect(text(await run(tools.get("ffgrep"), { pattern: "a", cursor: findCursor }))).to.include("Invalid or expired grep cursor");
    expect(text(await run(tools.get("fffind"), { pattern: "a", cursor: grepCursor }))).to.include("Invalid or expired find cursor");
  });

  it("rejects cursors after the active workspace changes", async () => {
    const nativeCursor = { __brand: "GrepCursor", _offset: 1 };
    let grepCalls = 0;
    let findCalls = 0;
    const finder = fakeFinder({
      grep: () => { grepCalls++; return grep([item("a.ts")], nativeCursor); },
      fileSearch: () => { findCalls++; return search([item("a.ts")], 2, [{ total: 100 }]); },
    });
    const runtime = harness(finder);
    await runtime.started;
    const grepToken = text(await run(runtime.tools.get("ffgrep"), { pattern: "a", limit: 1 })).match(/cursor="([^"]+)"/)?.[1];
    const findToken = text(await run(runtime.tools.get("fffind"), { pattern: "a", limit: 1 })).match(/cursor="([^"]+)"/)?.[1];
    await runtime.events.get("session_start")?.[0]({}, {
      cwd: join(process.cwd(), "other-workspace"),
      ui: { notify: () => {}, addAutocompleteProvider: () => {} },
    });
    const before = { grepCalls, findCalls };
    expect(text(await run(runtime.tools.get("ffgrep"), { pattern: "a", cursor: grepToken }))).to.include("Invalid or expired grep cursor");
    expect(text(await run(runtime.tools.get("fffind"), { pattern: "a", cursor: findToken }))).to.include("Invalid or expired find cursor");
    expect({ grepCalls, findCalls }).to.deep.equal(before);
  });

  it("searches an explicitly scoped hidden directory with a rooted native finder", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-fff-hidden-"));
    mkdirSync(join(fixture, ".agents"));
    writeFileSync(join(fixture, ".agents", "plan.md"), "plan\n");
    const root = fakeFinder({ fileSearch: () => search([]) });
    let scopedQuery = "";
    const scoped = fakeFinder({ fileSearch: (query: string) => { scopedQuery = query; return search([item("plan.md")]); } });
    const runtime = harness(root, undefined, {}, {
      cwd: fixture,
      create: (options) => options.basePath.endsWith(".agents") ? scoped : root,
    });
    try {
      await runtime.started;
      const result = await run(runtime.tools.get("fffind"), {
        pattern: "*",
        path: ".agents/**/*.md",
        exclude: ".agents/generated/**",
      });
      expect(text(result)).to.include(".agents/plan.md");
      expect(scopedQuery).to.equal("**/*.md !generated/ *");
      for (const exclude of ["generated", "generated/", "generated/**"]) {
        await run(runtime.tools.get("fffind"), { pattern: "*", path: ".agents", exclude });
        expect(scopedQuery).to.equal("!generated/ *");
      }
      expect(text(await run(runtime.tools.get("fffind"), {
        pattern: "*",
        path: ".agents/**/*.md",
        exclude: ".agents/**",
      }))).to.equal("No files found matching pattern");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("searches explicit hidden scopes with grep, override grep, and multi-grep", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-fff-hidden-grep-"));
    mkdirSync(join(fixture, ".agents"));
    writeFileSync(join(fixture, ".agents", "plan.md"), "needle\n");
    const cursor = { __brand: "GrepCursor", _offset: 1 };
    const root = fakeFinder({ grep: () => grep([]), multiGrep: () => grep([]) });
    const scopedQueries: string[] = [];
    const scopedConstraints: Array<string | undefined> = [];
    const scoped = fakeFinder({
      grep: (query: string, options: any) => {
        scopedQueries.push(query);
        return grep([item("plan.md", "needle")], options.cursor ? null : cursor);
      },
      multiGrep: (options: any) => {
        scopedConstraints.push(options.constraints);
        return grep([item("plan.md", "needle")]);
      },
    });
    const create = (options: any) => options.basePath.endsWith(".agents") ? scoped : root;
    try {
      const normal = harness(root, undefined, {}, { cwd: fixture, create });
      await normal.started;
      const first = await run(normal.tools.get("ffgrep"), {
        pattern: "needle",
        path: ".agents/**/*.md",
        exclude: ".agents/generated/**",
        limit: 1,
      });
      expect(text(first)).to.include(".agents/plan.md");
      const next = text(first).match(/cursor="([^"]+)"/)?.[1];
      expect(next).to.match(/^grep:/);
      expect(text(await run(normal.tools.get("ffgrep"), { pattern: "changed", cursor: next }))).to.include(".agents/plan.md");
      expect(text(await run(normal.tools.get("fff_multi_grep"), {
        patterns: ["needle"],
        path: ".agents/**/*.md",
        exclude: ".agents/generated/**",
      }))).to.include(".agents/plan.md");
      expect(scopedQueries[0]).to.equal("**/*.md !generated/ needle");
      expect(scopedConstraints).to.include("**/*.md !generated/");

      const override = harness(root, "override", {}, { cwd: fixture, create });
      await override.started;
      expect(text(await run(override.tools.get("grep"), { pattern: "needle", path: ".agents/**/*.md", literal: true }))).to.include(".agents/plan.md");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("applies pattern and exclusions to explicit hidden files", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-fff-hidden-file-"));
    writeFileSync(join(fixture, ".note"), "needle one\nneedle two\nneedle three\n");
    writeFileSync(join(fixture, ".large"), "needle\n");
    truncateSync(join(fixture, ".large"), 10 * 1024 * 1024 + 1);
    writeFileSync(join(fixture, ".dense"), "x\n".repeat(1_000_000));
    const root = fakeFinder({ fileSearch: () => search([]), grep: () => grep([]), multiGrep: () => grep([]) });
    const runtime = harness(root, undefined, {}, { cwd: fixture });
    try {
      await runtime.started;
      expect(text(await run(runtime.tools.get("fffind"), { pattern: ".note", path: ".note" }))).to.include(".note");
      expect(text(await run(runtime.tools.get("fffind"), { pattern: "*.ts", path: ".note" }))).to.equal("No files found matching pattern");
      expect(text(await run(runtime.tools.get("fffind"), { pattern: ".note", path: ".note", exclude: ".note" }))).to.equal("No files found matching pattern");
      expect(text(await run(runtime.tools.get("ffgrep"), { pattern: "needle", path: ".large" }))).to.equal("No matches found");
      const dense = await run(runtime.tools.get("ffgrep"), { pattern: "x", path: ".dense", limit: 1 });
      expect(text(dense)).to.include('cursor="grep:');
      const first = await run(runtime.tools.get("ffgrep"), { pattern: "needle", path: ".note", limit: 1 });
      const firstCursor = text(first).match(/cursor="([^"]+)"/)?.[1];
      expect(text(first)).to.include("needle one");
      const second = await run(runtime.tools.get("ffgrep"), { pattern: "changed", cursor: firstCursor });
      const secondCursor = text(second).match(/cursor="([^"]+)"/)?.[1];
      expect(text(second)).to.include("needle two");
      expect(text(await run(runtime.tools.get("ffgrep"), { pattern: "changed", cursor: secondCursor }))).to.include("needle three");

      const multiFirst = await run(runtime.tools.get("fff_multi_grep"), { patterns: ["needle"], path: ".note", limit: 1 });
      const multiCursor = text(multiFirst).match(/cursor="([^"]+)"/)?.[1];
      expect(text(multiFirst)).to.include("needle one");
      expect(text(await run(runtime.tools.get("fff_multi_grep"), { patterns: ["changed"], cursor: multiCursor }))).to.include("needle two");
      expect(text(await run(runtime.tools.get("fff_multi_grep"), { patterns: ["needle"], cursor: firstCursor }))).to.include("Invalid or expired multi-grep cursor");

      const override = harness(root, "override", {}, { cwd: fixture });
      await override.started;
      const overrideResult = await run(override.tools.get("grep"), { pattern: "needle", path: ".note", literal: true, limit: 1 });
      expect(text(overrideResult)).to.include("needle one");
      expect(overrideResult.details.matchLimitReached).to.equal(1);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects expired find cursors instead of restarting with new arguments", async () => {
    let calls = 0;
    const { tools } = harness(fakeFinder({ fileSearch: () => { calls++; return search([]); } }));
    const result = await run(tools.get("fffind"), { pattern: "new", cursor: "missing" });
    expect(text(result)).to.include("Invalid or expired find cursor");
    expect(calls).to.equal(0);
  });

  it("fetches a runner-up for resolve_file limit 1 and strips leading @", async () => {
    let query = "";
    let pageSize = 0;
    const finder = fakeFinder({
      fileSearch(q: string, options: any) {
        query = q;
        pageSize = options.pageSize;
        return search([item("src/a.ts"), item("src/b.ts")], 2, [{ total: 10 }, { total: 9 }]);
      },
    });
    const result = await run(harness(finder).tools.get("resolve_file"), { pattern: "@src/a", limit: 1 });
    expect(query).to.equal("src/a");
    expect(pageSize).to.equal(2);
    expect(result.details.resolved).to.equal(false);
    expect(text(result)).to.include("src/a.ts").and.not.include("src/b.ts");
  });

  it("keeps related files in the resolved file directory with the same normalized stem", async () => {
    const queries: string[] = [];
    const finder = fakeFinder({
      fileSearch(query: string) {
        queries.push(query);
        if (queries.length === 1) return search([item("src/Chart.tsx")]);
        return search([
          item("src/Chart.test.tsx"),
          item("src/Chart.module.css"),
          item("src/Chart.types.ts"),
          item("lib/Chart.tsx"),
          item("src/Chartreuse.tsx"),
        ]);
      },
    });
    const result = await run(harness(finder).tools.get("related_files"), { path: "@src/Chart.tsx" });
    expect(queries[0]).to.equal("src/Chart.tsx");
    expect(queries[1]).to.equal("src/ Chart");
    expect(result.details.related).to.deep.equal([
      "src/Chart.test.tsx",
      "src/Chart.module.css",
      "src/Chart.types.ts",
    ]);
  });

  it("makes concurrent callers await the same initial scan", async () => {
    let createCount = 0;
    let release!: () => void;
    const scanning = new Promise<void>((resolve) => { release = resolve; });
    const finder = fakeFinder({ waitForScan: () => scanning, fileSearch: () => search([]) });
    (FileFinder as any).create = () => { createCount++; return { ok: true, value: finder }; };
    const tools = new Map<string, any>();
    let sessionStart: Function | undefined;
    const pi = {
      getFlag: () => undefined,
      registerFlag: () => {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: () => {},
      on: (name: string, handler: Function) => {
        if (name === "session_start") sessionStart = handler;
      },
    };
    fffExtension(pi as any);
    const initializing = sessionStart?.({}, {
      cwd: process.cwd(),
      ui: { notify: () => {}, addAutocompleteProvider: () => {} },
    });

    let firstDone = false;
    let secondDone = false;
    const first = run(tools.get("fffind"), { pattern: "a" }).then(() => { firstDone = true; });
    const second = run(tools.get("resolve_file"), { pattern: "b" }).then(() => { secondDone = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(createCount).to.equal(1);
    expect(firstDone).to.equal(false);
    expect(secondDone).to.equal(false);
    release();
    await Promise.all([initializing, first, second]);
  });

  it("reads CLI flags after Pi populates them and before registering tools", async () => {
    let createOptions: any;
    const finder = fakeFinder();
    const runtime = harness(finder, "override", {
      "fff-frecency-db": "/tmp/frecency.db",
      "fff-history-db": "/tmp/history.db",
      "fff-enable-root-scan": true,
    }, {
      create: (options) => {
        createOptions = options;
        return finder;
      },
    });
    await runtime.started;
    expect(runtime.tools.has("find")).to.equal(true);
    expect(runtime.tools.has("grep")).to.equal(true);
    expect(runtime.tools.has("fffind")).to.equal(false);
    expect(runtime.activeTools).to.include.members(["find", "grep"]);
    expect(createOptions).to.include({
      frecencyDbPath: "/tmp/frecency.db",
      historyDbPath: "/tmp/history.db",
      enableFsRootScanning: true,
    });

    const excluded = harness(fakeFinder(), "override", {}, { excludedTools: ["grep"] });
    await excluded.started;
    expect(excluded.activeTools).to.include("find").and.not.include("grep");
  });

  it("reloads only when mode changes cross the override boundary and honors CLI flags", async () => {
    delete process.env.PI_FFF_MODE;
    const normal = harness(fakeFinder());
    let reloads = 0;
    const ctx = { ui: { notify: () => {} }, reload: async () => { reloads++; } };
    await normal.commands.get("fff-mode").handler("tools-only", ctx);
    expect(reloads).to.equal(0);
    expect(process.env.PI_FFF_MODE).to.equal("tools-only");
    await normal.commands.get("fff-mode").handler("override", ctx);
    expect(reloads).to.equal(1);
    expect(process.env.PI_FFF_MODE).to.equal("override");

    const flagged = harness(fakeFinder(), "override");
    process.env.PI_FFF_MODE = "override";
    await flagged.commands.get("fff-mode").handler("tools-only", ctx);
    expect(process.env.PI_FFF_MODE).to.equal("override");
  });

  it("uses Pi-compatible override schemas, details, and exact glob semantics", async () => {
    const cursor = { __brand: "GrepCursor", _offset: 1 };
    const globCalls: string[] = [];
    const finder = fakeFinder({
      grep: () => grep([item("src/a.ts")], cursor),
      fileSearch: () => search([item("src/a.ts")], 2, [{ total: 100 }]),
      glob: (pattern: string) => {
        globCalls.push(pattern);
        if (pattern === "foo") return search([]);
        if (pattern === "src/*.ts") return search([item("src/a.ts")]);
        return search([item("src/a.ts")], 2, [{ total: 100 }]);
      },
    });
    const { tools } = harness(finder, "override");
    expect(Object.keys(tools.get("find").parameters.properties)).to.deep.equal(["pattern", "path", "limit"]);
    expect(Object.keys(tools.get("grep").parameters.properties)).to.deep.equal([
      "pattern", "path", "glob", "ignoreCase", "literal", "context", "limit",
    ]);

    const grepResult = await run(tools.get("grep"), { pattern: "MATCH", glob: "*.ts", ignoreCase: true, literal: true, limit: 1 });
    expect(Object.keys(grepResult.details)).to.deep.equal(["matchLimitReached"]);
    const findResult = await run(tools.get("find"), { pattern: "*.ts", limit: 1 });
    expect(Object.keys(findResult.details)).to.deep.equal(["resultLimitReached"]);
    expect(text(await run(tools.get("find"), { pattern: "foo" }))).to.equal("No files found matching pattern");
    expect(text(await run(tools.get("find"), { pattern: "*.ts", path: "src" }))).to.equal("a.ts");
    expect(globCalls).to.include("src/*.ts");
  });

  it("truncates every tool output with Pi metadata", async () => {
    const items = Array.from({ length: 2101 }, (_, i) => item(`src/file-${i}.ts`));
    const result = await run(harness(fakeFinder({ fileSearch: () => search(items) })).tools.get("fffind"), {
      pattern: "file",
      limit: items.length,
    });
    expect(result.details.truncation.truncated).to.equal(true);
    expect(text(result)).to.include("[Output truncated:");
    expect(result.details.truncation.outputLines).to.be.at.most(2000);
  });
});
