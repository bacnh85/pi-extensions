# Changelog

## 0.1.7 (2026-09-30)

### Fixed

- **Dedupe-set clear-all at cap enabled replay double-counting**: when
  `countedMessageIds` reached 1000 the whole set was cleared, so replayed
  `message_end` events for recent ids were re-counted and could push the
  cumulative cost over the cap prematurely. The set now evicts exactly one
  oldest id per add at capacity (insertion-ordered Set), keeping the last
  1000 ids replay-deduped.
- **Stale budget footer in new no-cap sessions**: the footer-clear branch ran
  only inside `message_end`, so a `Budget $X / $Y` line left by a previous
  capped session lingered until the first assistant reply. `session_start`
  now clears the footer immediately when no cap is configured.
## 0.1.6 (2026-09-28)

### Fixed

- **Thrown `ctx.abort()` permanently disabled enforcement**: `state.exceeded`
  latched before the abort, so one throw stopped budget enforcement for the
  rest of the session. The abort is now retried on subsequent `message_end`
  events until it succeeds (`abortSucceeded` latches only on success), while
  the exceed notification and `budget-exceeded` entry still fire exactly once.
  Covered by new `abortThrows` tests.

## 0.1.5 (2026-09-24)

### Fixed

- **Stale status line when `theme?.fg` was missing**: the footer handler
  returned early without touching the status line, leaving the last rendered
  budget text on screen (e.g. during theme re-initialization). The no-fg path
  now clears the footer (`setStatus(STATUS_KEY, undefined)`), matching the
  no-cap branch.

## 0.1.4 (2026-09-22)

### Added

- Test locking the dedupe-set cap behavior (documented in 0.1.3, previously
  untested): `countedMessageIds` is cleared once it reaches 1000 ids, so an
  old message id replayed afterwards is re-counted — the accepted replay
  window vs. unbounded set growth. No production changes.

## 0.1.3 - 2026-09-12

### Fixed

- Capped the `countedMessageIds` dedupe set (keep-last-1000, clear on reach):
  it previously grew for the whole session lifetime; sessions past 1000
  assistant messages lose replay-dedupe for old ids, an acceptable trade vs.
  unbounded growth.
- The footer `setStatus` block is now gated on `role === "assistant"` for
  parity with cost accumulation — it previously ran on every `message_end`.

## 0.1.2 - 2026-08-15

Stale-extension-ctx crash fix (same root cause as pi-notify 0.1.1).

### Fixed

- `--budget` flag is captured once at extension load instead of being read from
  the extension API inside `session_start`/`message_end` handlers. After a
  session replacement (/new-session, fork, switch) or reload, the old runner is
  invalidated and `pi.getFlag` throws "extension ctx is stale" — a handler
  firing during teardown crashed the extension. CLI flags are immutable after
  parse, so the load-time capture is equivalent and removes the lazy re-read.
  Lazy-init edge (message_end before session_start) still enforced: the cap is
  known at load.

## 0.1.1 - 2026-08-05

Patch version bump for release sync and package documentation update.

## 0.1.0 - 2026-08-05

Initial release.

### Added

- `--budget <usd>` CLI flag — abort the agent when cumulative session cost
  reaches the cap.
- `message_end` cost accumulation (`message.usage.cost.total`), once-per-session
  abort guard, `budget-exceeded` custom entry.
- Footer status `Budget $X.XX / $Y.YY` when a cap is set (error / warning / dim
  colour states). Hidden when no cap is configured.
- Session reset: budget is per-session (`session_start`); compaction does not
  reset it.

### Known limitations

- Parent-session only: pi-subagent child spend is not aggregated (children are
  separate sessions). Follow-up: aggregate child cost from `tool_result`.
- Enforcement accuracy depends on provider `usage.cost.total` reporting.
