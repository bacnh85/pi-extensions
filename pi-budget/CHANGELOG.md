# Changelog

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
