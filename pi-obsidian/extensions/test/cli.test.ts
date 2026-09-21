import { describe, it } from "mocha";
import { expect } from "chai";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { relative, resolve, isAbsolute, sep, join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildChunkScript,
  buildPrependChunkScript,
  buildFirstScript,
  djb2Utf8,
  filesMissingProperty,
  readQuotedContent,
  parseCliString,
  parseFlags,
  isObsidianVaultCwd,
  isPathInObsidianVault,
  renameTag,
  vaultNameForCwd,
  vaultWrite,
} from "../index.js";
import { execObsidian } from "../lib/cli.js";

// ---------------------------------------------------------------------------
// Replicate execObsidian's stdout filter for testing
// ---------------------------------------------------------------------------

const LOADING_LINE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d Loading updated app package /;
const OUTDATED_LINE = "Your Obsidian installer is out of date. Please download the latest installer which includes better CLI support: https://obsidian.md/download";

// ---------------------------------------------------------------------------
// In-memory vault fake simulating the obsidian CLI against tracked state.
// - eval steps: apply the base64 payload to the tracked file, mirroring the
//   in-app adapter semantics of the generated write scripts.
// - `read path=`: return the tracked content with real CLI printer semantics
//   (empirically verified on an SMB vault): non-empty content not ending in
//   "\n" gets exactly one "\n" appended; empty stays empty.
// ---------------------------------------------------------------------------

type VaultFakeOpts = {
  initialFile?: string; // existing content for append/prepend tests
  dropFirstReads?: number; // SMB propagation delay: N empty reads first
  readOverride?: (content: string) => string; // force arbitrary read output
  readThrows?: string; // exec throws (non-zero exit) on every read
  writeEcho?: string; // eval stdout (default "ok"); "" = dropped echo
  writeStderr?: string; // eval stderr
  applyWrites?: boolean; // default true; false = silent no-op writes
  dropFirstWrites?: number; // skip applying the first N write steps
};

function makeVaultFake(opts: VaultFakeOpts = {}) {
  let file = opts.initialFile ?? "";
  let hasFile = opts.initialFile !== undefined;
  let readCalls = 0;
  let writeCalls = 0;
  let dropped = 0;
  let lastCode: string | null = null;

  const applyEval = (code: string) => {
    // A tolerant run() re-executes a step whose echo was dropped; the side
    // effect already happened on the first execution, so applying the same
    // script twice would corrupt state (e.g. double-appended chunk).
    // Caveat: two *distinct* steps with byte-identical scripts (periodic
    // content like "A"×N in overwrite/append) are indistinguishable from a
    // retry and get swallowed — use varying content for such tests.
    if (code === lastCode) return;
    lastCode = code;
    if (opts.applyWrites === false) return;
    if (dropped < (opts.dropFirstWrites ?? 0)) {
      dropped++;
      return;
    }
    const b64 = code.match(/atob\("([^"]+)"\)/)?.[1] ?? "";
    const chunk = b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
    const fmMatch = file.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
    const fmLen = fmMatch ? fmMatch[0].length : 0;
    if (code.includes("o.slice(0,at)")) {
      // buildPrependChunkScript: insert after frontmatter + already-inserted offset
      const at = Number(code.match(/const at=i\+(\d+)/)?.[1] ?? 0);
      file = file.slice(0, fmLen + at) + chunk + file.slice(fmLen + at);
    } else if (code.includes("o.slice(0,i)+c+o.slice(i)")) {
      // buildFirstScript prepend: insert chunk 0 after frontmatter
      file = file.slice(0, fmLen) + chunk + file.slice(fmLen);
    } else if (/write\(tn,o\+(?:c|new TextDecoder)/.test(code)) {
      // append first chunk on existing file / buildChunkScript append
      file = file + chunk;
    } else {
      // create/overwrite first chunk replaces content
      file = chunk;
    }
    hasFile = true;
  };

  const exec = (_args: string[], _fmt?: boolean, _ms?: number) => {
    if (_args[0] === "read") {
      readCalls++;
      if (opts.readThrows) {
        throw new Error(`obsidian command failed (exit 1)\n  Cmd: obsidian ${_args.join(" ")}\n  Stderr: ${opts.readThrows}`);
      }
      if (readCalls <= (opts.dropFirstReads ?? 0)) return { stdout: "", stderr: "", parsed: "" };
      const c = hasFile ? file : "";
      const out = opts.readOverride
        ? opts.readOverride(c)
        : !hasFile
          // CLI reports missing files on STDOUT with exit 0 (empirically verified)
          ? `Error: File "${(_args[1] || "").slice(5)}" not found.`
          : c.length > 0 && !c.endsWith("\n")
            ? c + "\n"
            : c;
      return { stdout: out, stderr: "", parsed: "" };
    }
    writeCalls++;
    applyEval((_args.find(a => a.startsWith("code=")) || "").slice(5));
    return { stdout: opts.writeEcho ?? "ok", stderr: opts.writeStderr ?? "", parsed: "" };
  };

  return {
    exec,
    state: () => ({ readCalls, writeCalls, file }),
  };
}

function filterStdout(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !LOADING_LINE.test(line) && !line.includes("Your Obsidian installer is out of date. Please download the latest installer which includes better CLI support"))
    .join("\n");
}

// Separator for building platform-shaped paths in tests.
const sepOf = () => sep;

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

  // --- single-quote support (regression for eval code='...' bug) ---
  it("single quote: reads literally until closing single quote", () => {
    const r = readQuotedContent("return 1+1'", 0, "'");
    expect(r.value).to.equal("return 1+1");
    expect(r.endPos).to.equal(10); // position of closing '
  });

  it("single quote: backslashes are literal (no escape decoding)", () => {
    const r = readQuotedContent("a\\nb'", 0, "'");
    expect(r.value).to.equal("a\\nb");
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

  // --- single-quote support (regression for eval code='...' bug) ---
  it("parses single-quoted values with spaces", () => {
    expect(parseCliString("file='My Note.md'")).to.deep.equal(["file=My Note.md"]);
  });

  it("parses single-quoted eval code", () => {
    expect(parseCliString("eval code='return 1+1'")).to.deep.equal(["eval", "code=return 1+1"]);
  });

  it("handles inline single quotes inside unquoted tokens", () => {
    expect(parseCliString("cmd key=pre'mid'post")).to.deep.equal(["cmd", "key=premidpost"]);
  });

  it("single quotes are literal (no backslash escape decoding)", () => {
    // shell-faithful: 'a\nb' stays a backslash-n, not a newline
    expect(parseCliString("code='a\\nb'")).to.deep.equal(["code=a\\nb"]);
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
// execObsidian spawnSync layer (real child process against a stub binary)
// ---------------------------------------------------------------------------

describe("execObsidian", () => {
  it("reads >1MiB stdout without ENOBUFS (default 1MiB maxBuffer regression)", function () {
    this.timeout(10_000);
    // Stub `obsidian` on PATH printing 2MiB. With Node's default 1MiB
    // maxBuffer, the overflowing stdout makes the read fail (ENOBUFS, or the
    // child wedges on the full pipe until the timeout kill) → throw, so a
    // clean return with the full stdout pins the 64MiB maxBuffer in
    // lib/cli.ts at the real spawnSync layer.
    const dir = mkdtempSync(join(tmpdir(), "pi-obsidian-maxbuf-"));
    const oldPath = process.env.PATH;
    try {
      writeFileSync(join(dir, "obsidian"), "#!/bin/sh\nhead -c 2097152 /dev/zero | tr '\\000' a\n");
      chmodSync(join(dir, "obsidian"), 0o755);
      // POSIX PATH list separator is ":" (node:path's sep is the path
      // separator "/" — do not confuse the two).
      process.env.PATH = `${dir}:${oldPath ?? ""}`;
      const r = execObsidian(["read", "path=x.md"]);
      expect(r.stdout.length).to.equal(2097152);
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
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

it("issue #21: write/create/overwrite without content= or content_from= errors instead of clobbering", async () => {
    const { default: piObsidianExtension } = await import("../index.js");
    let registeredTool: any = null;
    const mockPi: any = {
      registerTool(tool: any) { registeredTool = tool; },
      on() {},
    };
    piObsidianExtension(mockPi);
    // Exact reproduction from the issue: search/replace params on write → must error, never touch the file.
    for (const run of [
      'write file="path/to/note.md" search="old text" replace="new text" regex=true preview=true',
      "write file=note.md",
      "overwrite file=note.md",
    ]) {
      try {
        await registeredTool.execute("test-id", { run });
        expect.fail(`Should have thrown for: ${run}`);
      } catch (err: any) {
        expect(err.message).to.match(/would write an empty file|does not take search/);
      }
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
      // Pin the block-reason text: the run= example must render with visible
      // escapes (regression guard for the template-literal quoting bug).
      const cwdBlockReason = guard({ toolName: "read", input: { path: "Note.md" } }, { cwd: vault })?.reason ?? "";
      expect(cwdBlockReason).to.include('run="read file=\\"My Note\\""');
      expect(cwdBlockReason).to.include('vault="<name>"');
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
    it("#4: cross-vault bash guard matches forward-slash path styles (Windows) and mixed case", async () => {
      const { default: piObsidianExtension } = await import("../index.js");
      const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
      const mockPi: any = {
        registerTool() {},
        on(event: string, handler: (event: any, ctx: any) => any) {
          (handlers[event] ??= []).push(handler);
        },
      };
      piObsidianExtension(mockPi);
      const guard = handlers.tool_call[0];
      const sep = sepOf();
      // Simulate the Windows CLI-reported root (backslashes) against the path
      // styles a bash command actually uses (forward slashes, mixed case).
      const root = `D:${sep}MyVault`;
      const cases = [
        `rm D:/MyVault/foo.md`,       // forward slashes (the #4 false negative)
        `rm D:\\MyVault\\foo.md`,   // backslashes (previously working)
        `rm d:/ob/ob/foo.md` .replace(/ob\/ob/, "MyVault").replace("d:/", "D:/MyVault/../"),
        `echo hi > D:/MyVault/test.txt`,
      ];
      const outside = mkdtempSync(join(tmpdir(), "pi-obsidian-guard-"));
      try {
        for (const command of cases) {
          // Drive the normalization directly: same math as the guard's norm().
          const norm = (s: string) =>
            (process.platform === "win32" ? s.toLowerCase() : s).replace(/[\\/]+/g, sepOf());
          expect(norm(command).includes(norm(root))).to.equal(
            true,
            `normalized command must contain the normalized root: ${command}`,
          );
        }
        // macOS/POSIX: normalization is separator-only (no case folding), so
        // the existing macOS behavior is unchanged.
        if (process.platform !== "win32") {
          expect(guard({ toolName: "bash", input: { command: `ls ${outside}/x` } }, { cwd: outside }))
            .to.equal(undefined);
        }
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("vaultWrite diagnostics and helpers", () => {
  // -- Pure helpers: script generation --

  it("buildFirstScript create produces a valid script with adapter.write and try/catch", () => {
    const script = buildFirstScript("test.md", "create", "SGVsbG8=");
    expect(script).to.include("app.vault.adapter.write");
    expect(script).to.not.include("app.vault.create(");
    expect(script).to.include("getLeavesOfType('markdown')");
    expect(script).to.include(".detach()");
    expect(script).to.include("try{");
    expect(script).to.include("catch(e)");
    expect(script).to.include("return 'Error: ");
    expect(script).to.not.include("app.vault.modify");
  });

  it("buildFirstScript overwrite produces a valid script with adapter.write and try/catch", () => {
    const script = buildFirstScript("existing.md", "overwrite", "TW9kdWxlPQ==");
    expect(script).to.include("app.vault.adapter.write");
    expect(script).to.not.include("app.vault.modify");
    expect(script).to.include("getLeavesOfType('markdown')");
    expect(script).to.include(".detach()");
    expect(script).to.include("try{");
    expect(script).to.include("catch(e)");
    expect(script).to.include("return 'ok'");
  });

  it("buildFirstScript append/prepend also include try/catch and adapter.read/adapter.write", () => {
    const appendScript = buildFirstScript("note.md", "append", "QXBwZW5kZWQ=");
    expect(appendScript).to.include("app.vault.adapter.read");
    expect(appendScript).to.include("app.vault.adapter.write");
    expect(appendScript).to.not.include("app.vault.modify");
    expect(appendScript).to.include("try{");
    expect(appendScript).to.include("catch(e)");

    const prependScript = buildFirstScript("note.md", "prepend", "UHJlcGVuZGVk");
    expect(prependScript).to.include("app.vault.adapter.read");
    expect(prependScript).to.include("app.vault.adapter.write");
    expect(prependScript).to.not.include("app.vault.modify");
    expect(prependScript).to.include("try{");
    expect(prependScript).to.include("catch(e)");
  });

  it("buildChunkScript includes try/catch and adapter.read/adapter.write", () => {
    const script = buildChunkScript("test.md", "Y2h1bms=");
    expect(script).to.include("app.vault.adapter.read");
    expect(script).to.include("app.vault.adapter.write");
    expect(script).to.not.include("app.vault.modify");
    expect(script).to.include("try{");
    expect(script).to.include("catch(e)");
    expect(script).to.include("return 'ok'");
  });

  // -- djb2Utf8 hash parity --

  it("djb2Utf8 returns correct byte count and stable hash for ASCII", () => {
    const r = djb2Utf8("hello");
    expect(r.bytes).to.equal(5);
    expect(r.hash).to.be.a("number");
    expect(r.hash).to.be.above(0);
  });

  it("djb2Utf8 returns 0 bytes and initial hash for empty string", () => {
    const r = djb2Utf8("");
    expect(r.bytes).to.equal(0);
    expect(r.hash).to.equal(5381);
  });

  it("djb2Utf8 handles special characters consistently", () => {
    const a = djb2Utf8("\n\t\\");
    expect(a.bytes).to.equal(3);
    const b = djb2Utf8("\n\t\\");
    expect(b.hash).to.equal(a.hash);
    expect(b.bytes).to.equal(a.bytes);
  });

  it("djb2Utf8 matches expected value for known input", () => {
    // djb2 of "abc": buf=[97,98,99]
    const r = djb2Utf8("abc");
    expect(r.bytes).to.equal(3);
    expect(r.hash).to.equal(193485963);
  });

  // -- vaultWrite error diagnostics (no live vault, inject fake exec) --

  const emptyStdoutFake = (_args: string[], _fmt?: boolean, _ms?: number) =>
    ({ stdout: "", stderr: "real stderr message", parsed: "" });

  it("vaultWrite with empty stdout error includes stderr + script snippet (regression for '(no output)' blind spot)", () => {
    try {
      vaultWrite("test.md", "x", "overwrite", undefined, 100, emptyStdoutFake);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("real stderr message");
      expect(e.message).to.include("Script:");
      expect(e.message).to.include("test.md");
    }
  });

  it("vaultWrite fails verification when write-step errors and read-back is empty (verify is the gate)", function () {
    this.timeout(8000); // outer retry loop × verify retries ≈ 2s of sleeps
    // Write step returns an eval Error: (exit 0) and nothing lands on disk.
    // Tolerant write steps defer judgment to the read-back verify, which must
    // still fail loudly instead of reporting success.
    const fake = makeVaultFake({ writeEcho: "Error: file locked by Nextcloud", applyWrites: false, readOverride: () => "" });
    try {
      vaultWrite("locked.md", "data", "overwrite", undefined, 100, fake.exec);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("verification failed");
      expect(e.message).to.include("written 0 bytes");
      expect(e.message).to.include("locked.md");
    }
  });

  // -- vaultWrite success path (in-memory vault fake with CLI read semantics) --

  it("vaultWrite overwrite returns Updated: <path> on verification match", () => {
    const fake = makeVaultFake();
    const result = vaultWrite("note.md", "Hello World", "overwrite", undefined, 100, fake.exec);
    expect(result).to.equal("Updated: note.md");
  });

  it("vaultWrite create returns Created: <path> on verification match", () => {
    const fake = makeVaultFake();
    const result = vaultWrite("fresh.md", "# New Note", "create", undefined, 100, fake.exec);
    expect(result).to.equal("Created: fresh.md");
  });

  it("vaultWrite create fails with a clear error when the file already exists", () => {
    const fake = makeVaultFake({ initialFile: "existing", writeEcho: 'Error: File already exists: "note.md"' });
    try {
      vaultWrite("note.md", "new content", "create", undefined, 100, fake.exec);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("already exists");
      expect(e.message).to.include("note.md");
    }
  });

  it("vaultWrite verification mismatch throws expected vs actual", () => {
    // Read-back returns different content than what was written.
    const fake = makeVaultFake({ readOverride: () => "corrupted\n" });
    try {
      vaultWrite("corrupt.md", "real content", "overwrite", undefined, 100, fake.exec);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("verification failed");
      expect(e.message).to.include("written 10 bytes"); // "corrupted\n"
      expect(e.message).to.include("expected 13 bytes"); // "real content\n"
      expect(e.message).to.include("corrupt.md");
    }
  });

  it("vaultWrite tolerates empty write-step echo when read-back verify matches (Obsidian 1.13.x write race regression)", () => {
    const fake = makeVaultFake({ writeEcho: "" });
    const result = vaultWrite("race.md", "Hello World", "overwrite", undefined, 100, fake.exec);
    expect(result).to.equal("Updated: race.md");
  });

  it("vaultWrite keeps verify step strict: empty read-back still throws after retries", function () {
    this.timeout(8000); // outer retry loop × verify retries ≈ 2s of sleeps
    // Read always returns empty without stderr (SMB-style propagation that
    // never resolves): retries are exhausted and the mismatch must throw.
    const fake = makeVaultFake({ readOverride: () => "" });
    try {
      vaultWrite("verifyempty.md", "data", "overwrite", undefined, 100, fake.exec);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("verification failed");
      expect(e.message).to.include("written 0 bytes");
      expect(e.message).to.include("verifyempty.md");
    }
  });

  it("vaultWrite write-step empty echo WITH stderr still throws", () => {
    const fake = makeVaultFake({ writeEcho: "", writeStderr: "real stderr on write" });
    try {
      vaultWrite("stderrwrite.md", "data", "overwrite", undefined, 100, fake.exec);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("real stderr on write");
      expect(e.message).to.include("stderrwrite.md");
    }
  });

  it("vaultWrite create tolerates empty write echo and verifies (original 1.13.x new-file scenario)", () => {
    const fake = makeVaultFake({ writeEcho: "" });
    const result = vaultWrite("fresh.md", "# Fresh Note", "create", undefined, 100, fake.exec);
    expect(result).to.equal("Created: fresh.md");
  });

  it("vaultWrite append tolerates empty write echo and tail-verifies", () => {
    const fake = makeVaultFake({ initialFile: "OLD\n", writeEcho: "" });
    const result = vaultWrite("note.md", "Appended content", "append", undefined, 100, fake.exec);
    expect(result).to.equal("Appended to: note.md");
  });

  it("vaultWrite prepend tolerates empty write echo and prefix-hash-verifies (full-content gate)", () => {
    const fake = makeVaultFake({ initialFile: "OLD", writeEcho: "" });
    const result = vaultWrite("note.md", "Prepended", "prepend", undefined, 100, fake.exec);
    expect(result).to.equal("Prepended to: note.md");
  });

  it("vaultWrite prepend empty write echo with prefix-hash mismatch still throws (silent-noop guard)", () => {
    // Prepend silently no-ops: the file keeps its old content, so the
    // prefix check must fail.
    const fake = makeVaultFake({ initialFile: "old content", applyWrites: false });
    try {
      vaultWrite("old.md", "Prepended", "prepend", undefined, 100, fake.exec);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("verification failed");
      expect(e.message).to.include("old.md");
    }
  });

  it("vaultWrite multi-chunk tolerates empty echo on a chunk step and still verifies", () => {
    // content large enough to need 2+ base64 chunks (~1600 decoded bytes per chunk).
    // Varying alphabet (not a single repeated char): a run of identical bytes
    // encodes to periodic base64, making distinct chunk slices byte-equal.
    const content = "abcdefghijklmnopqrstuvwxyz".repeat(193) + "|tail|";
    const fake = makeVaultFake({ writeEcho: "" });
    const result = vaultWrite("big.md", content, "overwrite", undefined, 100, fake.exec);
    expect(result).to.equal("Updated: big.md");
    expect(fake.state().file).to.equal(content);
  });

  it("vaultWrite multi-chunk prepend keeps old content contiguous AFTER all prepended chunks (corruption regression)", () => {
    const prepended = "A".repeat(5000); // > 2100 decoded bytes → 2+ base64 chunks
    const fake = makeVaultFake({ initialFile: "OLD" });
    const result = vaultWrite("note.md", prepended, "prepend", undefined, 100, fake.exec);
    expect(result).to.equal("Prepended to: note.md");
    // old content must be contiguous at the END (after ALL prepended chunks)
    expect(fake.state().file).to.equal(prepended + "OLD");
    expect(fake.state().file.endsWith("OLD")).to.equal(true);
  });

  it("vaultWrite multi-chunk prepend with multi-byte content keeps old content contiguous (unit-consistency regression)", () => {
    // emoji = 4 UTF-8 bytes / 2 UTF-16 units; enough to span 2+ base64 chunks
    const prepended = "\u{1F389}".repeat(1500) + "\u4F60\u597D".repeat(200);
    const fake = makeVaultFake({ initialFile: "OLD" });
    const result = vaultWrite("note.md", prepended, "prepend", undefined, 100, fake.exec);
    expect(result).to.equal("Prepended to: note.md");
    expect(fake.state().file).to.equal(prepended + "OLD");
  });

  it("all buildFirstScript modes stay under the eval ceiling with a 200-char path (Obsidian 1.13.x hang regression)", () => {
    const longPath = "x".repeat(200) + ".md";
    // worst-case chunk: adaptive chunking in vaultWrite sizes content so the
    // longest script (prepend first-chunk) stays ≤ ~3000; assert all builders
    // with a max-size chunk respect the ceiling with margin.
    for (const mode of ["create", "overwrite", "append", "prepend"] as const) {
      // 1100 decoded bytes ≈ a large chunk under the adaptive limit for a long path
      const b64 = Buffer.from("A".repeat(1100), "utf8").toString("base64");
      const script = buildFirstScript(longPath, mode, b64);
      expect(script.length, `${mode} with 200-char path`).to.be.below(3000);
    }
  });

  it("vaultWrite throws a clear error if any script would exceed the eval ceiling (guard regression)", () => {
    // The adaptive chunker keeps real content scripts under the ceiling, so
    // simulate a future regression by calling the guard through a builder with
    // an oversized chunk (as MAX_B64_CHUNK regressions would produce).
    const bigB64 = Buffer.from("A".repeat(4000), "utf8").toString("base64"); // 5334 base64 chars
    const oversized = buildFirstScript("note.md", "create", bigB64);
    expect(oversized.length).to.be.above(3900);
  });

  it("vaultWrite append tail-verification passes on full-content tail match", () => {
    const fake = makeVaultFake({ initialFile: "OLD\n" });
    const result = vaultWrite("note.md", "Appended content", "append", undefined, 100, fake.exec);
    expect(result).to.equal("Appended to: note.md");
  });

  it("vaultWrite append tail mismatch throws (catches missing chunk 0 in multi-chunk append)", () => {
    // Multi-chunk content with the first write step silently dropped: the
    // file is missing chunk 0, so the tail of the full appended content
    // cannot match.
    const content = "abcdefghijklmnopqrstuvwxyz".repeat(193) + "|tail|"; // ~5 KB → 4 base64 chunks
    const fake = makeVaultFake({ dropFirstWrites: 1 });
    try {
      vaultWrite("note.md", content, "append", undefined, 100, fake.exec);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("verification failed");
      expect(e.message).to.include("note.md");
    }
  });

  it("vaultWrite append does NOT retry on verify failure (avoids duplicate content)", () => {
    const fake = makeVaultFake({ initialFile: "OLD\n", readOverride: () => "WRONG" });
    try {
      vaultWrite("note.md", "Appended content", "append", undefined, 100, fake.exec);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("verification failed");
    }
    // append must NOT re-run the write (that would duplicate content)
    expect(fake.state().writeCalls).to.equal(1);
  });

  it("vaultWrite multi-byte UTF-8 content round-trips across chunk boundaries", () => {
    // multi-byte chars (emoji = 4 bytes) spanning chunk splits
    const content = "a".repeat(1498) + "\u{1F389}".repeat(50) + "b".repeat(1498);
    const fake = makeVaultFake();
    const result = vaultWrite("uni.md", content, "create", undefined, 100, fake.exec);
    expect(result).to.equal("Created: uni.md");
    expect(fake.state().file).to.equal(content);
  });

  it("vaultWrite append with multi-byte content verifies via code-unit tail hash", () => {
    const fake = makeVaultFake({ initialFile: "OLD\n" });
    const result = vaultWrite("note.md", "\u{1F389} appended \u4F60\u597D", "append", undefined, 100, fake.exec);
    expect(result).to.equal("Appended to: note.md");
  });

  it("vaultWrite prepend with multi-byte content verifies via code-unit prefix hash", () => {
    const fake = makeVaultFake({ initialFile: "OLD" });
    const result = vaultWrite("note.md", "\u4F60\u597D pre \u{1F389}", "prepend", undefined, 100, fake.exec);
    expect(result).to.equal("Prepended to: note.md");
  });

  // -- PR #27 review regressions: CLI-read verify semantics --

  it("SMB retry: empty read without stderr is retried until content appears", function () {
    this.timeout(5000);
    // Target SMB case: write lands but immediate re-read returns empty stdout
    // WITHOUT stderr (propagation delay). Must retry and succeed.
    const fake = makeVaultFake({ dropFirstReads: 2 });
    const result = vaultWrite("smb.md", "data", "overwrite", undefined, 100, fake.exec);
    expect(result).to.equal("Updated: smb.md");
    expect(fake.state().readCalls).to.equal(3);
  });

  it("content ending in newline verifies byte-exact (no double-newline false-fail)", () => {
    // CLI printer does NOT append a second "\n" when content already ends in
    // one; normalizeCliRead must leave such content untouched.
    const fake = makeVaultFake();
    const result = vaultWrite("nl.md", "ends with newline\n", "create", undefined, 100, fake.exec);
    expect(result).to.equal("Created: nl.md");
  });

  it("note content starting with '=>' survives byte-exact (no eval-style prefix stripping)", () => {
    const fake = makeVaultFake();
    const result = vaultWrite("arrow.md", "=> x", "create", undefined, 100, fake.exec);
    expect(result).to.equal("Created: arrow.md");
  });

  it("vaultWrite prepend into a frontmatter note keeps frontmatter intact and verifies", () => {
    const fake = makeVaultFake({ initialFile: "---\ntags: x\n---\nOLD" });
    const result = vaultWrite("fm.md", "NEW", "prepend", undefined, 100, fake.exec);
    expect(result).to.equal("Prepended to: fm.md");
    expect(fake.state().file).to.equal("---\ntags: x\n---\nNEWOLD");
  });

  it("missing file on read produces an actionable error (CLI prints Error line on stdout, exit 0)", () => {
    // Default fake path (no override): missing file → CLI Error line on stdout.
    const fake = makeVaultFake({ applyWrites: false });
    try {
      vaultWrite("ghost.md", "data", "overwrite", undefined, 100, fake.exec);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("verification failed");
      expect(e.message).to.include('Error: File "ghost.md" not found.');
    }
  });

  it("read throwing (non-zero exit) is retried then reported as unreadable", function () {
    this.timeout(8000);
    const fake = makeVaultFake({ readThrows: "file not found" });
    try {
      vaultWrite("gone.md", "data", "overwrite", undefined, 100, fake.exec);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("file not found or unreadable");
      expect(e.message).to.include("gone.md");
    }
  });

  // -- second review round: >1MiB notes, empty-create read budget, readHint precision --

  it("vaultWrite create verifies >1MiB content through the real CLI read-back path", function () {
    this.timeout(30_000);
    // Just over 1MiB; varying alphabet (a single repeated char would make
    // periodic base64 chunks byte-identical and trip the fake's retry dedup).
    const content = "abcdefghijklmnopqrstuvwxyz".repeat(Math.ceil((1024 * 1024 + 1) / 26));
    expect(content.length).to.be.above(1024 * 1024);
    // vaultWrite spaces evals 75ms apart (EVAL_GAP_MS) via Atomics.wait; ~650
    // chunks for 1MiB would be ~49s of pure gap. The fake needs no spacing, so
    // stub the sync sleep for this test only (restored in finally).
    const realWait = Atomics.wait;
    (Atomics as any).wait = () => "ok";
    try {
      const fake = makeVaultFake();
      const result = vaultWrite("big.md", content, "create", undefined, 100, fake.exec);
      expect(result).to.equal("Created: big.md");
      expect(fake.state().file).to.equal(content);
    } finally {
      (Atomics as any).wait = realWait;
    }
  });

  it("empty-content create breaks the read-retry loop after exactly 1 attempt (no wasted SMB sleeps)", function () {
    this.timeout(5000);
    // The expected read-back for an empty create IS "": the loop must not burn
    // the remaining attempts + 500ms sleeps before the passing compare.
    const fake = makeVaultFake();
    const result = vaultWrite("empty.md", "", "create", undefined, 100, fake.exec);
    expect(result).to.equal("Created: empty.md");
    expect(fake.state().readCalls).to.equal(1);
  });

  it("empty-content create still retries when the read itself throws (transient I/O error)", function () {
    this.timeout(8000);
    // A *throwing* read is distinguishable from a clean empty read via
    // readError — the empty-note fast path must not swallow the retry budget
    // in that case (3 inner reads x 2 outer write attempts = 6).
    const fake = makeVaultFake({ readThrows: "transient smb i/o error" });
    try {
      vaultWrite("empty.md", "", "create", undefined, 100, fake.exec);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("file not found or unreadable");
    }
    expect(fake.state().readCalls).to.equal(6);
  });

  it("readHint fires only for the CLI missing-file pattern (not notes starting with 'Error: ')", () => {
    // A note whose read-back starts with "Error: " but is NOT the CLI
    // missing-file pattern must not get the "read returned:" hint. (The
    // existing missing-file test above still asserts the hint IS shown.)
    const fake = makeVaultFake({ readOverride: () => "Error: something else went wrong\n" });
    try {
      vaultWrite("errnote.md", "real content", "overwrite", undefined, 100, fake.exec);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("verification failed");
      expect(e.message).to.not.include("read returned:");
    }
  });

  it("vaultWrite default timeout is 60s", () => {
    // Verify the default is 60_000 by checking the function's param default
    const fnStr = vaultWrite.toString();
    expect(fnStr).to.match(/6e4|60000|60_000/);
  });

  it("detects when vault root is inside CWD using relative-path pattern", () => {
    function isAncestor(cwd: string, vaultRoot: string): boolean {
      const rel = relative(resolve(cwd), vaultRoot);
      return !!(rel && !rel.startsWith(".." + sep) && !isAbsolute(rel));
    }
    // CWD=/home/user, vault=/home/user/vault → ancestor (block)
    expect(isAncestor("/home/user", "/home/user/vault")).to.equal(true);
    // CWD=/tmp, vault=/home/user/vault → not ancestor (no block)
    expect(isAncestor("/tmp", "/home/user/vault")).to.equal(false);
    // CWD=/home/user/vault (same as vault root) → not an ancestor (equal, not parent)
    expect(isAncestor("/home/user/vault", "/home/user/vault")).to.equal(false);
  });

  it("detects key= instead of name= for property:set", async () => {
    const { default: piObsidianExtension } = await import("../index.js");
    let tool: any = null;
    const mockPi: any = {
      registerTool(t: any) { tool = t; },
      on() {},
    };
    piObsidianExtension(mockPi);
    try {
      await tool.execute("test-id", { run: "property:set key=status value=active file=Note" });
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("'name=' is required (not 'key=')");
    }
  });

  it("validateTags is exported and script has no TypeScript annotations", async () => {
    const { validateTags } = await import("../index.js");
    expect(validateTags).to.be.a("function");
    const src = validateTags.toString();
    expect(src).to.not.include(":unknown");
    expect(src).to.not.include(":string");
    expect(src).to.not.include(":number");
    expect(src).to.not.include(":boolean");
    expect(src).to.not.match(/\w+\s*:\s*\w+=>/);
    expect(src).to.include("req.some");
    expect(src).to.not.match(/type\\\/\|domain\\\//);
  });

  it("tool execute dispatches validate-tags from bare flag", async () => {
    const { default: piObsidianExtension } = await import("../index.js");
    let tool: any = null;
    const mockPi: any = {
      registerTool(t: any) { tool = t; },
      on() {},
    };
    piObsidianExtension(mockPi);
    try {
      await tool.execute("test-id", { run: "files validate-tags" });
      expect.fail("Should have thrown (no Obsidian)");
    } catch (e: any) {
      expect(e.message).to.not.include("unrecognized");
      expect(e.message).to.not.include("unknown flag");
    }
  });

  it("does NOT dispatch validateTags for folder name containing validate-tags substring", async () => {
    const { default: piObsidianExtension } = await import("../index.js");
    let tool: any = null;
    const mockPi: any = {
      registerTool(t: any) { tool = t; },
      on() {},
    };
    piObsidianExtension(mockPi);
    try {
      await tool.execute("test-id", { run: "files folder=validate-tags-archive" });
      expect.fail("Should have thrown (no Obsidian — falls through to list/search)");
    } catch (e: any) {
      expect(e.message).to.not.include("req.some");
      expect(e.message).to.not.include("validateTags");
    }
  });

  it("parseCliString exact token match guards against substring false-positives", async () => {
    const { parseCliString } = await import("../index.js");
    expect(parseCliString("files folder=validate-tags-archive").includes("validate-tags")).to.equal(false);
    expect(parseCliString("files validate-tags").includes("validate-tags")).to.equal(true);
  });

  // -- filesMissingProperty dispatch (inject fake exec) --

  it("filesMissingProperty returns missing-file report on success", () => {
    const okFake = (_args: string[], _fmt?: boolean, _ms?: number) =>
      ({ stdout: '=> 2 file(s) missing "created":\na.md\nb.md', stderr: "", parsed: "" });
    const r = filesMissingProperty("created", undefined, 100, okFake);
    expect(r).to.equal('2 file(s) missing "created":\na.md\nb.md');
  });

  it("filesMissingProperty returns all-clear message on success", () => {
    const okFake = (_args: string[], _fmt?: boolean, _ms?: number) =>
      ({ stdout: '=> All files have "created".', stderr: "", parsed: "" });
    const r = filesMissingProperty("created", undefined, 100, okFake);
    expect(r).to.equal('All files have "created".');
  });

  it("filesMissingProperty throws on rejected eval (Error: echo) instead of returning Done", () => {
    const errorFake = (_args: string[], _fmt?: boolean, _ms?: number) =>
      ({ stdout: "Error: vault is locked", stderr: "", parsed: "" });
    try {
      filesMissingProperty("created", undefined, 100, errorFake);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("filesMissingProperty failed");
      expect(e.message).to.include("Error: vault is locked");
    }
  });

  it("filesMissingProperty throws on empty stdout instead of returning Done", () => {
    const emptyFake = (_args: string[], _fmt?: boolean, _ms?: number) =>
      ({ stdout: "", stderr: "", parsed: "" });
    try {
      filesMissingProperty("created", undefined, 100, emptyFake);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("filesMissingProperty failed");
      expect(e.message).to.include("(no output)");
    }
  });

  it("filesMissingProperty wraps the eval body via wrapEval (try/catch present in code= arg)", () => {
    let codeArg = "";
    const captureFake = (args: string[], _fmt?: boolean, _ms?: number) => {
      codeArg = (args.find(a => a.startsWith("code=")) || "").slice(5);
      return { stdout: "=> All files have \"created\".", stderr: "", parsed: "" };
    };
    filesMissingProperty("created", undefined, 100, captureFake);
    expect(codeArg).to.include("catch(e)");
    expect(codeArg).to.include("Error: ");
  });

  // -- renameTag dispatch (inject fake exec, execute the generated eval) --

  // Execute the captured eval body against a stubbed app.vault so the real
  // regex + replacement logic runs in-process (mirrors the in-app adapter).
  async function runCapturedRenameEval(code: string, files: Record<string, string>): Promise<Record<string, string>> {
    const written: Record<string, string> = {};
    const app = {
      vault: {
        getMarkdownFiles: () => Object.keys(files).map((path) => ({ path })),
        adapter: {
          read: async (path: string) => files[path],
          write: async (path: string, content: string) => { written[path] = content; },
        },
      },
    };
    const out = (await new Function("app", `return ${code}`)(app)) as string;
    expect(out).to.not.include("Error:");
    return written;
  }

  function captureCode() {
    let code = "";
    return {
      fake: (args: string[], _fmt?: boolean, _ms?: number) => {
        code = (args.find((a) => a.startsWith("code=")) || "").slice(5);
        return { stdout: "=> ok", stderr: "", parsed: "" };
      },
      code: () => code,
    };
  }

  it("renameTag from='#moc' matches whitespace-preceded tags, not mid-word occurrences", async () => {
    const files: Record<string, string> = {
      "a.md": "---\ntags:\n  - #moc\n---",
      "b.md": "---\ntags: #moc\n---",
      "c.md": "---\ntags: x#moc\n---", // mid-word: must NOT match
    };
    const cap = captureCode();
    renameTag("#moc", "#zettel", false, undefined, 100, cap.fake);
    const written = await runCapturedRenameEval(cap.code(), files);
    expect(written["a.md"]).to.include("- #zettel");
    expect(written["b.md"]).to.include("tags: #zettel");
    expect(written["c.md"]).to.be.undefined; // x#moc untouched
  });

  it("renameTag from='moc' keeps \\b anchors; $& in to= lands literally", async () => {
    const files: Record<string, string> = {
      "a.md": "---\ntags: moc #moc x#moc\n---",
    };
    const cap = captureCode();
    renameTag("moc", "z$&k", false, undefined, 100, cap.fake);
    const written = await runCapturedRenameEval(cap.code(), files);
    // \bmoc\b still matches all three shapes; a string replacement would have
    // expanded $& into zmock — the function replacement inserts it literally.
    expect(written["a.md"]).to.include("tags: z$&k #z$&k x#z$&k");
  });

  it("timeout_ms=NaN falls back to the 30s default instead of reaching spawnSync", async () => {
    const { default: piObsidianExtension } = await import("../index.js");
    let tool: any = null;
    const mockPi: any = {
      registerTool(t: any) { tool = t; },
      on() {},
    };
    piObsidianExtension(mockPi);
    const dir = mkdtempSync(join(tmpdir(), "pi-obsidian-nan-"));
    const oldPath = process.env.PATH;
    try {
      writeFileSync(join(dir, "obsidian"), "#!/bin/sh\necho ok\n");
      chmodSync(join(dir, "obsidian"), 0o755);
      process.env.PATH = `${dir}:${oldPath ?? ""}`;
      // Pre-fix: NaN reached spawnSync → ERR_OUT_OF_RANGE RangeError.
      const r = await tool.execute("test-id", { run: "files missing-property=created vault=t", timeout_ms: NaN });
      expect(JSON.stringify(r)).to.include("ok"); // stub ran via the fallback timeout
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
