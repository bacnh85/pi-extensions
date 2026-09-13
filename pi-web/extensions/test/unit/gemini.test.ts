/**
 * Unit tests for the Gemini web research wrapper (lib/gemini.ts).
 * No network — the gemini-reverse client is injected via a fake factory.
 */

import { expect } from "chai";
import {
  extractSources,
  loadGeminiWebConfig,
  loadDefaultFactory,
  injectGeminiHeaderCap,
  describeGeminiError,
  geminiAsk,
  geminiResearch,
  withGeminiClient,
  __resetGeminiClientCache,
  type GeminiClientLike,
  type GeminiClientFactory,
} from "../../lib/gemini";

function fakeClient(overrides: Partial<GeminiClientLike> = {}): GeminiClientLike {
  return {
    ask: async () => ({ text: "ok" }),
    research: async () => ({ text: "report" }),
    ...overrides,
  };
}

function factoryFor(client: GeminiClientLike, calls?: { n: number }): GeminiClientFactory {
  return () => {
    if (calls) calls.n++;
    return client;
  };
}

describe("extractSources", () => {
  it("extracts markdown links first, then bare URLs", () => {
    const text = "See [docs](https://example.com/a) and https://example.org/b directly.";
    expect(extractSources(text)).to.deep.equal(["https://example.com/a", "https://example.org/b"]);
  });

  it("dedupes and strips trailing punctuation", () => {
    const text = "[a](https://x.com/p) — visit https://x.com/p. Also (https://y.com/q).";
    expect(extractSources(text)).to.deep.equal(["https://x.com/p", "https://y.com/q"]);
  });

  it("caps the list", () => {
    const text = Array.from({ length: 40 }, (_, i) => `[s](${`https://s.io/${i}`})`).join(" ");
    expect(extractSources(text, 30)).to.have.length(30);
  });

  it("returns empty for empty text", () => {
    expect(extractSources("")).to.deep.equal([]);
    expect(extractSources("no urls here")).to.deep.equal([]);
  });
});

describe("loadGeminiWebConfig", () => {
  const OLD_PSID = process.env.GEMINI_WEB_SECURE_1PSID;
  const OLD_PROXY = process.env.GEMINI_WEB_PROXY;
  const OLD_DIR = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (OLD_PSID !== undefined) process.env.GEMINI_WEB_SECURE_1PSID = OLD_PSID;
    else delete process.env.GEMINI_WEB_SECURE_1PSID;
    if (OLD_PROXY !== undefined) process.env.GEMINI_WEB_PROXY = OLD_PROXY;
    else delete process.env.GEMINI_WEB_PROXY;
    if (OLD_DIR !== undefined) process.env.PI_CODING_AGENT_DIR = OLD_DIR;
    else delete process.env.PI_CODING_AGENT_DIR;
  });

  it("reads env vars (process.env first)", () => {
    process.env.GEMINI_WEB_SECURE_1PSID = "psid-test";
    process.env.GEMINI_WEB_PROXY = "http://127.0.0.1:8080";
    const cfg = loadGeminiWebConfig("/tmp", false);
    expect(cfg.psid).to.equal("psid-test");
    expect(cfg.proxy).to.equal("http://127.0.0.1:8080");
    expect(cfg.psidSource).to.equal("process.env");
  });

  it("reports not set when absent (guest mode) — isolated from the host's pi config", () => {
    delete process.env.GEMINI_WEB_SECURE_1PSID;
    delete process.env.GEMINI_WEB_PROXY;
    process.env.PI_CODING_AGENT_DIR = "/nonexistent-pi-agent-dir"; // shield from the host's ~/.pi/agent/.env.local
    const cfg = loadGeminiWebConfig("/nonexistent-dir-for-tests", false);
    expect(cfg.psid).to.be.undefined;
    expect(cfg.psidSource).to.equal("not set");
  });
});

describe("describeGeminiError", () => {
  it("maps upstream error classes by name and constructor", () => {
    expect(describeGeminiError({ name: "AuthError" })).to.include("cookie expired");
    class UsageLimitExceeded extends Error {}
    expect(describeGeminiError(new UsageLimitExceeded("x"))).to.include("usage limit");
    expect(describeGeminiError({ name: "TemporarilyBlocked" })).to.include("GEMINI_WEB_PROXY");
    expect(describeGeminiError(new Error("boom"))).to.equal("Gemini web error: boom");
  });

  it("maps unknown API errors (e.g. 1184) to an entitlement/protocol hint", () => {
    const msg = describeGeminiError(new Error("Unknown API error: 1184"));
    expect(msg).to.include("1184");
    expect(msg).to.include("Gemini Advanced");
  });
});

describe("injectGeminiHeaderCap (25KB Google CSP response headers)", () => {
  const CAP = 256 * 1024;

  it("injects the cap for gemini.google.com in all three http.request input forms", () => {
    for (const input of [
      "https://gemini.google.com/app",
      new URL("https://gemini.google.com/app"),
      { hostname: "gemini.google.com", path: "/app" },
    ]) {
      const out = injectGeminiHeaderCap(input);
      expect(out, String(input)).to.be.an("object");
      expect(out!.maxHeaderSize).to.equal(CAP);
      expect(out!.hostname).to.equal("gemini.google.com");
    }
  });

  it("passes through non-gemini hosts untouched", () => {
    const opts = { hostname: "example.com", path: "/" };
    expect(injectGeminiHeaderCap(opts)).to.be.null;
    expect(opts).to.not.have.property("maxHeaderSize");
  });

  it("preserves a pre-set maxHeaderSize", () => {
    const opts = { hostname: "gemini.google.com", maxHeaderSize: 1024 };
    expect(injectGeminiHeaderCap(opts)).to.be.null;
    expect(opts.maxHeaderSize).to.equal(1024);
  });

  it("rejects non-object non-string input", () => {
    expect(injectGeminiHeaderCap(undefined)).to.be.null;
    expect(injectGeminiHeaderCap(42)).to.be.null;
  });

  it("parses the host from string/URL forms with ports and paths intact", () => {
    const out = injectGeminiHeaderCap("https://gemini.google.com:443/app?x=1");
    expect(out!.path).to.equal("/app?x=1");
    expect(out!.maxHeaderSize).to.equal(CAP);
  });
});

describe("loadDefaultFactory (real gemini-reverse import path)", () => {
  // Constructor is offline (init is lazy per call) — no network in unit tests.
  it("resolves the Gemini constructor across CJS interop and constructs a client", async () => {
    const make = await loadDefaultFactory();
    expect(make).to.be.a("function");
    const client = await make({});
    expect(client.ask).to.be.a("function");
    expect(client.research).to.be.a("function");
  });
});

describe("geminiAsk", () => {
  it("returns text + sources and passes temporary/model", async () => {
    __resetGeminiClientCache();
    let captured: Record<string, unknown> | undefined;
    const client = fakeClient({
      ask: async (_q: string, opts?: Record<string, unknown>) => {
        captured = opts;
        return { text: "Answer with [src](https://a.example/x).", model: "gemini-3-flash" };
      },
    });
    const res = await geminiAsk("q", { config: { psid: "p", psidSource: "test" }, model: "gemini-3-flash", factory: factoryFor(client) });
    expect(res.text).to.include("Answer with");
    expect(res.model).to.equal("gemini-3-flash");
    expect(res.guest).to.be.false;
    expect(res.sources).to.deep.equal(["https://a.example/x"]);
    expect(captured?.temporary).to.equal(true);
    expect(captured?.model).to.equal("gemini-3-flash");
  });

  it("flags guest mode when no cookie", async () => {
    __resetGeminiClientCache();
    const res = await geminiAsk("q", { config: { psidSource: "not set" }, factory: factoryFor(fakeClient()) });
    expect(res.guest).to.be.true;
  });

  it("falls back to candidates[0].text when the getter is absent", async () => {
    __resetGeminiClientCache();
    const client = fakeClient({ ask: async () => ({ candidates: [{ text: "from candidate" }] }) });
    const res = await geminiAsk("q", { config: { psid: "p", psidSource: "test" }, factory: factoryFor(client) });
    expect(res.text).to.equal("from candidate");
  });
});

describe("geminiResearch", () => {
  it("passes timeout and returns title/eta/sources", async () => {
    __resetGeminiClientCache();
    let captured: Record<string, unknown> | undefined;
    const client = fakeClient({
      research: async (_q: string, opts?: Record<string, unknown>) => {
        captured = opts;
        return { text: "Report citing [s](https://r.example/1).", plan: { title: "T", eta_text: "10 min" } };
      },
    });
    const res = await geminiResearch("q", { config: { psid: "p", psidSource: "test" }, timeoutMs: 5000, factory: factoryFor(client) });
    expect(res.title).to.equal("T");
    expect(res.eta).to.equal("10 min");
    expect(res.sources).to.deep.equal(["https://r.example/1"]);
    expect(captured?.wait).to.equal(true);
    expect(captured?.timeout).to.equal(5000);
    expect(captured?.pollInterval).to.equal(10000);
  });

  it("refuses research in guest mode with a setup message", async () => {
    try {
      await geminiResearch("q", { config: { psidSource: "not set" }, factory: factoryFor(fakeClient()) });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).to.include("GEMINI_WEB_SECURE_1PSID");
    }
  });
});

describe("abort + timeout guarding", () => {
  it("ask rejects with AbortError when the signal is already aborted (no poll awaited)", async () => {
    __resetGeminiClientCache();
    const controller = new AbortController();
    controller.abort();
    const never = fakeClient({ ask: () => new Promise(() => {}) });
    try {
      await geminiAsk("q", { config: { psid: "p", psidSource: "test" }, signal: controller.signal, factory: factoryFor(never) });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).name).to.equal("AbortError");
    }
  });

  it("research rejects with AbortError on a pre-aborted signal without awaiting the fake poll", async () => {
    __resetGeminiClientCache();
    const controller = new AbortController();
    controller.abort();
    const never = fakeClient({ research: () => new Promise(() => {}) });
    try {
      await geminiResearch("q", { config: { psid: "p", psidSource: "test" }, signal: controller.signal, factory: factoryFor(never) });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).name).to.equal("AbortError");
    }
  });

  it("ask enforces timeout_ms (TimeoutError) when the client never resolves", async () => {
    __resetGeminiClientCache();
    const never = fakeClient({ ask: () => new Promise(() => {}) });
    try {
      await geminiAsk("q", { config: { psid: "p", psidSource: "test" }, timeoutMs: 20, factory: factoryFor(never) });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).name).to.equal("TimeoutError");
      expect((err as Error).message).to.include("timed out after 20ms");
    }
  });

  it("describeGeminiError passes abort/timeout messages through unprefixed", () => {
    const e = new Error("web_research ask aborted");
    e.name = "AbortError";
    expect(describeGeminiError(e)).to.equal("web_research ask aborted");
  });
});

describe("withGeminiClient auth retry", () => {
  it("re-creates the client once on AuthError and succeeds", async () => {
    __resetGeminiClientCache();
    let attempts = 0;
    const client = fakeClient({
      ask: async () => {
        attempts++;
        if (attempts === 1) {
          const e = new Error("Cookies invalid.");
          e.name = "AuthError";
          throw e;
        }
        return { text: "recovered" };
      },
    });
    const calls = { n: 0 };
    const res = await withGeminiClient({ psid: "p", psidSource: "test" }, (c) => c.ask("q"), factoryFor(client, calls));
    expect((res as { text?: string }).text).to.equal("recovered");
    expect(calls.n).to.equal(2);
  });

  it("does not retry non-auth errors", async () => {
    __resetGeminiClientCache();
    const calls = { n: 0 };
    const client = fakeClient({ ask: async () => { throw new Error("boom"); } });
    try {
      await withGeminiClient({ psid: "p2", psidSource: "test" }, (c) => c.ask("q"), factoryFor(client, calls));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).to.equal("boom");
    }
    expect(calls.n).to.equal(1);
  });
});
