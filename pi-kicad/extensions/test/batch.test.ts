import { assert } from "chai";
import { runBatch, summarizeBatch, type BatchOp } from "../lib/batch.js";

describe("batch", () => {
  it("runs ops strictly sequentially (callFn awaited in order)", async () => {
    const order: string[] = [];
    const callFn = async (op: BatchOp) => {
      order.push(op.tool);
      // force interleaving opportunity; sequential means order is deterministic
      await new Promise((r) => setTimeout(r, 1));
      order.push(`done:${op.tool}`);
      return { content: [{ text: JSON.stringify({ ok: true, tool: op.tool }) }] };
    };
    const outcome = await runBatch(
      [{ tool: "a" }, { tool: "b" }, { tool: "c" }],
      callFn,
    );
    assert.deepEqual(order, ["a", "done:a", "b", "done:b", "c", "done:c"], "no interleaving");
    assert.equal(outcome.errors, 0);
    assert.isFalse(outcome.stopped);
    assert.equal(outcome.results.length, 3);
  });

  it("parses JSON payloads and flags isError from the result body", async () => {
    const callFn = async (op: BatchOp) =>
      op.tool === "bad"
        ? { content: [{ text: JSON.stringify({ error: { message: "boom" } }) }], isError: true }
        : { content: [{ text: JSON.stringify({ added: "x" }) }] };
    const outcome = await runBatch([{ tool: "good" }, { tool: "bad" }], callFn);
    assert.isFalse(outcome.results[0].isError);
    assert.deepEqual(outcome.results[0].result, { added: "x" });
    assert.isTrue(outcome.results[1].isError);
    assert.deepEqual(outcome.results[1].result, { error: { message: "boom" } });
    assert.equal(outcome.errors, 1);
  });

  it("catches a throwing callFn as an error result", async () => {
    const callFn = async (op: BatchOp) => {
      if (op.tool === "throw") throw new Error("network");
      return { content: [{ text: "{}" }] };
    };
    const outcome = await runBatch([{ tool: "throw" }, { tool: "ok" }], callFn);
    assert.isTrue(outcome.results[0].isError);
    assert.equal(outcome.results[0].error, "network");
    assert.isFalse(outcome.results[1].isError);
    assert.equal(outcome.errors, 1);
  });

  it("stops on first error when stopOnError is set", async () => {
    let calls = 0;
    const callFn = async (op: BatchOp) => {
      calls++;
      return op.tool === "bad"
        ? { content: [{ text: JSON.stringify({ error: { message: "x" } }) }] }
        : { content: [{ text: "{}" }] };
    };
    const outcome = await runBatch(
      [{ tool: "ok" }, { tool: "bad" }, { tool: "never" }],
      callFn,
      { stopOnError: true },
    );
    assert.isTrue(outcome.stopped);
    assert.equal(calls, 2, "did not call the op after the error");
    assert.equal(outcome.results.length, 2);
  });

  it("summarizeBatch marks ok/failed ops", () => {
    const s = summarizeBatch({
      results: [
        { index: 0, tool: "load_toolset", ok: true, isError: false },
        { index: 1, tool: "create_symbol", ok: false, isError: true, error: "IO error" },
      ],
      errors: 1,
      stopped: false,
    });
    assert.match(s, /2 ops, 1 error/);
    assert.match(s, /✓ \[0\] load_toolset/);
    assert.match(s, /✗ \[1\] create_symbol: IO error/);
  });
});
