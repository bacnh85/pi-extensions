import { assert } from "chai";
import { loadConfig, resolvePeer, authHeaders } from "../lib/config";
import { DEFAULTS } from "./helpers";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-a2a-cfg-"));
}

/** Isolate from the operator's real ~/.pi/agent/settings.json by pointing the
 * config dir at the temp dir. */
function withIsolatedPiDir<T>(fn: (dir: string) => T): T {
  const dir = tmpDir();
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
}

describe("config", () => {
  it("returns defaults when nothing is configured", () => {
    const cfg = withIsolatedPiDir((dir) => loadConfig({ cwd: dir }));
    assert.equal(cfg.server.port, 9910);
    assert.equal(cfg.server.host, "127.0.0.1");
    assert.isFalse(cfg.server.enabled);
    assert.equal(cfg.timeouts.send, 120000);
  });

  it("reads settings.json a2a key", () => {
    withIsolatedPiDir((dir) => {
      fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".pi", "settings.json"),
        JSON.stringify({
          a2a: {
            peers: {
              researcher: {
                url: "http://localhost:9999",
                auth: { type: "bearer", token: "tok" },
                timeout: 60,
                capabilities: ["research"],
              },
            },
            server: { port: 8888, enabled: true },
          },
        }),
      );
      const cfg = loadConfig({ cwd: dir });
      assert.deepEqual(cfg.peers.researcher, {
        url: "http://localhost:9999",
        auth: { type: "bearer", token: "tok" },
        timeout: 60000,
        capabilities: ["research"],
        description: undefined,
      });
      assert.equal(cfg.server.port, 8888);
      assert.isTrue(cfg.server.enabled);
    });
  });

  it("reads A2A_* env vars", () => {
    withIsolatedPiDir((dir) => {
      const old = { ...process.env };
      process.env.A2A_PORT = "7777";
      process.env.A2A_HOST = "0.0.0.0";
      process.env.A2A_BEARER_TOKEN = "envtok";
      try {
        const cfg = loadConfig({ cwd: dir });
        assert.equal(cfg.server.port, 7777);
        assert.equal(cfg.server.host, "0.0.0.0");
        assert.equal(cfg.server.sharedToken, "envtok");
      } finally {
        process.env = old;
      }
    });
  });

  describe("resolvePeer", () => {
    it("treats a raw URL as a direct peer", () => {
      const cfg = DEFAULTS();
      const p = resolvePeer(cfg, "http://example.com:9900");
      assert.equal(p?.url, "http://example.com:9900");
      assert.equal(p?.auth.type, "none");
    });
    it("resolves a configured peer name", () => {
      const cfg = DEFAULTS();
      cfg.peers.alice = { url: "http://a", auth: { type: "none" }, timeout: 1000, capabilities: [] };
      assert.equal(resolvePeer(cfg, "alice")?.url, "http://a");
    });
    it("returns null for unknown name", () => {
      assert.isNull(resolvePeer(DEFAULTS(), "nope"));
    });
  });

  describe("authHeaders", () => {
    it("builds a Bearer header", () => {
      const h = authHeaders({ url: "", auth: { type: "bearer", token: "t" }, timeout: 1, capabilities: [] });
      assert.deepEqual(h, { Authorization: "Bearer t" });
    });
    it("builds an ApiKey header", () => {
      const h = authHeaders({ url: "", auth: { type: "apiKey", token: "k" }, timeout: 1, capabilities: [] });
      assert.deepEqual(h, { Authorization: "ApiKey k" });
    });
    it("omits headers for no auth", () => {
      assert.deepEqual(authHeaders({ url: "", auth: { type: "none" }, timeout: 1, capabilities: [] }), {});
    });
  });
});
