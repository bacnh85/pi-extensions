import { assert } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  heartbeat,
  list,
  register,
  unregister,
  type SessionDescriptor,
} from "../lib/registry";

function tmpPiDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-a2a-registry-"));
}

function desc(pid: number, overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    pid,
    url: `http://127.0.0.1:9910/`,
    port: 9910,
    host: "127.0.0.1",
    cwd: "/repo",
    model: { provider: "anthropic", id: "claude", name: "Claude" },
    agentName: "pi",
    tools: ["bash", "read"],
    skills: [],
    startedAt: new Date().toISOString(),
    mtime: Date.now(),
    ...overrides,
  };
}

describe("session registry", () => {
  it("register → list roundtrip returns the descriptor", () => {
    const dir = tmpPiDir();
    register(desc(11111), dir);
    const got = list({ piDir: dir, ttlSec: 60, aliveProbe: () => true });
    assert.lengthOf(got, 1);
    assert.strictEqual(got[0]!.pid, 11111);
    assert.strictEqual(got[0]!.cwd, "/repo");
    assert.strictEqual(got[0]!.model?.provider, "anthropic");
    assert.deepEqual(got[0]!.tools, ["bash", "read"]);
  });

  it("list ignores files that do not match <pid>.json", () => {
    const dir = tmpPiDir();
    register(desc(22222), dir);
    // stray non-registry file in the dir
    fs.writeFileSync(path.join(dir, "a2a_registry", "README.md"), "noise");
    fs.writeFileSync(path.join(dir, "a2a_registry", "abc.json"), "{}");
    const got = list({ piDir: dir, ttlSec: 60, aliveProbe: () => true });
    assert.lengthOf(got, 1);
    assert.strictEqual(got[0]!.pid, 22222);
  });

  it("sweeps stale entries by mtime TTL", () => {
    const dir = tmpPiDir();
    const d = desc(33333, { mtime: Date.now() - 120_000 }); // 2 min ago
    register(d, dir);
    // Force the on-disk mtime into the past so the sweep triggers.
    const p = path.join(dir, "a2a_registry", "33333.json");
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(p, past, past);
    const got = list({ piDir: dir, ttlSec: 60, aliveProbe: () => true });
    assert.lengthOf(got, 0, "stale entry should be swept");
    // Self-heal: file removed.
    assert.isFalse(fs.existsSync(p));
  });

  it("sweeps dead-pid entries via aliveProbe", () => {
    const dir = tmpPiDir();
    register(desc(44444), dir);
    const got = list({ piDir: dir, ttlSec: 60, aliveProbe: () => false });
    assert.lengthOf(got, 0, "dead-pid entry should be swept");
  });

  it("heartbeat refreshes mtime so a TTL sweep keeps the entry", () => {
    const dir = tmpPiDir();
    const d = desc(55555, { mtime: Date.now() - 120_000 });
    heartbeat(d, dir); // bumps mtime to now
    const got = list({ piDir: dir, ttlSec: 60, aliveProbe: () => true });
    assert.lengthOf(got, 1);
    assert.strictEqual(got[0]!.pid, 55555);
  });

  it("unregister removes the file and is idempotent", () => {
    const dir = tmpPiDir();
    register(desc(66666), dir);
    unregister(66666, dir);
    assert.lengthOf(list({ piDir: dir, ttlSec: 60, aliveProbe: () => true }), 0);
    // second unregister must not throw
    unregister(66666, dir);
    assert.lengthOf(list({ piDir: dir, ttlSec: 60, aliveProbe: () => true }), 0);
  });

  it("list on a missing directory returns [] (no throw)", () => {
    const dir = tmpPiDir();
    fs.rmSync(path.join(dir, "a2a_registry"), { recursive: true, force: true });
    assert.lengthOf(list({ piDir: dir }), 0);
  });

  it("multiple live sessions coexist", () => {
    const dir = tmpPiDir();
    register(desc(100, { cwd: "/repo-a" }), dir);
    register(desc(200, { cwd: "/repo-b" }), dir);
    register(desc(300, { cwd: "/repo-c" }), dir);
    const got = list({ piDir: dir, ttlSec: 60, aliveProbe: () => true }).sort((a, b) => a.pid - b.pid);
    assert.lengthOf(got, 3);
    assert.deepEqual(got.map((d) => d.cwd), ["/repo-a", "/repo-b", "/repo-c"]);
  });
});
