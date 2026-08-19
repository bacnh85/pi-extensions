# Changelog

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
