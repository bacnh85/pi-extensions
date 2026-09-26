import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "mocha";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LEASE_TTL_MS,
  detectWorkspaceConflict,
  encodeSessionDirName,
  readLiveLeases,
  recentSessionFiles,
  removeLease,
  writeLease,
} from "./workspace-guard";

describe("workspace-guard", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-plan-guard-"));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it("encodes cwd the way Pi stores session dirs", () => {
    assert.equal(encodeSessionDirName("/Volumes/Dev/agents/pi-extensions"), "--Volumes-Dev-agents-pi-extensions--");
    assert.equal(encodeSessionDirName("/home/user"), "--home-user--");
  });

  it("round-trips a lease and detects a live foreign session", async () => {
    const cwd = "/repo/x";
    await writeLease({ pid: 111, cwd, startedAt: 1 }, agentDir);
    const live = await readLiveLeases(cwd, 999, { agentDir, isAlive: (pid) => pid === 111 });
    assert.deepEqual(live.map((l) => l.pid), [111]);
  });

  it("ignores the caller's own lease", async () => {
    const cwd = "/repo/x";
    await writeLease({ pid: 111, cwd, startedAt: 1 }, agentDir);
    const live = await readLiveLeases(cwd, 111, { agentDir, isAlive: () => true });
    assert.deepEqual(live, []);
  });

  it("ignores leases for other workspaces", async () => {
    await writeLease({ pid: 111, cwd: "/repo/other", startedAt: 1 }, agentDir);
    const live = await readLiveLeases("/repo/x", 999, { agentDir, isAlive: () => true });
    assert.deepEqual(live, []);
  });

  it("GCs leases whose pid is dead", async () => {
    const cwd = "/repo/x";
    await writeLease({ pid: 111, cwd, startedAt: 1 }, agentDir);
    const live = await readLiveLeases(cwd, 999, { agentDir, isAlive: () => false });
    assert.deepEqual(live, []);
    // Second scan must not see it either — the file is gone.
    const again = await readLiveLeases(cwd, 999, { agentDir, isAlive: () => false });
    assert.deepEqual(again, []);
  });

  it("removes its own lease on shutdown", async () => {
    await writeLease({ pid: 42, cwd: "/repo/x", startedAt: 1 }, agentDir);
    await removeLease(42, agentDir);
    const live = await readLiveLeases("/repo/x", 999, { agentDir, isAlive: () => true });
    assert.deepEqual(live, []);
  });

  it("falls back to recent session files when no lease exists", async () => {
    const cwd = "/repo/x";
    const dir = path.join(agentDir, "sessions", encodeSessionDirName(cwd));
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    await writeFile(path.join(dir, "old.jsonl"), "");
    await writeFile(path.join(dir, "fresh.jsonl"), "");
    await writeFile(path.join(dir, "own.jsonl"), "");
    const past = new Date(now - LEASE_TTL_MS - 60_000);
    await utimes(path.join(dir, "old.jsonl"), past, past);

    const found = await recentSessionFiles(cwd, path.join(dir, "own.jsonl"), { agentDir, now: () => now });
    assert.deepEqual(found.map((f) => path.basename(f)), ["fresh.jsonl"]);
  });

  it("prefers a live lease over session recency", async () => {
    const cwd = "/repo/x";
    await writeLease({ pid: 111, cwd, startedAt: 1 }, agentDir);
    const dir = path.join(agentDir, "sessions", encodeSessionDirName(cwd));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "fresh.jsonl"), "");

    const conflicts = await detectWorkspaceConflict(cwd, 999, undefined, { agentDir, isAlive: (pid) => pid === 111 });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].lease?.pid, 111);
  });

  it("reports session recency when no lease matches", async () => {
    const cwd = "/repo/x";
    const dir = path.join(agentDir, "sessions", encodeSessionDirName(cwd));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "fresh.jsonl"), "");

    const conflicts = await detectWorkspaceConflict(cwd, 999, undefined, { agentDir, isAlive: () => true });
    assert.equal(conflicts.length, 1);
    assert.equal(typeof conflicts[0].sessionFile, "string");
  });

  it("matches a lease recorded through a symlinked path (macOS /tmp → /private/tmp)", async function () {
    // /tmp is a symlink to /private/tmp on macOS; the same workspace must be
    // recognized whichever form the lease recorded. Skipped where /tmp is not
    // a symlink (Linux CI).
    const viaSymlink = path.join("/tmp", `pi-plan-canon-${process.pid}-${Date.now()}`);
    await mkdir(viaSymlink, { recursive: true });
    const real = realpathSync(viaSymlink);
    if (real === viaSymlink) { await rm(viaSymlink, { recursive: true, force: true }); this.skip(); return; }
    try {
      await writeLease({ pid: 111, cwd: real, startedAt: 1 }, agentDir);
      const live = await readLiveLeases(viaSymlink, 999, { agentDir, isAlive: (pid) => pid === 111 });
      assert.deepEqual(live.map((l) => l.pid), [111], "symlinked cwd still matches the lease");
    } finally {
      await rm(viaSymlink, { recursive: true, force: true });
    }
  });

  it("is silent on a clean workspace", async () => {
    const conflicts = await detectWorkspaceConflict("/repo/x", 999, undefined, { agentDir, isAlive: () => true });
    assert.deepEqual(conflicts, []);
  });
});
