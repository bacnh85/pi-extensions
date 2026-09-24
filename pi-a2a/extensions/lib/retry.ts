/**
 * Transient provider-error retry policy for dispatched child sessions
 * (fleet task #470, incident lesson f4b6578c).
 *
 * Background. A dispatched worker on 2026-09-23 (task #462) ran its full
 * investigation and then died on its FINAL model call with
 * `503 model_not_found: No available channel for model claude-opus-4-8 under
 * group default (distributor)` — stopReason=error, no reply, no receipt, the
 * knowfleet task left silently open. Channel availability on the new-api
 * distributor is transient by nature, so a bounded retry with backoff turns
 * this last-step failure class into a blip (same family as the glm-5.3
 * last-step stall, 104f48eb).
 *
 * Where the retry actually happens. pi's SDK agent loop already retries a
 * failed model turn in place — `retryAssistantCall` /
 * `isRetryableAssistantError` (@earendil-works/pi-ai) remove the errored
 * assistant message and re-run the SAME turn with exponential backoff, and
 * their retryable pattern already includes `503` / `429` / `5xx` / network
 * text while EXCLUDING quota/billing ("insufficient_quota", "billing",
 * "quota exceeded", usage-limit). That is exactly the narrow transient class
 * this task wants — never 4xx/permanent/model errors. The defect was purely
 * the BUDGET: the child runner pinned `retry.maxRetries` to 1 (a single 2s
 * retry) since the extension's first commit, undercutting the SDK default of
 * 3, so a channel blip lasting more than one short backoff killed the run.
 *
 * The fix is therefore to hand the child a bounded, backoff-based retry
 * budget ({@link childRetrySettings}) rather than to reimplement the retry
 * loop — reimplementing at the pi-a2a layer would mean re-running the whole
 * `prompt()` (re-executing every tool with side effects), whereas the SDK
 * retries just the failed model call against preserved session state.
 *
 * {@link isTransientChannelError} mirrors the SDK's classification so pi-a2a
 * can label an exhausted-retry terminal error clearly, and is the contract
 * the regression test pins with a stub provider.
 */

/** Retry policy shape consumed by the SDK's SettingsManager (`retry`). */
export interface ChildRetrySettings {
  enabled: boolean;
  /** Number of RETRIES after the initial attempt (total attempts = maxRetries + 1). */
  maxRetries: number;
  /** Base backoff; the SDK grows it as baseDelayMs * 2**(attempt-1). */
  baseDelayMs: number;
}

/**
 * Bounded transient-error retry budget for dispatched child sessions.
 *
 * 3 retries (4 attempts total) at 1s base backoff → ~1s + 2s + 4s ≈ 7s of
 * coverage across a channel-availability blip, then the run errors honestly
 * rather than retrying forever. Deliberately small: this is a blip-absorber,
 * not a way to wait out a sustained outage.
 */
export function childRetrySettings(): ChildRetrySettings {
  return { enabled: true, maxRetries: 3, baseDelayMs: 1000 };
}

// Quota / billing / account-limit exhaustion: deterministic, NOT transient —
// retrying only burns backoff before failing the same way. Mirrors the SDK's
// NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.
const NON_TRANSIENT_PATTERN =
  /insufficient_quota|out of budget|quota exceeded|billing|usage limit|available balance|GoUsageLimitError|FreeUsageLimitError/i;

// Transient provider/transport failures worth a bounded retry. Mirrors the
// SDK's RETRYABLE_PROVIDER_ERROR_PATTERN, plus the distributor's channel-
// availability wording ("no available channel", "model_not_found" as carried
// by the 503 in task #462). HTTP status codes are matched as whole tokens so
// a 4xx like 400/404 is never mistaken for a transient 5xx.
const TRANSIENT_PATTERN =
  /(^|[^0-9])(429|500|502|503|504|524)([^0-9]|$)|overloaded|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|no available channel|provider.?returned.?error|network.?error|connection.?(error|refused|lost)|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|stream ended before/i;

/**
 * Whether a failed model turn's error text looks like a TRANSIENT provider or
 * transport failure that is worth a bounded retry — as opposed to a 4xx,
 * permanent model/config error, or quota/billing exhaustion.
 *
 * Quota/billing is checked first: "503 ... billing" is treated as
 * non-transient because the deterministic signal dominates.
 */
export function isTransientChannelError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const msg = errorMessage.trim();
  if (!msg) return false;
  if (NON_TRANSIENT_PATTERN.test(msg)) return false;
  return TRANSIENT_PATTERN.test(msg);
}
