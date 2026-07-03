/**
 * Unit tests for pi-web retry module.
 */

import { expect } from "chai";
import { withRetry, signalWithTimeout } from "../../lib/retry";

describe("withRetry", () => {
	it("resolves when function succeeds on first try", async () => {
		const result = await withRetry(async () => "success");
		expect(result).to.equal("success");
	});

	it("retries on transient error and eventually succeeds", async () => {
		let attempts = 0;
		const result = await withRetry(async () => {
			attempts++;
			if (attempts < 3) throw new Error("ETIMEDOUT connection timeout");
			return "ok";
		}, { maxRetries: 3, initialDelay: 10, maxDelay: 50 });
		expect(result).to.equal("ok");
		expect(attempts).to.equal(3);
	});

	it("throws after exhausting retries", async () => {
		let attempts = 0;
		try {
			await withRetry(async () => {
				attempts++;
				throw new Error("ETIMEDOUT timeout");
			}, { maxRetries: 2, initialDelay: 10, maxDelay: 50 });
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("ETIMEDOUT");
			expect(attempts).to.equal(3); // initial + 2 retries
		}
	});

	it("does not retry non-retryable errors (auth)", async () => {
		let attempts = 0;
		try {
			await withRetry(async () => {
				attempts++;
				throw new Error("unauthorized: invalid api key");
			}, { maxRetries: 3 });
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("unauthorized");
			expect(attempts).to.equal(1);
		}
	});

	it("does not retry validation errors", async () => {
		let attempts = 0;
		try {
			await withRetry(async () => {
				attempts++;
				throw new Error("validation error: required field missing");
			}, { maxRetries: 3 });
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(attempts).to.equal(1);
		}
	});

	it("calls onRetry callback on each retry", async () => {
		const retries: number[] = [];
		let attempts = 0;
		try {
			await withRetry(async () => {
				attempts++;
				throw new Error("ETIMEDOUT timeout");
			}, {
				maxRetries: 2,
				initialDelay: 10,
				maxDelay: 50,
				onRetry: (attempt, max, delay) => {
					retries.push(attempt);
				},
			});
		} catch (_e) {
			// expected
		}
		expect(retries).to.have.length(2);
	});

	it("uses custom retryableErrors when provided", async () => {
		let attempts = 0;
		try {
			await withRetry(async () => {
				attempts++;
				throw new Error("custom transient glitch");
			}, { maxRetries: 2, initialDelay: 10, maxDelay: 50, retryableErrors: ["glitch"] });
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("glitch");
			expect(attempts).to.equal(3);
		}
	});

	it("does not retry when custom retryableErrors does not match", async () => {
		let attempts = 0;
		try {
			await withRetry(async () => {
				attempts++;
				throw new Error("some other error");
			}, { maxRetries: 2, initialDelay: 10, maxDelay: 50, retryableErrors: ["glitch"] });
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(attempts).to.equal(1);
		}
	});
});

describe("signalWithTimeout", () => {
	it("returns a timeout signal when no external signal provided", () => {
		const signal = signalWithTimeout(5000);
		expect(signal).to.be.instanceOf(AbortSignal);
		expect(signal.aborted).to.be.false;
	});

	it("combines timeout with external signal", () => {
		const external = new AbortController().signal;
		const combined = signalWithTimeout(5000, external);
		expect(combined).to.be.instanceOf(AbortSignal);
	});

	it("signal aborts after timeout", async () => {
		const signal = signalWithTimeout(50);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(signal.aborted).to.be.true;
	}).timeout(500);

	it("signal aborts when external signal aborts", async () => {
		const controller = new AbortController();
		const signal = signalWithTimeout(5000, controller.signal);
		controller.abort();
		expect(signal.aborted).to.be.true;
	});
});
