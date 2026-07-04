// Retry utility: signal/timeout helpers.

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
	let last: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try { return await fn(); }
		catch (error) {
			last = error;
			if (attempt === attempts - 1) break;
			await abortableSleep(1000 * 2 ** attempt);
		}
	}
	throw last ?? new Error("retry failed");
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
