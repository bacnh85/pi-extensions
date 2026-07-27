import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSemanticMissToolCall,
  missedDedicatedTool,
  dedicatedToolForShellCommand,
  suggestBestSerenaCommand,
  categorizeToolError,
  checkDangerousCommand,
} from "../../lib/shell-helpers.ts";

describe("semantic miss detection", () => {
  it("does not flag reads of code files (read is the correct tool for content)", () => {
    assert.equal(isSemanticMissToolCall("read", { path: "extensions/index.ts" }), false);
    assert.equal(isSemanticMissToolCall("read", { path: "src/app.py?x=1" }), false);
  });

  it("does not flag docs, package/config files, or non-code reads", () => {
    assert.equal(isSemanticMissToolCall("read", { path: "README.md" }), false);
    assert.equal(isSemanticMissToolCall("read", { path: "package.json" }), false);
    assert.equal(isSemanticMissToolCall("read", { path: ".gitignore" }), false);
    assert.equal(isSemanticMissToolCall("read", { path: "notes.txt" }), false);
  });

  it("flags shell semantic code searches", () => {
    assert.equal(isSemanticMissToolCall("bash", { command: "rg 'function foo' src/**/*.ts" }), true);
    assert.equal(isSemanticMissToolCall("bash", { command: "find src -name '*.ts' -print" }), true);
    assert.equal(isSemanticMissToolCall("bash", { command: "grep -R 'class User' src" }), true);
    // Simple cat/head/tail on code files are NOT semantic misses — handled by dedicatedToolForShellCommand
    assert.equal(isSemanticMissToolCall("bash", { command: "cat index.ts" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "head -n 10 src/main.go" }), false);
  });

  it("does not flag normal shell commands or non-code exact searches", () => {
    assert.equal(isSemanticMissToolCall("bash", { command: "ls -la" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "pwd" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "git status --short" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "npm test" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "grep -R PI_MODEL_TOOLS README.md" }), false);
  });
});

describe("dedicated tool miss detection", () => {
  const active = ["bash", "ls", "find", "grep", "read", "write"];

  it("maps simple shell substitutions to dedicated Pi tools", () => {
    assert.equal(dedicatedToolForShellCommand("ls extensions", active), "ls");
    assert.equal(dedicatedToolForShellCommand("find src -name '*.ts'", active), "find");
    assert.equal(dedicatedToolForShellCommand("grep -R PI_MODEL_TOOLS README.md", active), "grep");
    assert.equal(dedicatedToolForShellCommand("cat README.md", active), "read");
    assert.equal(dedicatedToolForShellCommand("head -n 5 README.md", active), "read");
    assert.equal(dedicatedToolForShellCommand("head README.md", active), "read");
    assert.equal(dedicatedToolForShellCommand("tail -20 README.md", active), "read");
    assert.equal(dedicatedToolForShellCommand("sed -n '1,20p' README.md", active), undefined, "sed -n is a real command");
    assert.equal(dedicatedToolForShellCommand("echo 'hello' > /tmp/test.md", active), "write");
    assert.equal(dedicatedToolForShellCommand("printf 'content' > /tmp/file", active), "write");
  });

  it("does not flag commands that genuinely need a shell", () => {
    assert.equal(dedicatedToolForShellCommand("ls | wc -l", active), undefined);
    assert.equal(dedicatedToolForShellCommand("git status --short", active), undefined);
    assert.equal(dedicatedToolForShellCommand("npm test", active), undefined);
    assert.equal(dedicatedToolForShellCommand("grep foo README.md && echo ok", active), undefined);
  });

  it("reports missed dedicated tools for bash calls", () => {
    assert.equal(missedDedicatedTool("bash", { command: "ls extensions" }, ["bash", "ls"]), "ls");
    assert.equal(missedDedicatedTool("read", { path: "README.md" }, ["bash", "ls"]), undefined);
  });
});

describe("suggestBestSerenaCommand", () => {
  const tools = ["serena_get_symbols_overview", "serena_find_symbol", "serena_search_for_pattern"];

  it("extracts symbol from grep -rn command", () => {
    const result = suggestBestSerenaCommand({ command: "grep -rn \"wrapToolDefinition\" src/" }, tools);
    assert.ok(result.includes("serena_find_symbol"));
    assert.ok(result.includes("wrapToolDefinition"));
  });

  it("extracts symbol from rg command", () => {
    const result = suggestBestSerenaCommand({ command: "rg 'REASONING_FIELDS'" }, tools);
    assert.ok(result.includes("serena_find_symbol"));
    assert.ok(result.includes("REASONING_FIELDS"));
  });

  it("extracts class search", () => {
    const result = suggestBestSerenaCommand({ command: "grep -rn 'class UserService' src/" }, tools);
    // 'class UserService' (with space) is not a clean symbol — falls back to overview
    assert.ok(result.includes("serena_"));
  });

  it("falls back to overview/search for unrecognized patterns", () => {
    const result = suggestBestSerenaCommand({ command: "find src -name '*.ts' -exec grep 'something' {} \\;" }, tools);
    assert.ok(result.includes("serena_get_symbols_overview") || result.includes("serena_search_for_pattern"));
  });

  it("handles missing/non-object input", () => {
    assert.ok(suggestBestSerenaCommand({}, tools).includes("serena_"));
    assert.ok(suggestBestSerenaCommand("not an object", tools).includes("serena_"));
  });
});

describe("categorizeToolError", () => {
  it("classifies rate limits", () => {
    const info = categorizeToolError("bash", { content: [{ type: "text", text: "rate limit exceeded (429)" }] });
    assert.equal(info.category, "rate_limit");
    assert.match(info.hint, /rate-limited/i);
  });

  it("classifies edit mismatches", () => {
    const info = categorizeToolError("edit", { content: [{ type: "text", text: "Could not find edits matching oldText" }] });
    assert.equal(info.category, "edit_mismatch");
    assert.match(info.hint, /exact unique matching/i);
  });

  it("classifies path-not-found", () => {
    const info = categorizeToolError("read", { content: [{ type: "text", text: "ENOENT: no such file or directory" }] });
    assert.equal(info.category, "path_not_found");
  });

  it("classifies unknown errors", () => {
    const info = categorizeToolError("read", "something weird happened");
    assert.equal(info.category, "unknown");
  });
});

describe("checkDangerousCommand", () => {
  it("flags forced recursive delete of absolute paths", () => {
    assert.ok(checkDangerousCommand("rm -rf /etc"));
    assert.ok(checkDangerousCommand("rm -rf --no-preserve-root /"));
    assert.ok(checkDangerousCommand("rm -rf '/home/user'"));
  });

  it("does not flag safe rm", () => {
    assert.equal(checkDangerousCommand("rm file.txt"), undefined);
    assert.equal(checkDangerousCommand("rm -rf ./build"), undefined); // relative, not absolute
    assert.equal(checkDangerousCommand("ls -la"), undefined);
  });
});
