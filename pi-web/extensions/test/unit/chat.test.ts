/**
 * Unit tests for web_chat (lib/chatapi.ts). No network — fetch is injected.
 */

import { expect } from "chai";
import {
  chatgptChat,
  describeChatApiError,
  loadChatConfig,
} from "../../lib/chatapi";
import type { FetchLike } from "../../lib/imageapi";

const ENV_VARS = ["WEB_CHAT_API_BASE_URL", "WEB_CHAT_API_KEY", "PI_CODING_AGENT_DIR"] as const;
const OLD_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_VARS) OLD_ENV[k] = process.env[k];
  for (const k of ENV_VARS) delete process.env[k];
  process.env.PI_CODING_AGENT_DIR = "/nonexistent-pi-agent-dir";
});

afterEach(() => {
  for (const k of ENV_VARS) {
    if (OLD_ENV[k] !== undefined) process.env[k] = OLD_ENV[k];
    else delete process.env[k];
  }
});

const ISOLATED = "/nonexistent-dir-for-tests";

function okFetch(body: unknown): FetchLike {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    void url;
    void init;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }) as unknown as FetchLike;
}

describe("loadChatConfig", () => {
  it("reads WEB_CHAT_API_BASE_URL + key (process.env first)", () => {
    process.env.WEB_CHAT_API_BASE_URL = "https://gw.example.com/v1/";
    process.env.WEB_CHAT_API_KEY = "ck";
    const cfg = loadChatConfig(ISOLATED, false);
    expect(cfg?.baseUrl).to.equal("https://gw.example.com/v1");
    expect(cfg?.apiKey).to.equal("ck");
    expect(cfg?.source).to.equal("process.env");
  });

  it("returns null when unconfigured (isolated from host pi config)", () => {
    expect(loadChatConfig(ISOLATED, false)).to.equal(null);
  });
});

describe("chatgptChat", () => {
  it("posts a non-streaming completion and returns content + model", async () => {
    let seenUrl = "";
    let seenInit: { headers?: Record<string, string>; body?: string } | undefined;
    const fetchImpl = (async (url: string, init?: any) => {
      seenUrl = url;
      seenInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: "gpt-5.3-mini", choices: [{ message: { content: "the answer" } }] }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }) as unknown as FetchLike;
    const r = await chatgptChat({ baseUrl: "https://gw.example.com/v1", apiKey: "ck", prompt: "q", model: "gpt-5.3-mini", fetchImpl });
    expect(r.text).to.equal("the answer");
    expect(r.model).to.equal("gpt-5.3-mini");
    expect(seenUrl).to.equal("https://gw.example.com/v1/chat/completions");
    expect(seenInit?.headers?.Authorization).to.equal("Bearer ck");
    const sent = JSON.parse(seenInit!.body!);
    expect(sent.stream).to.equal(false);
    expect(sent.messages).to.deep.equal([{ role: "user", content: "q" }]);
  });

  it("includes the system message when provided", async () => {
    let sent: any;
    const fetchImpl = (async (_url: string, init?: any) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }) as unknown as FetchLike;
    await chatgptChat({ baseUrl: "https://x/v1", prompt: "q", system: "be terse", fetchImpl });
    expect(sent.messages[0]).to.deep.equal({ role: "system", content: "be terse" });
  });

  it("rejects empty completions", async () => {
    try {
      await chatgptChat({ baseUrl: "https://x/v1", prompt: "q", model: "m", fetchImpl: okFetch({ choices: [{ message: { content: "" } }] }) });
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).message).to.include("empty completion");
      expect((e as Error).message).to.include("model m");
    }
  });
});

describe("describeChatApiError", () => {
  async function expectHint(status: number, body: unknown, fragment: string): Promise<void> {
    const failing = (async () => ({
      ok: false,
      status,
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as FetchLike;
    try {
      await chatgptChat({ baseUrl: "https://x/v1", prompt: "p", fetchImpl: failing });
      expect.fail("should throw");
    } catch (e) {
      expect(describeChatApiError(e)).to.include(fragment);
    }
  }

  it("maps 401 to an API-key hint", async () => {
    await expectHint(401, { error: { message: "bad key" } }, "API key");
  });

  it("maps 429 to a quota hint", async () => {
    await expectHint(429, { error: { message: "quota" } }, "429");
  });

  it("maps 502 to the empty account pool hint", async () => {
    await expectHint(502, { error: { message: "upstream_error" } }, "empty account pool");
  });

  it("maps 5xx to a server-error hint", async () => {
    await expectHint(503, { error: { message: "boom" } }, "server error");
  });
});
