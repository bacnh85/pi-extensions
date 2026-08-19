import { assert } from "chai";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { DEFAULTS } from "./helpers";
import {
  a2aCall,
  a2aDiscover,
  a2aOrchestrate,
  isPrivateHost,
  metrics,
  rpcUrl,
} from "../lib/client";
import { buildAgentCard, STATE_COMPLETED } from "../lib/protocol";
import { setGatewayRegistrationName, gatewayKeyFromUrl } from "../lib/config";

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

type FetchMock = (url: string, init?: any) => Promise<any>;

function mockFetch(opts: {
  card?: any;
  cardStatus?: number;
  legacyCard?: any;
  rpcResult?: any;
  rpcError?: { code: number; message: string };
  rpcStatus?: number;
}): FetchMock {
  return async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method || "GET";
    // Agent Card discovery
    if (method === "GET" && u.includes("/.well-known/agent-card.json")) {
      if (opts.cardStatus && opts.cardStatus !== 200) {
        return makeResp({}, opts.cardStatus);
      }
      return makeResp(opts.card ?? null, 200);
    }
    if (method === "GET" && u.includes("/.well-known/agent.json")) {
      return makeResp(opts.legacyCard ?? null, 200);
    }
    // JSON-RPC dispatch
    if (method === "POST") {
      if (opts.rpcError) {
        return makeResp({ jsonrpc: "2.0", id: 1, error: opts.rpcError }, opts.rpcStatus ?? 200);
      }
      return makeResp({ jsonrpc: "2.0", id: 1, result: opts.rpcResult }, opts.rpcStatus ?? 200);
    }
    return makeResp({}, 404);
  };
}

function makeResp(body: any, status: number): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-a2a-client-"));
}

describe("client", () => {
  let originalFetch: typeof globalThis.fetch;
  let piDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    piDir = tmpDir();
    metrics.reset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch as any;
  });

  describe("rpcUrl", () => {
    it("prefers the card's JSONRPC interface url", () => {
      const card = buildAgentCard({ name: "x", url: "http://h/" });
      card.supportedInterfaces[0]!.url = "http://h/rpc";
      assert.equal(rpcUrl("http://h/", card), "http://h/rpc");
    });
    it("falls back to the card top-level url", () => {
      const card = buildAgentCard({ name: "x", url: "http://h/" });
      assert.equal(rpcUrl("http://h/", card), "http://h/");
    });
    it("falls back to the base url with no card", () => {
      assert.equal(rpcUrl("http://h/", null), "http://h");
    });
  });

  describe("a2aDiscover", () => {
    it("summarizes a v1.0 card", async () => {
      const card = buildAgentCard({
        name: "researcher",
        url: "http://localhost:9900/",
        description: "a research agent",
        skills: [{ id: "s", name: "research", description: "web research" }],
      });
      globalThis.fetch = mockFetch({ card }) as any;
      const cfg = DEFAULTS();
      const out = await a2aDiscover({ cfg, url: "http://localhost:9900" });
      assert.include(out, "Agent: researcher");
      assert.include(out, "research");
    });

    it("falls back to legacy agent.json on 404", async () => {
      const legacyCard = buildAgentCard({ name: "legacy", url: "http://l/" });
      globalThis.fetch = mockFetch({ cardStatus: 404, legacyCard }) as any;
      const out = await a2aDiscover({ cfg: DEFAULTS(), url: "http://l" });
      assert.include(out, "Agent: legacy");
    });

    it("reports discovery failure on connection error", async () => {
      globalThis.fetch = (async () => {
        throw new Error("ECONNREFUSED");
      }) as any;
      const out = await a2aDiscover({ cfg: DEFAULTS(), url: "http://nope" });
      assert.include(out, "Error");
    });
  });

  describe("a2aCall", () => {
    it("attaches X-Gateway-Caller on gateway-proxied calls", async () => {
      const result = { task: { id: "t", contextId: "c", status: { state: STATE_COMPLETED }, artifacts: [{ parts: [{ text: "ok" }] }] } };
      let seenHeaders: Record<string, string> = {};
      globalThis.fetch = (async (url: string, init?: any) => {
        seenHeaders = { ...(init?.headers || {}) };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
        };
      }) as any;
      const cfg = DEFAULTS();
      cfg.selfIdentity = "pi-s2-9912";
      cfg.peers.bob = { url: "http://127.0.0.1:9920/peer/bob/", auth: { type: "bearer", token: "gw-token" }, timeout: 5000, capabilities: [], viaGateway: true };
      const out = await a2aCall({ cfg, piDir, agent: "bob", message: "hi" });
      assert.include(out, "ok");
      assert.equal(seenHeaders["X-Gateway-Caller"], "pi-s2-9912");
    });

    it("omits X-Gateway-Caller for non-gateway peers", async () => {
      const result = { task: { id: "t", contextId: "c", status: { state: STATE_COMPLETED }, artifacts: [{ parts: [{ text: "ok" }] }] } };
      let seenHeaders: Record<string, string> = {};
      globalThis.fetch = (async (_url: string, init?: any) => {
        seenHeaders = { ...(init?.headers || {}) };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
        };
      }) as any;
      const cfg = DEFAULTS();
      cfg.selfIdentity = "pi-s2-9912";
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      await a2aCall({ cfg, piDir, agent: "bob", message: "hi" });
      assert.isUndefined(seenHeaders["X-Gateway-Caller"]);
    });

    it("falls back to the runtime gateway registration name for X-Gateway-Caller", async () => {
      const result = { task: { id: "t", contextId: "c", status: { state: STATE_COMPLETED }, artifacts: [{ parts: [{ text: "ok" }] }] } };
      let seenHeaders: Record<string, string> = {};
      globalThis.fetch = (async (url: string, init?: any) => {
        seenHeaders = { ...(init?.headers || {}) };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
        };
      }) as any;
      const cfg = DEFAULTS();
      cfg.selfIdentity = ""; // no operator-pinned identity
      cfg.discovery.gateway = { enabled: true, url: "http://127.0.0.1:9920", token: "gw-token" };
      cfg.peers.bob = { url: "http://127.0.0.1:9920/peer/bob/", auth: { type: "bearer", token: "gw-token" }, timeout: 5000, capabilities: [], viaGateway: true };
      // Single configured gateway → its registration name (derived key) is the
      // fallback for unlabeled viaGateway peers.
      setGatewayRegistrationName("pi-9910", gatewayKeyFromUrl("http://127.0.0.1:9920"));
      try {
        const out = await a2aCall({ cfg, piDir, agent: "bob", message: "hi" });
        assert.include(out, "ok");
        assert.equal(seenHeaders["X-Gateway-Caller"], "pi-9910");
      } finally {
        setGatewayRegistrationName(null, gatewayKeyFromUrl("http://127.0.0.1:9920"));
      }
    });

    it("sends a task and returns the reply (wrapped {task} result)", async () => {
      const result = {
        task: {
          id: "t1",
          contextId: "ctx-1",
          status: { state: STATE_COMPLETED },
          artifacts: [{ parts: [{ text: "the answer" }] }],
        },
      };
      globalThis.fetch = mockFetch({ rpcResult: result }) as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aCall({ cfg, piDir, agent: "bob", message: "hi" });
      assert.include(out, "context ctx-1");
      assert.include(out, "completed");
      assert.include(out, "the answer");
    });

    it("extracts from a bare message result", async () => {
      const result = {
        message: { role: "ROLE_AGENT", parts: [{ text: "direct reply" }] },
      };
      globalThis.fetch = mockFetch({ rpcResult: result }) as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aCall({ cfg, piDir, agent: "bob", message: "hi" });
      assert.include(out, "direct reply");
    });

    it("surfaces INPUT_REQUIRED with a context hint", async () => {
      const result = {
        task: {
          id: "t2",
          contextId: "ctx-2",
          status: { state: "TASK_STATE_INPUT_REQUIRED", message: { parts: [{ text: "need more" }] } },
        },
      };
      globalThis.fetch = mockFetch({ rpcResult: result }) as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aCall({ cfg, piDir, agent: "bob", message: "hi" });
      assert.include(out, "input-required");
      assert.include(out, "context_id 'ctx-2'");
    });

    it("returns a clear error for an unknown agent", async () => {
      const out = await a2aCall({ cfg: DEFAULTS(), piDir, agent: "ghost", message: "hi" });
      assert.include(out, "unknown agent 'ghost'");
    });

    it("surfaces peer auth rejection (401)", async () => {
      globalThis.fetch = mockFetch({ rpcStatus: 401 }) as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aCall({ cfg, piDir, agent: "bob", message: "hi" });
      assert.include(out, "rejected auth");
    });

    it("redacts credentials before sending", async () => {
      let capturedBody = "";
      globalThis.fetch = (async (_url: string, init?: any) => {
        capturedBody = init?.body ?? "";
        return makeResp(
          { jsonrpc: "2.0", id: 1, result: { message: { parts: [{ text: "ok" }] } } },
          200,
        );
      }) as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      await a2aCall({ cfg, piDir, agent: "bob", message: "my key is sk-1234567890abcdefXX" });
      assert.notInclude(capturedBody, "sk-1234567890abcdefXX");
      assert.include(capturedBody, "sk-[redacted]");
    });
  });

  describe("a2aOrchestrate", () => {
    it("fans out to matching peers (mode all)", async () => {
      let posts = 0;
      globalThis.fetch = (async (_url: string, init?: any) => {
        if (init?.method === "POST") posts++;
        return makeResp(
          {
            jsonrpc: "2.0",
            id: 1,
            result: { message: { parts: [{ text: `reply ${posts}` }] } },
          },
          200,
        );
      }) as any;
      const cfg = DEFAULTS();
      cfg.peers.a = { url: "http://a", auth: { type: "none" }, timeout: 5000, capabilities: ["research"] };
      cfg.peers.b = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: ["research"] };
      cfg.peers.c = { url: "http://c", auth: { type: "none" }, timeout: 5000, capabilities: ["coding"] };
      const out = await a2aOrchestrate({ cfg, piDir, capability: "research", message: "go" });
      assert.equal(posts, 2, "only the 2 research-capable peers called");
      assert.include(out, "2/2");
    });

    it("returns a message when no peers match", async () => {
      const out = await a2aOrchestrate({ cfg: DEFAULTS(), piDir, capability: "x", message: "go" });
      assert.include(out, "No configured peers advertise capability");
    });

    it("reports failures when all peers error", async () => {
      globalThis.fetch = (async () => makeResp({}, 500)) as any;
      const cfg = DEFAULTS();
      cfg.peers.a = { url: "http://a", auth: { type: "none" }, timeout: 5000, capabilities: ["research"] };
      const out = await a2aOrchestrate({ cfg, piDir, capability: "research", message: "go" });
      assert.include(out, "fail");
    });
  });

  describe("SSRF guard", () => {
    it("blocks cloud-metadata endpoint", async () => {
      const cfg = DEFAULTS();
      cfg.peers.meta = { url: "http://169.254.169.254/latest", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aCall({ cfg, piDir, agent: "meta", message: "hi" });
      assert.include(out, "SSRF");
    });

    it("blocks IPv4-mapped IPv6 SSRF bypass", async () => {
      const cfg = DEFAULTS();
      cfg.peers.meta6 = { url: "http://[::ffff:169.254.169.254]/latest", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aCall({ cfg, piDir, agent: "meta6", message: "hi" });
      assert.include(out, "SSRF");
    });

    it("blocks IPv6 link-local and ULA", async () => {
      assert.isTrue(isPrivateHost(new URL("http://[fe80::1]/").hostname));
      assert.isTrue(isPrivateHost(new URL("http://[fc00::1]/").hostname));
      assert.isTrue(isPrivateHost(new URL("http://[fd12:3456::1]/").hostname));
    });

    it("blocks hex-form IPv4-mapped IPv6 (Node canonicalizes to this)", async () => {
      // Node's URL parser turns ::ffff:169.254.169.254 into ::ffff:a9fe:a9fe.
      assert.isTrue(isPrivateHost("::ffff:a9fe:a9fe")); // 169.254.169.254
      assert.isTrue(isPrivateHost("::ffff:0a00:0001")); // 10.0.0.1
      assert.isTrue(isPrivateHost("::ffff:c0a8:0101")); // 192.168.1.1
      assert.isFalse(isPrivateHost("::ffff:7f00:0001")); // 127.0.0.1 loopback allowed
    });

    it("allows loopback (IPv4 + IPv6 ::1) for local peers", async () => {
      assert.isFalse(isPrivateHost("127.0.0.1"));
      assert.isFalse(isPrivateHost(new URL("http://[::1]/").hostname));
    });

    it("blocks private RFC 1918 ranges", async () => {
      const cfg = DEFAULTS();
      cfg.peers.internal = { url: "http://10.0.0.1:9900", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aCall({ cfg, piDir, agent: "internal", message: "hi" });
      assert.include(out, "SSRF");
    });

    it("allows localhost (loopback) for local peers", async () => {
      // Should NOT throw SSRF — may fail on connection, but not with SSRF.
      const cfg = DEFAULTS();
      cfg.peers.local = { url: "http://127.0.0.1:9999", auth: { type: "none" }, timeout: 1000, capabilities: [] };
      const out = await a2aCall({ cfg, piDir, agent: "local", message: "hi" });
      assert.notInclude(out, "SSRF");
    });
  });

  describe("conversation persistence (single context)", () => {
    it("persists user + agent reply under the SAME contextId", async () => {
      const { loadConversation } = await import("../lib/persistence");
      globalThis.fetch = (async () =>
        makeResp(
          {
            jsonrpc: "2.0",
            id: 1,
            result: { task: { id: "t1", contextId: "ctx-xyz", status: { state: STATE_COMPLETED }, artifacts: [{ parts: [{ text: "reply body" }] }] } },
          },
          200,
        )) as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://127.0.0.1:9900", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aCall({ cfg, piDir, agent: "bob", message: "my question" });
      // The returned context must be the peer's ctx-xyz.
      assert.include(out, "ctx-xyz");
      // And BOTH messages live under ctx-xyz.
      const msgs = loadConversation(piDir, "ctx-xyz");
      assert.lengthOf(msgs, 2);
      assert.equal(msgs[0]!.role, "user");
      assert.equal(msgs[0]!.text, "my question");
      assert.equal(msgs[1]!.role, "agent");
      assert.equal(msgs[1]!.text, "reply body");
    });
  });
});
