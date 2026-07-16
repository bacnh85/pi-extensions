# pi-review

Read-only local code review for Pi. `/review` uses the isolated `reviewer` role from `pi-subagent` when available and falls back to a corrected one-turn review in the parent session.

## Install

```bash
pi install npm:@bacnh85/pi-subagent
pi install npm:@bacnh85/pi-review
# local checkout
pi install ./pi-subagent
pi install ./pi-review
```

`pi-subagent` is optional; without it, `/review` still works locally.

## Usage

```text
/review
/review xhigh main...my-feature
/review focus on auth/session regressions
```

Supported effort tokens: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

In TUI mode, bare `/review` asks for uncommitted, branch, or custom scope. Without UI it uses the default branch/local-change scope.

## Behavior

- Parent gathers compact read-only Git status/diff evidence.
- Isolated review runs in a lean child with read/search tools but no mutators or shell.
- Each confirmed finding is a structured actionable issue with severity, file/line, reproduction or evidence, expected behavior, suggested fix, acceptance criteria, and `blocking`.
- Only compact findings return to the parent; `/agent` retains the child thread.
- `REVIEW.md`, when present, is passed as bounded review guidance.
- Isolated reviews use a 3-minute activity-resettable inactivity window and a 20-minute absolute cap; transport heartbeats do not count as activity.

The local fallback preserves active safe research tools (Serena, FFF, web, and Munin reads), blocks mutators and unsafe Bash, chains review guidance into the per-turn system prompt, and restores tools/thinking once on `agent_settled`.

## Automation

`pi-review` exposes the `pi-review:run` event used by `pi-plan`'s **Implement, verify, and review** approval choice. If isolated review is unavailable, the automated workflow stops instead of treating the review as clean.
