import { assert } from "chai";
import {
  buildJsonRpcRequest,
  extractResult,
  mapContent,
  callKonnect,
  probeHealth,
  _resetRequestId,
  baseUrl,
  MCP_PATH,
  HEALTH_PATH,
  type JsonRpcResponse,
} from "../lib/konnect-client.js";

describe("konnect-client", () => {
  describe("buildJsonRpcRequest", () => {
    beforeEach(() => _resetRequestId());

    it("builds a JSON-RPC 2.0 envelope with monotonic id", () => {
      const r1 = buildJsonRpcRequest("tools/call", { name: "x" });
      const r2 = buildJsonRpcRequest("ping");
      assert.equal(r1.jsonrpc, "2.0");
      assert.equal(r1.method, "tools/call");
      assert.deepEqual(r1.params, { name: "x" });
      assert.equal(r2.id, r1.id + 1, "id is monotonic");
      assert.isUndefined(r2.params, "params omitted when undefined");
    });

    it("accepts an explicit id", () => {
      const r = buildJsonRpcRequest("ping", undefined, 42);
      assert.equal(r.id, 42);
      assert.isUndefined(r.params);
    });
  });

  describe("extractResult", () => {
    it("returns result on success", () => {
      const res: JsonRpcResponse = { jsonrpc: "2.0", id: 1, result: { ok: true } };
      assert.deepEqual(extractResult(res), { ok: true });
    });

    it("throws on error with code and message", () => {
      const res: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found: foo" },
      };
      assert.throws(() => extractResult(res), /RPC error -32601.*Method not found: foo/);
    });
  });

  describe("mapContent", () => {
    it("passes text through and truncates over the limit", () => {
      const big = "x".repeat(500);
      const { piContent, images } = mapContent([{ type: "text", text: big }], { maxChars: 100 });
      assert.equal(images.length, 0);
      assert.equal(piContent.length, 1);
      assert.isAtMost(piContent[0].text.length, 100);
      assert.match(piContent[0].text, /truncated/);
    });

    it("maps image content to a text summary and preserves base64 in images[]", () => {
      const { piContent, images } = mapContent(
        [{ type: "image", data: "QUJD", mimeType: "image/png" }],
        { maxChars: 1000 },
      );
      assert.equal(images.length, 1);
      assert.equal(images[0].data, "QUJD");
      assert.match(piContent[0].text, /image: image\/png/);
      assert.match(piContent[0].text, /4 chars base64/);
    });

    it("handles mixed content and respects the shared budget", () => {
      const { piContent, images } = mapContent(
        [
          { type: "text", text: "hello" },
          { type: "image", data: "QUJD", mimeType: "image/png" },
          { type: "text", text: "world".repeat(50) },
        ],
        { maxChars: 30 },
      );
      assert.equal(images.length, 1);
      assert.isAtLeast(piContent.length, 1);
      const total = piContent.reduce((n, c) => n + c.text.length, 0);
      assert.isAtMost(total, 30 + 200, "stays near the budget");
    });

    it("returns empty arrays for undefined content", () => {
      const { piContent, images } = mapContent(undefined, { maxChars: 100 });
      assert.deepEqual(piContent, []);
      assert.deepEqual(images, []);
    });
  });

  describe("probeHealth / baseUrl", () => {
    it("builds localhost urls", () => {
      assert.equal(baseUrl(31337), "http://127.0.0.1:31337");
      assert.equal(MCP_PATH, "/mcp");
      assert.equal(HEALTH_PATH, "/health");
    });

    it("returns false when fetch throws", async () => {
      const ok = await probeHealth(1, {
        fetchImpl: (() => Promise.reject(new Error("no server"))) as unknown as typeof fetch,
        timeoutMs: 200,
      });
      assert.equal(ok, false);
    });

    it("returns true when /health responds ok", async () => {
      const fake = (async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response("ok", { status: 200 })) as unknown as typeof fetch;
      const ok = await probeHealth(31337, { fetchImpl: fake, timeoutMs: 500 });
      assert.equal(ok, true);
    });
  });

  describe("callKonnect", () => {
    it("POSTs a JSON-RPC request and returns the result", async () => {
      let captured: { url?: string; init?: RequestInit } = {};
      const fake = (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init };
        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [1, 2] } });
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch;

      const result = await callKonnect({ port: 31337, method: "tools/list", fetchImpl: fake });
      assert.deepEqual(result, { tools: [1, 2] });
      assert.match(captured.url!, /127\.0\.0\.1:31337\/mcp/);
      const sent = JSON.parse(String(captured.init!.body)) as { method: string };
      assert.equal(sent.method, "tools/list");
    });

    it("throws on HTTP non-200", async () => {
      const fake = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
      try {
        await callKonnect({ port: 31337, method: "tools/call", fetchImpl: fake });
        assert.fail("expected rejection");
      } catch (e) {
        assert.match((e as Error).message, /HTTP 500/);
      }
    });

    it("throws on JSON-RPC error", async () => {
      const fake = (async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } }),
          { status: 200 },
        )) as unknown as typeof fetch;
      try {
        await callKonnect({ port: 31337, method: "tools/call", fetchImpl: fake });
        assert.fail("expected rejection");
      } catch (e) {
        assert.match((e as Error).message, /RPC error -32602.*bad params/);
      }
    });
  });
});
