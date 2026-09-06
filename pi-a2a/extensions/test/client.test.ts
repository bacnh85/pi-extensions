import { assert } from "chai";

import { DEFAULTS } from "./helpers";
import { makeTempDir } from "./tmp";
import {
  a2aCall,
  a2aDiscover,
  a2aList,
  a2aOrchestrate,
  a2aStatus,
  isPrivateHost,
  metrics,
  rpcUrl,
} from "../lib/client";
import { buildAgentCard, STATE_COMPLETED, STATE_WORKING } from "../lib/protocol";
import { setGatewayRegistrationName, setGatewayPeers, gatewayKeyFromUrl } from "../lib/config";
import type { DiscoveredPeer } from "../lib/discovery";

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
  return makeTempDir("pi-a2a-client-");
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

    it("sends the asserted X-A2A-Identity header from selfIdentity", async () => {
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
      cfg.selfIdentity = "pi-kimchi";
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aCall({ cfg, piDir, agent: "bob", message: "hi" });
      assert.include(out, "ok");
      assert.equal(seenHeaders["X-A2A-Identity"], "pi-kimchi");
    });

    it("falls back to server.agentName for X-A2A-Identity", async () => {
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
      cfg.server.agentName = "pi-bingsu"; // selfIdentity unset
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      await a2aCall({ cfg, piDir, agent: "bob", message: "hi" });
      assert.equal(seenHeaders["X-A2A-Identity"], "pi-bingsu");
    });

    it("omits X-A2A-Identity when no identity is configured", async () => {
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
      const cfg = DEFAULTS(); // selfIdentity and server.agentName both ""
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      await a2aCall({ cfg, piDir, agent: "bob", message: "hi" });
      assert.isUndefined(seenHeaders["X-A2A-Identity"]);
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

    it("calls a discovered peer by name", async () => {
      let postUrl = "";
      globalThis.fetch = (async (url: string, init?: any) => {
        if (init?.method === "POST") postUrl = String(url);
        return makeResp(
          { jsonrpc: "2.0", id: 1, result: { message: { parts: [{ text: "pong" }] } } },
          200,
        );
      }) as any;
      const discoveredPeers: DiscoveredPeer[] = [
        { name: "pi-solo", url: "http://127.0.0.1:9912", source: "local", alive: true },
      ];
      const out = await a2aCall({ cfg: DEFAULTS(), piDir, agent: "pi-solo", message: "hi", discoveredPeers });
      assert.include(out, "pong");
      assert.include(postUrl, "127.0.0.1:9912");
    });

    it("errors with candidate URLs for an ambiguous discovered name", async () => {
      const discoveredPeers: DiscoveredPeer[] = [
        { name: "pi-s2", url: "http://127.0.0.1:9912", source: "local", alive: true },
        { name: "pi-s2", url: "http://127.0.0.1:9913", source: "local", alive: true },
      ];
      const out = await a2aCall({ cfg: DEFAULTS(), piDir, agent: "pi-s2", message: "hi", discoveredPeers });
      assert.include(out, "share the name 'pi-s2'");
      assert.include(out, "9912");
      assert.include(out, "9913");
    });

    it("does not attach a bearer token to a discovered peer outside the known set", async () => {
      let auth = "";
      globalThis.fetch = (async (_url: string, init?: any) => {
        if (init?.method === "POST") auth = String(init?.headers?.Authorization ?? "");
        return makeResp({ jsonrpc: "2.0", id: 1, result: { message: { parts: [{ text: "pong" }] } } }, 200);
      }) as any;
      const cfg = DEFAULTS();
      cfg.server = { ...cfg.server, peerTokens: { anon: "secret-token" } } as any;
      const discoveredPeers: DiscoveredPeer[] = [
        // loopback URL but NOT in the local registry (unknown → no credential)
        { name: "rogue", url: "http://127.0.0.1:9999", source: "local", alive: true },
      ];
      await a2aCall({ cfg, piDir, agent: "rogue", message: "hi", discoveredPeers });
      assert.notInclude(auth, "secret-token");
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

  describe("non-blocking dispatch (asyncDispatch + a2a_status)", () => {
    const workingTask = {
      id: "task-9",
      contextId: "ctx-async",
      status: { state: STATE_WORKING },
    };
    const completedTask = {
      id: "task-9",
      contextId: "ctx-async",
      status: { state: STATE_COMPLETED },
      artifacts: [{ parts: [{ text: "late result" }] }],
    };

    /** Sequential POST-result mock: each POST returns the next entry (last
     *  one repeats). GETs (card fetch) 404 — non-fatal, rpcUrl falls back to
     *  the base URL. */
    function seqMock(results: any[]): { fetch: FetchMock; posts: () => number } {
      let i = 0;
      let n = 0;
      const fetch = async (url: string, init?: any) => {
        if (init?.method === "POST") {
          n += 1;
          const result = results[Math.min(i++, results.length - 1)];
          return makeResp({ jsonrpc: "2.0", id: 1, result }, 200);
        }
        return makeResp(null, 404);
      };
      return { fetch, posts: () => n };
    }

    it("sends configuration.returnImmediately only when asyncDispatch is set", async () => {
      const bodies: any[] = [];
      globalThis.fetch = (async (_url: string, init?: any) => {
        if (init?.method === "POST") bodies.push(JSON.parse(init.body));
        return makeResp({ jsonrpc: "2.0", id: 1, result: { task: workingTask } }, 200);
      }) as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      await a2aCall({ cfg, piDir, agent: "bob", message: "hi", asyncDispatch: true });
      await a2aCall({ cfg, piDir, agent: "bob", message: "hi" });
      assert.equal(bodies[0]!.params.configuration?.returnImmediately, true, "asyncDispatch must set the configuration");
      assert.isUndefined(bodies[1]!.params.configuration, "a blocking call must not send any configuration");
    });

    it("formats the detached ack with the poll hint", async () => {
      globalThis.fetch = mockFetch({ rpcResult: { task: workingTask } }) as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aCall({ cfg, piDir, agent: "bob", message: "hi", asyncDispatch: true });
      assert.include(out, "detached");
      assert.include(out, "task-9");
      assert.include(out, "non-blocking");
      assert.include(out, 'a2a_status(agent: "bob", task_id: "task-9")');
      assert.notInclude(out, "late result");
    });

    it("falls through to normal formatting when the task finished before the ack", async () => {
      // A fast peer completes before the ack is serialized — the ack carries
      // the terminal state, so the caller gets the result inline, no poll hint.
      globalThis.fetch = mockFetch({ rpcResult: { task: completedTask } }) as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aCall({ cfg, piDir, agent: "bob", message: "hi", asyncDispatch: true });
      assert.include(out, "completed");
      assert.include(out, "late result");
      assert.notInclude(out, "detached");
      assert.notInclude(out, "a2a_status(");
    });

    it("persists the dispatch ack marker under the conversation context", async () => {
      const { loadConversation } = await import("../lib/persistence");
      globalThis.fetch = mockFetch({ rpcResult: { task: workingTask } }) as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      await a2aCall({ cfg, piDir, agent: "bob", message: "hi", asyncDispatch: true });
      // Both sides land under the PEER's context id so a2a_history works.
      const msgs = loadConversation(piDir, "ctx-async");
      assert.lengthOf(msgs, 2);
      assert.equal(msgs[0]!.role, "user");
      assert.equal(msgs[1]!.role, "agent");
      assert.include(msgs[1]!.text, "dispatched non-blocking");
      assert.include(msgs[1]!.text, "task-9");
    });

    it("a2a_status: single fetch without wait_seconds", async () => {
      const m = seqMock([{ task: workingTask }]);
      globalThis.fetch = m.fetch as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aStatus({ cfg, piDir, agent: "bob", taskId: "task-9" });
      assert.equal(m.posts(), 1, "no wait_seconds → exactly one GetTask");
      assert.include(out, "task-9");
      assert.include(out, "working");
      assert.include(out, "no text yet");
    });

    it("a2a_status: polls to terminal with wait_seconds", async () => {
      const m = seqMock([{ task: workingTask }, { task: completedTask }]);
      globalThis.fetch = m.fetch as any;
      const cfg = DEFAULTS();
      cfg.timeouts.async = 250; // min poll interval for a fast test
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aStatus({ cfg, piDir, agent: "bob", taskId: "task-9", waitSeconds: 5 });
      assert.equal(m.posts(), 2, "WORKING then COMPLETED → exactly two GetTask polls");
      assert.include(out, "completed");
      assert.include(out, "late result");
    });

    it("a2a_status: expires with a clear message at the deadline", async () => {
      const m = seqMock([{ task: workingTask }]);
      globalThis.fetch = m.fetch as any;
      const cfg = DEFAULTS();
      cfg.timeouts.async = 250;
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aStatus({ cfg, piDir, agent: "bob", taskId: "task-9", waitSeconds: 0.3 });
      assert.include(out, "Still non-terminal after 0.3s of polling");
      assert.include(out, "call a2a_status again later");
    });

    it("a2a_status: non-positive wait_seconds is a single fetch (no nonsense deadline)", async () => {
      const m = seqMock([{ task: workingTask }]);
      globalThis.fetch = m.fetch as any;
      const cfg = DEFAULTS();
      cfg.timeouts.async = 250;
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aStatus({ cfg, piDir, agent: "bob", taskId: "task-9", waitSeconds: -5 });
      assert.equal(m.posts(), 1, "negative wait_seconds must not enter the poll loop");
      assert.notInclude(out, "-5s");
      assert.include(out, "working");
    });

    it("a2a_status: maps TaskNotFoundError (-32001) to the unknown/evicted/foreign hint", async () => {
      globalThis.fetch = mockFetch({ rpcError: { code: -32001, message: "task not found" } }) as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aStatus({ cfg, piDir, agent: "bob", taskId: "task-ghost" });
      assert.include(out, "does not know task 'task-ghost'");
      assert.include(out, "visible only to the identity that sent them");
    });

    it("a2a_status: maps 401 to the auth error", async () => {
      globalThis.fetch = mockFetch({ rpcStatus: 401 }) as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const out = await a2aStatus({ cfg, piDir, agent: "bob", taskId: "task-9" });
      assert.include(out, "rejected auth");
    });

    it("a2a_status: errors with candidate URLs for an ambiguous discovered name", async () => {
      const discoveredPeers: DiscoveredPeer[] = [
        { name: "pi-s2", url: "http://127.0.0.1:9912", source: "local", alive: true },
        { name: "pi-s2", url: "http://127.0.0.1:9913", source: "local", alive: true },
      ];
      const out = await a2aStatus({ cfg: DEFAULTS(), piDir, agent: "pi-s2", taskId: "task-9", discoveredPeers });
      assert.include(out, "share the name 'pi-s2'");
      assert.include(out, "9912");
      assert.include(out, "9913");
    });

    it("a2a_status: cancels promptly when the abort signal fires mid-poll", async () => {
      const m = seqMock([{ task: workingTask }]);
      globalThis.fetch = m.fetch as any;
      const cfg = DEFAULTS();
      cfg.timeouts.async = 250;
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 120);
      const t0 = Date.now();
      const out = await a2aStatus({
        cfg,
        piDir,
        agent: "bob",
        taskId: "task-9",
        waitSeconds: 30, // would poll ~2min at 250ms without the signal
        signal: ctl.signal,
      });
      const elapsed = Date.now() - t0;
      assert.isBelow(elapsed, 2000, `abort must end the poll promptly (took ${elapsed}ms)`);
      assert.include(out, "Status polling canceled");
      assert.include(out, "call a2a_status");
      // The last-known state is still reported — the abort only stops polling.
      assert.include(out, "working");
    });

    it("a2a_status: returns immediately on a pre-aborted signal (no fetch)", async () => {
      const m = seqMock([{ task: workingTask }]);
      globalThis.fetch = m.fetch as any;
      const cfg = DEFAULTS();
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      const ctl = new AbortController();
      ctl.abort();
      const out = await a2aStatus({
        cfg,
        piDir,
        agent: "bob",
        taskId: "task-9",
        waitSeconds: 30,
        signal: ctl.signal,
      });
      assert.equal(m.posts(), 0, "a pre-aborted poll must not fetch at all");
      assert.include(out, "Status polling canceled");
      assert.include(out, "task-9");
    });

    it("carries X-A2A-Identity on SendMessage AND on GetTask polls", async () => {
      const seen: Array<Record<string, string>> = [];
      globalThis.fetch = (async (url: string, init?: any) => {
        if (init?.method === "POST") {
          seen.push({ ...(init?.headers || {}) });
          const isGetTask = JSON.parse(init.body).method === "GetTask";
          return makeResp(
            { jsonrpc: "2.0", id: 1, result: { task: isGetTask ? completedTask : workingTask } },
            200,
          );
        }
        return makeResp(null, 404);
      }) as any;
      const cfg = DEFAULTS();
      cfg.selfIdentity = "pi-kimchi";
      cfg.peers.bob = { url: "http://b", auth: { type: "none" }, timeout: 5000, capabilities: [] };
      await a2aCall({ cfg, piDir, agent: "bob", message: "hi", asyncDispatch: true });
      await a2aStatus({ cfg, piDir, agent: "bob", taskId: "task-9" });
      assert.equal(seen.length, 2, "one SendMessage + one GetTask");
      assert.equal(seen[0]!["X-A2A-Identity"], "pi-kimchi", "SendMessage carries the identity");
      assert.equal(seen[1]!["X-A2A-Identity"], "pi-kimchi", "GetTask polls carry the identity too");
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
      assert.include(out, "No peers advertise capability");
    });

    it("fans out to gateway peers advertising the capability", async () => {
      let gwPost = 0;
      globalThis.fetch = (async (url: string, init?: any) => {
        if (init?.method === "POST" && String(url).includes("gw-proxy")) gwPost++;
        return makeResp(
          { jsonrpc: "2.0", id: 1, result: { message: { parts: [{ text: "gw reply" }] } } },
          200,
        );
      }) as any;
      setGatewayPeers({
        "gw/remote/x": { url: "http://gw-proxy/peer/x/", auth: { type: "bearer", token: "t" }, timeout: 5000, capabilities: ["coding"], viaGateway: true },
      });
      try {
        const out = await a2aOrchestrate({ cfg: DEFAULTS(), piDir, capability: "coding", message: "go" });
        assert.equal(gwPost, 1, "gateway peer called at its proxy URL");
        assert.include(out, "gw/remote/x");
      } finally {
        setGatewayPeers({});
      }
    });

    it("configured peer with the same capability wins over gateway-only entries", async () => {
      let posts = 0;
      globalThis.fetch = (async (_url: string, init?: any) => {
        if (init?.method === "POST") posts++;
        return makeResp({ jsonrpc: "2.0", id: 1, result: { message: { parts: [{ text: "ok" }] } } }, 200);
      }) as any;
      const cfg = DEFAULTS();
      cfg.peers.local = { url: "http://a", auth: { type: "none" }, timeout: 5000, capabilities: ["coding"] };
      setGatewayPeers({
        "gw/remote/local": { url: "http://gw-proxy/peer/local/", auth: { type: "bearer", token: "t" }, timeout: 5000, capabilities: ["coding"], viaGateway: true },
      });
      try {
        const out = await a2aOrchestrate({ cfg, piDir, capability: "coding", message: "go" });
        assert.equal(posts, 1, "merged by name — one entry, not two");
        assert.include(out, "local");
      } finally {
        setGatewayPeers({});
      }
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

  describe("a2aList", () => {
    it("shows up to 20 tools with a +N more suffix", () => {
      const tools = Array.from({ length: 25 }, (_, i) => `tool_${i}`);
      const out = a2aList({
        cfg: DEFAULTS(),
        piDir,
        discoveredPeers: [{ name: "big", url: "http://127.0.0.1:1/", source: "local", tools }],
      });
      assert.include(out, "tool_19");
      assert.include(out, "(+5 more)");
      assert.notInclude(out, "tool_20");
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
