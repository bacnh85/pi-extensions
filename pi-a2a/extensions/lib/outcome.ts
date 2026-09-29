/**
 * Terminal-outcome check for a dispatched child session (fleet tasks #314,
 * #425). A child's run "finishes" whenever the agent loop ends, but that
 * includes endings with no usable answer. Returning normally from those hands
 * the dispatcher a COMPLETED task with a stale or empty "(no reply)" — the
 * false-success trap. Each case here returns an error message (the runner
 * throws it so the task maps to FAILED), or null when the run really produced
 * an answer.
 */
export interface TerminalState {
  /** stopReason of the LAST assistant message, if any arrived. */
  stopReason?: string;
  /** Whether that last assistant message carried any text. */
  hadText: boolean;
  /** Whether any assistant message arrived at all. */
  sawAssistant: boolean;
  /** errorMessage of the last assistant message (provider/transport error). */
  errorMessage?: string;
}

export function terminalOutcomeError(s: TerminalState): string | null {
  if (!s.sawAssistant) {
    return "run ended without any assistant output — the model produced nothing (provider unreachable or request rejected before a response?)";
  }
  if (s.stopReason === "error") {
    // The provider/transport failed the final turn (e.g. HTTP 503 "no available
    // channel"). Any text in `reply` belongs to an EARLIER turn, so it is stale.
    const detail = (s.errorMessage ?? "").trim().slice(0, 500);
    return `model call failed on the final turn${detail ? `: ${detail}` : ""} — no usable reply was produced`;
  }
  if (s.stopReason === "length" && !s.hadText) {
    return "run ended on a length stop with no assistant text — no usable reply was produced (output capped before any content; context-clamped max_tokens?)";
  }
  return null;
}

/**
 * Detect + strip a trailing [INPUT_REQUIRED] marker from a final assistant
 * reply. Only a marker at the trimmed TAIL counts — a peer merely QUOTING the
 * marker mid-text must neither flip the state nor mangle the quoted text, and
 * only that one trailing occurrence is removed.
 */
export function stripInputRequired(reply: string): { text: string; inputRequired: boolean } {
  const m = /\[INPUT_REQUIRED\]\s*$/i.exec(reply);
  return m
    ? { text: reply.slice(0, m.index).trim(), inputRequired: true }
    : { text: reply, inputRequired: false };
}
