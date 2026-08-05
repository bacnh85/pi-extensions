/**
 * pi-budget — spend cap enforcement for Pi.
 *
 * Halts the agent when cumulative session cost exceeds a `--budget <usd>` cap.
 * Companion to pi-sub: pi-sub *renders* subscription usage, pi-budget *enforces*
 * a spend policy. Zero deps, plain JS (pi-ux/pi-ponytail pattern).
 *
 * Flag: `--budget <usd>` (e.g. `pi --budget 0.50`). Parsed at startup and
 * lazily re-read on the first message if no session_start has fired yet.
 * Cost source: `message_end` assistant messages (`usage.cost.total`).
 * Enforcement: `ctx.abort()` + notify + one custom entry for the session record.
 * Reset: new session (`session_start`) = fresh budget. Compaction does NOT reset
 * (compaction is mid-session).
 *
 * Limitation (ponytail: parent-only budget): pi-subagent children are separate
 * sessions, so child spend is not visible here. Aggregate from tool_result if
 * child spend leaks — see CHANGELOG.
 */

const STATUS_KEY = "pi-budget";

/**
 * Parse a `--budget` value into a positive number, or undefined when unset/invalid.
 * Accepts only plain decimals ("0.50", "5"); rejects currency suffixes, European
 * decimals, scientific notation, and hex ("5 USD", "0,50", "1e3", "0x10") so a
 * typo can never silently become a different cap — the caller warns on rejection.
 */
export function parseBudgetCap(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

export default function budgetExtension(pi) {
  // Session-scoped state. `exceeded` guards so abort fires exactly once per session.
  const state = {
    budgetCap: undefined,
    cumulativeCost: 0,
    exceeded: false,
    // Idempotency: message IDs already counted (guards double-count on
    // retry/replay when the host re-fires message_end for the same message).
    countedMessageIds: new Set(),
    budgetInitAttempted: false,
  };

  pi.registerFlag("budget", {
    description: "Max USD spend before auto-abort (e.g. 0.50)",
    type: "string",
  });

  pi.on("session_start", (event, ctx) => {
    const raw = pi.getFlag("budget");
    state.budgetCap = parseBudgetCap(raw);
    state.cumulativeCost = 0;
    state.exceeded = false;
    state.countedMessageIds = new Set();
    if (raw !== undefined && raw !== null && raw !== "" && state.budgetCap === undefined) {
      // A non-empty flag we couldn't parse means the user asked for a cap that
      // will NOT be enforced. Say so — silent disable is a false sense of safety.
      try {
        ctx.ui.notify(`Invalid --budget value "${raw}"; spend enforcement disabled.`, "warning");
      } catch { /* best-effort UI */ }
    }
  });

  pi.on("message_end", (event, ctx) => {
    // Lazy init: if message_end ever fires before session_start (host ordering
    // edge), still enforce rather than silently dropping the first message's cost.
    if (state.budgetCap === undefined && !state.budgetInitAttempted) {
      state.budgetInitAttempted = true;
      state.budgetCap = parseBudgetCap(pi.getFlag("budget"));
    }

    if (event.message?.role === "assistant") {
      const cost = Number(event.message.usage?.cost?.total);
      if (Number.isFinite(cost) && cost > 0) {
        const id = event.message.id;
        if (!id || !state.countedMessageIds.has(id)) {
          state.cumulativeCost += cost;
          if (id) state.countedMessageIds.add(id);
        }
      }
      // NaN/Infinity/string costs are skipped (Number.isFinite guard) so a bad
      // provider response can never poison the accumulator into a permanent
      // NaN >= cap === false bypass.

      if (!state.exceeded && state.budgetCap !== undefined && state.cumulativeCost >= state.budgetCap) {
        state.exceeded = true;
        // Enforcement first; UI side effects are best-effort and must not be
        // able to skip the abort.
        try {
          ctx.abort();
        } catch { /* still recorded below */ }
        try {
          ctx.ui.notify(
            `Budget cap reached: $${state.cumulativeCost.toFixed(2)} / $${state.budgetCap.toFixed(2)}. Aborting.`,
            "warning",
          );
        } catch { /* best-effort UI */ }
        try {
          pi.appendEntry("budget-exceeded", { cap: state.budgetCap, spent: state.cumulativeCost });
        } catch { /* best-effort */ }
      }
    }

    // Footer: best-effort, must never throw out of the handler (theme proxy may
    // not be initialized yet — pi-ponytail guards the same pattern).
    try {
      if (state.budgetCap === undefined) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const remaining = Math.max(0, state.budgetCap - state.cumulativeCost);
      const line = `Budget $${state.cumulativeCost.toFixed(2)} / $${state.budgetCap.toFixed(2)}`;
      const color = state.exceeded ? "error" : remaining <= state.budgetCap * 0.2 ? "warning" : "dim";
      if (!ctx.ui.theme?.fg) return;
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, line));
    } catch { /* best-effort footer */ }
  });
}
