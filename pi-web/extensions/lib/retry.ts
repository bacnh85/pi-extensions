// Retry utility: signal/timeout helpers.

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
