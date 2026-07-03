// Retry logic with exponential backoff for transient network failures.
// Ported from pi-munin/lib/retry.ts.

export interface RetryOptions {
	maxRetries?: number;
	initialDelay?: number;
	maxDelay?: number;
	multiplier?: number;
	retryableErrors?: string[];
	onRetry?: (attempt: number, max: number, delay: number, error: Error) => void;
}

function isRetryableError(error: Error): boolean {
	const errorMessage = (error.message || "").toLowerCase();
	const retryablePatterns = [
		"econnrefused",
		"enotfound",
		"etimedout",
		"econnreset",
		"econnaborted",
		"enetunreach",
		"etimeout",
		"timeout",
		"network",
		"socket hang up",
		"socket",
		"connection",
		"fetch",
		"request timeout",
	];
	return retryablePatterns.some((pattern) => errorMessage.includes(pattern));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateDelay(
	attempt: number,
	initialDelay: number,
	maxDelay: number,
	multiplier: number,
): number {
	const exponentialDelay = initialDelay * Math.pow(multiplier, attempt);
	const jitter = Math.random() * 0.1 * exponentialDelay;
	return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * Retry a function with exponential backoff.
 * Never retries auth, not_found, or validation errors.
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const {
		maxRetries = 3,
		initialDelay = 1000,
		maxDelay = 10000,
		multiplier = 2,
		retryableErrors = [],
		onRetry,
	} = options;

	// Errors we never retry (non-transient)
	const nonRetryablePatterns = [
		"unauthorized",
		"invalid api key",
		"not found",
		"validation",
		"required",
		"refusing to send",
		"refusing to send a configured",
		"must use http or https",
		"could not extract readable content",
		"brave_api_key is required",
		"firecrawl_api_key is required",
	];

	let lastError: Error;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error as Error;

			if (attempt === maxRetries) throw error;

			// Never retry non-transient errors
			const msg = lastError.message.toLowerCase();
			if (nonRetryablePatterns.some((p) => msg.includes(p))) throw error;

			// Check if error is retryable
			const shouldRetry =
				retryableErrors.length > 0
					? retryableErrors.some((pattern) => msg.includes(pattern.toLowerCase()))
					: isRetryableError(lastError);

			if (!shouldRetry) throw error;

			const delay = calculateDelay(attempt, initialDelay, maxDelay, multiplier);

			if (onRetry) {
				onRetry(attempt + 1, maxRetries + 1, delay, lastError);
			}

			await sleep(delay);
		}
	}

	throw lastError!;
}

/**
 * Combine a timeout signal with an optional external signal.
 */
export function signalWithTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!signal) return timeoutSignal;
	return AbortSignal.any([signal, timeoutSignal]);
}

/**
 * Sleep that is abortable via an AbortSignal.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Operation aborted."));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(cleanupResolve, ms);
		function cleanupResolve() {
			signal?.removeEventListener("abort", cleanupReject);
			resolve();
		}
		function cleanupReject() {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("Operation aborted."));
		}
		signal?.addEventListener("abort", cleanupReject, { once: true });
	});
}
