import { assert } from "chai";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildA2ASettingsPatch, loadConfig, setConfigOverrides } from "../lib/config";
import { clearConfigValueCache, resolveConfigValue, resolveSettingsValue } from "../lib/resolve-config-value";
import { makeTempDir } from "./tmp";

/** Point PI_CODING_AGENT_DIR at a temp dir (operator settings), cwd = same dir
 *  so `<dir>/.pi/settings.json` is the repo-controlled file. */
function withIsolatedPiDir<T>(fn: (dir: string) => T): T {
  const dir = makeTempDir("pi-a2a-cv-");
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
}

function writeOperatorSettings(dir: string, a2a: unknown): void {
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ a2a }));
}

function writeRepoSettings(dir: string, a2a: unknown): void {
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({ a2a }));
}

describe("resolve-config-value (#50)", () => {
  const ENV = "PI_A2A_CV_TEST_TOKEN";
  beforeEach(() => {
    clearConfigValueCache();
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    setConfigOverrides(null);
  });

  describe("resolveConfigValue (pi core semantics)", () => {
    it("returns a plain literal unchanged", () => {
      assert.equal(resolveConfigValue("abc123"), "abc123");
    });

    it("runs a !command and trims stdout", () => {
      assert.equal(resolveConfigValue("!printf '  tok-1\\n'"), "tok-1");
    });

    it("leaves the value unset on nonzero exit or empty output", () => {
      assert.isUndefined(resolveConfigValue("!exit 3"));
      assert.isUndefined(resolveConfigValue("!true"));
    });

    it("caches !command results (failures included) per value", () => {
      const dir = makeTempDir("pi-a2a-cv-count-");
      const counter = path.join(dir, "n");
      const cmd = `!echo x >> '${counter}'; printf tok`;
      assert.equal(resolveConfigValue(cmd), "tok");
      assert.equal(resolveConfigValue(cmd), "tok");
      assert.equal(fs.readFileSync(counter, "utf-8").trim().split("\n").length, 1, "command ran once");
    });

    it("interpolates $NAME and ${NAME}", () => {
      process.env[ENV] = "secret";
      assert.equal(resolveConfigValue(`$${ENV}`), "secret");
      assert.equal(resolveConfigValue(`Bearer \${${ENV}}!`), "Bearer secret!");
    });

    it("leaves the whole value unset when a referenced env var is missing", () => {
      assert.isUndefined(resolveConfigValue(`pre-$${ENV}`));
    });

    it("supports $$ and $! escapes", () => {
      assert.equal(resolveConfigValue("a$$b"), "a$b");
      assert.equal(resolveConfigValue("$!literal"), "!literal");
    });

    it("keeps a lone $ and an invalid ${...} literal", () => {
      assert.equal(resolveConfigValue("cost $5"), "cost $5");
      assert.equal(resolveConfigValue("${not valid}"), "${not valid}");
    });
  });

  describe("resolveSettingsValue", () => {
    it("passes non-strings through", () => {
      assert.isUndefined(resolveSettingsValue(undefined, false));
      assert.equal(resolveSettingsValue(42, false), 42);
    });

    it("returns repo-sourced values literally, never resolved", () => {
      process.env[ENV] = "secret";
      assert.equal(resolveSettingsValue(`$${ENV}`, true), `$${ENV}`);
      assert.equal(resolveSettingsValue("!printf tok", true), "!printf tok");
    });
  });

  describe("loadConfig", () => {
    it("resolves every credential field from operator settings", () => {
      withIsolatedPiDir((dir) => {
        process.env[ENV] = "env-secret";
        writeOperatorSettings(dir, {
          peers: { p: { url: "http://127.0.0.1:9901", auth: { type: "bearer", token: "!printf peer-tok" } } },
          server: { sharedToken: `$${ENV}`, peerTokens: { alice: "!printf alice-tok" } },
          discovery: {
            gateway: { url: "http://gw", token: "!printf gw-tok", upstreamToken: `\${${ENV}}` },
            gateways: { two: { url: "http://gw2", token: "!printf gw2-tok", upstreamToken: "!printf gw2-up" } },
          },
        });
        const cfg = loadConfig({ cwd: dir, env: {} });
        assert.equal(cfg.peers.p!.auth.token, "peer-tok");
        assert.equal(cfg.server.sharedToken, "env-secret");
        assert.deepEqual(cfg.server.peerTokens, { alice: "alice-tok" });
        assert.equal(cfg.discovery.gateway!.token, "gw-tok");
        assert.equal(cfg.discovery.gateway!.upstreamToken, "env-secret");
        assert.equal(cfg.discovery.gateways!.two!.token, "gw2-tok");
        assert.equal(cfg.discovery.gateways!.two!.upstreamToken, "gw2-up");
      });
    });

    it("never runs a !command from a repo-controlled .pi/settings.json", () => {
      withIsolatedPiDir((dir) => {
        const sentinel = path.join(dir, "pwned");
        writeRepoSettings(dir, {
          peers: { evil: { url: "http://127.0.0.1:9902", auth: { type: "bearer", token: `!touch '${sentinel}'` } } },
        });
        const cfg = loadConfig({ cwd: dir, env: {} });
        assert.isFalse(fs.existsSync(sentinel), "repo command must not execute");
        assert.equal(cfg.peers.evil!.auth.token, `!touch '${sentinel}'`, "kept literal");
      });
    });

    it("never interpolates operator env vars into a repo-controlled peer token", () => {
      withIsolatedPiDir((dir) => {
        process.env[ENV] = "env-secret";
        writeRepoSettings(dir, {
          peers: { evil: { url: "http://127.0.0.1:9902", auth: { type: "bearer", token: `$${ENV}` } } },
        });
        const cfg = loadConfig({ cwd: dir, env: {} });
        assert.equal(cfg.peers.evil!.auth.token, `$${ENV}`, "kept literal");
      });
    });
  });

  describe("buildA2ASettingsPatch", () => {
    it("persists the raw token reference, not the resolved secret, for unedited peers", () => {
      withIsolatedPiDir((dir) => {
        const fileA2a = {
          peers: { p: { url: "http://127.0.0.1:9901", auth: { type: "bearer", token: "!printf peer-tok" }, timeout: 300 } },
        };
        writeOperatorSettings(dir, fileA2a);
        const cfg = loadConfig({ cwd: dir, env: {} });
        assert.equal(cfg.peers.p!.auth.token, "peer-tok");
        const working = structuredClone(cfg);
        working.peers.p!.url = "http://127.0.0.1:9999"; // unrelated peer edit
        working.peers.q = { url: "http://127.0.0.1:9903", auth: { type: "none" }, timeout: 120000, capabilities: [] };
        const a2a = buildA2ASettingsPatch({ cfg, working, peerChanges: true, gatewayChanged: false })(fileA2a);
        assert.deepEqual(a2a.peers.p.auth, { type: "bearer", token: "!printf peer-tok" });
        assert.equal(a2a.peers.p.url, "http://127.0.0.1:9999");
        assert.deepEqual(a2a.peers.q.auth, { type: "none" }, "new peer keeps its own auth");
      });
    });
  });
});
