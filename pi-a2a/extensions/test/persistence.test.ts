import { assert } from "chai";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir } from "./tmp";
import { persistMessage, loadConversation, listConversations, childTranscriptDir, sweepChildTranscripts } from "../lib/persistence";

function tmpDir(): string {
  return makeTempDir("pi-a2a-persist-");
}

describe("persistence", () => {
  it("round-trips messages to JSONL", () => {
    const dir = tmpDir();
    persistMessage({ piDir: dir, contextId: "ctx-1", role: "user", text: "hello" });
    persistMessage({ piDir: dir, contextId: "ctx-1", role: "agent", text: "hi back" });
    const msgs = loadConversation(dir, "ctx-1");
    assert.lengthOf(msgs, 2);
    assert.equal(msgs[0]!.role, "user");
    assert.equal(msgs[0]!.text, "hello");
    assert.equal(msgs[1]!.role, "agent");
    assert.equal(msgs[1]!.text, "hi back");
  });

  it("returns [] for an unknown context", () => {
    const dir = tmpDir();
    assert.deepEqual(loadConversation(dir, "nope"), []);
  });

  it("respects the limit (last N)", () => {
    const dir = tmpDir();
    for (let i = 0; i < 10; i++) {
      persistMessage({ piDir: dir, contextId: "ctx-2", role: "user", text: `m${i}` });
    }
    const msgs = loadConversation(dir, "ctx-2", 3);
    assert.lengthOf(msgs, 3);
    assert.equal(msgs[0]!.text, "m7");
    assert.equal(msgs[2]!.text, "m9");
  });

  it("lists conversations", () => {
    const dir = tmpDir();
    persistMessage({ piDir: dir, contextId: "ctx-a", role: "user", text: "x" });
    persistMessage({ piDir: dir, contextId: "ctx-b", role: "user", text: "y" });
    const list = listConversations(dir);
    assert.includeMembers(list, ["ctx-a", "ctx-b"]);
  });
});

describe("child transcript sweep (#252)", () => {
  function touch(dir: string, name: string, ageDays: number): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "{}\n");
    const t = new Date(Date.now() - ageDays * 86_400_000);
    fs.utimesSync(p, t, t);
    return p;
  }

  it("childTranscriptDir sits under the pi dir", () => {
    assert.equal(childTranscriptDir("/tmp/agent"), path.join("/tmp/agent", "a2a_sessions"));
  });

  it("deletes only transcripts older than the retention window", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "a2a_sessions"), { recursive: true });
    const sessions = path.join(dir, "a2a_sessions");
    const old = touch(sessions, "20260101T000000_task-old.jsonl", 40);
    const fresh = touch(sessions, "20260830T000000_task-new.jsonl", 1);
    const removed = sweepChildTranscripts(sessions, 30);
    assert.equal(removed, 1);
    assert.isFalse(fs.existsSync(old), "past-retention transcript removed");
    assert.isTrue(fs.existsSync(fresh), "within-retention transcript kept");
  });

  it("ignores non-jsonl files", () => {
    const dir = tmpDir();
    const old = touch(dir, "notes.txt", 400);
    assert.equal(sweepChildTranscripts(dir, 30), 0);
    assert.isTrue(fs.existsSync(old));
  });

  it("retentionDays 0 keeps everything", () => {
    const dir = tmpDir();
    const old = touch(dir, "20260101T000000_task-old.jsonl", 400);
    assert.equal(sweepChildTranscripts(dir, 0), 0);
    assert.isTrue(fs.existsSync(old));
  });

  it("missing dir is a no-op, never a throw", () => {
    assert.equal(sweepChildTranscripts(path.join(tmpDir(), "nope"), 30), 0);
  });
});
