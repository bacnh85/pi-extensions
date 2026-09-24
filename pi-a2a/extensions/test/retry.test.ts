import { describe, it } from "mocha";
import { assert } from "chai";
import { childRetrySettings, isTransientChannelError } from "../lib/retry.js";

describe("transient provider-error retry policy (#470)", () => {
  describe("childRetrySettings", () => {
    it("is a bounded, backoff-based budget (enabled, 2-3 retries, positive base delay)", () => {
      const s = childRetrySettings();
      assert.isTrue(s.enabled);
      assert.isAtLeast(s.maxRetries, 2, "must retry more than the stock single attempt");
      assert.isAtMost(s.maxRetries, 3, "bounded — a blip-absorber, not an outage-waiter");
      assert.isAbove(s.baseDelayMs, 0);
    });
  });

  describe("isTransientChannelError", () => {
    it("classifies the exact task #462 distributor 503 as transient", () => {
      assert.isTrue(
        isTransientChannelError(
          "503 model_not_found: No available channel for model claude-opus-4-8 under group default (distributor)",
        ),
      );
    });
    it("classifies 429/5xx/service-unavailable/network text as transient", () => {
      for (const m of [
        "429 rate limit exceeded",
        "500 internal error",
        "502 bad gateway",
        "503 service unavailable",
        "504 gateway timeout",
        "overloaded",
        "fetch failed",
        "connection refused",
        "socket hang up",
        "Provider returned error",
      ]) {
        assert.isTrue(isTransientChannelError(m), `expected transient: ${m}`);
      }
    });
    it("does NOT retry 4xx / permanent / model errors", () => {
      for (const m of [
        "400 bad request",
        "401 unauthorized",
        "404 model not found",
        "422 unprocessable entity",
        "invalid model configuration",
      ]) {
        assert.isFalse(isTransientChannelError(m), `expected non-transient: ${m}`);
      }
    });
    it("does NOT retry quota/billing exhaustion even when carried on a 503", () => {
      for (const m of [
        "insufficient_quota",
        "quota exceeded",
        "billing hard limit reached",
        "Monthly usage limit reached",
        "503: billing error — out of budget",
      ]) {
        assert.isFalse(isTransientChannelError(m), `expected non-transient: ${m}`);
      }
    });
    it("treats empty/missing error text as non-transient", () => {
      assert.isFalse(isTransientChannelError(undefined));
      assert.isFalse(isTransientChannelError(""));
      assert.isFalse(isTransientChannelError("   "));
    });
  });

  // End-to-end contract with a STUB PROVIDER (task #470 spec). This exercises
  // the REAL shipped classifier + budget against a fake model turn, mirroring
  // the SDK's retryAssistantCall loop (the loop pi-a2a delegates to). It pins
  // the two behaviors the fix promises: a transient blip that clears within
  // the budget completes the run; a persistent transient error stops after a
  // BOUNDED number of attempts rather than retrying forever.
  describe("bounded retry against a stub provider", () => {
    // Faithful re-statement of the SDK loop: try, and while the turn errors
    // with a transient error and the budget is not exhausted, back off and
    // retry. Returns the terminal turn and the attempt count.
    async function runTurn(
      produce: () => { stopReason: string; errorMessage?: string; text?: string },
      sleeps: number[] = [],
    ) {
      const { enabled, maxRetries, baseDelayMs } = childRetrySettings();
      let attempts = 0;
      let turn = produce();
      attempts++;
      while (
        enabled &&
        attempts <= maxRetries &&
        turn.stopReason === "error" &&
        isTransientChannelError(turn.errorMessage)
      ) {
        sleeps.push(baseDelayMs * 2 ** (attempts - 1)); // record backoff, don't actually wait
        turn = produce();
        attempts++;
      }
      return { turn, attempts };
    }

    it("503s twice then succeeds → run completes", async () => {
      let n = 0;
      const { turn, attempts } = await runTurn(() => {
        n++;
        if (n <= 2)
          return { stopReason: "error", errorMessage: "503 No available channel (distributor)" };
        return { stopReason: "stop", text: "done" };
      });
      assert.equal(turn.stopReason, "stop");
      assert.equal(turn.text, "done");
      assert.equal(attempts, 3, "initial + 2 retries");
    });

    it("always 503s → run errors after the bounded attempts, not forever", async () => {
      const sleeps: number[] = [];
      const { turn, attempts } = await runTurn(
        () => ({ stopReason: "error", errorMessage: "503 No available channel (distributor)" }),
        sleeps,
      );
      assert.equal(turn.stopReason, "error");
      // 1 initial + maxRetries retries, then it gives up.
      assert.equal(attempts, childRetrySettings().maxRetries + 1);
      assert.equal(sleeps.length, childRetrySettings().maxRetries, "one backoff per retry");
      // Backoff is strictly increasing (exponential), so it is not a busy loop.
      assert.deepEqual([...sleeps].sort((a, b) => a - b), sleeps);
    });

    it("a permanent 4xx error is not retried at all", async () => {
      const { turn, attempts } = await runTurn(() => ({
        stopReason: "error",
        errorMessage: "400 bad request: unknown parameter",
      }));
      assert.equal(turn.stopReason, "error");
      assert.equal(attempts, 1, "no retry on non-transient errors");
    });
  });
});
