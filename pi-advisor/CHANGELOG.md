# Changelog

## 0.2.4 (2026-09-12)

### Removed

- Dead `AdvisorState.getThinking` knob (sole impl returned `undefined`; the
  value flowed nowhere meaningful).

### Fixed

- `saveModels` / `migrateLegacyAdvisorModel` no longer leave a `*.tmp-*` file
  behind when the final rename throws (best-effort unlink, error re-thrown).

### Documentation

- README: added `/advisor watch-off` to the command list.

## 0.2.3 (2026-09-11)

- **Fix 20–30s+ TUI freeze after every settled turn**: pi core awaits
  `agent_settled` handlers before the prompt regains input, and the advisor
  review (a full model call — measured median ~11s, p90 ~96s) ran inside that
  awaited barrier, freezing the TUI — most visibly after `write_plan`, where
  the prefilled `/plan-approve` was dead until the review finished. The review
  now runs fire-and-forget: notes deliver via `sendUserMessage`, which the SDK
  queues as a steer when a run is already active or fires as a follow-up turn
  when idle. A still-running review makes the next settle skip (bounded loss).
- **Watch is skipped in headless modes** (print/rpc/json): a floating review
  would die at process exit, and a note there fired an unrequested follow-up
  agent run. The on-demand `/advisor` consult tool is unaffected.
- **Hardened against stale/edge contexts** (review follow-up): a review still
  in flight when a new session starts is silently discarded instead of
  steering the new session; the in-flight guard moved to per-runtime state so
  a draining old review can't suppress the new session's first review; a
  mode-less context is treated as headless (fail-safe skip).
- **Delivery-time liveness + teardown self-disarm** (final review round): a
  review in flight across `/new`, `/resume`, `/fork`, `/reload`, or quit is
  discarded silently — `session_shutdown` disarms the watch before the runner
  invalidates, so no stale-ctx error toast lands in the replaced session; the
  pause toast routes through the same liveness gate; the watch-disabled state
  mid-review (`/advisor off`, `watch-off`) also suppresses delivery.

## 0.2.2 (2026-09-07)

- **Fix TUI hang on stalled reviewer provider**: every chain candidate now
  runs under a 90s **idle** deadline — a candidate is treated as dead only
  after 90s with no stream events, so a hung provider (accepts the
  connection, never streams) advances the chain to the next model, while
  healthy slow streams (reasoning models, large transcripts) are never
  killed: any event resets the deadline. Previously a hung provider stalled
  the awaited `agent_settled` review forever, blocking the prompt so
  slash commands (e.g. `/plan-approve` after write_plan) could not run.
  Caller abort (`/advisor` consult tool) still aborts without fall-through.

## 0.2.1 (2026-09-05)

- Widen Pi SDK peer range to `>=0.85.0 <0.86.0` and bump devDep to `^0.85.0` for Pi 0.85.0 compatibility (no breaking changes; peer cap widening only).

## 0.2.0 (2026-08-31)

### Added

- **Multi-model fallback chain**: `pi-advisor.models` accepts an ordered array
  (or comma-separated string) of reviewer models; when the first is
  rate-limited, out of quota, or unavailable, the next candidate serves the
  review or on-demand consult automatically. Whole-chain failure counts as one
  review failure (the existing 3-consecutive-failure pause still applies).
  No parent-model fallback — the advisor never reviews its own turns.
- **`/advisor models`**: interactive chain editor (TUI panel with model
  completions, add/remove slots; non-TUI prints the chain and settings path).
- **`/advisor a/b, c/d`**: set the whole chain in one comma-separated argument;
  completion after each comma carries the typed prefix.
- `/advisor status` shows the chain and which model served the last review.

### Changed

- Config key is now `pi-advisor.models` (chain); the legacy `pi-advisor.model`
  string is still honored (wrapped to a one-entry chain) and is deleted on the
  next explicit save. No migration needed — existing configs keep working.
- `/advisor <model>` sets the chain to that single model (chain composition is
  also available inline via comma-separated `/advisor a, b` and through
  `/advisor models`); `/advisor off` clears it.
- New dependency: `@bacnh85/pi-config-panel` (shared panel kernel, same as
  pi-subagent).

## 0.1.7 (2026-08-30)

### Changed

- Only nits defer during the post-steer cooldown; concerns now always steer
  (wake the agent) even inside the cooldown window. A deferred concern
  contradicted its own delivery template ("address this or state why it does
  not apply") — the agent couldn't address what it wasn't woken for, and the
  note just sat visible-but-unacted until the user's next prompt (session
  01a051c6: 1h21m). Blockers already always steered; nit ping-pong guard is
  unchanged.

## 0.1.6 (2026-08-30)

### Fixed

- Deferred (cooldown) advisor notes are now visible immediately as a display-only
  card ("Advisor (deferred — next turn)") at settle time. Previously they sat in
  the SDK's pending-next-turn queue with no visual presence and only materialized
  when the user's next prompt flushed them into the agent's context — looking
  like the advisor stayed silent and then blurted a note out after user input
  (session 01a05099, 1h37m gap). The flushed LLM message is now `display:false`
  so the note never renders twice. Anti-ping-pong deferral behavior unchanged.

## 0.1.5 (2026-08-29)

### Added

- `/advisor` argument completion now offers the `on` / `off` / `status` /
  `watch-off` keywords ahead of model suggestions (previously only models were
  offered, so keywords could not be discovered or completed).

## 0.1.4 (2026-08-26)

### Changed

- Post-steer cooldown (OMP parity): after any advisor note steers a turn,
  non-blocker notes within the next `immuneTurns` settled turns are deferred to
  LLM-visible next-turn asides instead of waking the agent again. Without this,
  each new settled turn's fresh transcript lets the reviewer emit a new note
  every cycle and the identical-note dedupe never trips — an unbounded
  nit/concern ping-pong. Blockers always steer immediately (OMP #5628: handing
  off broken work must be acknowledged). Deferred notes are never lost — they
  appear in the agent's context on the next user- or blocker-driven turn.

## 0.1.3 (2026-08-26)

### Changed

- Every accepted advisor note now steers the agent as a follow-up turn,
  regardless of severity (nit included). The review runs from `agent_settled`,
  when the primary turn is already idle — there is no next step boundary to
  batch a non-interrupting aside into, so a nit delivered as a card was never
  acted on until the next user prompt (or never at all). Severity still sets
  the note's authority wording ("nit — consider" vs "concern — address this"
  vs "blocker — fix before continuing"). Loop protection remains the emission
  guard (same normalized note not re-delivered within `immuneTurns`).

### Fixes

- Peer dependency range narrowed to `>=0.84.3 <0.85.0` (the model-picker `ModelSelectorComponent` call is only valid against the 0.84.3 SDK signature).

## 0.1.2 (2026-08-26)

### Fixes

- Reviewer severity calibration: rate by end state, not by the agent's summary.
  Disclosure or acknowledgement no longer demotes a broken/non-compiling result or
  a violated user constraint to a nit — such notes are at least a `concern`, so they
  steer a follow-up turn after a settled summary instead of sitting as an aside.
  Handles the case where the advisor sent a note after the agent's final summary but
  the agent never continued to act on it.

## 0.1.1 (2026-08-26)

### Fixes

- Model picker now matches Pi 0.84.3's `ModelSelectorComponent` constructor
  (the `settings` param was removed; default-model persistence is now via
  Ctrl+S and stays disabled here). Fixes a typecheck failure against
  `@earendil-works/pi-coding-agent@0.84.3`.
- DevDeps bumped to pi SDK/pi-tui 0.84.3 for CI parity.

## 0.1.0 (2026-08-25)

### Fixes

- Emission guard now suppresses no-op verdicts wrapped in prose: a reviewer
  note that leads or closes with "no note warranted", "no issues found",
  "nothing to flag", etc. is treated as content-free and not delivered as a
  nit (previously only exact whole-note matches were blocked, so a note like
  "…trivial edit matching the request exactly. No note warranted." was still
  delivered).

### Initial release

- Moved from pi-plan: the on-demand `advisor` tool (second-opinion consult over
  the full sanitized session transcript) and the `/advisor` model picker.
  Model preference lives in `~/.pi/agent/settings.json` under `"pi-advisor"` and
  auto-migrates from pi-plan's `advisorModel` on first start.
- New: automatic turn-end reviewing. After each settled turn with at least
  `watch.minToolCalls` (default 3) tool calls, an isolated second model reviews
  the turn and may emit one note:
  - `nit` → non-interrupting aside: rendered as an Advisor card and batched into
    the primary agent's LLM context on the next turn (visible card, never a steer)
  - `concern` / `blocker` → follow-up message that steers the agent (always —
    no silent downgrade; repeated distinct concerns steer too, loop protection
    is the emission guard's dedupe window)
- Watching is gated on a configured model: without `pi-advisor.model` no review
  runs (the primary model never reviews its own turns), and `/advisor off`
  stops both the tool and the watch.
- Legacy pi-plan migration is versioned (`pi-advisor.migrationVersion`): the
  `advisorModel` preference is adopted exactly once; an explicit disable is
  never resurrected by the legacy file on restart.
- Emission guard (noise control): content-free phrase blocklist ("lgtm",
  "done", …), normalized-text dedupe with severity escalation, one note per
  review cycle. Nits are delivered with `sendMessage({ triggerTurn: false })` so a
  concurrent user turn is never steered; concerns/blockers steer via `followUp`.
- Review failures never break the primary loop; after 3 consecutive failures
  watching pauses for the session (resume with `/advisor on`).
- Explicit `/advisor off` stamps `pi-advisor.migrationVersion` so the legacy
  pi-plan migration never resurrects a disabled advisor; a trusted project's
  `.pi/settings.json` `pi-advisor.model` now warns when it shadows the global disable.
- `/advisor on|off|watch-off|status` session controls + counters.
