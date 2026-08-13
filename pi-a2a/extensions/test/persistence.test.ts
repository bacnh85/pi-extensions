import { assert } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { persistMessage, loadConversation, listConversations } from "../lib/persistence";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-a2a-persist-"));
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
