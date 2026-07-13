// ponytail: hardcoded 3 retries, 1s/10s/2x, no customization — add params when a caller needs them

import { classifyError } from "./helpers";

/** Retry with exponential backoff. Never retries auth, not_found, or validation errors. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
	const nonRetryableTypes = ["auth", "e2ee", "stale_protocol", "not_found"];
	const retryableTypes = ["timeout", "network"];
	let last: Error | undefined;
	for (let i = 0; i <= 3; i++) {
		try { return await fn(); }
		catch (e) {
			last = e as Error;
			if (i === 3) throw e;
			const classified = classifyError(e);
			if (nonRetryableTypes.includes(classified.type)) throw e;
			if (!retryableTypes.includes(classified.type)) throw e;
			const delay = Math.min(1000 * Math.pow(2, i) + Math.random() * 100 * Math.pow(2, i), 10000);
			await new Promise(r => setTimeout(r, delay));
		}
	}
}
