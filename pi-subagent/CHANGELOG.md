# Changelog

## 0.21.4 (2026-09-13)

### Fixed

- **Read-only herdr children no longer get a report-file delivery
  instruction they cannot follow.** The delivery wrapper asked every child
  to write its report to `.pi/herdr/<name>-<stamp>.md`, but read-only
  sandboxes (scout: read/grep/find/ls) have no write tool — children burned
  3–5 turns discovering this before falling back to an inline reply (rescued
  only by the pane-read fallback). The sandbox flag now flows into the
  handle and `wrapTaskPrompt`, which tells read-only children to deliver
  inline and never write files. Applies to initial dispatch and
  control-tool follow-up prompts alike. The herdr `read` fallback hint now
  also branches on the sandbox (suggests an inline-reply prompt instead of
  the impossible file write). The full chain is pinned by three tests that
  fail if `readOnly` is dropped anywhere: the wrapper itself, the handle,
  the follow-up wrapper, or the `sandbox: read-only` frontmatter → dispatch
  mapping (mutation-verified).
- **Background receipts inside herdr now say herdr was skipped.**
  `background:true` always runs in-process (sdk) — inside a herdr session
  the resulting missing pane read as a bug. The receipt now explains it and
  points at the pane-dispatching alternative — but only when a foreground
  rerun would actually delegate (a pinned `runner:"sdk"`, disabled
  delegation, or a failed herdr-binary probe all suppress the advice).
- **Status of an evicted background task no longer reads as "never
  existed".** Finished tasks leave the in-memory map after 60s retention;
  `operation:"status"` now falls back to the durable
  `.pi/subagent-history.json` (background entries only — foreground `fg-*`
  ids are excluded) and reports the terminal state + summary ("no longer
  retained in memory"); non-terminal entries read as "history shows
  running — not live in this session".
- **Project-local agents (`.pi/agents/`) verified live**: invisible at the
  default `agentScope:"user"` (clear "Unknown agent" error), confirmation
  gate on first project-agent dispatch, then single/chain/background all
  work with `agentScope:"project"` on both sdk and herdr runners.

## 0.21.3 (2026-09-12)

### Fixed

- Changelog attribution correction for 0.21.2 (the cancelAgent escalation
  belongs to 0.21.2, not 0.21.1; malformed H1 ordering fixed). No code
  changes.

## 0.21.2 (2026-09-12)

### Fixed

- **cancelAgent escalates to ctrl+c whenever the post-esc state is not
  verifiably settled (idle/done)** — previously only the "working" state
  escalated, and herdr 0.9.0 misreports ask_user_question dialogs as
  "unknown", which left children stranded on the dialog after a timeout
  cancel. Best-effort: the dialog's own key handling is outside this
  extension's control.
- Doc corrections: the timeout path's esc behavior is unit-tested (live
  dialog dismissal unobserved); `/reload-runtime` control-action refusals
  now include the manual `herdr tab close <tabId>` fallback.

### Documented

- herdr 0.9.0 limitation: pi's `ask_user_question` dialogs are NOT
  classified as `blocked` by herdr's detection — a herdr child that asks a
  mid-task question makes the parent wait until the hard timeout. Answer in
  the pane (the child completes and the parent returns), or avoid mid-task
  questions in herdr children. Upstream: herdr needs question-widget
  detection for pi.
- After `/reload-runtime`, mutating control actions (`cancel`/`close-tab`/
  `forget`) refuse for pre-reload panes; refusal messages now include the
  manual `herdr tab close <tabId>` fallback.

## 0.21.1 (2026-09-12)

### Fixed

- **Packaging: `extensions/herdr.ts` was missing from `files[]`** — the
  published 0.21.0 tarball could not resolve `./herdr.ts` and crashed on
  load. 0.21.0 also shipped without the test files (intentional).

### Added

- **`herdr` control tool `forget` action** — drops a stale registry entry
  (e.g. after its tab was closed outside this session) without touching
  herdr state.
- **Keep-alive parity for herdr delegations** — single/chain/parallel herdr
  runs now emit the same onUpdate heartbeat traffic as SDK runs, so long
  pane runs are not idle-aborted by the host.
- **Chain `{previous}` truncation** — a large step report no longer pushes
  the next chain task past the 64KB herdr argv ceiling; substituted text is
  byte-safe truncated (multibyte-aware) with a visible marker. SDK chains
  are unaffected.
- Blocked herdr panes surfaced honestly in every mode: single mode returns
  a "blocked awaiting input" message instead of an empty success, and
  parallel headers count them separately (`N blocked awaiting input`) with
  per-task `blocked — awaiting input in its pane` labels.
- Task-size validation now reserves headroom for the delivery wrapper
  (HERDR_TASK_BUDGET = 64KB − 1KB) — a ceiling-sized task plus the
  report-file contract no longer exceeds the argv ceiling; the control
  tool's prompt check uses the same budget.
- The `herdr --version` probe is cached only on success — a transient CLI
  hang no longer permanently disables herdr delegation for the session.
- Parallel herdr integration tests: same-type prepare-before-prompt
  ordering, per-task prepare-failure mapping, mid-prompt abort (esc to every
  pane, no listener leaks), heartbeat traffic, oversized-report chain.

### Changed

- Task-control calls (`operation:"status"`/`"cancel"`) and `background:true`
  dispatches skip the `herdr --version` probe entirely; the probe is
  memoized per process for real dispatches.
- Abort listeners on the parent signal are now removed once a herdr task
  settles — a later abort no longer keystrokes completed step panes in
  chains.


## 0.21.0 (2026-09-12)

### Added

- **Herdr pane delegation** — when pi runs inside [herdr](https://herdr.dev)
  (`HERDR_ENV=1` + `herdr` binary), the `subagent` tool delegates to visible
  interactive pi sessions in herdr panes instead of in-process SDK sessions.
  Topology: one tab per agent type (tab label = agent name), one pane per
  agent instance. Children are full `pi` sessions with the agent persona
  applied via a file + `--append-system-prompt` (herdr's `agent start --`
  arg encoder rejects multi-line strings), plus `--model`, `--thinking`,
  `--tools`); read-only sandboxes map to the read-only allowlist. Results are
  delivered via a report-file contract (children write their final report as
  Markdown to a known path — pane scrollback is a best-effort fallback, since
  TUI agents render on the alternate screen). New `runner: "sdk" | "herdr"`
  tool parameter overrides the auto-detection per call; settings
  `subagent.herdr: "off"` disables it. Delegated children run with
  `PI_SUBAGENT_HERDR=off` so they never recurse into herdr dispatch.
  Same-type prepares are serialized (tab/pane/name allocation is
  race-prone); prompt submission and runs stay parallel.
- **`herdr` control tool** — main-session oversight of delegated pane agents:
  `list` (delegated agents + live states), `status`, `read` (best-effort pane
  output), `prompt` (follow-up that continues the child's session, with
  optional `wait`), `cancel` (esc, then ctrl+c if still working), `focus`
  (raise the agent's tab), and `close-tab` (restricted to tabs this session
  created). Always registered; outside herdr it returns a clear error.
- Fifth auto-review round hardening: a herdr child that settles but whose
  state cannot be verified with no collected report is an error, not an
  empty success; a pre-aborted dispatch no longer submits the task to the
  live child at all; a read-only agent whose tools never intersect the
  read-only allowlist is rejected (previously `--tools` was silently
  omitted, granting the child pi's full default toolset); arg building now
  happens before topology creation so validation failures leave no orphan
  tab/pane.
- Fresh session per herdr dispatch: child session ids are now unique per task
  (`herdr-<name>-<stamp>`), so a recycled agent name never silently resumes a
  stale (potentially huge) session after a tab close or parent restart.
  Control-tool follow-ups keep context in the live pane's memory — the
  session id was never what carried that.
- Pane-capture fallback (read-only agents without the report-file contract)
  is now tail-capped to the last 8KB with a truncation marker — herdr
  scrollback includes pre-prompt noise (resumed sessions, earlier turns), and
  that stale content previously flowed verbatim into results and chain
  `{previous}` substitution.
- Fourth review round hardening: agent-level `sandbox: "worktree"` is no
  longer silently dropped on the herdr runner — dispatch is rejected with an
  explicit error (herdr children share the working tree), mirroring the
  merge guard; control-tool follow-up prompts no longer return a stale
  report file (unchanged file is reported as such); the `herdr read`
  action clamps `lines` to 1-1000 and caps output bytes; four new
  dispatch-reaching integration tests cover single success (details.runner),
  chain blocked-pause, parent-abort cancellation with pane esc, and the
  worktree guard.
- Third review round hardening: herdr agents interrupted via parent abort or
  `abortOnFailure` now report `status: "aborted"` (previously a cancelled
  child settling to idle could read as success); the parallel abort listener
  also fires without a parent tool signal; `merge: "3way"` combined with the
  herdr runner is rejected with an explicit error instead of silently
  dropping the merge; the control tool's `prompt wait` is tool-abort
  interruptible; new index-level integration tests drive the registered
  tools through a fake pi host.
- Second review round hardening: `herdr` control tool `prompt`/`cancel` are
  scoped to agents this session delegated (status/read/focus remain
  workspace-wide, guidelines updated); dispatch into an adopted
  (label-matched) tab always splits a fresh pane with the validated cwd
  instead of reusing a free pane of unknown provenance; close-tab fails
  closed on unrecognized agent states; the cross-session name-collision
  retry re-reads live herdr names; report-file reads are capped at 256KB
  with a truncation marker; best-effort pane captures are labeled in
  results; `background: true` no longer stamps `runner: "herdr"`; oversized
  control-tool prompts fail fast.
- Blocked panes (child waiting on a permission/question dialog) surface as
  `partial` with `stopReason: "blocked"` instead of failing; a blocked chain
  step pauses the chain with instructions instead of feeding degraded output
  to the next step.
- `close-tab` only closes tabs this session actually created: a tab that
  pre-existed with a matching label is adopted for dispatch but refused on
  close, and it refuses while the named agent or sibling agents in the same
  tab are still working/blocked (same-type agents share one tab; closing it
  kills all their panes; an unverifiable sibling state counts as busy, while
  a missing state for the named agent's own pane is treated as already
  closed). The `herdr` control tool is disabled in delegated child sessions
  (`PI_SUBAGENT_HERDR=off`), not just dispatch.

## 0.20.1 (2026-09-12)

### Fixed

- **Service path honors agent frontmatter `timeout:` and raises the hard cap**:
  `runNamedAgent` (pi-review / auto-review path) applied only the caller's
  per-call timeout against the 20-min default cap and ignored the agent's
  `timeout:` frontmatter. Timeout resolution is now extracted into the shared
  `resolveChildTimeouts` helper (security.ts) used by the tool path, so the
  precedence is identical everywhere (per-call timeout > agent frontmatter
  default > global default) and the hard lifetime cap is raised to match the
  idle window — an agent with `timeout: 45` is no longer hard-killed mid-stream
  at the default cap.
- README: Compatibility peer ranges corrected from `<0.85.0` to `<0.86.0`
  (package.json peers already said `<0.86.0`), and the read-only restriction
  now describes the actual allowlist (built-in reads plus the read-only
  extension allowlist — FFF, Windows, web, Serena, Munin), not just the four
  built-in reads.

## 0.20.0 (2026-09-07)

### Added

- **Auto-review** (`subagent.autoReview: true` in settings.json, default off) —
  after a user-initiated turn that made ≥3 file-mutation tool calls
  (`edit`/`write`/`apply_patch`/`str_replace_editor`) in an interactive (TUI)
  session, the read-only `reviewer` agent is dispatched automatically as a
  background task reviewing the current uncommitted diff of the files the turn
  touched (new/untracked files are read directly); its findings wake the parent
  via the normal background follow-up turn, so an independent review happens
  after every real coding turn without asking. Precedence: global
  settings.json → trusted repo `.pi/settings.json` overlay. Guards keep it
  bounded: turns woken by auto-injected messages are
  skipped (custom wake-ups by role, and pi-advisor blocker/concern steers by
  their fixed `Advisor review (` content prefixes since those are plain user
  messages), max 3 dispatches per session, never while another background task
  runs, cursor tracked while the setting is off so enabling mid-session never
  replays history, `session_start` (startup and reload) reseeds it, and a
  fresh session's first coding turn is reviewed from entry zero. Subagent
  catalog prompt now also states when NOT to delegate (single-file small
  edits, quick greps → inline).

## 0.19.3 (2026-09-05)

- Widen Pi SDK peer range to `>=0.80.0 <0.86.0` and bump devDep to `^0.85.0` for Pi 0.85.0 compatibility (no breaking changes; peer cap widening only).

## 0.19.2 (2026-09-02)

### Fixed

- **Stalled streams now fall back to the next model** — when a provider
  accepts a request but the stream emits zero events for the entire idle
  window (known router/provider failure mode, e.g. slow-TTFT models behind
  omniroute), the run previously died on model #1 with "Idle timeout" and
  never tried the fallback chain. An IDLE timeout is now treated as a
  capacity signal (`isRetryableModelResult`): the task retries on the next
  candidate (each candidate is tried at most once, so worst case is N idle
  windows). The HARD lifetime cap stays terminal — a task that ran 20 min is
  genuinely huge, not a stall. Found by live background-task test: trivial
  20+22 task timed out on glm-5-turbo with zero stream events.

## 0.19.1 (2026-09-02)

### Fixed

- **Model fallback now engages on credential cooldown** — router providers
  report "All credentials for model X are cooling down" when every key for a
  model is in its rate-limit window. That message didn't match
  `RATE_LIMIT_PATTERNS`, so `runWithModelFallback` treated it as a fatal error
  instead of advancing to the next candidate (e.g. `@fast`
  glm-5-turbo → gpt-oss-20b → deepseek-v4-flash), aborting subagent and chain
  runs with "All credentials … are cooling down". Added the cooldown pattern
  (credential cooldown / cooldown window / cooling down) so capacity signals
  from the credential layer trigger the same fallback as 429s.

## 0.19.0 (2026-09-02)

### Fixed

- **Reviewer/planner agents no longer abort at the 3-min idle timeout while
  thinking** — root cause: a `thinking: high` child on a slow model can spend
  many minutes in one reasoning stretch, and the default 3-min inactivity
  window kills the run even though it is healthy. Fix: new agent frontmatter
  field **`timeout: <minutes>`** (1–60) bakes a per-agent idle window; the
  hard lifetime cap is raised to match so long windows are actually
  enforceable. Bundled `reviewer` and `planner` agents ship with
  `timeout: 10`. Per-call `timeout` still overrides. (The idle timer already
  treats every SDK event — including streaming deltas — as activity; a run
  that emits no events at all for the window is genuinely hung.)
  Reported by peer mbp-sao-9915 (review rounds hitting the 180s default).

## 0.18.0 (2026-09-02)

### Fixed

- **Worktree patches now reach the parent model** — `sandbox: worktree` results
  previously exposed the diff only in TUI details; the tool-result text the
  parent model reads contained just the child's final message, so the
  documented "parent merges via apply_patch" flow was impossible in practice.
  The diff is now appended as a `🌿 worktree patch` block (capped at the
  per-task output limit) in single, parallel, chain, and background-completion
  results, and `operation: "status"` reports `Patch: N diff lines`.

### Added

- **`merge: "3way"` per call/item** — with a worktree-sandboxed agent, the
  captured diff is applied to the parent checkout via `git apply --3way`
  (temp-file at repo root, applied before worktree removal so the staged blobs
  are available for 3-way reconstruction). Results carry
  `mergeStatus: "applied" | "conflict"`; conflicts keep git's markers, report
  the apply error, and still deliver the patch for manual merging — never
  silently resolved. Concurrent applies are serialized (OMP `withRepoLock`
  equivalent) so parallel siblings cannot race the checkout.
- Applies are mutex-serialized across parallel/background tasks.

## 0.17.0 (2026-08-31)

### Added

- **Add/remove model roles from the `/subagent` panel** — new `+ Add role` /
  `− Remove role` action rows (two-prompt flow: name → chain). Custom roles are
  deletable; built-in roles (`fast`/`coder`/`smart`) reset to their bundled
  default. New names validate against `[A-Za-z0-9._-]{1,64}` with
  case-insensitive collision checks.
- **Per-agent default display** — each override row now shows the agent's
  default (no-override) chain, e.g. `scout  (default: @fast → zai-coding-cn/
  glm-5-turbo, …)`, so blank = inherit is meaningful. Labels track live role
  edits and freshly added roles appear in `@role` completions immediately.
- Panel save is now guarded by a working-copy content diff (action-only
  sessions — add/remove without row edits — previously left `editedKeys` empty
  and silently skipped persistence).

## 0.16.1 (2026-08-29)

### Added

- `/subagent` argument completion: keywords (`list|all|agents|roles|reload|
  refresh|history`), discovered agent names, and `@role` refs.
- Roles editor rows now offer inline model suggestions (Tab to pick, Enter
  keeps typed text) when run against @bacnh85/pi-config-panel >= 0.1.1; the
  package stays compilable and fully functional on 0.1.0 (suggestions simply
  absent), so no dependency floor bump is required.

## 0.16.0 (2026-08-23)

### Features

- **Role-based model routing** — select models by *function* instead of fixed
  per-agent chains, inspired by oh-my-pi's `modelRoles`. Roles (`@fast`,
  `@coder`, `@smart`, or custom) map functions to ordered fallback chains via
  `subagent.roles` in `~/.pi/agent/settings.json`; bundled agents now reference
  roles instead of hardcoding chains. Without settings, defaults reproduce the
  previous chains exactly.
- `subagent.agentModels` per-agent overrides — remap a bundled agent's models
  (e.g. `{ "reviewer": "@smart:high" }`) without editing its file. Repo
  `.pi/settings.json` overlays the mapping for trusted projects (read-only).
- `:thinking` suffix support on any role/model entry (`"@smart:high"`);
  openrouter `:free` ids are preserved.
- `/subagent roles` — interactive role editor (TUI panel via the shared
  `@bacnh85/pi-config-panel` kernel, saves to global settings.json) or plain
  text mapping in headless mode.
- Bare `/subagent` now opens the roles view directly (the agent list moved to
  `/subagent list`); `/subagent <role>` / `/subagent @role` shows a role's
  chain, default, and the agents using it instead of erroring.
- `/subagent <name>` and the system-prompt catalog now show each agent's
  *resolved* chain (role → models → parent fallback) plus unresolved-role
  warnings.

## 0.15.3 (2026-08-20)
 ### Improvements
- Timeouts have been extracted as Environment Variables enabling overriding.
- `PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS` default : 3 Mins
- `PI_SUBAGENT_HARD_TIMEOUT_MINS` default: 20 Mins

## 0.15.2 (2026-08-18)

### Improvements

- Colored borders around thread viewer overlay using agent color.
- Colored scroll-indicator arrows (↑/↓) matching agent color.
- Scroll offset only resets when switching to a different thread, not on every refresh.

## 0.15.1 (2026-08-17)

### Improvements

- Project-local agent approval is now a single select — **Allow once / Trust for this session / Deny** — instead of a yes/no confirm repeated on every delegation. "Trust for this session" remembers the project agents dir for the session (cleared on `session_start`); dismissed dialogs and Deny cancel the delegation. Headless sessions still fail closed.
- New test coverage for the approval gate (Deny / dismissed / headless / trust-remembering / session_start clearing).

## 0.15.0 (2026-08-09)

### Packaging

- Added `extensions/background.ts`, `history.ts`, `result.ts`, `widget.ts`
  to `files[]` — they were imported by `index.ts` but missing from the
  manifest, so the published package would have failed to load.

### Compact collapsed result (no tool-call trace in conversation)

Completed single subagent results no longer dump the tool-call trace
(`→ ls`, `→ grep`, `→ read …`) into the conversation block. The collapsed
view now shows the answer preview + usage, matching Claude Code's
`⎿ Done (N tool uses · tokens)` and pi-task's `⎿ <summary> (Ctrl+O to expand)`
UX. The full trace remains available via Ctrl+O (expanded) and `/agent`
(thread viewer); the hint text now points to both.

- `renderSingleResult` collapsed branch: `✓ agent` + `⎿ <first ~200 chars of
  final output>` + usage + `(Ctrl+O to expand · /agent for full thread)`.
- Removed the dead `renderDisplayItems` / `COLLAPSED_ITEM_COUNT` — the
  collapsed path no longer lists tool calls (was the noise source).
- Parallel and chain collapsed views were already compact (per-task/step
  one-liners) — unchanged.
- New tests: `render.test.ts` (5 cases) asserting collapsed shows the answer
  preview and NOT the tool-call trace, plus error/no-output/hint paths.

### Live progress widget (Phase 1)

A persistent above-editor widget now shows what each running subagent is doing
right now — spinner, agent name, elapsed time, tool-call count, and the latest
tool call with ✓/✗/⟳ status. Fed by live `threadStore` subscriptions (per SDK
session event), not JSONL polling. Replaces the old 30s plain-text
"still running…" heartbeat.

- One block per running thread (single, parallel, chain), capped at 8 +
  `+N more running`.
- Latest tool-call line with `done`/`error`/`in_progress` status derived by
  pairing assistant `toolCall` parts against later `toolResult` messages.
- Clears automatically when no threads are running.
- Inspired by [pi-task](https://github.com/heyhuynhgiabuu/pi-task)'s widget UX,
  but cheaper: in-process SDK gives per-event live data without polling.

### Background mode + task control (Phase 2)

- `background: true` (single mode only) runs the subagent detached: `execute`
  returns immediately with a receipt, and completion arrives as a follow-up
  turn via `sendMessage({ triggerTurn: true, deliverAs: "followUp" })`.
- `operation: "status"` / `operation: "cancel"` with `taskId` inspects or
  cancels a running background task without relaunching.
- A `pi-subagent-complete` message renderer renders the follow-up turn
  compactly (status icon, agent, output, usage).
- Background tasks are aborted and the widget is disposed on `session_shutdown`.

### Structured result + history registry (Phase 3)

- New `result.ts`: parent-side structured extraction of the child's final
  message (summary, findings, files, caveats, next steps) by detecting
  markdown headers. No child XML contract — we structure the output ourselves.
- New `history.ts`: durable metadata under `.pi/subagent-history.json`. Every
  completed task (foreground and background) is recorded.
- `/subagent history` lists recent delegations with status and timestamp.
- On restart, prior-session `running` entries are marked `interrupted` (honest
  about the in-process ceiling: we cannot resume a live SDK session).

## 0.14.1 (2026-08-07)

### Improvements

- Widen peer dependency range to support Pi 0.84.0 (`>=0.80.0 <0.85.0`).
  No code changes — verified compatible against the 0.84.0 SDK types.

## 0.14.0 (2026-08-05)

### Git worktree isolation (`sandbox: worktree`)

Agents can now run in an isolated **git worktree** instead of the parent's
working tree — the safe way to run parallel implementation agents that edit
files. Set `sandbox: worktree` in agent frontmatter (see `agent-format.md`).

- Child file mutations land in `.pi-worktrees/<id>` under the repo root; the
  main checkout stays untouched, so two parallel `worker` agents can never
  clobber each other's edits.
- On completion, a unified diff of the child's changes is returned as
  `result.patch` and shown in the thread viewer as a `🌿 worktree` badge.
- **Merging is explicit** — the parent receives the diff and applies it via
  `apply_patch` / cherry-pick / discard; nothing is auto-merged.
- The worktree is removed in a `finally` on success, error, or abort.
- Falls back to in-process execution with a warning when the cwd is not a git
  repo (`ponytail`: isolation optimization, not a hard requirement).
- Wired through the `subagent` tool, the service path (`pi-subagent:run` for
  pi-review), and `runner.ts`'s `runSubAgent` (new `sandbox` + `exec` options).

## 0.13.0 (2026-07-31)

### Subagents inherit parent extensions & tools by default

Subagents can now use the same tools the main agent has — including extension
 tools like `web_search`, `serena_*`, `munin_*`, `obsidian`, and `notebooklm`.
 Previously children were restricted to the 7 Pi built-in tools (`read, grep,
 find, ls, bash, edit, write`) and could not load extensions, which made
 delegation far less capable than the main agent.

This follows the **Claude Code model**: subagents inherit the parent's tool set,
 with a small denylist (`subagent` — recursive delegation is always prevented)
 and per-agent restriction via an explicit `tools:` line.

**Tool resolution:**
- Agent **omits** `tools:` → inherits **all parent tools** (minus denylist).
  `worker` and `general-purpose` now do this.
- Agent **specifies** `tools:` → restricted to that list, validated against
  built-ins ∪ parent tools.
- `sandbox: read-only` / `readOnly` → filters the effective set to read-only.
- Denied tools (`subagent`) are **silently stripped**, never errored — whether
  explicitly listed or inherited. Inheritance must not crash on a tool the
  child cannot have (the inherited set always includes `subagent`).

**Smart lean optimization:** extensions are only loaded when the effective tool
 set contains at least one non-built-in tool. Recon agents with a built-in-only
 `tools:` line (scout, tester, planner, reviewer) stay cheap — zero extension
 overhead, same fast cold-start.

**Per-child extension loader.** Children that need extensions get a FRESH
 `DefaultResourceLoader` each run (extensions only: no skills, prompt templates,
 AGENTS.md, or themes). The loader must NOT be cached/shared: extensions capture
 the ExtensionAPI at factory-load time, and its actions delegate to the runtime
 the factory was given (pi.getAllTools() → runtime.getAllTools()). A shared
 loader's runtime is never the one any single child binds — children then hit
 the runtime's throwing "Extension runtime not initialized" stubs on the first
 provider request (pi-model-tools' before_provider_request calls pi.getAllTools())
 or stale-ctx errors after the first child's dispose invalidates the shared
 runtime. A per-child loader keeps every captured `pi` pointing at a runtime the
 child both binds and owns. reload() per child re-reads extension files +
 re-runs factories; acceptable for short-lived children.

Extension load errors in children are logged, not fatal. Project-extension trust
 is inherited from the parent (children never prompt).

### Bundled agent changes

- `worker` and `general-purpose`: removed the explicit `tools:` line so they
  inherit all parent tools.
- `scout`, `tester`, `planner`, `reviewer`: unchanged (still lean + restricted).

## 0.12.4 (2026-07-30)

### Improvements

- Widen Pi peer dependency range to <0.84.0 for Pi 0.83.0 compatibility.

## 0.12.3 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.12.0 (2026-07-24)

### Model routing

- Chains are now **free-first** to conserve the metered opencode-go budget: paid DeepSeek moves to the **last** position so free nvidia/openrouter fallbacks are tried first. Previously DeepSeek sat at position 2 and burned quota whenever the free GLM primary rate-limited.
- **Removed two dead fallbacks** found by live-testing every free model on 2026-07-24: `nvidia/moonshotai/kimi-k2.6` (HTTP 404, NVCF not provisioned for the account) and `nvidia/z-ai/glm-5.2` (timeout). These are non-rate-limit failures, so the rate-limit retry loop did not advance past them — a subagent that reached them died instead of falling through to the working `:free` entries behind them.
- New chains: scout/tester `glm-5-turbo` → `nvidia/gpt-oss-20b` → `deepseek-v4-flash`; worker/general-purpose `glm-5.1` → `nvidia/mistral-small-4-119b-2603` → `nemotron-3-super:free` → `deepseek-v4-flash`; planner/reviewer `glm-5.2` → `nemotron-3-ultra:free` → `deepseek-v4-pro`.
- Verified-working free additions: `nvidia/openai/gpt-oss-20b` (1.2s), `nvidia/mistralai/mistral-small-4-119b-2603` (2.6s, 119B reasoning), `openrouter/nvidia/nemotron-3-nano-30b-a3b:free` (1.2s).

## 0.11.0 (2026-07-23)

### Model routing

- Bundled roles now route through **zai-coding-cn** (GLM) as the primary provider, with a provider-diverse fallback chain: `zai-coding-cn` (free GLM) → `opencode-go` (cheap `deepseek-v4-flash`) → `nvidia` (free NIM) → `openrouter` (`:free` models, last resort).
- Fast tier (scout, tester) uses `glm-5-turbo` with `thinking: off` (GLM reasoning is ~11× slower; these are mechanical roles).
- Strong-coding tier (worker, general-purpose) uses `glm-5.1`; deep-reasoning tier (planner, reviewer) uses `glm-5.2` (the only GLM with reasoning-effort control).
- opencode-go contributes one DeepSeek model per role, matched to strength: `deepseek-v4-flash` for scout/tester/worker/general-purpose, `deepseek-v4-pro` for planner/reviewer — never its GLM models, which cost ~$1.40/$4.40 per M versus zai-coding-cn's free GLM.
- Chains are cost-ascending on failure and spread load 2/2/2 across the GLM tiers to respect GLM's low concurrency; the existing rate-limit retry walks the chain on 429s.
- Free-model fallbacks verified live against the OpenRouter API: `nemotron-3-super:free` (worker/general-purpose) and `nemotron-3-ultra:free` (planner/reviewer) respond correctly with reasoning on. scout/tester omit a `:free` entry because their `thinking: off` conflicts with reasoning-mandatory `:free` models (`gpt-oss-20b:free` returns HTTP 400 when reasoning is disabled; `gemma-4-31b:free` rate-limits, `cohere/north-mini-code:free` returns empty).

## 0.9.2 (2026-07-16)

### Pi SDK compatibility

- Removed use of the deleted `AuthStorage.inMemory()` API so delegated planner and other subagents start on Pi 0.80.10.

## 0.9.1 (2026-07-16)

### Activity-aware timeouts

- Child `timeout` values now define a sliding inactivity window (three minutes by default); real SDK lifecycle events reset it while a fixed 20-minute hard cap remains.
- `/agent` distinguishes real activity from transport heartbeats and reports idle versus hard timeouts.

## 0.9.0 (2026-07-16)

### Model routing

- Bundled roles now select the first authenticated model from an ordered preference list, with the authenticated parent model as the final fallback.
- Added read-only `planner` and focused `tester` roles for consequential design and cheap routine verification.
- Agent files accept `models` as a YAML array or comma-separated string; legacy `model` remains the explicit first choice.

## 0.8.2 (2026-07-16)

### Reliability

- Transient provider and transport failures receive one bounded SDK retry. Retrying Codex WebSocket failures uses the session's SSE fallback, waits through retrying `agent_end` events, clears recovered error state, preserves nonzero failure exit codes, and reports explicit timeout messages.

## 0.8.1 (2026-07-15)

### Review handoff

- Reviewer findings now require reproduction or evidence, expected behavior, and acceptance criteria so implementation agents receive self-contained actionable issues.

## 0.6.0 (2026-07-12)

### Security (breaking changes)

- **Project-agent confirmation removed from tool schema.** The `confirmProjectAgents` parameter is no longer exposed to the LLM. Project-agent approval is enforced via trusted configuration only. Interactive sessions prompt for confirmation; headless sessions fail closed unless `allowUnconfirmedProjectAgents` is explicitly enabled through trusted configuration (environment variable `PI_SUBAGENT_ALLOW_UNCONFIRMED_PROJECT_AGENTS=true` or pi settings).

- **Child working directories confined to the workspace.** Tool-specified `cwd` values are validated against the workspace root. Relative paths are resolved within the workspace; `..` traversal, absolute paths outside the workspace, and symlink escapes are rejected. A trusted `allowExternalCwd` setting (env `PI_SUBAGENT_ALLOW_EXTERNAL_CWD=true` or pi settings) can opt out.

- **Tool allowlist enforced.** Child agent tools are validated against a fixed allowlist: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`. The `subagent` tool is always rejected. Unknown or misspelled tool names produce clear errors. Read-only service execution cannot gain `bash`, `edit`, or `write`.

- **Default timeout added.** Every child execution receives a default 10-minute timeout (`DEFAULT_TIMEOUT_MS`). Maximum allowed timeout is 60 minutes (`MAX_TIMEOUT_MS`). Timeout errors are distinguishable from parent cancellation.

### Reliability

- **Abort signal composition fixed.** `createCombinedAbortSignal()` correctly combines multiple abort signals with proper listener cleanup. Works without `AbortSignal.any()` via a manual fallback that removes all listeners after the first abort.

- **Parallel abort listeners cleaned up.** Parent-signal listeners attached during parallel execution are removed in a `finally` block after completion.

- **Canonical result status.** `SubAgentResult.status` classifies outcomes as `"success"`, `"partial"`, `"error"`, `"aborted"`, or `"timeout"`. Known Pi SDK stop reasons are classified explicitly; unknown reasons default conservatively to `"error"`.

- **Validation hardened.** Numeric and collection limits (timeout, max parallel tasks, concurrency, chain length, output cap, instructions length) are enforced at both schema and runtime levels.

- **Parallel result ordering preserved.** Results remain in input-task order regardless of completion order.

- **`abortOnFailure` behavior deterministic.** First canonical failure aborts running siblings; queued tasks never start; completed tasks retain their results.

### Agent discovery

- **Malformed agent files produce diagnostics.** Missing name, missing description, empty name, invalid model, invalid thinking levels, and unreadable files are reported with file path and severity. Valid agents continue to load.

### Packaging

- **Peer dependency ranges constrained.** `@earendil-works/pi-*` dependencies use `>=0.80.0 <0.81.0`; `typebox` uses `>=1.3.0 <2.0.0`.

- **Node engine requirement added.** `engines.node: ">=20.18"`.

- **Scripts fixed.** `npm test` uses locally installed `mocha` (no `npx`). Added `npm run check` (typecheck + test).

- **Package metadata updated.** `homepage` points to the package subdirectory.

- **`security.ts` added to published files.**

- **`CHANGELOG.md` added to published files.**

### Documentation

- **Security model section** added to README covering project-agent trust, cwd confinement, tool validation, timeout defaults, cancellation, result status, and compatibility.

### Backward compatibility

- `SubAgentResult.status` is a new field; existing consumers that ignore unknown fields remain compatible.
- Tool schema no longer accepts `confirmProjectAgents`; model-generated calls using it will be silently ignored (the field is fully removed from the schema, not just deprecated).
- Child `cwd` values that previously worked outside the workspace are now rejected unless the trusted `allowExternalCwd` setting is enabled.
- `combineAbortSignals()` is still exported from `runner.ts` but delegates to `createCombinedAbortSignal()` internally.
