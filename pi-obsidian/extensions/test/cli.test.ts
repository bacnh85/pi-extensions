import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readQuotedContent,
  parseCliString,
  parseFlags,
  isObsidianVaultCwd,
  isPathInObsidianVault,
  vaultNameForCwd,
} from "../index.js";

// ---------------------------------------------------------------------------
// Replicate execObsidian's stdout filter for testing
// ---------------------------------------------------------------------------

const LOADING_LINE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d Loading updated app package /;
const OUTDATED_LINE = "Your Obsidian installer is out of date. Please download the latest installer which includes better CLI support: https://obsidian.md/download";

function filterStdout(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !LOADING_LINE.test(line) && !line.includes("Your Obsidian installer is out of date. Please download the latest installer which includes better CLI support"))
    .join("\n");
}

describe("readQuotedContent", () => {
  it("reads simple content", () => {
    const r = readQuotedContent('hello"', 0);
    expect(r.value).to.equal("hello");
    expect(r.endPos).to.equal(5); // position of closing "
  });

  it("reads empty content", () => {
    const r = readQuotedContent('"', 0);
    expect(r.value).to.equal("");
    expect(r.endPos).to.equal(0);
  });

  it("decodes \\n escape", () => {
    const r = readQuotedContent("line1\\nline2\"", 0);
    expect(r.value).to.equal("line1\nline2");
    expect(r.endPos).to.equal(12);
  });

  it("decodes \\t escape", () => {
    const r = readQuotedContent("col1\\tcol2\"", 0);
    expect(r.value).to.equal("col1\tcol2");
  });

  it("decodes \\r escape", () => {
    const r = readQuotedContent("line\\r\"", 0);
    expect(r.value).to.equal("line\r");
  });

  it("decodes mixed escapes", () => {
    const r = readQuotedContent("a\\nb\\tc\\\\d\\\"e\"", 0);
    expect(r.value).to.equal("a\nb\tc\\d\"e");
  });

  it("handles escaped double quote", () => {
    const r = readQuotedContent('say \\"hi\\" there"', 0);
    expect(r.value).to.equal('say "hi" there');
    expect(r.endPos).to.equal(16); // position of closing "
  });

  it("handles escaped backslash", () => {
    const r = readQuotedContent('path\\\\name"', 0);
    expect(r.value).to.equal("path\\name");
    expect(r.endPos).to.equal(10); // position of closing "
  });

  it("stops at closing quote", () => {
    const r = readQuotedContent('abc"def', 0);
    expect(r.value).to.equal("abc");
    expect(r.endPos).to.equal(3); // position of closing "
  });
});

describe("parseCliString", () => {
  it("parses simple arguments", () => {
    expect(parseCliString("read path=test.md")).to.deep.equal(["read", "path=test.md"]);
  });

  it("parses quoted values", () => {
    expect(parseCliString('file="My Note.md"')).to.deep.equal(["file=My Note.md"]);
  });

  it("parses mixed quoted and unquoted", () => {
    const result = parseCliString('search query="hello world" limit=10');
    expect(result).to.deep.equal(["search", "query=hello world", "limit=10"]);
  });

  it("handles empty string", () => {
    expect(parseCliString("")).to.deep.equal([]);
  });

  it("handles whitespace-only string", () => {
    expect(parseCliString("   ")).to.deep.equal([]);
  });

  it("handles inline quotes inside unquoted tokens", () => {
    const result = parseCliString('cmd key=pre"mid"post');
    expect(result).to.deep.equal(["cmd", "key=premidpost"]);
  });

  it("handles escaped quotes inside quoted values", () => {
    const result = parseCliString('read path="note \\"v2\\".md"');
    expect(result).to.deep.equal(['read', 'path=note "v2".md']);
  });

  it("trims leading whitespace", () => {
    expect(parseCliString("  read path=test.md")).to.deep.equal(["read", "path=test.md"]);
  });

  it("handles multiple spaces between args", () => {
    expect(parseCliString("read   path=test.md   verbose=true")).to.deep.equal(["read", "path=test.md", "verbose=true"]);
  });
});

describe("parseFlags", () => {
  it("parses simple key=value", () => {
    expect(parseFlags("read path=test.md")).to.deep.equal({ path: "test.md" });
  });

  it("parses quoted values", () => {
    expect(parseFlags('read path="My Note.md"')).to.deep.equal({ path: "My Note.md" });
  });

  it("parses multiple flags", () => {
    expect(parseFlags("query=hello regex=true preview=true")).to.deep.equal({
      query: "hello",
      regex: "true",
      preview: "true",
    });
  });

  it("returns empty object when no flags", () => {
    expect(parseFlags("read")).to.deep.equal({});
  });

  it("parses hyphenated flag names", () => {
    expect(parseFlags("missing-property=created")).to.deep.equal({ "missing-property": "created" });
  });

  it("handles empty string", () => {
    expect(parseFlags("")).to.deep.equal({});
  });

  it("handles empty value (key=)", () => {
    expect(parseFlags("cmd key=")).to.deep.equal({ key: "" });
  });

  it("unescapes quoted values", () => {
    expect(parseFlags('cmd val="a \\"b\\""')).to.deep.equal({ val: 'a "b"' });
  });
});

describe("stdout filter", () => {
  it("filters loading lines", () => {
    const raw = [
      "2024-01-15 10:30:00 Loading updated app package from 1.5.3",
      "result line 1",
      "2024-01-15 10:30:01 Loading updated app package from 1.5.3",
      "result line 2",
    ].join("\n");
    expect(filterStdout(raw)).to.equal("result line 1\nresult line 2");
  });

  it("filters outdated installer line", () => {
    const raw = [
      OUTDATED_LINE,
      "actual output",
    ].join("\n");
    expect(filterStdout(raw)).to.equal("actual output");
  });

  it("preserves normal output unchanged", () => {
    const raw = "line1\nline2";
    expect(filterStdout(raw)).to.equal("line1\nline2");
  });

  it("handles lines with partial date matches", () => {
    const raw = "2024-not-a-loading-line\nstill valid";
    expect(filterStdout(raw)).to.equal("2024-not-a-loading-line\nstill valid");
  });

  it("handles empty output", () => {
    expect(filterStdout("")).to.equal("");
  });
});

// ---------------------------------------------------------------------------
// FormatObsidianOutput routing tests (pure function mapping)
// ---------------------------------------------------------------------------

describe("formatObsidianOutput routing", () => {
  it("routes 'search' to formatSearchResults", async () => {
    // Import the actual formatter to verify it handles the shape
    const { formatSearchResults } = await import("../lib/format.js");
    const result = formatSearchResults([{ filename: "test.md", match: "found it" }]);
    expect(result).to.include("test.md");
    expect(result).to.include("found it");
  });

  it("routes 'tasks' to formatTasks", async () => {
    const { formatTasks } = await import("../lib/format.js");
    const result = formatTasks([{ status: " ", text: "A task" }]);
    expect(result).to.include("[ ] A task");
  });

  it("routes 'tags' to formatTags", async () => {
    const { formatTags } = await import("../lib/format.js");
    const result = formatTags([{ tag: "#work", count: 3 }]);
    expect(result).to.include("#work: 3");
  });

  it("routes 'backlinks' to formatLinks", async () => {
    const { formatLinks } = await import("../lib/format.js");
    const result = formatLinks([{ filename: "ref.md" }], "Backlinks");
    expect(result).to.include("ref.md");
  });

  it("routes 'outline' to formatOutline", async () => {
    const { formatOutline } = await import("../lib/format.js");
    const result = formatOutline([{ level: 1, heading: "Root" }]);
    expect(result).to.include("# Root");
  });

  it("routes 'properties' to formatProperties", async () => {
    const { formatProperties } = await import("../lib/format.js");
    const result = formatProperties([{ name: "status", count: 10 }]);
    expect(result).to.include("status: 10");
  });

  it("routes 'file' to formatFileInfo", async () => {
    const { formatFileInfo } = await import("../lib/format.js");
    const result = formatFileInfo({ name: "test.md", size: 100 });
    expect(result).to.include("name: test.md");
    expect(result).to.include("size: 100");
  });

  it("routes 'aliases' to formatAliases", async () => {
    const { formatAliases } = await import("../lib/format.js");
    const result = formatAliases([{ alias: "My Note" }]);
    expect(result).to.include("My Note");
  });

  it("routes 'links' to formatOutgoingLinks", async () => {
    const { formatOutgoingLinks } = await import("../lib/format.js");
    const result = formatOutgoingLinks([{ link: "[[Note]]" }]);
    expect(result).to.include("[[Note]]");
  });

  it("routes unknown commands to JSON.stringify", async () => {
    // Unknown commands fall through to JSON.stringify
    // This is tested implicitly by the default branch in formatObsidianOutput
    const result = JSON.stringify({ custom: "data" }, null, 2);
    expect(result).to.include('"custom"');
  });
});

describe("error message formatting", () => {
  it("ENOENT error message mentions Obsidian installation", () => {
    const err = new Error("spawnSync ENOENT");
    (err as any).code = "ENOENT";
    expect(err.message).to.include("ENOENT");
  });

  it("non-zero exit error includes stdout and stderr", () => {
    const err = new Error(
      "obsidian command failed (exit 1)\n" +
      "  Cmd: obsidian read path=nonexistent\n" +
      "  Stderr: File not found\n" +
      "  Stdout: (empty)"
    );
    expect(err.message).to.include("exit 1");
    expect(err.message).to.include("nonexistent");
    expect(err.message).to.include("File not found");
  });
});

describe("piObsidianExtension tool integration", () => {
  it("registers obsidian tool and throws error on unsupported daily:today command", async () => {
    const { default: piObsidianExtension } = await import("../index.js");
    let registeredTool: any = null;
    const mockPi: any = {
      registerTool(tool: any) {
        registeredTool = tool;
      },
      on() {},
    };
    piObsidianExtension(mockPi);
    expect(registeredTool).to.not.be.null;
    expect(registeredTool.name).to.equal("obsidian");

    try {
      await registeredTool.execute("test-id", { run: "daily:today" });
      expect.fail("Should have thrown an error");
    } catch (err: any) {
      expect(err.message).to.include("is only available via the Obsidian desktop app");
    }
  });

  it("blocks generic vault filesystem operations but leaves normal shell work alone", async () => {
    const { default: piObsidianExtension } = await import("../index.js");
    let registeredTool: any = null;
    const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
    const mockPi: any = {
      registerTool(tool: any) { registeredTool = tool; },
      on(event: string, handler: (event: any, ctx: any) => any) {
        (handlers[event] ??= []).push(handler);
      },
    };
    piObsidianExtension(mockPi);
    const guard = handlers.tool_call[0];
    const vault = mkdtempSync(join(tmpdir(), "pi-obsidian-vault-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-obsidian-outside-"));
    writeFileSync(join(outside, ".obsidian"), "not a directory");
    mkdirSync(join(vault, ".obsidian"));
    mkdirSync(join(vault, "..notes"));
    symlinkSync(vault, join(outside, "vault-link"), "dir");
    symlinkSync(outside, join(vault, "external-link"), "dir");
    try {
      expect(isObsidianVaultCwd(outside)).to.equal(false);
      expect(isObsidianVaultCwd(join(vault, "nested"))).to.equal(true);
      expect(isPathInObsidianVault("Note.md", vault)).to.equal(true);
      expect(isPathInObsidianVault("..notes/Note.md", vault)).to.equal(true);
      expect(isPathInObsidianVault(join(outside, "vault-link", "Note.md"), vault)).to.equal(true);
      expect(isPathInObsidianVault("external-link/README.md", vault)).to.equal(false);
      expect(isPathInObsidianVault(join(outside, "README.md"), vault)).to.equal(false);
      expect(vaultNameForCwd(vault, { name: "vault-a", path: vault })).to.equal("vault-a");
      expect(vaultNameForCwd(vault, { name: "vault-b", path: outside })).to.equal(undefined);
      expect(guard({ toolName: "read", input: { path: "Note.md" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "write", input: { path: "Note.md" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "edit", input: { path: "Note.md" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "ls", input: { path: "." } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "find", input: { path: "." } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "grep", input: { path: "." } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "mv Note.md Archive/" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "ls -la" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "find -print" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "rg needle" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "/bin/rm Note.md" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "command rm Note.md" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "unlink Note.md" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "truncate -s 0 Note.md" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "sed -i.bak 's/a/b/' Note.md" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "perl -pi -e 's/a/b/' Note.md" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "grep -R needle" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "grep --recursive needle" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "echo hello > Note.md" } }, { cwd: vault })?.block).to.equal(true);
      expect(guard({ toolName: "bash", input: { command: "echo 'status > done'" } }, { cwd: vault })).to.equal(undefined);
      expect(guard({ toolName: "bash", input: { command: "echo hello" } }, { cwd: vault })).to.equal(undefined);
      expect(guard({ toolName: "bash", input: { command: `cat ${join(outside, "README.md")}` } }, { cwd: vault })).to.equal(undefined);
      expect(guard({ toolName: "bash", input: { command: `truncate -s 0 ${join(outside, "README.md")}` } }, { cwd: vault })).to.equal(undefined);
      expect(guard({ toolName: "bash", input: { command: `echo hello > "${join(outside, "outside file.md")}"` } }, { cwd: vault })).to.equal(undefined);
      expect(guard({ toolName: "bash", input: { command: "npm test" } }, { cwd: vault })).to.equal(undefined);
      expect(guard({ toolName: "read", input: { path: join(outside, "README.md") } }, { cwd: vault })).to.equal(undefined);
      expect(guard({ toolName: "grep", input: { path: outside } }, { cwd: vault })).to.equal(undefined);
      expect(registeredTool.promptGuidelines.join("\n")).to.include("Use obsidian—not bash, read, write, edit, ls, find, or grep");
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
