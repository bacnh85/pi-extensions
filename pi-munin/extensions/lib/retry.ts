// ponytail: hardcoded 3 retries, 1s/10s/2x, no customization — add params when a caller needs them

/** Retry with exponential backoff. Never retries auth, not_found, or validation errors. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
	const nonRetryable = ["unauthorized","invalid api key","not found","e2ee","encryption","stale protocol","validation","required","refusing to send"];
	const retryable = ["econnrefused","enotfound","etimedout","econnreset","econnaborted","enetunreach","etimeout","timeout","network","socket hang up","socket","connection","fetch","request timeout"];
	let last: Error | undefined;
	for (let i = 0; i <= 3; i++) {
		try { return await fn(); }
		catch (e) {
			last = e as Error;
			if (i === 3) throw e;
			const msg = last.message.toLowerCase().replace(/_/g, " ");
			if (nonRetryable.some(p => msg.includes(p))) throw e;
			if (!retryable.some(p => msg.includes(p))) throw e;
			const delay = Math.min(1000 * Math.pow(2, i) + Math.random() * 100 * Math.pow(2, i), 10000);
			await new Promise(r => setTimeout(r, delay));
		}
	}
	throw last!;
}
