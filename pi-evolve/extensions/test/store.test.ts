import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { expect } from "chai";
import { MuninClient } from "@kalera/munin-sdk";
import {
  type Learning,
  resolveStoreConfig,
  activeBackend,
  writeLearning,
  readRecentLearnings,
  searchLearnings,
  rankLocal,
  localPath,
  readLocalTail,
  capLocal,
  formatLearningContent,
  parseLearningContent,
  inferDomain,
} from "../lib/store";

const ENV_KEYS = ["MUNIN_API_KEY", "MUNIN_PROJECT", "MUNIN_BASE_URL", "PI_CODING_AGENT_DIR"] as const;

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "pi-evolve-test-"));
}

const sampleLearning: Learning = {
  kind: "recovery",
  trigger: "ECONNREFUSED on docker compose up",
  lesson: "Start the Docker daemon before running compose; check with `docker info`.",
  anchors: ["docker-compose.yml", "Makefile"],
};

describe("store config", () => {
  it("resolveStoreConfig applies defaults and validates values", () => {
    expect(resolveStoreConfig(undefined)).to.deep.equal({ store: "auto", localCap: 500 });
    expect(resolveStoreConfig({ store: "local", localCap: 100 })).to.deep.equal({
      store: "local",
      localCap: 100,
    });
    // invalid values fall back to defaults
    expect(resolveStoreConfig({ store: "bogus", localCap: -5 })).to.deep.equal({
      store: "auto",
      localCap: 500,
    });
  });

  it("activeBackend falls back to local when Munin is not configured", () => {
    const cwd = tmpCwd();
    try {
      expect(activeBackend({}, resolveStoreConfig({ store: "auto" }), cwd)).to.equal("local");
      expect(activeBackend({}, resolveStoreConfig({ store: "local" }), cwd)).to.equal("local");
      // forced munin without config still falls back (graceful)
      expect(activeBackend({}, resolveStoreConfig({ store: "munin" }), cwd)).to.equal("local");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("activeBackend uses munin when configured via env", () => {
    const cwd = tmpCwd();
    const saved = saveEnv();
    try {
      process.env.MUNIN_API_KEY = "test-key";
      process.env.MUNIN_PROJECT = "test-project";
      expect(activeBackend({}, resolveStoreConfig({ store: "auto" }), cwd)).to.equal("munin");
      expect(activeBackend({}, resolveStoreConfig({ store: "local" }), cwd)).to.equal("local");
    } finally {
      restoreEnv(saved);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("local JSONL store", () => {
  let cwd: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    cwd = tmpCwd();
    saved = saveEnv();
  });
  afterEach(() => {
    restoreEnv(saved);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes and reads back a learning via the local backend", async () => {
    const cfg = resolveStoreConfig({ store: "local" });
    const stored = await writeLearning(sampleLearning, {}, cfg, cwd);
    expect(stored.key).to.include("learning/recovery/");
    expect(stored.title).to.include("ECONNREFUSED");

    expect(existsSync(localPath(cwd))).to.equal(true);
    const recent = await readRecentLearnings(10, {}, cfg, cwd);
    expect(recent).to.have.length(1);
    expect(recent[0].kind).to.equal("recovery");
    expect(recent[0].lesson).to.include("Docker daemon");
    expect(recent[0].anchors).to.deep.equal(["docker-compose.yml", "Makefile"]);
  });

  it("caps the JSONL file at localCap lines", () => {
    const file = localPath(cwd);
    mkdirSync(dirname(file), { recursive: true });
    // write 10 lines directly, cap at 5
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ key: `k${i}`, title: `t${i}`, content: "Kind: strategy\nTrigger: x\nLesson: y", tags: "type:learning", storedAt: "2025-01-01" }),
    ).join("\n");
    writeFileSync(file, lines + "\n", "utf8");
    capLocal(file, 5);
    const remaining = readFileSync(file, "utf8").trim().split("\n");
    expect(remaining).to.have.length(5);
    expect(remaining[0]).to.include('"k5"'); // kept the last 5
  });

  it("readLocalTail tolerates malformed lines", () => {
    const file = localPath(cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      "not json\n" +
      JSON.stringify({ key: "good", title: "t", content: "Kind: strategy\nTrigger: x\nLesson: real lesson", storedAt: "2025-01-01" }) + "\n",
      "utf8",
    );
    const out = readLocalTail(file, 10);
    expect(out).to.have.length(1);
    expect(out[0].lesson).to.equal("real lesson");
  });
});

describe("content format round-trip", () => {
  it("formatLearningContent + parseLearningContent round-trip", () => {
    const formatted = formatLearningContent(sampleLearning);
    expect(formatted).to.include("Kind: recovery");
    expect(formatted).to.include("Anchors: docker-compose.yml, Makefile");
    const parsed = parseLearningContent(formatted);
    expect(parsed.kind).to.equal("recovery");
    expect(parsed.trigger).to.equal(sampleLearning.trigger);
    expect(parsed.lesson).to.equal(sampleLearning.lesson);
    expect(parsed.anchors).to.deep.equal(sampleLearning.anchors);
  });

  it("collapses internal newlines so multi-line lessons round-trip losslessly", () => {
    const multi: Learning = {
      kind: "strategy",
      trigger: "multi line\ntrigger",
      lesson: "line one\nline two\nline three",
      anchors: ["a.ts", "b.ts"],
    };
    const formatted = formatLearningContent(multi);
    const parsed = parseLearningContent(formatted);
    // Newlines collapsed to spaces — no data lost.
    expect(parsed.trigger).to.equal("multi line trigger");
    expect(parsed.lesson).to.equal("line one line two line three");
    expect(parsed.anchors).to.deep.equal(["a.ts", "b.ts"]);
  });

  it("inferDomain maps keywords to domains", () => {
    expect(inferDomain({ kind: "strategy", trigger: "jwt token refresh", lesson: "x" })).to.equal("auth");
    expect(inferDomain({ kind: "strategy", trigger: "react component", lesson: "x" })).to.equal("frontend");
    expect(inferDomain({ kind: "strategy", trigger: "api route", lesson: "x" })).to.equal("backend");
    expect(inferDomain({ kind: "strategy", trigger: "github actions ci", lesson: "x" })).to.equal("infra");
    expect(inferDomain({ kind: "strategy", trigger: "random thing", lesson: "x" })).to.equal("general");
  });
});

// ---------------------------------------------------------------------------
// Munin backend (mocked SDK — covers write + read + the parseMuninMemories shapes)
// ---------------------------------------------------------------------------

describe("Munin backend (mocked)", () => {
  let saved: Record<string, string | undefined>;
  let cwd: string;
  let originalStore: typeof MuninClient.prototype.store;
  let originalInvoke: typeof MuninClient.prototype.invoke;
  let originalRecent: any;
  const storeCalls: any[] = [];
  let recentReturn: unknown = { data: { memories: [] } };

  beforeEach(() => {
    saved = saveEnv();
    cwd = tmpCwd();
    process.env.MUNIN_API_KEY = "test-key";
    process.env.MUNIN_PROJECT = "test-project";
    storeCalls.length = 0;
    originalStore = MuninClient.prototype.store as any;
    originalInvoke = MuninClient.prototype.invoke as any;
    originalRecent = (MuninClient.prototype as any).recent;
    // Mock store() to capture calls.
    (MuninClient.prototype as any).store = async function (_projectId: string, payload: any) {
      storeCalls.push(payload);
      return { ok: true, ...payload };
    };
    // Mock recent() to return the current fixture.
    (MuninClient.prototype as any).recent = async function (_projectId: string, _opts: any) {
      return recentReturn;
    };
  });
  afterEach(() => {
    (MuninClient.prototype as any).store = originalStore;
    (MuninClient.prototype as any).invoke = originalInvoke;
    (MuninClient.prototype as any).recent = originalRecent;
    restoreEnv(saved);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes a learning via Munin store() when backend is munin", async () => {
    const cfg = resolveStoreConfig({ store: "auto" });
    expect(activeBackend({}, cfg, cwd)).to.equal("munin");
    const stored = await writeLearning(sampleLearning, {}, cfg, cwd);
    expect(storeCalls).to.have.length(1);
    expect(storeCalls[0].tags).to.include("type:learning");
    expect(storeCalls[0].content).to.include("Kind: recovery");
    expect(stored.key).to.include("learning/recovery/");
  });

  it("passes tags as an ARRAY to Munin store() (SDK does tags.join)", async () => {
    const cfg = resolveStoreConfig({ store: "auto" });
    // The real SDK throws `(tags || []).join is not a function` on a string;
    // our mock mimics that contract by rejecting non-array tags.
    (MuninClient.prototype as any).store = async function (_pid: string, payload: any) {
      if (typeof payload.tags === "string") throw new Error("(tags || []).join is not a function");
      if (!Array.isArray(payload.tags)) throw new Error("tags must be an array");
      storeCalls.push(payload);
      return { ok: true, ...payload };
    };
    const stored = await writeLearning(sampleLearning, {}, cfg, cwd);
    expect(storeCalls).to.have.length(1);
    expect(storeCalls[0].tags).to.deep.equal(["type:learning", "domain:infra"]);
    expect(stored.key).to.include("learning/recovery/");
  });

  it("reads recent learnings via Munin recent() and parses the {data:{memories:[]}} shape", async () => {
    recentReturn = {
      data: {
        memories: [
          {
            key: "learning/strategy/a",
            title: "[strategy] x",
            content: "Kind: strategy\nTrigger: t\nLesson: the real lesson",
            storedAt: "2025-01-01",
          },
        ],
      },
    };
    const cfg = resolveStoreConfig({ store: "auto" });
    const recent = await readRecentLearnings(5, {}, cfg, cwd);
    expect(recent).to.have.length(1);
    expect(recent[0].lesson).to.equal("the real lesson");
    expect(recent[0].kind).to.equal("strategy");
  });

  it("parses the raw-array shape and the {memories:[]} shape", async () => {
    const cfg = resolveStoreConfig({ store: "auto" });
    // Raw array shape.
    recentReturn = [{ key: "k1", title: "t", content: "Kind: recovery\nTrigger: x\nLesson: raw lesson", storedAt: "2025-01-01" }];
    let recent = await readRecentLearnings(5, {}, cfg, cwd);
    expect(recent[0].lesson).to.equal("raw lesson");
    // {memories:[]} shape.
    recentReturn = { memories: [{ key: "k2", title: "t", content: "Kind: strategy\nTrigger: x\nLesson: mem lesson", storedAt: "2025-01-01" }] };
    recent = await readRecentLearnings(5, {}, cfg, cwd);
    expect(recent[0].lesson).to.equal("mem lesson");
  });

  it("readRecentLearnings returns [] on Munin failure (best-effort)", async () => {
    (MuninClient.prototype as any).recent = async function () {
      throw new Error("network down");
    };
    const cfg = resolveStoreConfig({ store: "auto" });
    const recent = await readRecentLearnings(5, {}, cfg, cwd);
    expect(recent).to.deep.equal([]);
  });

  it("searchLearnings falls back to client.invoke when search() is absent", async () => {
    const cfg = resolveStoreConfig({ store: "auto" });
    // Remove search from the prototype so the invoke fallback runs.
    (MuninClient.prototype as any).search = undefined;
    const invokeCalls: any[] = [];
    (MuninClient.prototype as any).invoke = async function (_pid: string, action: string, payload: any) {
      invokeCalls.push({ action, payload });
      return {
        data: {
          memories: [
            { key: "learning/strategy/x", title: "t", content: "Kind: strategy\nTrigger: x\nLesson: invoke path works", storedAt: "2025-01-01" },
          ],
        },
      };
    };
    const results = await searchLearnings("test query", 5, {}, cfg, cwd);
    expect(invokeCalls).to.have.length(1);
    expect(invokeCalls[0].action).to.equal("search");
    expect(invokeCalls[0].payload.tags).to.deep.equal(["type:learning"]);
    expect(results[0].lesson).to.equal("invoke path works");
  });
});

// ---------------------------------------------------------------------------
// Search (v0.2 similarity-keyed injection)
// ---------------------------------------------------------------------------

describe("searchLearnings (local ranking)", () => {
  let cwd: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    cwd = tmpCwd();
  });
  afterEach(() => {
    restoreEnv(saved);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("ranks learnings by query-keyword overlap", async () => {
    const cfg = resolveStoreConfig({ store: "local" });
    await writeLearning(
      { kind: "strategy", trigger: "docker compose networking", lesson: "check docker network ls", anchors: [] },
      {}, cfg, cwd,
    );
    await writeLearning(
      { kind: "recovery", trigger: "jwt token expiry", lesson: "refresh token before expiry", anchors: ["auth.ts"] },
      {}, cfg, cwd,
    );
    // Query about docker should rank the docker learning first (jwt doesn't match).
    const results = await searchLearnings("docker network is not working", 5, {}, cfg, cwd);
    expect(results).to.have.length(1);
    expect(results[0].lesson).to.include("docker network ls");
  });

  it("ranks multiple matching learnings by overlap (docker query returns both but docker first)", async () => {
    const cfg = resolveStoreConfig({ store: "local" });
    await writeLearning(
      { kind: "strategy", trigger: "docker compose networking", lesson: "check docker network ls", anchors: [] },
      {}, cfg, cwd,
    );
    await writeLearning(
      { kind: "recovery", trigger: "docker build fails", lesson: "check docker daemon is running", anchors: [] },
      {}, cfg, cwd,
    );
    const results = await searchLearnings("docker network is not working", 5, {}, cfg, cwd);
    expect(results).to.have.length(2);
    expect(results[0].lesson).to.include("docker network ls"); // more overlap → first
  });

  it("returns [] when no learning matches the query", async () => {
    const cfg = resolveStoreConfig({ store: "local" });
    await writeLearning(
      { kind: "strategy", trigger: "react rendering", lesson: "memoize components", anchors: [] },
      {}, cfg, cwd,
    );
    const results = await searchLearnings("kubernetes cluster setup", 5, {}, cfg, cwd);
    expect(results).to.deep.equal([]);
  });

  it("rankLocal scores empty query as no preference (returns all)", () => {
    const learnings: any[] = [
      { trigger: "a", lesson: "x", title: "t1" },
      { trigger: "b", lesson: "y", title: "t2" },
    ];
    expect(rankLocal(learnings, "")).to.have.length(2);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}
