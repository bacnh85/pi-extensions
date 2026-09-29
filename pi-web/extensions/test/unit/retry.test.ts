/**
 * Unit tests for pi-web retry module: transient-only policy, clamp bounds.
 */

import { expect } from "chai";
import { HttpError, withRetry, signalWithTimeout } from "../../lib/retry";

describe("withRetry transient policy", () => {
  it("does not retry 401 (surfaces on first attempt)", async () => {
    let calls = 0;
    const fn = async (): Promise<never> => {
      calls++;
      throw new HttpError(401, "Unauthorized", "");
    };
    let caught: unknown;
    try {
      await withRetry(fn, 3);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(HttpError);
    expect(calls).to.equal(1);
  });

  it("does not retry 403", async () => {
    let calls = 0;
    const fn = async (): Promise<never> => {
      calls++;
      throw new HttpError(403, "Forbidden", "");
    };
    let caught: unknown;
    try {
      await withRetry(fn, 3);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(HttpError);
    expect(calls).to.equal(1);
  });

  it("retries 408 (Request Timeout) then succeeds", async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      if (calls++ === 0) throw new HttpError(408, "Request Timeout", "");
      return "ok";
    };
    expect(await withRetry(fn, 3)).to.equal("ok");
    expect(calls).to.equal(2);
  });

  it("retries 429 then succeeds", async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      if (calls++ === 0) throw new HttpError(429, "Too Many Requests", "");
      return "ok";
    };
    expect(await withRetry(fn, 3)).to.equal("ok");
    expect(calls).to.equal(2);
  });

  it("retries 500 then succeeds", async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      if (calls++ === 0) throw new HttpError(500, "Server Error", "");
      return "ok";
    };
    expect(await withRetry(fn, 3)).to.equal("ok");
    expect(calls).to.equal(2);
  });

  it("retries statusless network errors (generic Error)", async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      if (calls++ === 0) throw new Error("fetch failed");
      return "ok";
    };
    expect(await withRetry(fn, 3)).to.equal("ok");
    expect(calls).to.equal(2);
  });

  it("throws the last error after exhausting attempts on 500", async () => {
    let calls = 0;
    const fn = async (): Promise<never> => {
      calls++;
      throw new HttpError(500, "Server Error", "");
    };
    let caught: unknown;
    try {
      await withRetry(fn, 3);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(HttpError);
    expect(calls).to.equal(3);
  });
});

describe("signalWithTimeout clamp", () => {
  it("clamps sub-1000ms up to 1000ms (abort fires after >=1s, not instantly)", () => {
    const s = signalWithTimeout(50);
    let abortedAt = 0;
    s.addEventListener("abort", () => (abortedAt = Date.now()));
    const start = Date.now();
    return new Promise<void>((resolve) => setTimeout(resolve, 1100)).then(() => {
      expect(abortedAt).to.be.at.least(start + 1000);
    });
  });

  it("clamps huge timeouts down to 600000ms (not aborted immediately)", () => {
    const s = signalWithTimeout(3_600_000);
    expect(s.aborted).to.equal(false);
  });

  it("passes in-range values through", () => {
    const s = signalWithTimeout(5000);
    expect(s.aborted).to.equal(false);
  });
});
