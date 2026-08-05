# pi-budget

Spend cap enforcement for Pi — halts the agent when cumulative session cost
exceeds a `--budget <usd>` limit. Companion to
[`pi-sub`](https://www.npmjs.com/package/@bacnh85/pi-sub): pi-sub *renders*
subscription usage in the footer; pi-budget *enforces* a spend policy.

Zero dependencies. Plain JS.

## Install

```bash
pi packages install @bacnh85/pi-budget
```

## Usage

```bash
pi --budget 0.50          # abort the session once spend hits $0.50
pi --budget 5             # a whole-dollar cap works too
```

When the cumulative cost of assistant responses reaches the cap:

- The current turn is aborted (`ctx.abort()`).
- A warning notification is shown.
- A `budget-exceeded` custom entry is appended to the session record.
- The footer shows `Budget $X.XX / $Y.YY` (red when exceeded, yellow below 20%
  remaining).

The budget resets on a **new session**. Context compaction does **not** reset it
(compaction is mid-session). No cap set → the extension stays silent and shows
no footer.

## How it works

- `pi.registerFlag("budget")` reads `--budget <usd>` once at startup.
- `message_end` events accumulate `message.usage.cost.total` for assistant
  messages.
- `ctx.abort()` stops the turn when the cap is crossed; an `exceeded` guard
  ensures the abort fires exactly once per session.

## Limitations

- **Parent-session only.** pi-subagent children are separate sessions, so child
  spend is not visible to this extension. Child aggregation from `tool_result`
  is a possible follow-up (tracked in the CHANGELOG).
- **Accuracy follows providers.** Enforcement is only as accurate as each
  provider's `usage.cost.total` reporting.

## Development

```bash
npm test   # node --test (no framework)
```

## License

MIT
