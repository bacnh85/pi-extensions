import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import { runIsolatedChain } from "../lib/isolated-model";

/** Model ref that parseModel resolves; provider name is arbitrary. */
const MODEL = "fake/timeout-model";

interface FakeOptions {
  signal?: AbortSignal;
}

type FakeResponse = AsyncIterable<{ type: string; delta?: string }> & {
  result(): Promise<{ stopReason: string; content: Array<{ type: string; text?: string }> }>;
};

/** Response that streams `count` deltas `intervalMs` apart, then completes —
 *  total duration exceeds the deadline while each idle gap stays under it.
 *  Honors abort like the real streamSimple: an abort mid-stream surfaces as
 *  an error (iterator/result reject), never as a successful completion. */
function slowAliveResponse(options: FakeOptions, intervalMs: number, count: number, text: string): FakeResponse {
  const signal = options.signal;
  let remaining = count;
  const abortError = () => new Error("SLOW-ALIVE-ABORTED: stream killed mid-stream");
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (remaining <= 0) return { done: true, value: undefined as never };
          remaining--;
          const sleep = new Promise((r) => setTimeout(r, intervalMs));
          const aborted = new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          await Promise.race([sleep, aborted]);
          if (signal?.aborted) throw abortError();
          return { done: false, value: { type: "text_delta", delta: text } };
        },
      };
    },
    async result() {
      if (signal?.aborted) throw abortError();
      return { stopReason: "stop", content: [{ type: "text", text }] };
    },
  };
}

/** Response that never yields data but honors abort like the real streamSimple:
 *  the iterator stalls until the signal fires, then result() rejects. */
function hangingResponse(signal: AbortSignal | undefined): FakeResponse {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (!signal || signal.aborted) return { done: true, value: undefined as never };
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { done: true, value: undefined as never };
        },
      };
    },
    async result() {
      if (signal?.aborted) throw new Error("CANDIDATE-ABORT-MARKER: stream killed by abort");
      await new Promise(() => {}); // never resolves when not aborted
      return {} as never;
    },
  };
}

/** Response that streams text normally. */
function goodResponse(text: string): FakeResponse {
  return {
    [Symbol.asyncIterator]() {
      return (async function* () {
        yield { type: "text_delta", delta: text };
      })();
    },
    async result() {
      return { stopReason: "stop", content: [{ type: "text", text }] };
    },
  };
}

type FakeProvider = (model: unknown, context: unknown, options: FakeOptions) => unknown;

function fakeCtx(provider: FakeProvider): unknown {
  return {
    model: undefined,
    getSystemPrompt: () => "",
    modelRegistry: {
      find: () => ({ id: "timeout-model", provider: "fake" }),
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k", headers: {}, env: {} }),
      getRegisteredProviderConfig: () => ({ streamSimple: provider }),
    },
  };
}

describe("runIsolatedChain candidate deadline", () => {
  it("a hung first candidate times out and the chain serves the next model", async function () {
    this.timeout(5000);
    let calls = 0;
    const provider: FakeProvider = (_model, _context, options) => {
      calls++;
      return calls === 1 ? hangingResponse(options.signal) : goodResponse("ok");
    };
    const result = await runIsolatedChain(
      fakeCtx(provider) as never,
      [MODEL, MODEL],
      { systemPrompt: "s", messages: [] },
      undefined,
      undefined,
      undefined,
      100,
    );
    assert.equal(result.text, "ok");
    assert.equal(result.model, MODEL);
  });

  it("a slow-but-alive stream survives the deadline (idle, not total)", async function () {
    this.timeout(5000);
    // 5 deltas × 40ms = 200ms total > timeoutMs=100, but no idle gap reaches it.
    let calls = 0;
    const provider: FakeProvider = (_model, _context, options) => {
      calls++;
      return slowAliveResponse(options, 40, 5, "slow-ok");
    };
    const result = await runIsolatedChain(
      fakeCtx(provider) as never,
      [MODEL],
      { systemPrompt: "s", messages: [] },
      undefined,
      undefined,
      undefined,
      100,
    );
    assert.equal(result.text, "slow-ok");
    assert.equal(calls, 1);
  });

  it("caller abort still aborts without falling through", async function () {
    this.timeout(5000);
    let calls = 0;
    const provider: FakeProvider = (_model, _context, options) => {
      calls++;
      return hangingResponse(options.signal);
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      runIsolatedChain(fakeCtx(provider) as never, [MODEL, MODEL], { systemPrompt: "s", messages: [] }, undefined, controller.signal),
      /CANDIDATE-ABORT-MARKER/,
    );
    // The ORIGINAL candidate error must surface (exact-marker match above):
    // if the catch-side `signal?.aborted` rethrow were removed, the chain
    // would swallow it and the loop-top check would throw the generic
    // "Advisor call aborted" instead, failing this assertion.
    assert.equal(calls, 1);
  });

  it("an erroring first candidate falls through to a good one (existing chain behavior)", async function () {
    this.timeout(5000);
    let calls = 0;
    const provider: FakeProvider = () => {
      calls++;
      if (calls === 1) throw new Error("rate limited");
      return goodResponse("ok");
    };
    const result = await runIsolatedChain(fakeCtx(provider) as never, [MODEL, MODEL], { systemPrompt: "s", messages: [] });
    assert.equal(result.text, "ok");
    assert.deepEqual(calls, 2);
  });
});
