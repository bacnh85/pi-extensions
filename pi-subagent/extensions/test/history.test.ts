/**
 * Tests for the history registry — append, read, find, interrupted-on-restart.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "mocha";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendHistory,
  readHistory,
  findHistory,
  markInterruptedOnRestart,
  trimHistory,
  getHistoryPath,
  type HistoryEntry,
} from "../history.ts";

function tmpPiDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "pi-subagent-hist-"));
}

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  const now = Date.now();
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    agent: "scout",
    task: "find auth",
    status: "completed",
    startedAt: now - 5000,
    completedAt: now,
    summary: "Found it.",
    ...overrides,
  };
}

describe("history registry", () => {
  let dir: string;
  beforeEach(() => { dir = tmpPiDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns empty array when no history file exists", () => {
    assert.deepEqual(readHistory(dir), []);
  });

  it("appends and reads back entries", () => {
    const e = makeEntry({ id: "t1" });
    appendHistory(dir, e);
    const read = readHistory(dir);
    assert.equal(read.length, 1);
    assert.equal(read[0]!.id, "t1");
  });

  it("upserts by id (replace, not duplicate)", () => {
    appendHistory(dir, makeEntry({ id: "t1", status: "running" }));
    appendHistory(dir, makeEntry({ id: "t1", status: "completed" }));
    const read = readHistory(dir);
    assert.equal(read.length, 1);
    assert.equal(read[0]!.status, "completed");
  });

  it("finds by id", () => {
    appendHistory(dir, makeEntry({ id: "t1" }));
    appendHistory(dir, makeEntry({ id: "t2" }));
    const found = findHistory(dir, "t2");
    assert.ok(found);
    assert.equal(found!.id, "t2");
  });

  it("returns undefined for unknown id", () => {
    appendHistory(dir, makeEntry({ id: "t1" }));
    assert.equal(findHistory(dir, "nope"), undefined);
  });

  it("marks running entries as interrupted on restart", () => {
    appendHistory(dir, makeEntry({ id: "t1", status: "running" }));
    appendHistory(dir, makeEntry({ id: "t2", status: "completed" }));
    appendHistory(dir, makeEntry({ id: "t3", status: "running" }));
    const changed = markInterruptedOnRestart(dir);
    assert.equal(changed, 2);
    const read = readHistory(dir);
    assert.equal(read.find((e) => e.id === "t1")!.status, "interrupted");
    assert.equal(read.find((e) => e.id === "t2")!.status, "completed"); // unchanged
    assert.equal(read.find((e) => e.id === "t3")!.status, "interrupted");
  });

  it("trims to max entries, keeping most recent", () => {
    for (let i = 0; i < 10; i++) {
      appendHistory(dir, makeEntry({ id: `t${i}`, completedAt: 1000 + i }));
    }
    const len = trimHistory(dir, 5);
    assert.equal(len, 5);
    const read = readHistory(dir);
    assert.equal(read.length, 5);
    // Most recent 5 = t5..t9 (highest completedAt).
    const ids = read.map((e) => e.id).sort();
    assert.deepEqual(ids, ["t5", "t6", "t7", "t8", "t9"]);
  });

  it("getHistoryPath places file under piDir", () => {
    const p = getHistoryPath("/tmp/fake-pi");
    assert.ok(p.endsWith("subagent-history.json"));
  });
});
