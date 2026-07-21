// ponytail: hardcoded 3 retries, 1s/10s/2x, no customization — add params when a caller needs them

import { classifyError } from "./helpers";

/** Retry with exponential backoff. Never retries auth, not_found, or validation errors. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const retryableTypes = new Set(["timeout", "network", "rate_limit"]);
  for (let i = 0; i <= 3; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === 3 || !retryableTypes.has(classifyError(error).type)) throw error;
      const delay = Math.min(1000 * 2 ** i + Math.random() * 100 * 2 ** i, 10000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Munin retry loop exhausted");
}
