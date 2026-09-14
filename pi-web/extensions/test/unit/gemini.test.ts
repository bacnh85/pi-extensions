/**
 * Unit tests for the Gemini web research wrapper (lib/gemini.ts).
 * No network — the gemini-reverse client is injected via a fake factory.
 */

import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyHeaderCapArgs,
  extractSources,
  loadGeminiWebConfig,
  loadDefaultFactory,
  injectGeminiRequestTweaks,
  describeGeminiError,
  geminiAsk,
  geminiResearch,
  withGeminiClient,
  type DrHttp,
  __resetGeminiClientCache,
  type GeminiClientLike,
  type GeminiClientFactory,
} from "../../lib/gemini";

const here = path.dirname(fileURLToPath(import.meta.url));

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

describe("raceGuard abort safety", () => {
  it("pre-aborted signal: AbortError now, later underlying rejection is swallowed (no unhandledRejection)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Non-AuthError rejection keeps withGeminiClient on its single-attempt
      // path (no rotation) — the abort semantics under test are orthogonal.
      const client: GeminiClientLike = {
        ask: async () => {
          throw new Error("boom");
        },
        research: async () => ({ text: "r" }),
      };
      const p = geminiAsk("q", {
        config: { psid: "p", psidSource: "t" },
        signal: AbortSignal.abort(),
        factory: () => client,
      });
      await p.then(
        () => {
          throw new Error("should have rejected");
        },
        (e) => expect((e as Error).name).to.equal("AbortError"),
      );
      // give the unguarded-rejection a chance to fire if the fix regressed
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).to.have.length(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("describeGeminiError", () => {
  it("maps upstream error classes by name and constructor", () => {
    expect(describeGeminiError({ name: "AuthError" })).to.include("session expired");
    class UsageLimitExceeded extends Error {}
    expect(describeGeminiError(new UsageLimitExceeded("x"))).to.include("usage limit");
    expect(describeGeminiError({ name: "TemporarilyBlocked" })).to.include("GEMINI_WEB_PROXY");
    expect(describeGeminiError(new Error("boom"))).to.equal("Gemini web error: boom");
  });

  it("maps unknown API errors (e.g. 1184) to the hedged reliability hint", () => {
    const msg = describeGeminiError(new Error("Unknown API error: 1184"));
    expect(msg).to.include("1184");
    expect(msg).to.include("unreliable");
    expect(msg).to.include("free-tier");
    expect(msg).to.include("Pro/Ultra-gated");
    expect(msg).to.include("unverified");
  });
});

describe("loadDefaultFactory 1PSIDTS injection", () => {
  it("injects __Secure-1PSIDTS into the client cookie jar pre-init", async () => {
    const f = await loadDefaultFactory();
    const c = await f({ secure_1psid: "psid", secure_1psidts: "ts-value" });
    expect((c as unknown as { cookies: Record<string, string> }).cookies["__Secure-1PSIDTS"]).to.equal("ts-value");
  });
});

describe("applyHeaderCapArgs (http.request 3-arg safety)", () => {
  const CAP = 256 * 1024;

  it("mutates the options-object form in place", () => {
    const opts = { hostname: "gemini.google.com", path: "/x" };
    const cb = () => {};
    const out = applyHeaderCapArgs([opts, { method: "POST" }, cb]);
    expect((opts as { maxHeaderSize?: number }).maxHeaderSize).to.equal(CAP);
    expect(out[0]).to.equal(opts);
  });

  it("3-arg (url, options, cb): merges into the follow-on options and keeps the url", () => {
    const follow: Record<string, unknown> = { method: "POST" };
    const cb = () => {};
    const url = "https://gemini.google.com/app";
    const out = applyHeaderCapArgs([url, follow, cb]);
    expect(follow.maxHeaderSize).to.equal(CAP);
    expect((follow.headers as Record<string, unknown>)["user-agent"]).to.include("Chrome/145");
    expect(out[0]).to.equal(url);
    expect(out[1]).to.equal(follow);
    expect(out[2]).to.equal(cb);
  });

  it("2-arg (url, cb): replaces the url with options carrying the cap", () => {
    const cb = () => {};
    const out = applyHeaderCapArgs(["https://gemini.google.com/app", cb]);
    expect((out[0] as { hostname?: string }).hostname).to.equal("gemini.google.com");
    expect((out[0] as { maxHeaderSize?: number }).maxHeaderSize).to.equal(CAP);
    expect(out[1]).to.equal(cb);
  });

  it("non-gemini hosts pass through untouched", () => {
    const opts = { hostname: "example.com" };
    const out = applyHeaderCapArgs([opts, () => {}]);
    expect(opts).to.not.have.property("maxHeaderSize");
    expect(out[0]).to.equal(opts);
  });
});

describe("injectGeminiRequestTweaks (header cap + browser UA for privileged surfaces)", () => {
  const CAP = 256 * 1024;

  it("injects the cap for gemini.google.com in all three http.request input forms", () => {
    for (const input of [
      "https://gemini.google.com/app",
      new URL("https://gemini.google.com/app"),
      { hostname: "gemini.google.com", path: "/app" },
    ]) {
      const out = injectGeminiRequestTweaks(input);
      expect(out, String(input)).to.be.an("object");
      expect(out!.maxHeaderSize).to.equal(CAP);
      expect(out!.hostname).to.equal("gemini.google.com");
    }
  });

  it("adds browser UA + client hints to gemini.google.com requests", () => {
    const opts = { hostname: "gemini.google.com", path: "/app" } as Record<string, unknown>;
    injectGeminiRequestTweaks(opts);
    const headers = opts.headers as Record<string, unknown>;
    expect(headers["user-agent"]).to.include("Chrome/145");
    expect(headers["sec-ch-ua"]).to.be.a("string");
    expect(headers["sec-fetch-site"]).to.equal("same-origin");
    expect(headers["accept-language"]).to.be.a("string");
  });

  it("replaces a non-browser UA; never clobbers other existing headers (any case)", () => {
    const opts = {
      hostname: "gemini.google.com",
      headers: { "User-Agent": "axios/1.20.0", "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    };
    injectGeminiRequestTweaks(opts);
    const headers = opts.headers as Record<string, unknown>;
    expect(headers["User-Agent"]).to.be.undefined; // mixed-case key removed — no duplicate UA headers
    expect(headers["user-agent"]).to.include("Chrome/145"); // axios default replaced
    expect(headers["content-type"]).to.equal("application/x-www-form-urlencoded;charset=utf-8");
    // absent keys still land
    expect(headers["sec-fetch-mode"]).to.equal("cors");
  });

  it("leaves an existing browser UA untouched", () => {
    const opts = { hostname: "gemini.google.com", headers: { "user-agent": "Mozilla/5.0 Chrome/145.0.0.0 mine" } };
    injectGeminiRequestTweaks(opts);
    expect((opts.headers as Record<string, unknown>)["user-agent"]).to.equal("Mozilla/5.0 Chrome/145.0.0.0 mine");
  });

  it("passes through non-gemini hosts untouched", () => {
    const opts = { hostname: "example.com", path: "/" };
    expect(injectGeminiRequestTweaks(opts)).to.be.null;
    expect(opts).to.not.have.property("maxHeaderSize");
    expect(opts).to.not.have.property("headers");
  });

  it("preserves a pre-set maxHeaderSize", () => {
    const opts = { hostname: "gemini.google.com", maxHeaderSize: 1024 };
    expect(injectGeminiRequestTweaks(opts)).to.be.null;
    expect(opts.maxHeaderSize).to.equal(1024);
  });

  it("rejects non-object non-string input", () => {
    expect(injectGeminiRequestTweaks(undefined)).to.be.null;
    expect(injectGeminiRequestTweaks(42)).to.be.null;
  });

  it("parses the host from string/URL forms with ports and paths intact", () => {
    const out = injectGeminiRequestTweaks("https://gemini.google.com:443/app?x=1");
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
  it("runs the pure-Node DR cycle and returns title/text/sources", async () => {
    __resetGeminiClientCache();
    const planBuf = fs.readFileSync(path.join(here, "fixtures", "dr-plan.bin"));
    const reportJson = JSON.stringify([null, [["rc_x", ["Report body citing [s](https://r.example/1) — " + "padding ".repeat(30) + " End of report."]]]]);
    const reportBuf = Buffer.from(")]}'\n\n" + (Buffer.byteLength(reportJson) + 1) + "\n" + reportJson + "\n");
    let turns = 0;
    const drHttp: DrHttp = async (url) => {
      if (url.startsWith("https://gemini.google.com/app")) {
        return { status: 200, headers: { get: () => null }, buf: Buffer.from('<html>"SNlM0e":"TOK","cfb2h":"b1","FdrFJe":"7"</html>') };
      }
      if (url.includes("StreamGenerate")) {
        turns++;
        return { status: 200, headers: { get: () => null }, buf: planBuf };
      }
      return { status: 200, headers: { get: () => null }, buf: reportBuf };
    };
    const res = await geminiResearch("q", { config: { psid: "p", psidSource: "test" }, timeoutMs: 5000, drHttp });
    expect(res.title).to.equal("JPEG Compression Research Plan");
    expect(res.eta).to.equal(null);
    expect(res.sources).to.deep.equal(["https://r.example/1"]);
    expect(turns).to.equal(2); // plan + confirm turns
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

  it("research rejects with AbortError on a pre-aborted signal without real network", async () => {
    __resetGeminiClientCache();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const offlineHttp: DrHttp = () => {
      calls++;
      return new Promise(() => {}); // never resolves — any call proves the transport is stubbed, not defaultHttp
    };
    try {
      await geminiResearch("q", { config: { psid: "p", psidSource: "test" }, signal: controller.signal, drHttp: offlineHttp });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).name).to.equal("AbortError");
    }
    expect(calls).to.equal(1); // init attempted on the stub — no real https.request fired
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
    const auth = {
      rotatePost: async () => ({ status: 200, setCookie: ["__Secure-1PSIDTS=rotated; Path=/"] }),
      storePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-")), "cookies.json"),
    };
    const res = await withGeminiClient({ psid: "p", psidSource: "test" }, (c) => c.ask("q"), factoryFor(client, calls), auth);
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
