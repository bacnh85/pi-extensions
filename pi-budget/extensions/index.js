/**
 * pi-budget — spend cap enforcement for Pi.
 *
 * Halts the agent when cumulative session cost exceeds a `--budget <usd>` cap.
 * Companion to pi-sub: pi-sub *renders* subscription usage, pi-budget *enforces*
 * a spend policy. Zero deps, plain JS (pi-ux/pi-ponytail pattern).
 *
 * Flag: `--budget <usd>` (e.g. `pi --budget 0.50`). Parsed once at extension
 * load; `session_start` only resets per-session accumulators.
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

/** ponytail: dedupe-set cap, evict-oldest at 1000 (insertion-ordered Set) —
 *  the last 1000 ids stay replay-deduped; only ids older than that window can
 *  be re-counted on replay, a bounded ceiling vs. unbounded growth; raise if
 *  replay windows ever grow. */
const MAX_COUNTED_MESSAGE_IDS = 1000;

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
  pi.registerFlag("budget", {
    description: "Max USD spend before auto-abort (e.g. 0.50)",
    type: "string",
  });

  // CLI flags are immutable after parse; capture once at load so event
  // handlers never touch the captured pi API (stale after session
  // replacement/reload — getFlag throws there).
  let rawBudget = undefined;
  try {
    rawBudget = pi.getFlag("budget");
  } catch {
    rawBudget = undefined;
  }

  // Session-scoped state. `exceeded` guards so the exceed path runs once per
  // session; `abortSucceeded` only latches after a successful ctx.abort(), so
  // a thrown abort is retried on later message_end events.
  const state = {
    budgetCap: parseBudgetCap(rawBudget),
    cumulativeCost: 0,
    exceeded: false,
    abortSucceeded: false,
    notified: false,
    // Idempotency: message IDs already counted (guards double-count on
    // retry/replay when the host re-fires message_end for the same message).
    countedMessageIds: new Set(),
  };

  pi.on("session_start", (event, ctx) => {
    state.cumulativeCost = 0;
    state.exceeded = false;
    state.abortSucceeded = false;
    state.notified = false;
    state.countedMessageIds = new Set();
    if (state.budgetCap === undefined) {
      // No cap configured: clear any footer left over from a previous capped
      // session instead of letting it linger until the first assistant reply.
      try {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      } catch { /* best-effort UI */ }
    }
    if (rawBudget !== undefined && rawBudget !== null && rawBudget !== "" && state.budgetCap === undefined) {
      // A non-empty flag we couldn't parse means the user asked for a cap that
      // will NOT be enforced. Say so — silent disable is a false sense of safety.
      try {
        ctx.ui.notify(`Invalid --budget value "${rawBudget}"; spend enforcement disabled.`, "warning");
      } catch { /* best-effort UI */ }
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message?.role === "assistant") {
      const cost = Number(event.message.usage?.cost?.total);
      if (Number.isFinite(cost) && cost > 0) {
        const id = event.message.id;
        if (!id || !state.countedMessageIds.has(id)) {
          state.cumulativeCost += cost;
          if (id) {
            // Evict-oldest: at capacity drop the first-inserted id only, so
            // recent ids keep replay-dedupe (clear-all reopened a window over
            // the entire set and let replayed events double-count).
            if (state.countedMessageIds.size >= MAX_COUNTED_MESSAGE_IDS) {
              state.countedMessageIds.delete(state.countedMessageIds.values().next().value);
            }
            state.countedMessageIds.add(id);
          }
        }
      }
      // NaN/Infinity/string costs are skipped (Number.isFinite guard) so a bad
      // provider response can never poison the accumulator into a permanent
      // NaN >= cap === false bypass.

      if (state.budgetCap !== undefined && state.cumulativeCost >= state.budgetCap) {
        state.exceeded = true;
        // Record + notify exactly once; retry the abort on subsequent
        // message_end events until one succeeds — a thrown abort must never
        // silently disable enforcement for the rest of the session.
        if (!state.abortSucceeded) {
          try {
            ctx.abort();
            state.abortSucceeded = true;
          } catch { /* retried on the next message_end */ }
        }
        if (!state.notified) {
          state.notified = true;
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
      // not be initialized yet — pi-ponytail guards the same pattern). Gated on
      // assistant messages for parity with the accumulation above.
      try {
        if (state.budgetCap === undefined) {
          ctx.ui.setStatus(STATUS_KEY, undefined);
          return;
        }
        const remaining = Math.max(0, state.budgetCap - state.cumulativeCost);
        const color = state.exceeded ? "error" : remaining <= state.budgetCap * 0.2 ? "warning" : "dim";
        const line = `Budget $${state.cumulativeCost.toFixed(2)} / $${state.budgetCap.toFixed(2)}`;
        if (!ctx.ui.theme?.fg) {
          // Theme not ready (or no fg): clear any stale footer instead of
          // leaving the previous render on screen.
          ctx.ui.setStatus(STATUS_KEY, undefined);
          return;
        }
        ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, line));
      } catch { /* best-effort footer */ }
    }
  });
}
