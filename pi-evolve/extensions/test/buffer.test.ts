import { expect } from "chai";
import { TrajectoryBuffer, digestInput, categorizeError } from "../lib/buffer";

describe("TrajectoryBuffer", () => {
  it("records entries and caps the ring", () => {
    const buf = new TrajectoryBuffer(3);
    buf.record("grep", "pattern=foo");
    buf.record("read", "path=src/x.ts");
    buf.record("edit", "file=y.ts");
    buf.record("bash", "cmd=ls"); // should evict the oldest
    expect(buf.size).to.equal(3);
    const snap = buf.snapshot();
    expect(snap[0].tool).to.equal("read"); // grep evicted
    expect(snap[2].tool).to.equal("bash");
  });

  it("marks results on the most recent unmatched entry for a tool", () => {
    const buf = new TrajectoryBuffer();
    buf.record("grep", "p=1", "c1");
    buf.record("read", "p=2", "c2");
    buf.markResult("grep", false, undefined, "c1");
    buf.markResult("read", true, "not_found", "c2");
    const snap = buf.snapshot();
    expect(snap[0].status).to.equal("ok");
    expect(snap[1].status).to.equal("error");
    expect(snap[1].errorCategory).to.equal("not_found");
  });

  it("matches by toolCallId for parallel same-tool calls (out-of-order results)", () => {
    const buf = new TrajectoryBuffer();
    buf.record("read", "a.ts", "A");
    buf.record("read", "b.ts", "B");
    // Results arrive in reverse order: B (ok) then A (error).
    buf.markResult("read", false, undefined, "B");
    buf.markResult("read", true, "not_found", "A");
    const snap = buf.snapshot();
    const a = snap.find((e) => e.toolCallId === "A");
    const b = snap.find((e) => e.toolCallId === "B");
    expect(a.status).to.equal("error");
    expect(a.errorCategory).to.equal("not_found");
    expect(b.status).to.equal("ok");
  });

  it("falls back to tool-name match when toolCallId absent", () => {
    const buf = new TrajectoryBuffer();
    buf.record("grep", "p=1"); // no toolCallId
    buf.markResult("grep", true, "validation");
    const snap = buf.snapshot();
    expect(snap[0].status).to.equal("error");
    expect(snap[0].errorCategory).to.equal("validation");
  });

  it("snapshot returns a copy that does not mutate the buffer", () => {
    const buf = new TrajectoryBuffer();
    buf.record("grep", "x");
    const snap = buf.snapshot();
    snap[0].tool = "mutated";
    expect(buf.snapshot()[0].tool).to.equal("grep");
  });

  it("counts multiple error→ok cycles per tool", () => {
    const buf = new TrajectoryBuffer();
    // error → ok → error → ok = 2 recoveries.
    buf.record("edit", "f=1", "c1");
    buf.markResult("edit", true, "validation", "c1");
    buf.record("edit", "f=1", "c2");
    buf.markResult("edit", false, undefined, "c2");
    buf.record("edit", "f=2", "c3");
    buf.markResult("edit", true, "parse", "c3");
    buf.record("edit", "f=2", "c4");
    buf.markResult("edit", false, undefined, "c4");
    expect(buf.errorCount).to.equal(2);
    expect(buf.size).to.equal(4);
  });
});

describe("digestInput", () => {
  it("truncates long input to maxLen", () => {
    // Use a realistic long command string (not a uniform-char run, which the
    // secret redactor could mangle if it matched a pattern).
    const long = "npm install " + "package-".repeat(40);
    const d = digestInput({ cmd: long }, 50);
    expect(d.length).to.be.lessThanOrEqual(52); // 50 + ellipsis
    expect(d.endsWith("…")).to.equal(true);
  });

  it("redacts key=value secrets (JSON)", () => {
    const d = digestInput({ api_key: "sk-secret1234567890" });
    expect(d).to.include("[REDACTED]");
    expect(d).to.not.include("sk-secret");
  });

  it("redacts space-containing secret values fully", () => {
    const d = digestInput({ password: "my passphrase here" });
    expect(d).to.not.include("passphrase");
    expect(d).to.not.include("here");
    expect(d).to.include("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const d = digestInput({ Authorization: "Bearer abc.def.ghi" });
    expect(d).to.not.include("abc.def.ghi");
  });

  it("redacts full base64 Bearer tokens with + and =", () => {
    const d = digestInput({ Authorization: "Bearer Zm9vYmFy+YmF6=" });
    expect(d).to.not.include("Zm9vYmFy");
    expect(d).to.not.include("+YmF6");
    expect(d).to.include("[REDACTED]");
  });

  it("redacts unquoted key=value secrets in raw command strings", () => {
    const d = digestInput("export API_KEY=sk-secret123 && curl https://x");
    expect(d).to.not.include("sk-secret123");
    expect(d).to.include("[REDACTED]");
  });

  it("does NOT redact prose mentions of secret-ish words", () => {
    const d = digestInput("echo rotate the password carefully tomorrow");
    expect(d).to.include("password carefully");
    expect(d).to.not.include("[REDACTED]");
  });

  it("returns empty string for null/undefined", () => {
    expect(digestInput(null)).to.equal("");
    expect(digestInput(undefined)).to.equal("");
  });

  it("handles circular references gracefully", () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    const d = digestInput(obj);
    expect(d).to.include("unserializable");
  });

  it("does not split a surrogate pair on truncation", () => {
    // 199 ASCII chars + a 4-byte emoji (surrogate pair).
    const input = "a".repeat(199) + "😀";
    const d = digestInput(input, 200);
    expect(d.endsWith("…")).to.equal(true);
    // The emoji should not appear as a lone surrogate.
    const chars = Array.from(d);
    expect(chars[chars.length - 1]).to.equal("…");
  });
});

describe("categorizeError", () => {
  it("classifies into known buckets", () => {
    expect(categorizeError("Operation timed out")).to.equal("timeout");
    expect(categorizeError("ECONNREFUSED")).to.equal("network");
    expect(categorizeError("Unauthorized access")).to.equal("auth");
    expect(categorizeError("File not found")).to.equal("not_found");
    expect(categorizeError("validation failed")).to.equal("validation");
    expect(categorizeError("unexpected token }")).to.equal("parse");
    expect(categorizeError("something weird")).to.equal("generic");
    expect(categorizeError("")).to.equal(undefined);
  });
});
