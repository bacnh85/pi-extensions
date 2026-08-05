/**
 * Fallback-model detection for pi-plan.
 *
 * Detects provider overload / rate-limit errors on assistant messages and
 * resolves the next model in a configured fallback chain.
 *
 * ponytail: pattern list mirrors pi-subagent's RATE_LIMIT_PATTERNS; extend as
 * providers surface new error shapes.
 */

export const OVERLOAD_PATTERNS = [
  /\b429\b/,
  /\b529\b/,
  /rate[\s_]limit/i,
  /ratelimit/i,
  /too[\s_]many[\s_]requests/i,
  /quota[\s_]exhausted/i,
  /quota[\s_]exceeded/i,
  /exceeded[\s_](?:your[\s_])?(?:current[\s_])?quota/i,
  /insufficient_quota/i,
  /resource[\s_]exhausted/i,
  /capacity[\s_]exceeded/i,
  /usage[\s_]limit/i,
  /overloaded/i,
  /server[\s_]overloaded/i,
  /temporarily[\s_]unavailable/i,
  /try[\s_]again[\s_]later/i,
  /service[\s_]busy/i,
  /server[\s_]busy/i,
  /load[\s_]shed/i,
  /503\b/i,
];

/** True when an assistant error message looks like a provider overload / rate limit. */
export function isOverloadError(message: {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}): boolean {
  if (message?.role !== "assistant") return false;
  if (message.stopReason !== "error") return false;
  const text = message.errorMessage ?? "";
  return OVERLOAD_PATTERNS.some((p) => p.test(text));
}
