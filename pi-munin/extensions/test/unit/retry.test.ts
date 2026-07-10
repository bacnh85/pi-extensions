/**
 * Unit tests for retry logic.
 */

import { expect } from "chai";
import { withRetry } from "../../lib/retry";

describe("withRetry", () => {
	it("returns result on first success", async () => {
		const result = await withRetry(async () => "ok");
		expect(result).to.equal("ok");
	});

	it("retries on transient errors", async () => {
		let attempts = 0;
		const result = await withRetry(async () => {
			attempts++;
			if (attempts < 2) throw new Error("ECONNREFUSED");
			return "recovered";
		});
		expect(result).to.equal("recovered");
		expect(attempts).to.equal(2);
	});

	it("retries on network errors", async () => {
		let attempts = 0;
		await withRetry(async () => {
			attempts++;
			if (attempts < 3) throw new Error("socket hang up");
			return "ok";
		});
		expect(attempts).to.equal(3);
	});

	it("retries on timeout errors", async () => {
		let attempts = 0;
		await withRetry(async () => {
			attempts++;
			if (attempts < 2) throw new Error("ETIMEDOUT");
			return "ok";
		});
		expect(attempts).to.equal(2);
	});

	it("throws after max retries", async () => {
		let attempts = 0;
		try {
			await withRetry(async () => {
				attempts++;
				throw new Error("ECONNREFUSED");
			});
			expect.fail("Should have thrown");
		} catch (err) {
			expect((err as Error).message).to.include("ECONNREFUSED");
		}
		expect(attempts).to.equal(4); // initial + 3 retries
	});

	it("does NOT retry auth errors", async () => {
		let attempts = 0;
		try {
			await withRetry(async () => {
				attempts++;
				throw new Error("Unauthorized");
			});
			expect.fail("Should have thrown");
		} catch (err) {
			expect((err as Error).message).to.include("Unauthorized");
		}
		expect(attempts).to.equal(1);
	});

	it("does NOT retry not_found errors", async () => {
		let attempts = 0;
		try {
			await withRetry(async () => {
				attempts++;
				throw new Error("Memory not found");
			});
			expect.fail("Should have thrown");
		} catch (err) {
			expect((err as Error).message).to.include("not found");
		}
		expect(attempts).to.equal(1);
	});

	it("does NOT retry stale protocol errors", async () => {
		let attempts = 0;
		try {
			await withRetry(async () => {
				attempts++;
				throw new Error("Stale protocol");
			});
			expect.fail("Should have thrown");
		} catch (err) {
			expect((err as Error).message).to.include("Stale protocol");
		}
		expect(attempts).to.equal(1);
	});

	it("does NOT retry ERR_STALE_PROTOCOL errors", async () => {
		let attempts = 0;
		try {
			await withRetry(async () => {
				attempts++;
				throw new Error("ERR_STALE_PROTOCOL");
			});
			expect.fail("Should have thrown");
		} catch (err) {
			expect((err as Error).message).to.include("ERR_STALE_PROTOCOL");
		}
		expect(attempts).to.equal(1);
	});

	it("does NOT retry validation errors", async () => {
		let attempts = 0;
		try {
			await withRetry(async () => {
				attempts++;
				throw new Error("Tag validation failed");
			});
			expect.fail("Should have thrown");
		} catch (err) {
			expect((err as Error).message).to.include("validation");
		}
		expect(attempts).to.equal(1);
	});
});
