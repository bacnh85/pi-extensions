/**
 * Unit tests for pi-munin helpers module.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import {
  getMuninConfig,
  loadEnv,
  piConfigDirs,
  parseTags,
  validateMemoryTags,
  validateMemoryKey,
  validateSearchQuery,
  classifyError,
  sanitizeErrorMessage,
  formatMemory,
  formatMemories,
  formatCapabilities,
  truncateText,
  normalizeMemory,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
} from "../../lib/helpers";

const CONFIG_ENV_KEYS = ["MUNIN_API_KEY", "MUNIN_PROJECT", "MUNIN_BASE_URL", "PI_CODING_AGENT_DIR"] as const;

describe("getMuninConfig", () => {
  let dirs: string[];
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dirs = [];
    originalEnv = Object.fromEntries(CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of CONFIG_ENV_KEYS) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-munin-global-"));
    dirs.push(process.env.PI_CODING_AGENT_DIR);
  });

  afterEach(() => {
    for (const key of CONFIG_ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function projectEnv(apiKey: string, project: string): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-munin-project-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env.local"), `MUNIN_API_KEY=${apiKey}\nMUNIN_PROJECT=${project}\n`);
    return dir;
  }

  it("isolates trusted project env without mutating process.env", () => {
    const first = getMuninConfig({}, projectEnv("first-key", "first-project"), true);
    const second = getMuninConfig({}, projectEnv("second-key", "second-project"), true);
    expect(first).to.include({ apiKey: "first-key", projectId: "first-project" });
    expect(second).to.include({ apiKey: "second-key", projectId: "second-project" });
    expect(process.env.MUNIN_API_KEY).to.equal(undefined);
    expect(process.env.MUNIN_PROJECT).to.equal(undefined);
  });

  it("keeps first-file precedence while parsing env files", () => {
    const dir = projectEnv("local-key", "local-project");
    writeFileSync(join(dir, ".env"), "MUNIN_API_KEY=fallback-key\nMUNIN_PROJECT=fallback-project\n");
    expect(loadEnv(dir, true)).to.include({
      MUNIN_API_KEY: "local-key",
      MUNIN_PROJECT: "local-project",
    });
  });

  it("does not pair an ambient key with an endpoint override", () => {
    process.env.MUNIN_API_KEY = "ambient-key";
    process.env.MUNIN_PROJECT = "ambient-project";
    expect(() => getMuninConfig({ base_url: "https://example.test" })).to.throw("explicit api_key");
    expect(getMuninConfig({ base_url: "https://example.test/api/", api_key: "explicit-key" })).to.deep.equal({
      apiKey: "explicit-key",
      projectId: "ambient-project",
      baseUrl: "https://example.test/api",
    });
  });

  it("validates endpoint URLs", () => {
    process.env.MUNIN_API_KEY = "key";
    process.env.MUNIN_PROJECT = "project";
    for (const base_url of ["not a url", "ftp://example.test", "https://user:pass@example.test", "https://example.test?q=1"]) {
      expect(() => getMuninConfig({ base_url, api_key: "explicit-key" })).to.throw("Munin base URL");
    }
  });
});

describe("parseTags", () => {
  it("parses comma-separated string", () => {
    expect(parseTags("type:fact,domain:memory")).to.deep.equal([
      "type:fact",
      "domain:memory",
    ]);
  });

  it("trims whitespace", () => {
    expect(parseTags(" type:fact , domain:memory ")).to.deep.equal([
      "type:fact",
      "domain:memory",
    ]);
  });

  it("handles array input", () => {
    expect(parseTags(["type:fact", "domain:memory"])).to.deep.equal([
      "type:fact",
      "domain:memory",
    ]);
  });

  it("filters empty values", () => {
    expect(parseTags("type:fact,,domain:memory")).to.deep.equal([
      "type:fact",
      "domain:memory",
    ]);
  });

  it("returns empty array for falsy input", () => {
    expect(parseTags(null)).to.deep.equal([]);
    expect(parseTags(undefined)).to.deep.equal([]);
    expect(parseTags("")).to.deep.equal([]);
  });

  it("coerces non-string array items", () => {
    expect(parseTags(["type:fact", 123])).to.deep.equal(["type:fact", "123"]);
  });
});

describe("validateMemoryTags", () => {
  it("accepts valid tags with type: and domain:", () => {
    const result = validateMemoryTags("type:fact,domain:memory");
    expect(result.ok).to.be.true;
    if (result.ok) {
      expect(result.tags).to.deep.equal(["type:fact", "domain:memory"]);
    }
  });

  it("rejects tags without type:", () => {
    const result = validateMemoryTags("domain:memory,other");
    expect(result.ok).to.be.false;
  });

  it("rejects tags without domain:", () => {
    const result = validateMemoryTags("type:fact,other");
    expect(result.ok).to.be.false;
  });

  it("rejects empty tags", () => {
    const result = validateMemoryTags("");
    expect(result.ok).to.be.false;
  });

  it("accepts array input", () => {
    const result = validateMemoryTags(["type:fact", "domain:memory"]);
    expect(result.ok).to.be.true;
  });
});

describe("validateMemoryKey", () => {
  it("accepts valid keys", () => {
    expect(validateMemoryKey("my-key")).to.equal("my-key");
    expect(validateMemoryKey("category/sub/key")).to.equal("category/sub/key");
    expect(validateMemoryKey("auth-refresh-token")).to.equal("auth-refresh-token");
    expect(validateMemoryKey("a")).to.equal("a");
  });

  it("rejects empty key", () => {
    expect(() => validateMemoryKey("")).to.throw("non-empty string");
  });

  it("rejects whitespace-only key", () => {
    expect(() => validateMemoryKey("   ")).to.throw("whitespace");
  });

  it("rejects keys with invalid characters", () => {
    expect(() => validateMemoryKey("key with spaces")).to.throw("alphanumeric");
    expect(() => validateMemoryKey("key@special")).to.throw("alphanumeric");
    expect(() => validateMemoryKey("key.dots")).to.throw("alphanumeric");
  });

  it("rejects keys over 200 chars", () => {
    const long = "a".repeat(201);
    expect(() => validateMemoryKey(long)).to.throw("200");
  });

  it("rejects non-string", () => {
    expect(() => validateMemoryKey(null)).to.throw("non-empty string");
    expect(() => validateMemoryKey(123)).to.throw("non-empty string");
  });
});

describe("validateSearchQuery", () => {
  it("accepts valid queries", () => {
    expect(validateSearchQuery("test")).to.equal("test");
    expect(validateSearchQuery("  hello  ")).to.equal("hello");
  });

  it("rejects empty query", () => {
    expect(() => validateSearchQuery("")).to.throw("non-empty");
    expect(() => validateSearchQuery("   ")).to.throw("whitespace");
  });

  it("rejects non-string", () => {
    expect(() => validateSearchQuery(null)).to.throw("non-empty");
  });
});

describe("classifyError", () => {
  it("classifies auth errors", () => {
    expect(classifyError(new Error("Unauthorized access")).type).to.equal("auth");
    expect(classifyError(new Error("invalid API key")).type).to.equal("auth");
  });

  it("classifies e2ee errors", () => {
    expect(classifyError(new Error("E2EE encryption failed")).type).to.equal("e2ee");
  });

  it("classifies stale protocol errors", () => {
    expect(classifyError(new Error("Stale protocol detected")).type).to.equal(
      "stale_protocol",
    );
  });

  it("classifies ERR_STALE_PROTOCOL errors", () => {
    expect(classifyError(new Error("ERR_STALE_PROTOCOL")).type).to.equal(
      "stale_protocol",
    );
  });

  it("classifies not found errors", () => {
    expect(classifyError(new Error("Memory not found")).type).to.equal("not_found");
  });

  it("classifies timeout errors", () => {
    expect(classifyError(new Error("Request timeout")).type).to.equal("timeout");
    expect(classifyError(new Error("ETIMEDOUT")).type).to.equal("timeout");
  });

  it("classifies network errors", () => {
    expect(classifyError(new Error("Network error")).type).to.equal("network");
    expect(classifyError(new Error("ECONNREFUSED")).type).to.equal("network");
    expect(classifyError(new Error("socket hang up")).type).to.equal("network");
  });

  it("classifies unknown errors", () => {
    expect(classifyError(new Error("Something weird happened")).type).to.equal(
      "unknown",
    );
  });

  it("uses structured SDK error codes and names", () => {
    const cases = [
      ["AUTH_INVALID", "auth"],
      ["VALIDATION_ERROR", "validation"],
      ["FEATURE_DISABLED", "feature_disabled"],
      ["RATE_LIMITED", "rate_limit"],
      ["ERR_STALE_PROTOCOL", "stale_protocol"],
      ["NOT_FOUND", "not_found"],
    ] as const;
    for (const [code, type] of cases) {
      expect(classifyError(Object.assign(new Error(code), { code })).type).to.equal(type);
    }
    expect(classifyError(Object.assign(new Error("fetch failed"), { name: "MuninTransportError" })).type).to.equal("network");
    expect(classifyError(Object.assign(new Error("aborted"), { name: "AbortError" })).type).to.equal("timeout");
  });

  it("handles non-Error input", () => {
    expect(classifyError("string error").type).to.equal("unknown");
  });
});

describe("sanitizeErrorMessage", () => {
  it("redacts MUNIN_API_KEY in message", () => {
    const result = sanitizeErrorMessage(
      new Error("MUNIN_API_KEY=secret123"),
    );
    expect(result).to.include("[REDACTED]");
    expect(result).to.not.include("secret123");
  });

  it("passes through normal messages unchanged", () => {
    const result = sanitizeErrorMessage(new Error("Normal error message"));
    expect(result).to.equal("Normal error message");
  });
});

describe("formatMemory", () => {
  it("formats a complete memory", () => {
    const result = formatMemory({
      key: "my-key",
      title: "My Title",
      content: "Some content",
      tags: ["type:fact", "domain:memory"],
    });
    expect(result).to.include("Key: my-key");
    expect(result).to.include("Title: My Title");
    expect(result).to.include("Tags: type:fact, domain:memory");
    expect(result).to.include("Content:\nSome content");
  });

  it("does not show ID when same as key", () => {
    const result = formatMemory({ key: "my-key", id: "my-key" });
    expect(result).to.include("Key: my-key");
    expect(result).to.not.include("ID:");
  });

  it("shows ID when different from key", () => {
    const result = formatMemory({ key: "my-key", id: "different-id" });
    expect(result).to.include("ID: different-id");
  });

  it("handles empty memory", () => {
    const result = formatMemory({});
    expect(result).to.equal("");
  });

  it("handles content from text/body/value fallbacks", () => {
    expect(formatMemory({ text: "Hello" })).to.include("Content:\nHello");
    expect(formatMemory({ body: "Body text" })).to.include("Content:\nBody text");
    expect(formatMemory({ value: "Value text" })).to.include("Content:\nValue text");
  });

  it("prefers content over fallbacks", () => {
    const result = formatMemory({ content: "primary", text: "fallback" });
    expect(result).to.include("Content:\nprimary");
    expect(result).to.not.include("fallback");
  });

  it("handles updated/updatedAt and created/createdAt", () => {
    const result = formatMemory({
      key: "k",
      updatedAt: "2024-01-01",
      created: "2023-01-01",
    });
    expect(result).to.include("Updated: 2024-01-01");
    expect(result).to.include("Created: 2023-01-01");
  });
});

describe("formatMemories", () => {
  it("returns 'No memories found' for empty array", () => {
    expect(formatMemories({ data: [] })).to.equal("No memories found.");
    expect(formatMemories({ items: [] })).to.equal("No memories found.");
  });

  it("formats a single memory", () => {
    const result = formatMemories({ data: { key: "k", content: "c" } });
    expect(result).to.include("Key: k");
    expect(result).to.include("Content:\nc");
  });

  it("formats multiple memories", () => {
    const result = formatMemories({
      data: [
        { key: "a", title: "A" },
        { key: "b", title: "B" },
      ],
    });
    expect(result).to.include("--- Memory 1 ---");
    expect(result).to.include("--- Memory 2 ---");
    expect(result).to.include("Key: a");
    expect(result).to.include("Key: b");
  });

  it("preserves search scores and totals", () => {
    const result = formatMemories({
      data: { memories: [{ memory: { key: "a" }, score: 0.91 }], total: 42 },
    });
    expect(result).to.include("Score: 0.91");
    expect(result).to.include("Total: 42");
  });

  it("handles result wrapper", () => {
    const result = formatMemories({ result: { key: "k" } });
    expect(result).to.include("Key: k");
  });

  it("handles items wrapper", () => {
    const result = formatMemories({ items: [{ key: "k" }] });
    expect(result).to.include("Key: k");
  });

  it("handles search response shape (data.memories nested array)", () => {
    const result = formatMemories({
      data: {
        memories: [
          { key: "s1", title: "Search 1" },
          { key: "s2", title: "Search 2" },
        ],
      },
    });
    expect(result).to.include("--- Memory 1 ---");
    expect(result).to.include("--- Memory 2 ---");
    expect(result).to.include("Key: s1");
    expect(result).to.include("Key: s2");
    expect(result).to.include("Search 1");
    expect(result).to.include("Search 2");
  });

  it("handles data.memories with single item", () => {
    const result = formatMemories({
      data: { memories: [{ key: "single", title: "Only One" }] },
    });
    expect(result).to.include("Key: single");
    expect(result).to.include("Only One");
  });

  it("handles data.memories empty array", () => {
    const result = formatMemories({ data: { memories: [] } });
    expect(result).to.equal("No memories found.");
  });

  it("handles non-object input", () => {
    expect(formatMemories(undefined)).to.equal("undefined");
    expect(formatMemories(null)).to.equal("null");
    expect(formatMemories("string")).to.equal("string");
  });
});

describe("normalizeMemory", () => {
  it("unwraps { memory } wrapper or passes through plain objects", () => {
    const wrapped = normalizeMemory({ memory: { key: "k", content: "c" }, score: 0.95 });
    expect(wrapped.key).to.equal("k");
    expect(wrapped.score).to.equal(0.95);
    expect(normalizeMemory({ key: "k" }).key).to.equal("k");
    expect(normalizeMemory(null)).to.deep.equal({});
    expect(normalizeMemory(undefined)).to.deep.equal({});
  });
});

describe("truncateText", () => {
  it("returns text as-is when under limits", () => {
    expect(truncateText("hello")).to.equal("hello");
  });

  it("truncates when over line limit", () => {
    const lines = Array.from({ length: OUTPUT_MAX_LINES + 10 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");
    const result = truncateText(text);
    expect(result).to.include("[Munin output truncated:");
  });

  it("truncates when over byte limit", () => {
    // Create a string just over the byte limit
    const longLine = "x".repeat(OUTPUT_MAX_BYTES + 100);
    const result = truncateText(longLine);
    expect(Buffer.byteLength(result, "utf8")).to.be.lte(
      OUTPUT_MAX_BYTES + 1024,
    );
  });

  it("truncates UTF-8 output only at complete lines", () => {
    const result = truncateText("🙂🙂🙂\n".repeat(OUTPUT_MAX_LINES + 1));
    expect(result).to.include("[Munin output truncated:");
    expect(result).to.not.include("�");
  });

  it("does not add truncation notice when exact", () => {
    expect(truncateText("hello")).to.not.include("truncated");
  });
});

describe("formatCapabilities", () => {
  it("formats complete capabilities", () => {
    const result = formatCapabilities({
      specVersion: "v1.0.0",
      actions: {
        core: ["store", "list"],
        optional: ["encrypt", "decrypt"],
      },
      features: {
        semanticSearch: { supported: true },
      },
      metadata: { serverVersion: "1.5.0" },
    });
    expect(result).to.include("--- Munin Server Capabilities ---");
    expect(result).to.include("Spec Version: v1.0.0");
    expect(result).to.include("Server Version: 1.5.0");
    expect(result).to.include("Core Actions: store, list");
    expect(result).to.include("Optional Actions: encrypt, decrypt");
    expect(result).to.include("Features: semanticSearch");
  });

  it("handles missing optional sections", () => {
    const result = formatCapabilities({ specVersion: "v1.0.0", actions: { core: ["store"] } });
    expect(result).to.include("Core Actions: store");
    expect(result).to.not.include("Optional Actions");
    expect(result).to.not.include("Features");
    expect(result).to.not.include("Server Version");
  });

  it("handles empty object", () => {
    const result = formatCapabilities({});
    expect(result).to.equal("--- Munin Server Capabilities ---");
  });

  it("handles unknown features with unsupported status", () => {
    const result = formatCapabilities({
      features: { experimental: { supported: false } },
    });
    expect(result).to.include("experimental");
    expect(result).to.include("✗");
  });
});

describe("piConfigDirs", () => {
  const origEnv = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = origEnv;
    }
  });

  it("returns default dirs when PI_CODING_AGENT_DIR is not set", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    const dirs = piConfigDirs();
    expect(dirs.length).to.equal(2);
    expect(dirs[0]).to.include(".pi/agent");
    expect(dirs[1]).to.include(".pi/agents");
  });

  it("returns custom dir when PI_CODING_AGENT_DIR is set", () => {
    process.env.PI_CODING_AGENT_DIR = "/custom/pi";
    expect(piConfigDirs()).to.deep.equal(["/custom/pi"]);
  });
});
