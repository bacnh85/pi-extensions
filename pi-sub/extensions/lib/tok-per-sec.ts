/** tok-per-sec.ts — response-speed math shared by the footer and /sub details.
 *
 * Reasoning models bill thinking time into wall-clock but report the tokens
 * under a different usage field per provider; accept the known spellings. */

export function readThinkingTokens(usage: any): number {
  return usage?.thinking ?? usage?.reasoning ?? usage?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens ?? 0;
}

export function computeTokPerSec(output: number, thinking: number, elapsedMs: number): { out: number; withThinking: number } {
  const seconds = elapsedMs / 1000;
  return {
    out: Math.round(output / seconds),
    withThinking: Math.round((output + thinking) / seconds),
  };
}
