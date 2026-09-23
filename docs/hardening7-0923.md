# Hardening round 7 — 2026-09-23 (burn-pihard7-0923)

Fresh full-matrix audit on a clean clone of origin/main @ 452db4e: 34/34 CI-matrix
packages run with their exact ci.yml commands (npm ci + test + typecheck as wired).
Verdict: 32/34 green; 2 red → both fixed, test-only diffs, no version bumps.

## RED 1 — pi-subagent: test fixture not hermetic against host git signing config

`makeGitRepo` (extensions/test/core.test.ts, both copies ~L416 and ~L539) configured
`user.email`/`user.name` but not signing: on a dev machine with global
`commit.gpgsign=true` (ssh format, signing agent not reachable from tests) every
fixture commit died — `error: Couldn't get agent socket?` → `fatal: failed to write
commit object` — taking down all 10 git-worktree-isolation tests deterministically.

Fix: mirror the guard pi-plan's `createGitRepo` already carries —
`git config commit.gpgsign false` in the fixture, comment explaining why.

## RED 2 — pi-plan: re-entry/branch-switch review tests raced a fixed 20 ms sleep

"plan-mode re-entry aborts an in-flight flow's review timer (0.13.1)" asserted the
review signal exists after `await sleep(20)`. The signal only appears after a long
async chain (settled handler → git snapshots → emit), so under parallel load the
chain overran 20 ms → "flow reached the review phase" assertion error. Green solo,
red in a 4-way parallel audit run; same pattern in the 0.14.4 branch-switch test.

Fix: bounded `waitFor()` poll (5 ms tick, 5 s deadline) replaces both fixed sleeps;
returns the signal so TS narrowing is kept without `!`.

## Gates

- pi-subagent: npm test ×2 + npm run typecheck ×2 green (round 2 concurrent with
  pi-plan's suite).
- pi-plan: npm test ×2 + npm run typecheck ×2 green; the concurrent round is the
  load condition that previously flaked the suite.
- Full-matrix verdict with these two red was the only deviation; the other 32
  packages were untouched.

Test-only changes to existing suites — no package source, no version bumps, no
lockfile churn (round-6 precedent e21bb73).
