---
name: cron
description: Use when the user wants scheduled, recurring, or periodic tasks in Pi — cron jobs, reminders, jobs at a specific time ("every morning at 9", "weekly monday", "in 30 minutes"), or automation that should run without being asked each time.
---

# cron — scheduled jobs

Jobs fire a prompt **into the live session** while pi is running. Past-due jobs
catch up once on the next tick (~30s). Storage: `<agentDir>/cron/jobs.json`.

## Creating jobs

1. Convert the user's natural language to a **5-field cron expression**.
2. Verify it with `cron action:"test" schedule:"..."` — check the next 5 fire times.
3. Add it: `cron action:"add" name:"<short-name>" schedule:"..." prompt:"..."`.

Cheatsheet: `minute hour day-of-month month day-of-week`

- `0 9 * * mon` — Mondays 09:00
- `*/30 * * * *` — every 30 minutes
- `0 9 1 * *` — first of the month, 09:00
- `30 8 * * 1-5` — weekdays 08:30

Names: letters/digits/`_`/`.`/`-`, max 64 chars. Cap: 20 jobs.

## Job prompts

The prompt becomes a **standalone turn** — no conversation context. Write it
self-contained and short: what to do, where, and what to report. Bad: `"check
it again"`; good: `"Run npm test in this repo and summarize failures"`.

**Loop guard:** a fired turn cannot `add`, `remove`, or `run` jobs. Never
write job prompts that schedule further jobs.

## Managing

- `cron action:"list"` — name, schedule, next/last fire, enabled.
- `cron action:"run" name:"..."` — manual fire (result arrives as a follow-up turn).
- `cron action:"remove" name:"..."`.
- `cron action:"export"` — crontab lines for 24/7 coverage while pi is closed;
  hand the block to the user to install (`crontab -l | cat - cron.txt | crontab -`).
  Exported lines run headless `pi -p --no-session` and log under `<agentDir>/cron/logs/`.

## Config

`settings.json` → `"cron": { "enabled": true, "tickMs": 30000 }` (global kill
switch + tick interval).
