# @bacnh85/pi-cron

Scheduled jobs for Pi — cron-style jobs that fire a prompt **into the live
session** while pi is running, with past-due catch-up and crontab export for
24/7 coverage.

## Install

```bash
pi install @bacnh85/pi-cron
```

## Usage

The `cron` tool (and `/cron` command) manages jobs stored in
`<agentDir>/cron/jobs.json`:

| Action | What it does |
|---|---|
| `add` | Create a job: `name`, `schedule` (5-field cron), `prompt` (fired as a standalone turn), optional `cwd`, optional `model` / `thinking` pins. |
| `remove` | Delete a job by `name`. |
| `list` | Show name, schedule, next/last fire, enabled, last run status (`[ok]` / `[FAIL: reason]`), model pin. |
| `run` | Fire a job manually right now (also the retry for a failed job). |
| `enable` / `disable` | Toggle a job. `disable` pauses (schedule kept; skipped by ticks and export); `enable` recomputes the next fire from now — no surprise catch-up fire. `add` also accepts `enabled:false` to create a disabled job. |
| `test` | Preview the next 5 fire times of a schedule. |
| `logs` | Tail the newest run log of a job — see what a failed run printed. |
| `export` | Print crontab lines so jobs also run while pi is closed (headless `pi -p --no-session`, logs under `<agentDir>/cron/logs/`). |

Example: *"every weekday at 9, check CI status and summarize failures"* → the
agent converts that to `cron add schedule:"0 9 * * 1-5" prompt:"..."`, verifies
with `test`, and adds it.

**Execution model:** a 30s in-process timer fires due jobs as follow-up turns
in the open session; past-due jobs catch up once on the next tick (if pi was
closed at the scheduled time). Jobs only run while a pi process is open — use
`export` + system crontab for unattended schedules.

**Model & thinking pins (Hermes-style):** set `model:"provider/id"` and/or
`thinking:"high"` on a job and it runs **headless in its own pi process**
(`pi -p --no-session --model … --thinking …`) instead of the live session —
useful for cheap/fast models or isolated runs. Output is logged under
`<agentDir>/cron/logs/` (default 10 min, configurable via cron.timeoutMs) and the result is delivered
back into the session as a follow-up. `export` includes the pins in crontab
lines. Headless children run with `PI_CRON_DISABLED=1`: the cron scheduler is
off inside them (no parent/child races on `jobs.json`) and job mutations
(`add`/`remove`/`run`/`enable`/`disable`) are refused — a fired run can never
schedule more jobs.

**Loop guard:** while a cron-fired turn is in flight (and for 30s after the
last fire), `add`/`remove`/`run`/`enable`/`disable` are refused — fired jobs
can never schedule further jobs.

**Single session per agent dir:** the jobs store has no cross-process lock.
Running multiple pi sessions that share an agent dir can double-fire jobs or
lose concurrent edits — use one cron-active session per agent dir, or give
each session its own `PI_CODING_AGENT_DIR`.

## Configuration

`settings.json`:

```json
{ "cron": { "enabled": true, "tickMs": 30000, "timeoutMs": 10800000 } }
```

- `enabled` — global kill switch for the scheduler.
- `tickMs` — tick interval (clamped 5s–10min).
- `timeoutMs` — hard cap for headless (pinned) child runs — SIGTERM at the cap, SIGKILL after a 5s grace (clamped 1min–24h, default 10min). Raise it for long pinned jobs.

## Notes

- Every fired job spends model tokens on a real turn — keep prompts short.
- Schedule validation and fire-time math use `cron-parser`.
