import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Isolation ────────────────────────────────────────────────────────────────
// Point PI_CODING_AGENT_DIR at a temp dir so tests never touch the user's live
// ~/.pi/agent settings.json.
const TMP_HOME = join(tmpdir(), "pi-commandcode-test-" + process.pid);
before(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = TMP_HOME;
  delete process.env.COMMAND_CODE_BASE_URL;
});
after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

const globalSettings = () => join(TMP_HOME, "settings.json");

async function loadConfig() {
  // Dynamic import AFTER env is set (module reads PI_CODING_AGENT_DIR lazily).
  return import("../lib/config.js");
}

describe("config", () => {
  it("defaults to DEFAULT_BASE_URL when nothing is configured", async () => {
    const { getSettings } = await loadConfig();
    const { DEFAULT_BASE_URL } = await import("../lib/client.js");
    assert.equal(getSettings(TMP_HOME).baseUrl, DEFAULT_BASE_URL);
  });

  it("reads commandcode.baseUrl from global settings.json", async () => {
    writeFileSync(globalSettings(), JSON.stringify({ other: true, commandcode: { baseUrl: "http://cc.example/v1/" } }));
    const { getSettings } = await loadConfig();
    assert.equal(getSettings(TMP_HOME).baseUrl, "http://cc.example/v1"); // trailing slash stripped
  });

  it("trusted project: repo .pi/settings.json overrides global", async () => {
    writeFileSync(globalSettings(), JSON.stringify({ commandcode: { baseUrl: "http://global/v1" } }));
    const repo = join(TMP_HOME, "repo", ".pi", "settings.json");
    mkdirSync(join(TMP_HOME, "repo", ".pi"), { recursive: true });
    writeFileSync(repo, JSON.stringify({ commandcode: { baseUrl: "http://repo/v1" } }));
    const { getSettings } = await loadConfig();
    assert.equal(getSettings(join(TMP_HOME, "repo"), { trustProject: true }).baseUrl, "http://repo/v1");
  });

  it("untrusted project: repo .pi/settings.json is ignored — global wins", async () => {
    writeFileSync(globalSettings(), JSON.stringify({ commandcode: { baseUrl: "http://global/v1" } }));
    const repo = join(TMP_HOME, "repo", ".pi", "settings.json");
    mkdirSync(join(TMP_HOME, "repo", ".pi"), { recursive: true });
    writeFileSync(repo, JSON.stringify({ commandcode: { baseUrl: "http://evil/v1" } }));
    const { getSettings } = await loadConfig();
    assert.equal(getSettings(join(TMP_HOME, "repo")).baseUrl, "http://global/v1",
      "untrusted checkout must not redirect the credentialed endpoint");
  });

  it("untrusted project with no global setting: default wins over repo", async () => {
    try { unlinkSync(globalSettings()); } catch { /* ignore */ }
    const repo = join(TMP_HOME, "repo", ".pi", "settings.json");
    mkdirSync(join(TMP_HOME, "repo", ".pi"), { recursive: true });
    writeFileSync(repo, JSON.stringify({ commandcode: { baseUrl: "http://evil/v1" } }));
    const { getSettings } = await loadConfig();
    const { DEFAULT_BASE_URL } = await import("../lib/client.js");
    assert.equal(getSettings(join(TMP_HOME, "repo")).baseUrl, DEFAULT_BASE_URL);
  });

  it("env COMMAND_CODE_BASE_URL wins over both files", async () => {
    process.env.COMMAND_CODE_BASE_URL = "http://env/v1";
    try {
      const { getSettings } = await loadConfig();
      assert.equal(getSettings(TMP_HOME).baseUrl, "http://env/v1");
    } finally {
      delete process.env.COMMAND_CODE_BASE_URL;
    }
  });

  it("writeBaseUrl merges into global settings, preserving unrelated keys", async () => {
    writeFileSync(globalSettings(), JSON.stringify({ router: { baseUrl: "http://keep" }, a2a: { x: 1 } }));
    const { writeBaseUrl } = await loadConfig();
    const written = writeBaseUrl("http://new/v1/");
    assert.equal(written, globalSettings());
    const j = JSON.parse(readFileSync(globalSettings(), "utf8"));
    assert.equal(j.commandcode.baseUrl, "http://new/v1"); // normalized
    assert.equal(j.router.baseUrl, "http://keep", "unrelated keys preserved");
    assert.deepEqual(j.a2a, { x: 1 });
  });

  it("writeBaseUrl never writes a repo settings file", async () => {
    const repo = join(TMP_HOME, "repo2");
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(join(repo, ".pi", "settings.json"), JSON.stringify({ commandcode: { baseUrl: "http://repo/v1" } }));
    const { writeBaseUrl } = await loadConfig();
    writeBaseUrl("http://global2/v1");
    // Repo file untouched; global got the value.
    const repoJ = JSON.parse(readFileSync(join(repo, ".pi", "settings.json"), "utf8"));
    assert.equal(repoJ.commandcode.baseUrl, "http://repo/v1");
    const globalJ = JSON.parse(readFileSync(globalSettings(), "utf8"));
    assert.equal(globalJ.commandcode.baseUrl, "http://global2/v1");
  });

  it("writeBaseUrl bails on a corrupt global settings.json without overwriting it", async () => {
    // 0.2.1 regression: "exists but unparseable" must throw, not conflate with
    // "missing" and wipe every unrelated section (router, a2a, …).
    writeFileSync(globalSettings(), "{ not json");
    const { writeBaseUrl } = await loadConfig();
    assert.throws(() => writeBaseUrl("http://x/v1"), /not valid JSON/);
    assert.equal(readFileSync(globalSettings(), "utf8"), "{ not json", "corrupt file untouched");
  });

  it("panel round-trip: row set updates baseUrl through the kernel row()", async () => {
    const { getSettings } = await loadConfig();
    const { row } = await import("@bacnh85/pi-config-panel");
    const working = structuredClone(getSettings(TMP_HOME));
    const groups = [
      { key: "endpoint", label: "Endpoint", rows: [
        row("baseUrl", "Base URL", "string", working.baseUrl, (v) => {
          working.baseUrl = String(v ?? "");
        }),
      ] },
    ];
    groups[0]!.rows[0]!.set("http://panel/v1/");
    assert.equal(working.baseUrl, "http://panel/v1/");
  });
});
