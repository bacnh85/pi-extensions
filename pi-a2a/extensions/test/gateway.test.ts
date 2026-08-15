/**
 * Gateway peer discovery — merge, self-filter, overlay routing.
 *
 * Directory shape (agent-gateway GET /.well-known/agent.json, authed):
 *   { peers: [{ name, url: "/peer/<name>/", healthy, capabilities, skills }] }
 */

import { assert } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULTS } from "./helpers";
import { GatewayUpstream, isSelfEntry, mergeGatewayPeers } from "../lib/gateway";
import { resolvePeer, setGatewayPeers, type Peer } from "../lib/config";
import { a2aCall, metrics } from "../lib/client";

const GW = "http://127.0.0.1:9920";
const TOKEN = "gw-secret-token";

function merge(
  entries: unknown[],
  self: { name: string; url: string; autoName?: string } = { name: "pi-s2-9910", url: "http://127.0.0.1:9910" },
) {
  return mergeGatewayPeers({
    gatewayUrl: GW,
    token: TOKEN,
    selfName: self.name,
    selfUrl: self.url,
    selfAutoName: self.autoName,
    entries,
    timeoutMs: 120_000,
  });
}

function makeResp(body: any, status: number): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("gateway peer discovery", () => {
  describe("mergeGatewayPeers", () => {
    it("merges peers as gw/<name> with proxy URL and gateway bearer auth", () => {
      const out = merge([
        { name: "pi-s2-9912", url: "/peer/pi-s2-9912/", healthy: true, capabilities: ["web_search"] },
      ]);
      assert.deepEqual(Object.keys(out), ["gw/pi-s2-9912"]);
      const p = out["gw/pi-s2-9912"]!;
      assert.equal(p.url, "http://127.0.0.1:9920/peer/pi-s2-9912/");
      assert.deepEqual(p.auth, { type: "bearer", token: TOKEN });
      assert.deepEqual(p.capabilities, ["web_search"]);
      assert.isTrue(p.viaGateway);
    });

    it("skips self by registered name", () => {
      const out = merge([
        { name: "pi-s2-9910", url: "/peer/pi-s2-9910/", healthy: true }, // self
        { name: "pi-s2-9912", url: "/peer/pi-s2-9912/", healthy: true },
      ]);
      assert.deepEqual(Object.keys(out), ["gw/pi-s2-9912"]);
    });

    it("skips self by publicUrl port suffix (renamed session, stale auto-named entry)", () => {
      const out = merge(
        [
          { name: "pi-main", url: "/peer/pi-main/", healthy: true }, // self (pinned name)
          { name: "pi-s2-9910", url: "/peer/pi-s2-9910/", healthy: true }, // our stale auto-name
          { name: "pi-s2-9912", url: "/peer/pi-s2-9912/", healthy: true },
        ],
        { name: "pi-main", url: "http://127.0.0.1:9910", autoName: "pi-s2-9910" },
      );
      assert.deepEqual(Object.keys(out), ["gw/pi-s2-9912"]);
    });

    it("isSelfEntry also matches an absolute publicUrl", () => {
      assert.isTrue(
        isSelfEntry(
          { name: "other", url: "http://10.1.2.3:9910/" },
          { name: "pi-main", url: "http://10.1.2.3:9910" },
        ),
      );
      assert.isFalse(
        isSelfEntry(
          { name: "other", url: "http://10.1.2.3:9911/" },
          { name: "pi-main", url: "http://10.1.2.3:9910" },
        ),
      );
    });

    it("skips unhealthy peers, keeps unknown (null) health", () => {
      const out = merge([
        { name: "dead", url: "/peer/dead/", healthy: false },
        { name: "unknown", url: "/peer/unknown/", healthy: null },
        { name: "alive", url: "/peer/alive/" },
      ]);
      assert.deepEqual(Object.keys(out).sort(), ["gw/alive", "gw/unknown"]);
    });

    it("drops absolute/cross-origin urls (bearer token must only reach the gateway)", () => {
      const out = merge([
        { name: "evil", url: "http://attacker.example/peer/evil/", healthy: true },
        { name: "ok", url: "/peer/ok/", healthy: true },
      ]);
      assert.deepEqual(Object.keys(out), ["gw/ok"]);
    });

    it("cross-host same-port peer is NOT filtered (regression: bare -port suffix rule)", () => {
      const out = merge(
        [{ name: "other-host-9910", url: "/peer/other-host-9910/", healthy: true }],
        { name: "pi-main", url: "http://10.0.0.2:9910", autoName: "pi-main-9910" },
      );
      assert.deepEqual(Object.keys(out), ["gw/other-host-9910"]);
    });

    it("own auto-name entry IS filtered by exact match", () => {
      const out = merge(
        [{ name: "pi-main-9910", url: "/peer/pi-main-9910/", healthy: true }],
        { name: "pi-main", url: "http://10.0.0.2:9910", autoName: "pi-main-9910" },
      );
      assert.deepEqual(Object.keys(out), []);
    });

    it("surfaces skill names when capabilities is absent or an object", () => {
      const out = merge([
        { name: "a", url: "/peer/a/", healthy: true, capabilities: { streaming: true }, skills: [{ id: "coding", name: "coding" }] },
        { name: "b", url: "/peer/b/", healthy: true, skills: [{ id: "research" }] },
      ]);
      assert.deepEqual(out["gw/a"]!.capabilities, ["coding"]);
      assert.deepEqual(out["gw/b"]!.capabilities, ["research"]);
    });

    it("gw-peer timeout comes from callTimeoutMs, not heartbeatSec (regression)", () => {
      const out = mergeGatewayPeers({
        gatewayUrl: GW,
        token: TOKEN,
        selfName: "s",
        selfUrl: "http://127.0.0.1:9910",
        entries: [{ name: "p", url: "/peer/p/", healthy: true }],
        timeoutMs: 120_000,
      });
      assert.equal(out["gw/p"]!.timeout, 120_000);
    });

    it("drops malformed entries and tolerates a non-array peers field", () => {
      assert.deepEqual(merge([{ url: "/peer/x/" }, { name: "a/b", url: "/x" }, { name: "no-url" }, null]), {});
      assert.deepEqual(merge("not-an-array" as any), {});
    });
  });

  describe("GatewayUpstream heartbeat → directory refresh", () => {
    let originalFetch: typeof globalThis.fetch;
    let calls: Array<{ method: string; url: string; auth?: string }>;
    let overlay: Record<string, Peer>;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      calls = [];
      overlay = {};
      globalThis.fetch = (async (url: any, init?: any) => {
        calls.push({
          method: init?.method || "GET",
          url: String(url),
          auth: init?.headers?.authorization,
        });
        const u = String(url);
        if (u.endsWith("/register")) return makeResp({ status: "updated" }, 200);
        if (u.endsWith("/.well-known/agent.json")) {
          return makeResp(
            {
              peers: [
                { name: "pi-s2-9912", url: "/peer/pi-s2-9912/", healthy: true },
                { name: "self-1", url: "/peer/self-1/", healthy: true },
                { name: "dead", url: "/peer/dead/", healthy: false },
              ],
            },
            200,
          );
        }
        return makeResp({}, 404);
      }) as any;
    });
    afterEach(() => {
      globalThis.fetch = originalFetch as any;
      setGatewayPeers({});
    });

    it("fetches the directory after registering and emits the merged overlay", async () => {
      const gw = new GatewayUpstream(
        { url: GW, token: TOKEN, name: "self-1", heartbeatSec: 60 },
        () => ({}),
        () => {},
        (peers) => (overlay = peers),
      );
      const ok = await gw.start("http://127.0.0.1:9911");
      assert.isTrue(ok);
      // Snapshot BEFORE stop — stop() clears the overlay by design.
      const snapshot = { ...overlay };
      await gw.stop();
      const dir = calls.find((c) => c.url.endsWith("/.well-known/agent.json"))!;
      assert.equal(dir.method, "GET");
      assert.equal(dir.auth, `Bearer ${TOKEN}`);
      assert.deepEqual(Object.keys(snapshot), ["gw/pi-s2-9912"]); // self + dead filtered
      assert.equal(snapshot["gw/pi-s2-9912"]!.url, "http://127.0.0.1:9920/peer/pi-s2-9912/");
      assert.deepEqual(overlay, {}); // cleared on stop
    });

    it("clears the overlay on stop and on a failed start", async () => {
      const gw = new GatewayUpstream(
        { url: GW, token: TOKEN, name: "self-1" },
        () => ({}),
        () => {},
        (peers) => (overlay = peers),
      );
      assert.isTrue(await gw.start("http://127.0.0.1:9911"));
      assert.isNotEmpty(overlay);
      await gw.stop();
      assert.deepEqual(overlay, {});

      // Failed start (gateway refusing registrations) must clear stale state.
      globalThis.fetch = (async () => makeResp({ error: "unauthorized" }, 401)) as any;
      assert.isFalse(await gw.start("http://127.0.0.1:9911"));
      assert.deepEqual(overlay, {});
    });
  });

  describe("outbound overlay routing", () => {
    it("a2a_call('gw/…') works when the gateway is on a LAN/private IP (SSRF guard must not fire)", async () => {
      const lanPeers = mergeGatewayPeers({
        gatewayUrl: "http://192.168.1.50:9920",
        token: TOKEN,
        selfName: "s",
        selfUrl: "http://127.0.0.1:9910",
        entries: [{ name: "p", url: "/peer/p/", healthy: true }],
        timeoutMs: 120_000,
      });
      setGatewayPeers(lanPeers);
      const of = globalThis.fetch;
      const seen: string[] = [];
      globalThis.fetch = (async (u: any) => {
        seen.push(String(u));
        return makeResp(
          { jsonrpc: "2.0", id: 1, result: { message: { role: "ROLE_AGENT", parts: [{ text: "lan ok" }] } } },
          200,
        );
      }) as any;
      const piDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-a2a-lan-"));
      const out = await a2aCall({ cfg: { ...DEFAULTS(), discovery: { ...(DEFAULTS() as any).discovery, gateway: { url: "http://192.168.1.50:9920", token: TOKEN } } } as any, piDir: piDir2, agent: "gw/p", message: "hi" });
      globalThis.fetch = of as any;
      assert.include(out, "lan ok");
      assert.equal(seen.filter((u) => u.startsWith("http://192.168.1.50:9920/peer/p")).length, 1);
    });

    let originalFetch: typeof globalThis.fetch;
    let piDir: string;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-a2a-gateway-"));
      metrics.reset();
    });
    afterEach(() => {
      globalThis.fetch = originalFetch as any;
      setGatewayPeers({});
    });

    it("resolvePeer routes gw/<name> via the overlay; static peers win on collision", () => {
      setGatewayPeers(
        merge([{ name: "pi-s2-9912", url: "/peer/pi-s2-9912/", healthy: true }]),
      );
      const cfg = DEFAULTS();
      const p = resolvePeer(cfg, "gw/pi-s2-9912");
      assert.equal(p?.url, "http://127.0.0.1:9920/peer/pi-s2-9912/");
      assert.equal(p?.auth.type, "bearer");
      assert.equal(p?.auth.token, TOKEN);

      cfg.peers["gw/static"] = {
        url: "http://static",
        auth: { type: "none" },
        timeout: 1000,
        capabilities: [],
      };
      setGatewayPeers({ "gw/static": { url: "http://overlay", auth: { type: "none" }, timeout: 1000, capabilities: [] } });
      assert.equal(resolvePeer(cfg, "gw/static")?.url, "http://static");
      assert.isNull(resolvePeer(cfg, "gw/unknown"));
    });

    it("a2a_call('gw/…') posts JSON-RPC straight to the proxy URL with the gateway token", async () => {
      setGatewayPeers(
        merge([{ name: "pi-s2-9912", url: "/peer/pi-s2-9912/", healthy: true }]),
      );
      const requests: Array<{ method: string; url: string; auth?: string }> = [];
      globalThis.fetch = (async (url: any, init?: any) => {
        const h: Record<string, string> = Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
        );
        requests.push({
          method: init?.method || "GET",
          url: String(url),
          auth: h["authorization"],
        });
        return makeResp(
          { jsonrpc: "2.0", id: 1, result: { message: { role: "ROLE_AGENT", parts: [{ text: "proxied reply" }] } } },
          200,
        );
      }) as any;

      const out = await a2aCall({ cfg: DEFAULTS(), piDir, agent: "gw/pi-s2-9912", message: "hi" });

      // Exactly one request: the JSON-RPC POST pinned to the proxy URL — no
      // card GET (a proxied card would advertise the peer's direct URL and
      // bypass the gateway).
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.method, "POST");
      assert.equal(requests[0]!.url, "http://127.0.0.1:9920/peer/pi-s2-9912");
      assert.equal(requests[0]!.auth, `Bearer ${TOKEN}`);
      assert.include(out, "proxied reply");
    });
  });
});

// ---------------------------------------------------------------------------
// Reverse channel client
// ---------------------------------------------------------------------------

import { ChannelClient } from "../lib/gateway";
import * as http from "node:http";

describe("reverse channel client", () => {
  it("dispatches request envelopes to the local server and posts the response", async () => {
    // local A2A "server" (dispatch target)
    const localHits: Array<{ method: string; path: string; body?: string }> = [];
    const local = http.createServer((rq, rs) => {
      let body = "";
      rq.on("data", (c) => (body += c));
      rq.on("end", () => {
        localHits.push({ method: rq.method!, path: rq.url!, body });
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(JSON.stringify({ echoed: true }));
      });
    });
    await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
    const localPort = (local.address() as any).port;

    // fake gateway: /channel SSE that pushes one request, /channel/response records
    const posted: any[] = [];
    const gw = http.createServer((rq, rs) => {
      if (rq.url!.split("?")[0] === "/channel") {
        rs.writeHead(200, { "content-type": "text/event-stream" });
        const env = {
          id: 42,
          method: "POST",
          path: "/",
          headers: { "content-type": "application/json" },
          body_b64: Buffer.from('{"ping":1}').toString("base64"),
        };
        rs.write(`event: request\ndata: ${JSON.stringify(env)}\n\n`);
        return;
      }
      if (rq.url!.split("?")[0].startsWith("/channel/response/")) {
        let body = "";
        rq.on("data", (c) => (body += c));
        rq.on("end", () => {
          posted.push(JSON.parse(body));
          rs.writeHead(200); rs.end("ok");
        });
        return;
      }
      rs.writeHead(404); rs.end();
    });
    await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
    const gwPort = (gw.address() as any).port;

    const epoch = { value: 0 };
    const cc = new ChannelClient(
      { url: `http://127.0.0.1:${gwPort}`, token: TOKEN },
      `http://127.0.0.1:${localPort}`,
      () => {},
      epoch,
    );
    await cc.start();
    // give dispatch a beat
    await new Promise((r) => setTimeout(r, 300));
    cc.stop();

    assert.equal(localHits.length, 1);
    assert.equal(localHits[0]!.method, "POST");
    assert.equal(localHits[0]!.body, '{"ping":1}');
    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.id, 42);
    assert.equal(posted[0]!.status, 200);
    assert.deepEqual(JSON.parse(Buffer.from(posted[0]!.body_b64, "base64").toString()), { echoed: true });

    local.close(); gw.close();
  });

  it("stop() prevents reconnect resurrection (epoch guard)", async () => {
    // gateway that accepts /channel then immediately closes the stream
    const gw = http.createServer((rq, rs) => {
      if (rq.url!.split("?")[0] === "/channel") {
        rs.writeHead(200, { "content-type": "text/event-stream" });
        rs.end(); // immediate close → client would reconnect
        return;
      }
      rs.writeHead(404); rs.end();
    });
    await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
    const port = (gw.address() as any).port;
    let opens = 0;
    gw.on("request", () => { if (opens >= 0) opens += 1; });

    const epoch = { value: 0 };
    const cc = new ChannelClient(
      { url: `http://127.0.0.1:${port}`, token: TOKEN },
      "http://127.0.0.1:1",
      () => {},
      epoch,
    );
    const p = cc.start();
    await new Promise((r) => setTimeout(r, 150));
    cc.stop();
    await p;
    const after = opens;
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(opens, after); // no reconnection attempts after stop
    gw.close();
  });
});
