/**
 * Unit tests for the direct ChatGPT web-tier client (lib/chatgpt.ts) and its
 * web_image chain integration. No network — fetch is injected; SSE streams
 * come from canned event lists.
 */

import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  CHATGPT_MODEL_FALLBACK,
  ChatGptApiError,
  ChatGptAuthError,
  chatgptWebChat,
  chatgptWebGenerateImage,
  defaultChatGptAuthStorePath,
  describeChatGptError,
  loadChatGptAuth,
  refreshChatGptAuth,
  __resetChatGptAuthState,
  type ChatGptAuth,
  type SSEFetchLike,
} from "../../lib/chatgpt";
import { __resetImageRate, generateImageWithFallback, loadImageRateConfig } from "../../lib/imageapi";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENV_VARS = [
  "CHATGPT_WEB_AUTH_KEY",
  "CHATGPT_WEB_CODEX_AUTH",
  "CHATGPT_WEB_MODEL",
  "CHATGPT_WEB_AUTH_STORE",
  "PI_CODING_AGENT_DIR",
] as const;
const OLD_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_VARS) OLD_ENV[k] = process.env[k];
  for (const k of ENV_VARS) delete process.env[k];
  process.env.PI_CODING_AGENT_DIR = "/nonexistent-pi-agent-dir";
  __resetChatGptAuthState();
});

afterEach(() => {
  for (const k of ENV_VARS) {
    if (OLD_ENV[k] !== undefined) process.env[k] = OLD_ENV[k];
    else delete process.env[k];
  }
});

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600;
const PAST_EXP = Math.floor(Date.now() / 1000) - 3600;

function accessToken(claimsExtra: Record<string, unknown> = {}): string {
  return jwt({
    exp: FUTURE_EXP,
    "https://api.openai.com/auth": { chatgpt_account_id: "acc-123", chatgpt_plan_type: "plus" },
    "https://api.openai.com/profile": { email: "user@example.com" },
    ...claimsExtra,
  });
}

function makeAuth(overrides: Partial<ChatGptAuth> = {}): ChatGptAuth {
  return { accessToken: accessToken(), source: "test", sourceKind: "env", accountId: "acc-123", ...overrides };
}

function sseFetch(events: unknown[], opts: { status?: number; statusText?: string; jsonBody?: unknown } = {}): { fetch: SSEFetchLike; calls: { url: string; init?: any }[] } {
  const calls: { url: string; init?: any }[] = [];
  const encoder = new TextEncoder();
  const fetch: SSEFetchLike = (async (url: string, init?: any) => {
    calls.push({ url, init });
    const status = opts.status ?? 200;
    if (status !== 200) {
      return {
        ok: false,
        status,
        statusText: opts.statusText,
        text: async () => JSON.stringify(opts.jsonBody ?? { error: { message: "nope" } }),
        body: null,
      };
    }
    const payload = events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\ndata: [DONE]\n\n";
    const bytes = encoder.encode(payload);
    async function* body(): AsyncIterable<Uint8Array> {
      // yield in two chunks to exercise line buffering across chunks
      yield bytes.slice(0, Math.ceil(bytes.length / 2));
      yield bytes.slice(Math.ceil(bytes.length / 2));
    }
    return { ok: true, status, body: body() };
  }) as SSEFetchLike;
  return { fetch, calls };
}

const sseText = (delta: string) => ({ type: "response.output_text.delta", delta });
const sseImageDone = (b64: string) => ({ type: "response.output_item.done", item: { type: "image_generation_call", result: b64 } });
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

describe("loadChatGptAuth", () => {
  it("parses the codex-login tokens JSON from env", () => {
    process.env.CHATGPT_WEB_AUTH_KEY = JSON.stringify({ tokens: { access_token: accessToken(), refresh_token: "rt", account_id: "acc-file" } });
    const { auth, problem } = loadChatGptAuth("/nonexistent", false, { codexAuthPath: "/nonexistent", piAuthPath: "/nonexistent", storePath: "/nonexistent-store" });
    expect(problem).to.equal(undefined);
    expect(auth?.accessToken).to.equal(accessToken());
    expect(auth?.refreshToken).to.equal("rt");
    expect(auth?.accountId).to.equal("acc-123"); // from claims
    expect(auth?.plan).to.equal("plus");
    expect(auth?.email).to.equal("user@example.com");
  });

  it("parses flat OAuth JSON", () => {
    process.env.CHATGPT_WEB_AUTH_KEY = JSON.stringify({ access_token: accessToken(), refresh: "r2" });
    const { auth } = loadChatGptAuth("/nonexistent", false, { codexAuthPath: "/nonexistent", piAuthPath: "/nonexistent" });
    expect(auth?.refreshToken).to.equal("r2");
  });

  it("accepts a bare JWT", () => {
    process.env.CHATGPT_WEB_AUTH_KEY = accessToken();
    const { auth } = loadChatGptAuth("/nonexistent", false, { codexAuthPath: "/nonexistent", piAuthPath: "/nonexistent" });
    expect(auth?.accountId).to.equal("acc-123");
  });

  it("reports a problem for opaque bridge-era keys (not an OAuth token)", () => {
    process.env.CHATGPT_WEB_AUTH_KEY = "ae04ae981deadbeef";
    const { auth, problem } = loadChatGptAuth("/nonexistent", false, { codexAuthPath: "/nonexistent", piAuthPath: "/nonexistent" });
    expect(auth).to.equal(null);
    expect(problem).to.include("not an OpenAI OAuth token");
  });

  it("falls back to the codex auth file, then pi auth.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-test-"));
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: accessToken({ exp: FUTURE_EXP }), refresh_token: "rt-file" } }));
    const { auth } = loadChatGptAuth("/nonexistent", false, { codexAuthPath: path.join(dir, "auth.json"), piAuthPath: "/nonexistent" });
    expect(auth?.source).to.include("auth.json");
    expect(auth?.refreshToken).to.equal("rt-file");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the pi auth.json openai-codex entry (read-only)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-test-"));
    fs.writeFileSync(path.join(dir, "pi-auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: accessToken(), refresh: "rt-pi", accountId: "acc-pi" } }));
    const { auth } = loadChatGptAuth("/nonexistent", false, { codexAuthPath: "/nonexistent", piAuthPath: path.join(dir, "pi-auth.json") });
    expect(auth?.refreshToken).to.equal("rt-pi");
    expect(auth?.source).to.include("openai-codex");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when nothing is configured", () => {
    const { auth, problem } = loadChatGptAuth("/nonexistent", false, { codexAuthPath: "/nonexistent", piAuthPath: "/nonexistent" });
    expect(auth).to.equal(null);
    expect(problem).to.equal(undefined);
  });
});

// ---------------------------------------------------------------------------
// Refresh + store
// ---------------------------------------------------------------------------

// ponytail: plain structural fake — (url, init) => 200 + tokens JSON
function refreshOkFetch(newToken: string): any {
  return (async (url: string) => {
    void url;
    return { status: 200, text: JSON.stringify({ access_token: newToken, refresh_token: "rt-rotated", expires_in: 3600 }) };
  }) as any;
}

describe("refreshChatGptAuth", () => {
  it("refreshes, persists to the store (env source), and rotates the refresh token", async () => {
    const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-store-")), "store.json");
    const auth: ChatGptAuth = { ...makeAuth({ expiresAt: Date.now() - 1000, refreshToken: "rt-old" }) };
    const fresh = await refreshChatGptAuth(auth, { storePath, refreshFetch: refreshOkFetch(accessToken()) });
    expect(fresh.accessToken).to.equal(accessToken());
    expect(fresh.refreshToken).to.equal("rt-rotated");
    const stored = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(stored.refreshToken).to.equal("rt-rotated");
    expect(stored.refreshKey).to.equal(createHash("sha256").update("rt-rotated").digest("hex").slice(0, 16));
    fs.rmSync(path.dirname(storePath), { recursive: true, force: true });
  });

  it("rewrites the codex auth file in place when that is the source", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-codex-"));
    const file = path.join(dir, "auth.json");
    fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: "old", refresh_token: "rt-old" }, other: "kept" }));
    const auth: ChatGptAuth = { accessToken: "old", refreshToken: "rt-old", source: file, sourceKind: "codex-file" };
    await refreshChatGptAuth(auth, { refreshFetch: refreshOkFetch(accessToken()) });
    const rewritten = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(rewritten.other).to.equal("kept");
    expect(rewritten.tokens.access_token).to.equal(accessToken());
    expect(rewritten.tokens.refresh_token).to.equal("rt-rotated");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws an honest re-login error on invalid_grant", async () => {
    const auth: ChatGptAuth = { ...makeAuth({ refreshToken: "rt-dead" }) };
    const refreshFetch = (async () => ({ status: 400, text: JSON.stringify({ error: "invalid_grant" }) })) as any;
    try {
      await refreshChatGptAuth(auth, { refreshFetch });
      expect.fail("should throw");
    } catch (e) {
      expect(e).to.be.instanceOf(ChatGptAuthError);
      expect((e as Error).message).to.include("codex login");
    }
  });

  it("refuses to refresh without a refresh token", async () => {
    const auth: ChatGptAuth = { ...makeAuth({ expiresAt: Date.now() - 1000 }) };
    try {
      await refreshChatGptAuth(auth);
      expect.fail("should throw");
    } catch (e) {
      expect(e).to.be.instanceOf(ChatGptAuthError);
      expect((e as Error).message).to.include("codex login");
    }
  });

  it("loadChatGptAuth prefers a fresher stored token matching the refresh fingerprint", () => {
    const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-store-")), "store.json");
    const freshToken = accessToken();
    fs.writeFileSync(storePath, JSON.stringify({
      refreshKey: createHash("sha256").update("rt-old").digest("hex").slice(0, 16),
      accessToken: freshToken,
      refreshToken: "rt-rotated",
      expiresAt: Date.now() + 7200_000,
      updatedAt: Date.now(),
    }));
    process.env.CHATGPT_WEB_AUTH_KEY = JSON.stringify({ access_token: accessToken({ exp: PAST_EXP }), refresh_token: "rt-old" });
    const { auth } = loadChatGptAuth("/nonexistent", false, { codexAuthPath: "/nonexistent", piAuthPath: "/nonexistent", storePath });
    expect(auth?.accessToken).to.equal(freshToken);
    expect(auth?.refreshToken).to.equal("rt-rotated");
    fs.rmSync(path.dirname(storePath), { recursive: true, force: true });
  });

  it("adopts the rotated token persisted by a previous session's refresh (prev-key match)", async () => {
    const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-store-")), "store.json");
    process.env.CHATGPT_WEB_AUTH_KEY = JSON.stringify({ access_token: accessToken({ exp: PAST_EXP }), refresh_token: "rt-old" });
    // previous session: refresh rotates rt-old → rt-rotated, persists the store
    const first = loadChatGptAuth("/nonexistent", false, { codexAuthPath: "/nonexistent", piAuthPath: "/nonexistent", storePath }).auth!;
    await refreshChatGptAuth(first, { storePath, refreshFetch: refreshOkFetch(accessToken({ exp: FUTURE_EXP + 3600 })) });
    const stored = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(stored.prevRefreshKey).to.equal(createHash("sha256").update("rt-old").digest("hex").slice(0, 16));
    // next session: SAME env (still stale access + rt-old) must adopt the store
    const next = loadChatGptAuth("/nonexistent", false, { codexAuthPath: "/nonexistent", piAuthPath: "/nonexistent", storePath }).auth!;
    expect(next.refreshToken).to.equal("rt-rotated");
    expect(next.accessToken).to.equal(accessToken({ exp: FUTURE_EXP + 3600 }));
    expect(next.expiresAt).to.be.greaterThan(Date.now());
    fs.rmSync(path.dirname(storePath), { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

describe("chatgptWebChat", () => {
  it("streams the answer from output_text deltas and sends the codex request shape", async () => {
    const { fetch, calls } = sseFetch([
      { type: "response.created", response: { tools: [] } },
      sseText("pon"),
      sseText("g"),
      { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 }, output: [] } },
    ]);
    const r = await chatgptWebChat({ auth: makeAuth(), prompt: "say pong", fetchImpl: fetch });
    expect(r.text).to.equal("pong");
    expect(r.model).to.equal("gpt-5.5");
    expect(r.usage?.totalTokens).to.equal(6);
    const init = calls[0].init;
    expect(calls[0].url).to.equal("https://chatgpt.com/backend-api/codex/responses");
    expect(init.headers.Authorization).to.match(/^Bearer eyJ/);
    expect(init.headers["chatgpt-account-id"]).to.equal("acc-123");
    expect(init.headers.Accept).to.equal("text/event-stream");
    expect(init.headers["OpenAI-Beta"]).to.equal("responses=experimental");
    expect(init.headers["session-id"]).to.equal(init.headers["x-client-request-id"]);
    const body = JSON.parse(init.body);
    expect(body.stream).to.equal(true);
    expect(body.store).to.equal(false);
    expect(body.model).to.equal("gpt-5.5");
    expect(body.instructions).to.equal("You are a helpful assistant.");
    expect(body.input[0].content[0].text).to.equal("say pong");
  });

  it("passes system through as instructions", async () => {
    const { fetch, calls } = sseFetch([sseText("ok")]);
    await chatgptWebChat({ auth: makeAuth(), prompt: "q", system: "be terse", fetchImpl: fetch });
    expect(JSON.parse(calls[0].init.body).instructions).to.equal("be terse");
  });

  it("falls back to the completed response output when no deltas arrived", async () => {
    const { fetch } = sseFetch([
      { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "final text" }] }] } },
    ]);
    const r = await chatgptWebChat({ auth: makeAuth(), prompt: "q", fetchImpl: fetch });
    expect(r.text).to.equal("final text");
  });

  it("falls back to the fallback model on unknown-model errors", async () => {
    const calls: any[] = [];
    let n = 0;
    const fetch: SSEFetchLike = (async (_url, init) => {
      calls.push(init);
      n++;
      if (n === 1) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "Unknown model: bogus-model" } }) };
      const encoder = new TextEncoder();
      const bytes = encoder.encode(`data: ${JSON.stringify(sseText("ok"))}\n\ndata: [DONE]\n\n`);
      async function* body() { yield bytes; }
      return { ok: true, status: 200, body: body() };
    }) as SSEFetchLike;
    const r = await chatgptWebChat({ auth: makeAuth(), prompt: "q", model: "bogus-model", fetchImpl: fetch });
    expect(r.model).to.equal(CHATGPT_MODEL_FALLBACK);
    expect(JSON.parse(calls[1].body).model).to.equal(CHATGPT_MODEL_FALLBACK);
  });

  it("surfaces mid-stream failure details and empty completions", async () => {
    const failed = sseFetch([{ type: "response.failed", response: { error: { message: "quota exceeded" } } }]);
    try {
      await chatgptWebChat({ auth: makeAuth(), prompt: "q", fetchImpl: failed.fetch });
      expect.fail("should throw");
    } catch (e) {
      expect(describeChatGptError(e)).to.include("quota exceeded");
    }
    const empty = sseFetch([{ type: "response.created", response: {} }]);
    try {
      await chatgptWebChat({ auth: makeAuth(), prompt: "q", fetchImpl: empty.fetch });
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).message).to.include("no usable output");
    }
  });
});

// ---------------------------------------------------------------------------
// Auth retry
// ---------------------------------------------------------------------------

describe("auth retry", () => {
  function makeFlow(authExpiryPast: boolean) {
    // The API 401s exactly the STALE token; the refresh issues a fresh one, so
    // a proactive refresh never hits the wire and a mid-session 401 retries once.
    const apiCalls: string[] = [];
    const staleToken = accessToken();
    const staleAuth = (): ChatGptAuth => makeAuth({ accessToken: staleToken, expiresAt: authExpiryPast ? Date.now() - 1000 : FUTURE_EXP * 1000, refreshToken: "rt-old" });
    let refreshed = false;
    const refreshFetch = (async () => {
      refreshed = true;
      // the refreshed token must differ from the stale fixture, or the fake
      // would 401 the post-refresh call too
      return { status: 200, text: JSON.stringify({ access_token: accessToken({ exp: FUTURE_EXP + 3600 }), refresh_token: "rt-new" }) };
    }) as any;
    const encode = (obj: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\ndata: [DONE]\n\n`);
    const okStream = async function* () { yield encode(sseText("recovered")); }();
    const fetch: SSEFetchLike = (async (_url, init) => {
      apiCalls.push(init.headers.Authorization);
      if (init.headers.Authorization === `Bearer ${staleToken}`) return { ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "expired" } }) };
      return { ok: true, status: 200, body: okStream };
    }) as SSEFetchLike;
    return { staleAuth, refreshFetch, fetch, apiCalls, getRefreshed: () => refreshed };
  }

  it("proactively refreshes an expired token before the call", async () => {
    const flow = makeFlow(true);
    const r = await chatgptWebChat({ auth: flow.staleAuth(), prompt: "q", fetchImpl: flow.fetch, refreshFetch: flow.refreshFetch, storePath: "/nonexistent-store" });
    expect(r.text).to.equal("recovered");
    expect(flow.getRefreshed()).to.equal(true);
    expect(flow.apiCalls.length).to.equal(1); // only the post-refresh call hit the API
  });

  it("retries once after a 401 mid-session", async () => {
    const flow = makeFlow(false);
    const r = await chatgptWebChat({ auth: flow.staleAuth(), prompt: "q", fetchImpl: flow.fetch, refreshFetch: flow.refreshFetch, storePath: "/nonexistent-store" });
    expect(r.text).to.equal("recovered");
    expect(flow.apiCalls.length).to.equal(2);
    expect(flow.apiCalls[0]).to.not.equal(flow.apiCalls[1]); // token changed
  });

  it("wraps an expired token without refresh material in an honest error", async () => {
    const auth = makeAuth({ refreshToken: undefined });
    const fetch: SSEFetchLike = (async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "expired" } }) })) as SSEFetchLike;
    try {
      await chatgptWebChat({ auth, prompt: "q", fetchImpl: fetch });
      expect.fail("should throw");
    } catch (e) {
      expect(e).to.be.instanceOf(ChatGptAuthError);
      expect((e as Error).message).to.include("no refresh token");
    }
  });
});

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

describe("chatgptWebGenerateImage", () => {
  it("decodes the image_generation_call result into a PNG file", async () => {
    const { fetch, calls } = sseFetch([
      { type: "response.image_generation_call.generating" },
      sseImageDone(PNG_B64),
      { type: "response.completed", response: { usage: { total_tokens: 100 }, tools: [{ type: "image_generation", model: "gpt-image-2-codex", size: "auto" }] } },
    ]);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-img-"));
    const r = await chatgptWebGenerateImage({ auth: makeAuth(), prompt: "a red cube", outDir, fetchImpl: fetch });
    expect(r.paths.length).to.equal(1);
    const buf = fs.readFileSync(r.paths[0]);
    expect(buf[0]).to.equal(0x89);
    expect(buf[1]).to.equal(0x50); // PNG magic
    expect(r.note).to.include("gpt-image-2-codex"); // server rewrote the model
    const body = JSON.parse(calls[0].init.body);
    expect(body.instructions).to.equal("You are an image generation assistant.");
    expect(body.tools[0].type).to.equal("image_generation");
    expect(body.tools[0].output_format).to.equal("png");
    expect(body.input[0].content[0].text).to.include("a red cube");
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("errors honestly when no image arrives", async () => {
    const { fetch } = sseFetch([{ type: "response.completed", response: {} }]);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-img-"));
    try {
      await chatgptWebGenerateImage({ auth: makeAuth(), prompt: "p", outDir, fetchImpl: fetch });
      expect.fail("should throw");
    } catch (e) {
      expect(e).to.be.instanceOf(ChatGptApiError);
      expect((e as Error).message).to.include("no image returned");
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Env trust boundaries (untrusted project cwd must not steer secrets/models)
// ---------------------------------------------------------------------------

describe("env trust boundaries", () => {
  it("defaultChatGptAuthStorePath ignores untrusted cwd .env.local", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-untrusted-"));
    const leak = path.join(cwd, "leak.json");
    fs.writeFileSync(path.join(cwd, ".env.local"), `CHATGPT_WEB_AUTH_STORE=${leak}\n`);
    const p = defaultChatGptAuthStorePath();
    expect(p).to.not.equal(leak);
    expect(p.endsWith("chatgpt-web-auth.json")).to.equal(true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("CHATGPT_WEB_MODEL from untrusted cwd is ignored unless includeCwdEnv", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-untrusted-"));
    fs.writeFileSync(path.join(cwd, ".env.local"), "CHATGPT_WEB_MODEL=gpt-from-untrusted-cwd\n");
    const calls: any[] = [];
    const fetch: SSEFetchLike = (async (_url, init) => {
      calls.push(init);
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify(sseText("ok"))}\n\ndata: [DONE]\n\n`);
      async function* body() { yield bytes; }
      return { ok: true, status: 200, body: body() };
    }) as SSEFetchLike;
    await chatgptWebChat({ auth: makeAuth(), prompt: "q", fetchImpl: fetch, cwd });
    expect(JSON.parse(calls[0].body).model).to.equal("gpt-5.5"); // cwd file NOT consulted
    await chatgptWebChat({ auth: makeAuth(), prompt: "q", fetchImpl: fetch, cwd, includeCwdEnv: true });
    expect(JSON.parse(calls[1].body).model).to.equal("gpt-from-untrusted-cwd"); // trusted → honored
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// web_image chain integration
// ---------------------------------------------------------------------------

describe("web_image chatgpt chain", () => {
  const rateConfig = loadImageRateConfig("/nonexistent", false);
  const base = {
    prompt: "a red cube",
    n: 1,
    provider: "auto" as const,
    geminiConfig: { psid: undefined, psidSource: undefined, proxy: undefined } as any,
    apiConfig: {} as any,
    rateConfig,
    geminiFactory: (() => { throw new Error("gemini not configured in this test"); }) as any,
  };

  afterEach(() => __resetImageRate());

  it("auto chain order is gemini → chatgpt → zai → custom with per-provider hints", async () => {
    const { fetch } = sseFetch([sseImageDone(PNG_B64)]);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-chain-"));
    const r = await generateImageWithFallback({
      ...base,
      outDir,
      chatgptAuth: makeAuth(),
      chatgptFetchImpl: fetch,
    });
    expect(r.provider).to.equal("chatgpt"); // gemini refused → chatgpt picked up
    expect(r.paths.length).to.equal(1);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("unconfigured chatgpt contributes a hint to the all-failed error", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-chain-"));
    try {
      await generateImageWithFallback({
        ...base,
        outDir,
        chatgptProblem: "CHATGPT_WEB_AUTH_KEY is set but is not an OpenAI OAuth token",
      });
      expect.fail("should throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).to.include("gemini: ");
      expect(msg).to.include("not an OpenAI OAuth token");
      expect(msg).to.include("zai: not configured (set ZAI_API_KEY)");
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("loops n images sequentially over the codex surface", async () => {
    let n = 0;
    const looping: SSEFetchLike = (async (url, init) => {
      void url;
      void init;
      n++;
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify(sseImageDone(PNG_B64))}\n\ndata: [DONE]\n\n`);
      async function* body() { yield bytes; }
      return { ok: true, status: 200, body: body() };
    }) as SSEFetchLike;
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-chain-"));
    const r = await generateImageWithFallback({
      ...base,
      n: 2,
      outDir,
      chatgptAuth: makeAuth(),
      chatgptFetchImpl: looping,
    });
    expect(n).to.equal(2);
    expect(r.paths.length).to.equal(2);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("counts chatgpt against the daily soft cap", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-chain-"));
    const looping: SSEFetchLike = (async () => {
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify(sseImageDone(PNG_B64))}\n\ndata: [DONE]\n\n`);
      async function* body() { yield bytes; }
      return { ok: true, status: 200, body: body() };
    }) as SSEFetchLike;
    const cfg = { ...rateConfig, dailyCap: 1, minIntervalMs: 0 };
    const ok = await generateImageWithFallback({ ...base, outDir, rateConfig: cfg, chatgptAuth: makeAuth(), chatgptFetchImpl: looping });
    expect(ok.provider).to.equal("chatgpt");
    // next call: chatgpt is capped → gemini throws (test factory), zai/custom
    // unconfigured → the aggregated error must show the cap, not a silent skip.
    try {
      await generateImageWithFallback({ ...base, outDir, rateConfig: cfg, chatgptAuth: makeAuth(), chatgptFetchImpl: looping });
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).message).to.include("daily soft cap reached");
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("counts each metered chatgpt generation (n>1) against the cap", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-chain-"));
    const looping: SSEFetchLike = (async () => {
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify(sseImageDone(PNG_B64))}\n\ndata: [DONE]\n\n`);
      async function* body() { yield bytes; }
      return { ok: true, status: 200, body: body() };
    }) as SSEFetchLike;
    const cfg = { ...rateConfig, dailyCap: 2, minIntervalMs: 0 };
    // n=2 consumes the whole cap in ONE tool call (2 metered generations)
    const first = await generateImageWithFallback({ ...base, n: 2, outDir, rateConfig: cfg, chatgptAuth: makeAuth(), chatgptFetchImpl: looping });
    expect(first.paths.length).to.equal(2);
    try {
      await generateImageWithFallback({ ...base, outDir, rateConfig: cfg, chatgptAuth: makeAuth(), chatgptFetchImpl: looping });
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).message).to.include("daily soft cap reached");
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});
