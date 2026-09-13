/**
 * Unit tests for web_image (lib/imageapi.ts + gemini image generation).
 * No network — the gemini-reverse client is injected via a fake factory and
 * HTTP via an injectable fetchImpl; rate guardrails use a fake clock.
 */

import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ZAI_PRESET,
  MAX_DOWNLOAD_BYTES,
  apiGenerateImage,
  describeImageApiError,
  generateImageWithFallback,
  imageRateCheck,
  imageRateRecord,
  imageRateSnapshot,
  loadImageApiConfig,
  loadImageRateConfig,
  __resetImageRate,
  __setImageRateClock,
  type FetchLike,
  type ImageApiConfig,
  type ImageRateConfig,
} from "../../lib/imageapi";
import {
  geminiGenerateImage,
  loadGeminiWebConfig,
  __resetGeminiClientCache,
  type GeminiClientFactory,
  type GeminiClientLike,
} from "../../lib/gemini";

// ---------------------------------------------------------------------------
// Env isolation (host ~/.pi/agent/.env.local must never leak in)
// ---------------------------------------------------------------------------

const ENV_VARS = [
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "WEB_IMAGE_API_BASE_URL",
  "WEB_IMAGE_API_KEY",
  "WEB_IMAGE_API_LABEL",
  "WEB_IMAGE_MIN_INTERVAL_MS",
  "WEB_IMAGE_DAILY_CAP",
  "GEMINI_WEB_SECURE_1PSID",
  "GEMINI_WEB_PROXY",
  "PI_CODING_AGENT_DIR",
] as const;
const OLD_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_VARS) OLD_ENV[k] = process.env[k];
  for (const k of ENV_VARS) delete process.env[k];
  process.env.PI_CODING_AGENT_DIR = "/nonexistent-pi-agent-dir";
  __resetImageRate();
  __resetGeminiClientCache();
});

afterEach(() => {
  for (const k of ENV_VARS) {
    if (OLD_ENV[k] !== undefined) process.env[k] = OLD_ENV[k];
    else delete process.env[k];
  }
});

const ISOLATED = "/nonexistent-dir-for-tests";
const NO_RATE: ImageRateConfig = { minIntervalMs: 0, dailyCap: 9999 };

async function tmpDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-web-image-test-"));
}

// ---------------------------------------------------------------------------
// Fake gemini client (image-capable)
// ---------------------------------------------------------------------------

function imageClient(opts: { images?: number; text?: string; failFirst?: boolean } = {}) {
  let generateCalls = 0;
  const seen: { newChatOpts?: { model?: string }; prompts: string[]; saved: string[] } = { prompts: [], saved: [] };
  const client: GeminiClientLike = {
    ask: async () => ({ text: "ok" }),
    research: async () => ({ text: "report" }),
    newChat: (newChatOpts?: { model?: string }) => ({
      generateContent: async (o: { prompt: string }) => {
        generateCalls++;
        seen.newChatOpts = newChatOpts;
        seen.prompts.push(o.prompt);
        if (opts.failFirst && generateCalls === 1) {
          const e = new Error("expired");
          e.name = "AuthError";
          throw e;
        }
        const n = opts.images ?? 1;
        return {
          text: opts.text ?? "",
          model: "gemini-image-test",
          generated_images: Array.from({ length: n }, (_, i) => ({
            save: async (so?: { path?: string }) => {
              const p = path.join(so?.path ?? ".", `img-${generateCalls}-${i}.png`);
              fs.writeFileSync(p, "png");
              seen.saved.push(p);
              return p;
            },
            url: "https://example.com/x.png",
            alt: "x",
          })),
        };
      },
    }),
  };
  return { client, seen };
}

function factoryFor(client: GeminiClientLike, calls?: { n: number }): GeminiClientFactory {
  return () => {
    if (calls) calls.n++;
    return client;
  };
}

// ---------------------------------------------------------------------------
// Fake fetch (OpenAI-images shape)
// ---------------------------------------------------------------------------

const PNG_B64 = Buffer.from("pngbytes").toString("base64");

function routingFetch(apiBody: unknown, apiStatus = 200, fileBytes = "imgbytes", fileMime = "png"): FetchLike {
  return (async (url: string, init?: { method?: string }) => {
    if (init?.method === "POST") {
      return {
        ok: apiStatus >= 200 && apiStatus < 300,
        status: apiStatus,
        statusText: "Status",
        json: async () => apiBody,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    // image download — TextEncoder gives an exact-size ArrayBuffer (Buffer
    // pooling would leak neighboring bytes into the "downloaded" file)
    const fakeRes = {
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () => new TextEncoder().encode(fileBytes).buffer as ArrayBuffer,
    };
    void fileMime;
    void url;
    return fakeRes;
  }) as unknown as FetchLike;
}

// ---------------------------------------------------------------------------
// loadImageApiConfig / loadImageRateConfig
// ---------------------------------------------------------------------------

describe("loadImageApiConfig", () => {
  it("reads ZAI_API_KEY (process.env first)", () => {
    process.env.ZAI_API_KEY = "zk";
    const cfg = loadImageApiConfig(ISOLATED, false);
    expect(cfg.zai?.apiKey).to.equal("zk");
    expect(cfg.zai?.source).to.equal("process.env");
    expect(cfg.custom).to.be.undefined;
  });

  it("falls back to Z_AI_API_KEY when ZAI_API_KEY is unset", () => {
    process.env.Z_AI_API_KEY = "zk2";
    expect(loadImageApiConfig(ISOLATED, false).zai?.apiKey).to.equal("zk2");
  });

  it("reads custom endpoint config and defaults the label to the host", () => {
    process.env.WEB_IMAGE_API_BASE_URL = "https://api.example.com/v1/";
    const cfg = loadImageApiConfig(ISOLATED, false);
    expect(cfg.custom?.baseUrl).to.equal("https://api.example.com/v1");
    expect(cfg.custom?.label).to.equal("api.example.com");
    expect(cfg.custom?.apiKey).to.be.undefined;
    process.env.WEB_IMAGE_API_KEY = "ck";
    process.env.WEB_IMAGE_API_LABEL = "mine";
    const cfg2 = loadImageApiConfig(ISOLATED, false);
    expect(cfg2.custom?.apiKey).to.equal("ck");
    expect(cfg2.custom?.label).to.equal("mine");
  });

  it("returns empty config when nothing is set (isolated from host pi config)", () => {
    const cfg = loadImageApiConfig(ISOLATED, false);
    expect(cfg.zai).to.be.undefined;
    expect(cfg.custom).to.be.undefined;
  });
});

describe("loadImageRateConfig", () => {
  it("defaults to 5s interval and 20/day cap", () => {
    expect(loadImageRateConfig(ISOLATED, false)).to.deep.equal({ minIntervalMs: 5000, dailyCap: 20 });
  });

  it("honors env overrides (invalid values fall back to defaults)", () => {
    process.env.WEB_IMAGE_MIN_INTERVAL_MS = "250";
    process.env.WEB_IMAGE_DAILY_CAP = "7";
    expect(loadImageRateConfig(ISOLATED, false)).to.deep.equal({ minIntervalMs: 250, dailyCap: 7 });
    process.env.WEB_IMAGE_MIN_INTERVAL_MS = "bogus";
    expect(loadImageRateConfig(ISOLATED, false).minIntervalMs).to.equal(5000);
  });
});

// ---------------------------------------------------------------------------
// Rate guardrails (fake clock)
// ---------------------------------------------------------------------------

describe("image rate guardrails", () => {
  it("enforces the min interval between calls", () => {
    let t = 10_000;
    __setImageRateClock(() => t);
    const rc: ImageRateConfig = { minIntervalMs: 5000, dailyCap: 20 };
    expect(imageRateCheck("gemini", rc).ok).to.equal(true);
    imageRateRecord("gemini");
    const v = imageRateCheck("gemini", rc);
    expect(v.ok).to.equal(false);
    if (!v.ok) expect(v.retryAfterMs).to.be.greaterThan(0);
    t += 5000;
    expect(imageRateCheck("gemini", rc).ok).to.equal(true);
  });

  it("enforces the daily cap for gemini only, resetting on UTC day roll", () => {
    let t = Date.UTC(2026, 8, 13, 23, 50, 0);
    __setImageRateClock(() => t);
    const rc: ImageRateConfig = { minIntervalMs: 0, dailyCap: 2 };
    imageRateRecord("gemini", 2);
    const blocked = imageRateCheck("gemini", rc);
    expect(blocked.ok).to.equal(false);
    expect(imageRateCheck("zai", rc).ok).to.equal(true); // keyed API: interval-limited only
    t += 11 * 60 * 1000; // cross midnight UTC
    expect(imageRateCheck("gemini", rc).ok).to.equal(true);
  });

  it("counts successes only and exposes a snapshot", () => {
    let t = 1_000;
    __setImageRateClock(() => t);
    const rc: ImageRateConfig = { minIntervalMs: 1000, dailyCap: 5 };
    imageRateRecord("custom");
    expect(imageRateSnapshot().custom.count).to.equal(1);
    t += 1000;
    expect(imageRateCheck("custom", rc).ok).to.equal(true);
    expect(imageRateSnapshot().custom.msSinceLast).to.equal(1000);
  });
});

// ---------------------------------------------------------------------------
// geminiGenerateImage
// ---------------------------------------------------------------------------

describe("geminiGenerateImage", () => {
  it("saves returned images and reports guest + model", async () => {
    const { client, seen } = imageClient({ images: 2 });
    const outDir = await tmpDir();
    const r = await geminiGenerateImage("a red cube", {
      config: { psid: "psid", psidSource: "test" },
      outDir,
      factory: factoryFor(client),
    });
    expect(r.paths).to.have.length(2);
    expect(fs.existsSync(r.paths[0])).to.equal(true);
    expect(r.guest).to.equal(false);
    expect(r.model).to.equal("gemini-image-test");
    expect(seen.prompts).to.deep.equal(["a red cube"]);
  });

  it("passes the model through to newChat and flags guest mode without a cookie", async () => {
    const { client, seen } = imageClient();
    const r = await geminiGenerateImage("x", {
      config: loadGeminiWebConfig(ISOLATED, false),
      outDir: await tmpDir(),
      model: "gemini-image",
      factory: factoryFor(client),
    });
    expect(seen.newChatOpts).to.deep.equal({ model: "gemini-image" });
    expect(r.guest).to.equal(true);
  });

  it("errors with a hint when no images come back", async () => {
    const { client } = imageClient({ images: 0, text: "I cannot generate that." });
    try {
      await geminiGenerateImage("x", { config: { psid: "p", psidSource: "t" }, outDir: await tmpDir(), factory: factoryFor(client) });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).to.include("no images");
      expect((e as Error).message).to.include("I cannot generate that.");
    }
  });

  it("retries once on AuthError (re-created client re-runs init)", async () => {
    const { client, seen } = imageClient({ failFirst: true });
    const calls = { n: 0 };
    const r = await geminiGenerateImage("x", {
      config: { psid: "psid", psidSource: "t" },
      outDir: await tmpDir(),
      factory: factoryFor(client, calls),
    });
    expect(calls.n).to.equal(2);
    expect(r.paths).to.have.length(1);
    void seen;
  });
});

// ---------------------------------------------------------------------------
// apiGenerateImage (fake fetch)
// ---------------------------------------------------------------------------

describe("apiGenerateImage", () => {
  it("writes b64_json results and echoes the model", async () => {
    const outDir = await tmpDir();
    const r = await apiGenerateImage({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "img-1",
      prompt: "p",
      outDir,
      fetchImpl: routingFetch({ data: [{ b64_json: PNG_B64 }], model: "img-1" }),
    });
    expect(r.paths).to.have.length(1);
    expect(fs.readFileSync(r.paths[0]).toString()).to.equal("pngbytes");
    expect(r.model).to.equal("img-1");
  });

  it("downloads url results (extension from the URL)", async () => {
    const outDir = await tmpDir();
    const fetchImpl = routingFetch({ data: [{ url: "https://cdn.example.com/a/b.WEBP?x=1" }] });
    const r = await apiGenerateImage({ baseUrl: ZAI_PRESET.baseUrl, model: "cogview-4", prompt: "p", outDir, fetchImpl });
    expect(r.paths).to.have.length(1);
    expect(r.paths[0].endsWith(".webp")).to.equal(true);
    expect(fs.readFileSync(r.paths[0]).toString()).to.equal("imgbytes");
  });

  it("maps HTTP errors into ImageApiError and rejects empty payloads", async () => {
    const outDir = await tmpDir();
    const fail = (status: number, body: unknown) =>
      apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl: routingFetch(body, status) });
    try {
      await fail(401, { error: { message: "bad key" } });
      expect.fail("should throw");
    } catch (e) {
      expect(describeImageApiError(e)).to.include("API key");
      expect((e as Error).message).to.include("bad key");
    }
    try {
      await fail(429, { message: "quota" });
      expect.fail("should throw");
    } catch (e) {
      expect(describeImageApiError(e)).to.include("429");
    }
    try {
      await fail(500, { error: { message: "boom" } });
      expect.fail("should throw");
    } catch (e) {
      expect(describeImageApiError(e)).to.include("server error");
    }
    try {
      await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl: routingFetch({ data: [] }) });
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).message).to.include("no image data");
    }
  });

  it("survives a failed image download by returning the URL (generation not wasted)", async () => {
    const outDir = await tmpDir();
    const failingDownload = (async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ url: "https://blocked-cdn.example.com/a.png" }] }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      throw new Error("connect ECONNREFUSED 0.0.0.0:443");
    }) as unknown as FetchLike;
    const r = await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl: failingDownload });
    expect(r.paths).to.deep.equal([]);
    expect(r.urls).to.deep.equal(["https://blocked-cdn.example.com/a.png"]);
  });
});

// ---------------------------------------------------------------------------
// generateImageWithFallback (the chain)
// ---------------------------------------------------------------------------

function baseParams(over: Partial<Parameters<typeof generateImageWithFallback>[0]> = {}) {
  return {
    prompt: "p",
    outDir: "/tmp/unused",
    provider: "auto" as const,
    geminiConfig: loadGeminiWebConfig(ISOLATED, false),
    apiConfig: {} as ImageApiConfig,
    rateConfig: NO_RATE,
    ...over,
  };
}

describe("generateImageWithFallback", () => {
  it("returns the first successful provider", async () => {
    const { client } = imageClient();
    const r = await generateImageWithFallback(baseParams({
      geminiFactory: factoryFor(client),
      outDir: await tmpDir(),
    }));
    expect(r.provider).to.equal("gemini");
    expect(r.attempts).to.deep.equal([]);
  });

  it("falls through to zai when gemini fails, recording the attempt", async () => {
    const { client } = imageClient({ images: 0, text: "nope" });
    process.env.ZAI_API_KEY = "zk";
    const r = await generateImageWithFallback(baseParams({
      geminiFactory: factoryFor(client),
      apiConfig: loadImageApiConfig(ISOLATED, false),
      outDir: await tmpDir(),
      fetchImpl: routingFetch({ data: [{ b64_json: PNG_B64 }], model: "cogview-4" }),
    }));
    expect(r.provider).to.equal("zai");
    expect(r.model).to.equal("cogview-4");
    expect(r.attempts).to.have.length(1);
    expect(r.attempts[0]).to.include("gemini:");
  });

  it("skips a capped gemini (web tier) and uses the next provider", async () => {
    const t = 10_000;
    __setImageRateClock(() => t);
    const { client } = imageClient();
    process.env.WEB_IMAGE_API_BASE_URL = "https://custom.example.com/v1";
    imageRateRecord("gemini"); // prior success consumes today's cap
    const r = await generateImageWithFallback(baseParams({
      geminiFactory: factoryFor(client),
      apiConfig: loadImageApiConfig(ISOLATED, false),
      rateConfig: { minIntervalMs: 0, dailyCap: 1 },
      outDir: await tmpDir(),
      fetchImpl: routingFetch({ data: [{ b64_json: PNG_B64 }] }),
    }));
    expect(r.provider).to.equal("custom");
    expect(r.attempts[0]).to.include("skipped");
    expect(r.attempts[0]).to.include("daily soft cap");
  });

  it("records rate state so a second immediate gemini call is interval-blocked", async () => {
    let t = 10_000;
    __setImageRateClock(() => t);
    const { client } = imageClient();
    process.env.ZAI_API_KEY = "zk";
    const common = baseParams({
      geminiFactory: factoryFor(client),
      apiConfig: loadImageApiConfig(ISOLATED, false),
      rateConfig: { minIntervalMs: 5000, dailyCap: 20 },
      outDir: await tmpDir(),
      fetchImpl: routingFetch({ data: [{ b64_json: PNG_B64 }] }),
    });
    const first = await generateImageWithFallback(common);
    expect(first.provider).to.equal("gemini");
    t += 1;
    const second = await generateImageWithFallback({ ...common, outDir: await tmpDir() });
    expect(second.provider).to.equal("zai");
    expect(second.attempts[0]).to.include("min interval");
  });

  it("throws an aggregated error when every provider fails", async () => {
    const { client } = imageClient({ images: 0, text: "nope" });
    try {
      await generateImageWithFallback(baseParams({ geminiFactory: factoryFor(client), outDir: await tmpDir() }));
      expect.fail("should throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).to.include("All image providers failed");
      expect(msg).to.include("zai: not configured");
      expect(msg).to.include("custom: not configured");
    }
  });

  it("reports a pinned-but-unconfigured provider as the failure cause", async () => {
    try {
      await generateImageWithFallback(baseParams({ provider: "zai", outDir: await tmpDir() }));
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).message).to.include("zai: not configured");
    }
  });
});

describe("generateImageWithFallback cancellation + n handling (review findings)", () => {
  it("rejects with AbortError on an aborted signal and does not try further providers", async () => {
    const { client } = imageClient();
    const calls = { n: 0 };
    const controller = new AbortController();
    controller.abort();
    let zaiCalled = false;
    const fetchSpy: FetchLike = (async () => {
      zaiCalled = true;
      throw new Error("zai must not be attempted after abort");
    }) as unknown as FetchLike;
    try {
      await generateImageWithFallback(baseParams({
        geminiFactory: factoryFor(client, calls),
        apiConfig: { zai: { apiKey: "k", source: "test" } },
        fetchImpl: fetchSpy,
        signal: controller.signal,
        outDir: await tmpDir(),
      }));
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).name).to.equal("AbortError");
    }
    expect(calls.n).to.equal(0); // loop-top check: no client construction either
    expect(zaiCalled).to.equal(false);
  });

  it("notes when the gemini web tier returns fewer images than n requested", async () => {
    const { client } = imageClient({ images: 1 });
    const r = await generateImageWithFallback(baseParams({
      geminiFactory: factoryFor(client),
      n: 3,
      outDir: await tmpDir(),
    }));
    expect(r.provider).to.equal("gemini");
    expect(r.paths).to.have.length(1);
    expect(r.attempts.join(" ")).to.include("n=3 requested");
    expect(r.attempts.join(" ")).to.include("zai/custom");
  });

  it("normalizes a provider-phase error to AbortError when the signal aborted mid-flight", async () => {
    const controller = new AbortController();
    let zaiAttempted = false;
    const client: GeminiClientLike = {
      ask: async () => ({ text: "" }),
      research: async () => ({ text: "" }),
      newChat: () => ({
        generateContent: async () => ({
          text: "",
          generated_images: [
            {
              save: async () => {
                controller.abort(); // user cancel lands during the save phase
                throw new Error("disk full");
              },
            },
          ],
        }),
      }),
    };
    try {
      await generateImageWithFallback(baseParams({
        geminiFactory: () => client,
        apiConfig: { zai: { apiKey: "k", source: "test" } },
        fetchImpl: (async () => {
          zaiAttempted = true;
          throw new Error("zai must not be attempted after abort");
        }) as unknown as FetchLike,
        signal: controller.signal,
        outDir: await tmpDir(),
      }));
      expect.fail("should throw");
    } catch (e) {
      // Not "disk full" (raw provider error) — cancellation semantics win.
      expect((e as Error).name).to.equal("AbortError");
    }
    expect(zaiAttempted).to.equal(false); // cancelled calls skip fallback
  });

  it("continues the chain when a foreign AbortError-named error is not from the caller's signal", async () => {
    const { client } = imageClient({ images: 0, text: "nope" }); // gemini must fail so the chain reaches zai
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      if (init?.method !== "POST") throw new Error("download not expected");
      if (String(url).includes("api.z.ai")) {
        const e = new Error("upstream internal abort");
        e.name = "AbortError"; // foreign abort — not the caller's signal
        throw e;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: PNG_B64 }] }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }) as unknown as FetchLike;
    const r = await generateImageWithFallback(baseParams({
      geminiFactory: factoryFor(client),
      apiConfig: {
        zai: { apiKey: "k", source: "test" },
        custom: { baseUrl: "https://custom.example.com/v1", label: "c", source: "test" },
      },
      fetchImpl,
      outDir: await tmpDir(),
    }));
    expect(r.provider).to.equal("custom"); // foreign abort recorded, chain continued
    expect(r.attempts.join(" ")).to.include("zai: upstream internal abort");
    expect(r.paths).to.have.length(1);
  });

  it("throws AbortError before any provider work when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    __setImageRateClock(() => 10_000);
    imageRateRecord("gemini"); // cap gemini so the pre-fix code would skip it and reach zai's fetch
    const { client } = imageClient();
    const calls = { n: 0 };
    let fetchCalls = 0;
    const fetchSpy: FetchLike = (async () => {
      fetchCalls++;
      throw new Error("no fetch expected");
    }) as unknown as FetchLike;
    try {
      await generateImageWithFallback(baseParams({
        geminiFactory: factoryFor(client, calls),
        apiConfig: { zai: { apiKey: "k", source: "test" } },
        rateConfig: { minIntervalMs: 0, dailyCap: 1 },
        fetchImpl: fetchSpy,
        signal: controller.signal,
        outDir: await tmpDir(),
      }));
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).name).to.equal("AbortError");
    }
    expect(calls.n).to.equal(0);
    expect(fetchCalls).to.equal(0);
  });

  it("skips gemini in auto chains after 2 consecutive refusals; pinned still attempts", async () => {
    const { client, seen } = imageClient({ images: 0, text: "can't create right now" });
    process.env.ZAI_API_KEY = "zk";
    const common = baseParams({
      geminiFactory: factoryFor(client),
      apiConfig: loadImageApiConfig(ISOLATED, false),
      rateConfig: { minIntervalMs: 0, dailyCap: 9999 },
      outDir: await tmpDir(),
      fetchImpl: routingFetch({ data: [{ b64_json: PNG_B64 }] }),
    });
    const first = await generateImageWithFallback(common); // refusal 1 → zai
    const second = await generateImageWithFallback({ ...common, outDir: await tmpDir() }); // refusal 2 → zai
    expect(first.provider).to.equal("zai");
    expect(second.provider).to.equal("zai");

    const third = await generateImageWithFallback({ ...common, outDir: await tmpDir() }); // gemini SKIPPED
    expect(third.provider).to.equal("zai");
    expect(third.attempts.join(" ")).to.include("skipped — refused image generation 2×");
    expect(seen.prompts).to.have.length(2); // gemini never invoked on the third call

    // A pinned provider=gemini always attempts (all-fail error lists it).
    try {
      await generateImageWithFallback({ ...common, provider: "gemini", outDir: await tmpDir() });
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).message).to.include("gemini:");
    }
  });

  it("SSRF-guards gateway-supplied image URLs (no fetch, URL surfaced)", async () => {
    const outDir = await tmpDir();
    let getCalled = false;
    const fetchImpl = (async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ url: "http://169.254.169.254/latest/meta-data" }] }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      getCalled = true;
      throw new Error("metadata host must not be fetched");
    }) as unknown as FetchLike;
    const r = await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl });
    expect(getCalled).to.equal(false);
    expect(r.paths).to.deep.equal([]);
    expect(r.urls).to.deep.equal(["http://169.254.169.254/latest/meta-data"]);
  });

  it("caps oversized downloads at MAX_DOWNLOAD_BYTES and surfaces the URL instead", async () => {
    const outDir = await tmpDir();
    const big = Buffer.alloc(MAX_DOWNLOAD_BYTES + 1);
    const fetchImpl = (async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ url: "https://cdn.example.com/huge.png" }] }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => big.buffer,
      };
    }) as unknown as FetchLike;
    const r = await apiGenerateImage({ baseUrl: "https://x/v1", prompt: "p", outDir, fetchImpl });
    expect(fs.readdirSync(outDir)).to.deep.equal([]); // nothing written
    expect(r.urls).to.deep.equal(["https://cdn.example.com/huge.png"]);
  });
});

describe("toImageBlock mime mapping", () => {
  it("maps .gif files to image/gif", async () => {
    const { toImageBlock } = await import("../../index");
    const dir = await tmpDir();
    const file = path.join(dir, "x.gif");
    fs.writeFileSync(file, "GIF89a");
    const block = await toImageBlock(file);
    expect(block.mimeType).to.equal("image/gif");
    expect(block.type).to.equal("image");
  });
});
