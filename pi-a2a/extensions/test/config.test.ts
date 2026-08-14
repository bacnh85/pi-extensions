import { assert } from "chai";
import { loadConfig, resolvePeer, authHeaders, normUrl, setConfigOverrides, writeSettingsA2A } from "../lib/config";
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

  describe("ui.transcript", () => {
    it("defaults to true", () => {
      const cfg = withIsolatedPiDir((dir) => loadConfig({ cwd: dir }));
      assert.isTrue(cfg.ui.transcript);
    });
    it("parses from settings.json", () => {
      withIsolatedPiDir((dir) => {
        fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({ a2a: { ui: { transcript: false } } }));
        const cfg = loadConfig({ cwd: dir });
        assert.isFalse(cfg.ui.transcript);
      });
    });
    it("parses from env A2A_UI_TRANSCRIPT", () => {
      withIsolatedPiDir((dir) => {
        const old = process.env.A2A_UI_TRANSCRIPT;
        process.env.A2A_UI_TRANSCRIPT = "false";
        try {
          const cfg = loadConfig({ cwd: dir });
          assert.isFalse(cfg.ui.transcript);
        } finally {
          if (old === undefined) delete process.env.A2A_UI_TRANSCRIPT;
          else process.env.A2A_UI_TRANSCRIPT = old;
        }
      });
    });
  });

  describe("setConfigOverrides", () => {
    afterEach(() => setConfigOverrides(null));

    it("overrides win over settings.json + env", () => {
      withIsolatedPiDir((dir) => {
        fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({ a2a: { server: { port: 8888 } } }));
        const old = process.env.A2A_PORT;
        process.env.A2A_PORT = "7777";
        try {
          setConfigOverrides({ server: { port: 6666 } } as any);
          const cfg = loadConfig({ cwd: dir });
          assert.equal(cfg.server.port, 6666);
        } finally {
          if (old === undefined) delete process.env.A2A_PORT;
          else process.env.A2A_PORT = old;
        }
      });
    });

    it("clearing overrides restores settings.json values", () => {
      withIsolatedPiDir((dir) => {
        fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({ a2a: { server: { port: 8888 } } }));
        setConfigOverrides({ server: { port: 6666 } } as any);
        assert.equal(loadConfig({ cwd: dir }).server.port, 6666);
        setConfigOverrides(null);
        assert.equal(loadConfig({ cwd: dir }).server.port, 8888);
      });
    });

    it("nested blocks merge (peers, discovery, ui)", () => {
      withIsolatedPiDir((dir) => {
        setConfigOverrides({
          peers: { bob: { url: "http://b", auth: { type: "none" }, timeout: 1, capabilities: [] } },
          discovery: { mdns: { enabled: true } },
          ui: { transcript: false },
        } as any);
        const cfg = loadConfig({ cwd: dir });
        assert.equal(cfg.peers.bob?.url, "http://b");
        assert.isTrue(cfg.discovery.mdns.enabled);
        assert.isFalse(cfg.ui.transcript);
        // untouched keys keep defaults
        assert.equal(cfg.server.port, 9910);
      });
    });
  });

  describe("writeSettingsA2A", () => {
    it("writes a new a2a key to the global settings path, preserving other keys", () => {
      withIsolatedPiDir((dir) => {
        // Place a settings.json in the isolated PI_CODING_AGENT_DIR
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ theme: "dark", other: 1 }));
        const written = writeSettingsA2A({ cwd: dir, patch: (a2a: any) => ({ ...a2a, server: { port: 1234 } }) });
        assert.equal(written, path.join(dir, "settings.json"));
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
        assert.equal(parsed.theme, "dark"); // unrelated keys preserved
        assert.equal(parsed.other, 1);
        assert.equal(parsed.a2a.server.port, 1234);
      });
    });

    it("prefers an existing settings.json that already has an a2a key", () => {
      withIsolatedPiDir((dir) => {
        fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({ a2a: { server: { port: 1 } } }));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ a2a: { server: { port: 2 } } }));
        const written = writeSettingsA2A({ cwd: dir, patch: (a2a: any) => ({ ...a2a, server: { port: 3 } }) });
        assert.equal(written, path.join(dir, ".pi", "settings.json"));
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, ".pi", "settings.json"), "utf-8"));
        assert.equal(parsed.a2a.server.port, 3);
      });
    });

    it("merges the patch onto existing a2a values (server changes keep discovery)", () => {
      withIsolatedPiDir((dir) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "settings.json"),
          JSON.stringify({ a2a: { server: { port: 1 }, discovery: { mdns: { enabled: true } } } }),
        );
        writeSettingsA2A({ cwd: dir, patch: (a2a: any) => ({ ...a2a, server: { port: 9 } }) });
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
        assert.equal(parsed.a2a.server.port, 9);
        assert.isTrue(parsed.a2a.discovery.mdns.enabled); // untouched subtree preserved
      });
    });

    it("writes to .pi/settings.json (project scope) when that file already has a2a", () => {
      withIsolatedPiDir((dir) => {
        fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({ a2a: { selfIdentity: "proj" } }));
        const written = writeSettingsA2A({ cwd: dir, patch: (a2a: any) => ({ ...a2a, selfIdentity: "proj2" }) });
        assert.equal(written, path.join(dir, ".pi", "settings.json"));
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, ".pi", "settings.json"), "utf-8"));
        assert.equal(parsed.a2a.selfIdentity, "proj2");
      });
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
    it("auto-attaches the shared token for KNOWN loopback URLs only", () => {
      const cfg = DEFAULTS();
      cfg.server.sharedToken = "s3cret";
      const known = new Set([normUrl("http://127.0.0.1:9911"), normUrl("http://localhost:9910")]);
      // Known peer URL → token attached
      const p = resolvePeer(cfg, "http://127.0.0.1:9911", { knownLoopbackUrls: known });
      assert.equal(p?.auth.type, "bearer");
      assert.equal((p!.auth as any).token, "s3cret");
      const p2 = resolvePeer(cfg, "http://localhost:9910", { knownLoopbackUrls: known });
      assert.equal(p2?.auth.type, "bearer");
    });
    it("does NOT attach the shared token to an ARBITRARY loopback URL (prompt-injection guard)", () => {
      const cfg = DEFAULTS();
      cfg.server.sharedToken = "s3cret";
      // No knownLoopbackUrls → arbitrary localhost must get NO token
      const p = resolvePeer(cfg, "http://localhost:1337");
      assert.equal(p?.auth.type, "none");
      // Even with a known set, a DIFFERENT port is not in it
      const known = new Set([normUrl("http://127.0.0.1:9911")]);
      const p2 = resolvePeer(cfg, "http://localhost:1337", { knownLoopbackUrls: known });
      assert.equal(p2?.auth.type, "none");
    });
    it("does NOT attach the shared token to non-loopback URLs", () => {
      const cfg = DEFAULTS();
      cfg.server.sharedToken = "s3cret";
      const known = new Set([normUrl("http://10.0.0.5:9911")]);
      const p = resolvePeer(cfg, "http://10.0.0.5:9911", { knownLoopbackUrls: known });
      assert.equal(p?.auth.type, "none");
    });
    it("does NOT attach a token when no shared token is configured", () => {
      const known = new Set([normUrl("http://127.0.0.1:9911")]);
      const p = resolvePeer(DEFAULTS(), "http://127.0.0.1:9911", { knownLoopbackUrls: known });
      assert.equal(p?.auth.type, "none");
    });
    it("treats IPv6 ::1 (bracketed or not) as loopback", () => {
      const cfg = DEFAULTS();
      cfg.server.sharedToken = "s3cret";
      const known = new Set([normUrl("http://[::1]:9911"), normUrl("http://::1:9911")]);
      assert.equal(resolvePeer(cfg, "http://[::1]:9911", { knownLoopbackUrls: known })?.auth.type, "bearer");
      // isLoopbackHost itself must accept both forms; unknown-port ::1 still no token
      const p = resolvePeer(cfg, "http://[::1]:9999");
      assert.equal(p?.auth.type, "none");
    });

    it("prefers this session's own peer token over the shared token", () => {
      const cfg = DEFAULTS();
      cfg.server.sharedToken = "SHARED";
      cfg.server.peerTokens = { "session-a": "OWN_TOKEN_A" };
      cfg.selfIdentity = "session-a";
      const known = new Set([normUrl("http://127.0.0.1:9911")]);
      const p = resolvePeer(cfg, "http://127.0.0.1:9911", { knownLoopbackUrls: known });
      assert.equal(p?.auth.type, "bearer");
      assert.equal((p!.auth as any).token, "OWN_TOKEN_A", "should present own token, not SHARED");
    });

    it("falls back to the shared token when selfIdentity has no peer token", () => {
      const cfg = DEFAULTS();
      cfg.server.sharedToken = "SHARED";
      cfg.server.peerTokens = { "session-b": "T_B" };
      cfg.selfIdentity = "session-a"; // not in peerTokens
      const known = new Set([normUrl("http://127.0.0.1:9911")]);
      const p = resolvePeer(cfg, "http://127.0.0.1:9911", { knownLoopbackUrls: known });
      assert.equal((p!.auth as any).token, "SHARED");
    });

    it("falls back to the shared token when selfIdentity is empty", () => {
      const cfg = DEFAULTS();
      cfg.server.sharedToken = "SHARED";
      cfg.server.peerTokens = { "session-a": "T_A" };
      cfg.selfIdentity = "";
      const known = new Set([normUrl("http://127.0.0.1:9911")]);
      const p = resolvePeer(cfg, "http://127.0.0.1:9911", { knownLoopbackUrls: known });
      assert.equal((p!.auth as any).token, "SHARED");
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
