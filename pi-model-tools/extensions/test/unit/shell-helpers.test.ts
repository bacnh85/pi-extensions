import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSemanticMissToolCall,
  missedDedicatedTool,
  dedicatedToolForShellCommand,
  suggestBestSerenaCommand,
  extractSymbolFromGrep,
  categorizeToolError,
  detectReasoningRejection,
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

  it("does not flag compound shell jobs (pipelines/chains) — legit shell work", () => {
    assert.equal(isSemanticMissToolCall("bash", { command: "grep -rn 'sqi_manager_task' system_tasks.c | head" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "cat file.txt | grep foo" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "grep foo src | head -n 5; echo done" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "ls -la; pwd" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "find . -name '*.ts' | wc -l" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "git status --short | grep modified" }), false);
  });

  it("does not flag searches in vendored SDK paths (Serena cannot index them)", () => {
    assert.equal(isSemanticMissToolCall("bash", { command: "grep -rn 'sqi_manager_task' vendors/microchip/boards/curiosity_pic32mzef/system_tasks.c" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "grep -rn 'init' vendor/foo.c" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "rg 'task' third_party/rtos/kernel.c" }), false);
  });

  it("still excludes dot-prefixed dirs (.git/.next/.cache) from steering", () => {
    assert.equal(isSemanticMissToolCall("bash", { command: "grep -rn 'foo' .git/hooks/pre-commit" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "grep -rn 'foo' repo/.git/config" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "grep -rn 'foo' .next/server.ts" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "grep -rn 'foo' .cache/build.ts" }), false);
  });

  it("does not flag searches in node_modules or .d.ts (Serena cannot index these)", () => {
    assert.equal(isSemanticMissToolCall("bash", { command: "grep -rn 'ResourceLoader' node_modules/@earendil-works/types.d.ts" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "grep -F 'ResourceLoader' dist/index.d.ts" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "find node_modules -name '*.d.ts'" }), false);
    assert.equal(isSemanticMissToolCall("bash", { command: "grep 'ResourceLoader' build/output.d.ts" }), false);
  });

  it("does not flag quoted grep patterns (literal text search, not symbol lookup)", () => {
    assert.equal(isSemanticMissToolCall("grep", { pattern: "'exact error string'" }), false);
    assert.equal(isSemanticMissToolCall("grep", { pattern: "\"getSystemPromptSource\"" }), false);
    assert.equal(isSemanticMissToolCall("grep", { pattern: "`template literal`" }), false);
  });

  it("still flags real symbol searches in project source", () => {
    assert.equal(isSemanticMissToolCall("bash", { command: "grep -rn 'class UserService' src/index.ts" }), true);
    assert.equal(isSemanticMissToolCall("bash", { command: "rg 'function foo' src/**/*.ts" }), true);
    assert.equal(isSemanticMissToolCall("grep", { pattern: "UserService", path: "src/index.ts" }), true);
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

  it("does not pick post-pipeline tokens as the symbol (regression: echo/head)", () => {
    const result = suggestBestSerenaCommand({ command: "grep -rn 'sqi_manager_task' system_tasks.c | head; echo ===" }, tools);
    // The metachar stop keeps the scan on grep's own args → picks sqi_manager_task, never echo/===
    assert.ok(result.includes("sqi_manager_task"), `expected symbol in: ${result}`);
    assert.ok(!result.includes("echo"), `must not suggest echo: ${result}`);
  });

  it("continues past quoted tokens containing metachars (a|b is literal content)", () => {
    // Quoted | is literal pattern content, not a shell separator. But per the
    // "first non-flag token is the pattern" rule, a QUOTED textual pattern
    // ("a|b") means the search is textual — no symbol is suggested after it.
    // Direct unit test of the scan behavior:
    assert.equal(extractSymbolFromGrep("rg \"a|b\" MyClass src/"), undefined, "textual quoted pattern → no symbol");
    // A clean single-quoted pattern is still extracted, even with a quoted
    // metachar token AFTER it (proves the m[3] stop doesn't fire on quoted |):
    assert.equal(extractSymbolFromGrep("grep -rn 'MyClass' \"a|b\" src/"), "MyClass", "clean pattern extracted past quoted |");
    // Unquoted | still stops the scan (post-pipeline tokens never count):
    assert.equal(extractSymbolFromGrep("grep -rn 'MyClass' file.ts | head"), "MyClass", "unquoted | stops after grep args");
    assert.equal(extractSymbolFromGrep("grep -rn 'MyClass' file.ts | head; echo ==="), "MyClass", "chain after pipe still extracts");
  });

  it("does not suggest directory names as symbols after a textual quoted pattern", () => {
    // "class Foo" is a textual pattern (rejected by the symbol filter); the scan
    // must NOT fall through to trailing path args like src/app/lib.
    const result = suggestBestSerenaCommand({ command: "grep -rn \"class Foo\" src" }, tools);
    assert.ok(!result.includes("name_path_pattern: \"src\""), `must not suggest src as symbol: ${result}`);
    assert.ok(!result.includes("name_path_pattern: \"app\""), `must not suggest app as symbol: ${result}`);
    assert.ok(result.includes("serena_"), "falls back to a generic serena suggestion");
    // Direct: the same command yields no symbol at all.
    assert.equal(extractSymbolFromGrep("grep -rn \"class Foo\" src"), undefined);
    // Unquoted clean pattern still extracts (no quoted-textual-pattern stop):
    assert.equal(extractSymbolFromGrep("grep -rn MyClass src"), "MyClass");
  });

  it("extracts pattern after a quoted token with metachars (find -exec grep)", () => {
    const result = suggestBestSerenaCommand({ command: "find . -name '*.ts' -exec grep 'a|b' {} \\;" }, tools);
    assert.ok(result.includes("serena_"), `expected serena suggestion: ${result}`);
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

  it("classifies edit mismatch even when the enriched nearest-region snippet contains 'timeout'/'429'", () => {
    // Regression: nearestBlock appends raw file lines; before the fix these
    // matched the rate_limit/timeout patterns first → wrong recovery hint.
    const text = "Could not find the exact text in a.ts. The old text must match exactly.\n\nNearest matching region (lines 5-8):\nconst timeout = 5000;\nif (status === 429) { rate limit }";
    const info = categorizeToolError("edit", { content: [{ type: "text", text }] });
    assert.equal(info.category, "edit_mismatch");
  });

  it("still classifies genuine rate_limit for non-edit tools", () => {
    const info = categorizeToolError("bash", { content: [{ type: "text", text: "429 too many requests" }] });
    assert.equal(info.category, "rate_limit");
  });

  it("classifies path-not-found", () => {
    const info = categorizeToolError("read", { content: [{ type: "text", text: "ENOENT: no such file or directory" }] });
    assert.equal(info.category, "path_not_found");
  });

  it("classifies unknown errors", () => {
    const info = categorizeToolError("read", "something weird happened");
    assert.equal(info.category, "unknown");
  });

  it("steers a sandboxed ENOENT to request_access when that tool is present", () => {
    const info = categorizeToolError("read", { content: [{ type: "text", text: "ENOENT: no such file or directory" }] }, { sandboxed: true, hasRequestAccess: true });
    assert.equal(info.category, "path_not_found");
    assert.match(info.hint, /request_access/);
    assert.doesNotMatch(info.hint, /find first/);
  });

  it("gives generic access guidance for a sandboxed ENOENT without request_access", () => {
    const info = categorizeToolError("read", { content: [{ type: "text", text: "ENOENT: no such file or directory" }] }, { sandboxed: true, hasRequestAccess: false });
    assert.equal(info.category, "path_not_found");
    assert.doesNotMatch(info.hint, /request_access/);
    assert.match(info.hint, /Grant access/);
  });

  it("keeps the find-first hint outside a sandbox", () => {
    const info = categorizeToolError("read", { content: [{ type: "text", text: "ENOENT: no such file or directory" }] }, { sandboxed: false });
    assert.match(info.hint, /find first/);
  });
});

describe("detectReasoningRejection", () => {
  it("detects explicit reasoning-field rejection", () => {
    assert.equal(detectReasoningRejection("400: reasoning_content is not supported by this model"), true);
    assert.equal(detectReasoningRejection("Unknown parameter: reasoning_content"), true);
    assert.equal(detectReasoningRejection("reasoning fields are not allowed in assistant messages"), true);
  });
  it("detects content-length/token-limit overflow mentioning tokens or reasoning", () => {
    assert.equal(detectReasoningRejection("The prompt is too long: 128000 tokens exceeds the limit"), true);
    assert.equal(detectReasoningRejection("content exceeds maximum length of 64K characters"), true);
    assert.equal(detectReasoningRejection("message too long, 120000 tokens"), true);
  });
  it("detects common OpenAI-style context-length and request-token-limit 400s", () => {
    assert.equal(detectReasoningRejection("The request exceeds the maximum token limit of 64000"), true);
    assert.equal(detectReasoningRejection("maximum context length is 128000 tokens"), true);
    assert.equal(detectReasoningRejection("This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens"), true);
    assert.equal(detectReasoningRejection("maximum input tokens per request exceeded"), true);
  });
  it("detects reasoning-block count overflows", () => {
    assert.equal(detectReasoningRejection("The total number of reasoning_content blocks exceeds the maximum allowed"), true);
  });
  it("does NOT flag unrelated errors", () => {
    assert.equal(detectReasoningRejection("rate limit exceeded (429)"), false);
    assert.equal(detectReasoningRejection("invalid api key"), false);
    assert.equal(detectReasoningRejection("Could not find edits matching oldText"), false);
    assert.equal(detectReasoningRejection(""), false);
  });
  it("does NOT flag length errors without token/reasoning mention", () => {
    assert.equal(detectReasoningRejection("file too long"), false);
    assert.equal(detectReasoningRejection("output too long, truncated"), false);
    // Regex-3 boundary: first sub-pattern matches, second (token/char/reasoning) does not.
    assert.equal(detectReasoningRejection("input exceeds maximum size"), false);
    assert.equal(detectReasoningRejection("message limit reached for this request"), false);
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
