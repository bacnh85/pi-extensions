# Changelog

## 0.2.0

- Model & thinking pins per job (`model`, `thinking`) — pinned jobs run headless in their own `pi -p` process (10-min cap), output logged under `<agentDir>/cron/logs/`, result delivered back as a follow-up. Hermes-style per-job model/reasoning pin.
- Hardening: headless children run with `PI_CRON_DISABLED=1` (scheduler off inside them — no parent/child `jobs.json` races, no duplicate fires) and refuse job mutations at the tool level; loop guard is a time-based 30s linger window after the last armed fire (no counter — SDK events carry no turn identity; over-arms rather than under-arms while cron turns are queued); `isJob` validates schedule, job names, pins, and status fields at load, and `export` skips jobs whose prompt/cwd/model contain newlines, blocking crontab injection from hand-edited files and tool-added multi-line prompts.
- Failure visibility: every fire records `lastStatus` (`ok`/`fail`) + `lastError` on the job (shown in `list` as `[ok]` / `[FAIL: …]`); new `logs` action tails a job's newest run log. `run` doubles as retry.

## 0.1.0

Initial release.

- `cron` tool: `add` / `remove` / `list` / `run` / `test` / `export` actions.
- Jobs fire a prompt into the live session while pi is running (30s in-process
  timer); past-due jobs catch up once on the next tick.
- `/cron` command lists jobs.
- Loop guard: mutating actions refused while a cron-fired turn is in flight.
- `export` prints crontab lines (headless `pi -p --no-session`) for 24/7 coverage.
- Storage: `<agentDir>/cron/jobs.json`, atomic writes, corrupt-file quarantine.
- Settings: `cron.enabled` kill switch, `cron.tickMs` tick interval.
