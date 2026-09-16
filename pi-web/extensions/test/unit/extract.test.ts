import { expect } from "chai";
import { createRequire } from "node:module";

import {
  extractWithDiagnostics,
  type ExtractMode,
  type ExtractParams,
  type ExtractResult,
} from "../../lib/extract";
import { resetAgyInstalledCache } from "../../lib/agy";

const _require = createRequire(import.meta.url);

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function installMockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

function restoreEnv(): void {
  process.env = { ...ORIGINAL_ENV };
}

describe("ExtractParams and ExtractResult types", () => {
  it("accept expected fields", () => {
    const modes: ExtractMode[] = ["auto", "static", "dynamic", "full", "agy"];
    const params: ExtractParams = { url: "https://example.com", mode: modes[0], wait_for: 1000, mobile: true };
    const result: ExtractResult = { title: "Title", markdown: "Content", backend: "static", structured: { ok: true } };
    expect(params.mode).to.equal("auto");
    expect(result.structured).to.deep.equal({ ok: true });
  });
});

describe("extractWithDiagnostics", () => {
  beforeEach(() => {
    restoreEnv();
    process.env.FIRECRAWL_API_URL = "http://firecrawl.test/v2";
    process.env.CRAWL4AI_API_URL = "http://crawl4ai.test";
    resetAgyInstalledCache(); // agy install cache is module-level — must reset between tests
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    restoreEnv();
    resetAgyInstalledCache();
  });

  it("uses static extraction when it returns useful content", async () => {
    installMockFetch((url) => {
      if (url === "https://example.com/static") {
        return htmlResponse("<html><head><title>Static</title></head><body><main><h1>Static</h1><p>This static article has enough readable text to pass the useful-content threshold in auto mode without falling back.</p><p>Additional words make it reliably longer than the minimum threshold.</p></main></body></html>");
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const diagnostics = await extractWithDiagnostics({ url: "https://example.com/static" });
    expect(diagnostics.selectedMode).to.equal("static");
    expect(diagnostics.fallbackUsed).to.be.false;
    expect(diagnostics.result.markdown).to.include("static article");
  });

  it("passes raw text/plain and JSON bodies through without Readability", async () => {
    installMockFetch((url) => {
      if (url === "https://raw.test/code.js") {
        return new Response("// A module used by tests.\n" + "export function boot() { return 42; }\n".repeat(6), { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (url === "https://raw.test/data.json") {
        return new Response(JSON.stringify({ name: "pi-fff", stars: 99, description: "Fuzzy file and content search for Pi, well over the useful-content threshold for extraction." }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://raw.test/page.html") {
        return htmlResponse("<html><head><title>Page</title></head><body><main><h1>Page</h1><p>This ordinary web page has plenty of readable content to pass the useful-content threshold in auto mode. Additional sentences ensure the extracted text is long enough to be considered useful by the extraction pipeline.</p><p>More filler keeps the article comfortably above the minimum length so the static path succeeds without falling through.</p></main></body></html>");
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const textDiag = await extractWithDiagnostics({ url: "https://raw.test/code.js" });
    expect(textDiag.selectedMode).to.equal("static");
    expect(textDiag.result.markdown).to.include("return 42;");

    const jsonDiag = await extractWithDiagnostics({ url: "https://raw.test/data.json" });
    expect(jsonDiag.result.markdown).to.include('"stars":99');
    expect(jsonDiag.result.markdown.indexOf("```json")).to.equal(0);

    // text/html must still go through Readability → markdown, not raw source
    const htmlDiag = await extractWithDiagnostics({ url: "https://raw.test/page.html" });
    expect(htmlDiag.result.markdown).to.not.include("<main>");
    expect(htmlDiag.result.title).to.equal("Page");
    expect(htmlDiag.result.markdown).to.include("plenty of readable content");
  });

  it("falls through from short static content to dynamic extraction", async () => {
    const calls = installMockFetch((url) => {
      if (url === "https://example.com/short") return htmlResponse("<html><body><main>short</main></body></html>");
      if (url === "http://firecrawl.test/v2/scrape") {
        return jsonResponse({ data: { markdown: "# Dynamic\n\nDynamic content from Firecrawl after static extraction was too short.", metadata: { title: "Dynamic", sourceURL: "https://example.com/short" } } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const diagnostics = await extractWithDiagnostics({ url: "https://example.com/short" });
    expect(diagnostics.selectedMode).to.equal("dynamic");
    expect(diagnostics.fallbackUsed).to.be.true;
    expect(diagnostics.attempts.map((a) => a.mode)).to.deep.equal(["static", "dynamic"]);
    expect(diagnostics.result.markdown).to.include("fell back to Firecrawl");
    expect(calls).to.deep.equal(["https://example.com/short", "http://firecrawl.test/v2/scrape"]);
  });

  it("explicit static mode does not fall through", async () => {
    installMockFetch((url) => {
      if (url === "https://example.com/short") return htmlResponse("<html><body><main>short</main></body></html>");
      throw new Error(`unexpected fetch ${url}`);
    });

    const diagnostics = await extractWithDiagnostics({ url: "https://example.com/short", mode: "static" });
    expect(diagnostics.selectedMode).to.equal("static");
    expect(diagnostics.result.markdown).to.include("short");
  });

  it("dynamic mode includes structured JSON output when present", async () => {
    installMockFetch((url, init) => {
      if (url === "http://firecrawl.test/v2/scrape") {
        const body = JSON.parse(String(init?.body));
        expect(body.formats).to.deep.equal(["markdown", "json"]);
        expect(body.jsonOptions).to.deep.equal({ prompt: "Extract title" });
        return jsonResponse({ data: { markdown: "# Dynamic\n\nBody", json: { title: "Structured" }, metadata: { title: "Dynamic" } } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const diagnostics = await extractWithDiagnostics({ url: "https://example.com/dynamic", mode: "dynamic", prompt: "Extract title" });
    expect(diagnostics.result.structured).to.deep.equal({ title: "Structured" });
    expect(diagnostics.result.markdown).to.include("## Structured extraction");
  });

  it("falls through to full mode when static and dynamic fail", async () => {
    installMockFetch((url) => {
      if (url === "https://example.com/full") return htmlResponse("<html><body><main>tiny</main></body></html>");
      if (url === "http://firecrawl.test/v2/scrape") return jsonResponse({ error: "blocked" }, 500);
      if (url === "http://crawl4ai.test/md") return jsonResponse({ success: true, markdown: "# Full\n\nCrawl4AI markdown content" });
      throw new Error(`unexpected fetch ${url}`);
    });

    const diagnostics = await extractWithDiagnostics({ url: "https://example.com/full" });
    expect(diagnostics.selectedMode).to.equal("full");
    expect(diagnostics.attempts.map((a) => a.mode)).to.deep.equal(["static", "dynamic", "full"]);
    expect(diagnostics.result.markdown).to.include("Crawl4AI");
  });

  it("falls through to agy mode when static/dynamic/full all fail and agy is installed", async () => {
    const cp = _require("node:child_process");
    const origSpawn = cp.spawn;
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 0 }); // agy installed
    cp.spawn = function () {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ response: "# agy content\n\nFetched via read_url" })));
        child.emit("close", 0, null);
      });
      return child;
    } as any;

    installMockFetch((url) => {
      if (url === "https://example.com/blocked") return htmlResponse("<html><body><main>tiny</main></body></html>");
      if (url === "http://firecrawl.test/v2/scrape") return jsonResponse({ error: "blocked" }, 500);
      if (url === "http://crawl4ai.test/md") return jsonResponse({ error: "blocked" }, 500);
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const diagnostics = await extractWithDiagnostics({ url: "https://example.com/blocked" });
      expect(diagnostics.selectedMode).to.equal("agy");
      expect(diagnostics.attempts.map((a) => a.mode)).to.deep.equal(["static", "dynamic", "full", "agy"]);
      expect(diagnostics.result.markdown).to.include("agy (model-backed browser)");
      expect(diagnostics.result.markdown).to.include("Fetched via read_url");
    } finally {
      cp.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
    }
  });

  it("skips agy in auto chain when agy is not installed", async () => {
    const cp = _require("node:child_process");
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 1 }); // agy not installed

    installMockFetch((url) => {
      if (url === "https://example.com/skipagy") return htmlResponse("<html><body><main>tiny</main></body></html>");
      if (url === "http://firecrawl.test/v2/scrape") return jsonResponse({ error: "blocked" }, 500);
      if (url === "http://crawl4ai.test/md") return jsonResponse({ success: true, markdown: "# Full\n\nCrawl4AI fallback content" });
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const diagnostics = await extractWithDiagnostics({ url: "https://example.com/skipagy" });
      expect(diagnostics.selectedMode).to.equal("full");
      expect(diagnostics.attempts.map((a) => a.mode)).to.deep.equal(["static", "dynamic", "full"]);
    } finally {
      cp.spawnSync = origSpawnSync;
    }
  });

  it("explicit agy mode calls agy directly", async () => {
    const cp = _require("node:child_process");
    const origSpawn = cp.spawn;
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 0 });
    let capturedArgs: string[] | null = null;
    cp.spawn = function (_cmd: string, args: string[]) {
      capturedArgs = args;
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ response: "# Direct agy\n\ncontent" })));
        child.emit("close", 0, null);
      });
      return child;
    } as any;

    try {
      const diagnostics = await extractWithDiagnostics({ url: "https://example.com/direct", mode: "agy" });
      expect(diagnostics.selectedMode).to.equal("agy");
      expect(diagnostics.attempts.map((a) => a.mode)).to.deep.equal(["agy"]);
      expect(capturedArgs).to.not.be.null;
      expect(capturedArgs!.join(" ")).to.not.include("--dangerously-skip-permissions");
      expect(capturedArgs!.join(" ")).to.include("read_url");
      expect(diagnostics.result.markdown).to.include("Direct agy");
    } finally {
      cp.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
    }
  });

  it("agy structured extraction populates structured field and strips fenced JSON", async () => {
    const cp = _require("node:child_process");
    const origSpawn = cp.spawn;
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 0 });
    cp.spawn = function () {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ response: '```json\n{"title": "Moby", "first": "sentence"}\n```\n' })));
        child.emit("close", 0, null);
      });
      return child;
    } as any;

    try {
      const diagnostics = await extractWithDiagnostics({
        url: "https://example.com/structured",
        mode: "agy",
        schema: { title: "string" },
      });
      expect(diagnostics.result.structured).to.deep.equal({ title: "Moby", first: "sentence" });
      // raw model fenced block stripped; only the renderer's own block remains
      expect(diagnostics.result.markdown.split("```json").length - 1).to.equal(1);
      expect(diagnostics.result.markdown).to.include("## Structured extraction");
    } finally {
      cp.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
    }
  });

  it("agy prompt-only (no schema) also populates structured field", async () => {
    const cp = _require("node:child_process");
    const origSpawn = cp.spawn;
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 0 });
    cp.spawn = function () {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ response: '```json\n{"title": "Moby"}\n```\n' })));
        child.emit("close", 0, null);
      });
      return child;
    } as any;

    try {
      const diagnostics = await extractWithDiagnostics({
        url: "https://example.com/promptonly",
        mode: "agy",
        prompt: "Extract the title",
      });
      expect(diagnostics.result.structured).to.deep.equal({ title: "Moby" });
    } finally {
      cp.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
    }
  });

  it("agy structured JSON is not duplicated in the body when only JSON is returned", async () => {
    const cp = _require("node:child_process");
    const origSpawn = cp.spawn;
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 0 });
    cp.spawn = function () {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ response: '```json\n{"title": "Moby"}\n```\n' })));
        child.emit("close", 0, null);
      });
      return child;
    } as any;

    try {
      const diagnostics = await extractWithDiagnostics({
        url: "https://example.com/jsononly",
        mode: "agy",
        schema: { title: "string" },
      });
      const md = diagnostics.result.markdown;
      const sectionIdx = md.indexOf("## Structured extraction");
      const body = md.slice(0, sectionIdx);
      // JSON appears only once total (in the structured section), not verbatim in body
      expect(body).to.not.include('"title"');
      expect(body).to.include("Structured extraction only");
      expect(md.split('"title"').length - 1).to.equal(1);
    } finally {
      cp.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
    }
  });

  it("agy bare-JSON output (no fence) still populates structured field", async () => {
    const cp = _require("node:child_process");
    const origSpawn = cp.spawn;
    const origSpawnSync = cp.spawnSync;
    cp.spawnSync = () => ({ status: 0 });
    cp.spawn = function () {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ response: '{"title": "Moby"}\n' })));
        child.emit("close", 0, null);
      });
      return child;
    } as any;

    try {
      const diagnostics = await extractWithDiagnostics({
        url: "https://example.com/barejson",
        mode: "agy",
        schema: { title: "string" },
      });
      expect(diagnostics.result.structured).to.deep.equal({ title: "Moby" });
      expect(diagnostics.result.markdown).to.include("Structured extraction only");
    } finally {
      cp.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
    }
  });

});
