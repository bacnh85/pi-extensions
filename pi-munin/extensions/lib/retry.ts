// Retry logic with exponential backoff for transient network failures.
// ponytail: hardcoded 3 retries, 1s/10s/2x, no customization — add params when a caller needs them

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff.
 * Never retries auth, not_found, or validation errors.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
	const nonRetryablePatterns = [
		"unauthorized", "invalid api key", "not found",
		"e2ee", "encryption", "stale protocol",
		"validation", "required", "refusing to send",
	];
	const retryablePatterns = [
		"econnrefused", "enotfound", "etimedout",
		"econnreset", "econnaborted", "enetunreach",
		"etimeout", "timeout", "network",
		"socket hang up", "socket", "connection",
		"fetch", "request timeout",
	];

	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= 3; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error as Error;
			if (attempt === 3) throw error;

			const msg = lastError.message.toLowerCase();
			if (nonRetryablePatterns.some((p) => msg.includes(p))) throw error;
			if (!retryablePatterns.some((p) => msg.includes(p))) throw error;

			const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 0.1 * 1000 * Math.pow(2, attempt), 10000);
			await sleep(delay);
		}
	}

	throw lastError!;
}
