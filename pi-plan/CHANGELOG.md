# Changelog

## 0.13.0 (2026-09-11)

### Changed

**Plan mode has its own model + thinking; normal mode is stock Pi.** pi-plan no
longer manages normal-mode model/thinking at all:

- Normal mode follows stock Pi: `/model` (or `Ctrl+P`) is a session pick,
  `Ctrl+S` in the picker saves the startup default (`settings.json`),
  `/thinking` (or `Shift+Tab`) adjusts the level. pi-plan never overrides the
  normal-mode model or thinking — including `--model`, session resume, and
  branch switches.
- New `/plan-model [<provider/model>|clear]` (no `-g`): sets the **plan-mode
  model**, persisted globally under the `pi-plan` key in `settings.json`.
  Applied immediately while plan mode is active. Without a ref, opens a
  `/model`-style picker in the TUI (Ctrl+S inert); refs complete inline with
  fuzzy search, and a failed picker falls back to a visible warning with the
  typed-ref usage. Fuzzy ref matching (exact `provider/id`, unique bare id,
  unique substring; ambiguous → error listing candidates).
- New `/plan-thinking [<level>|clear]` (no `-g`): sets the **plan-mode thinking
  level**, persisted globally. Applied immediately while plan mode is active.
- **Smooth toggling.** Entering plan mode remembers the model + thinking active
  at that moment and applies the plan config; leaving plan mode restores them.
  Model/thinking changes made *while planning* (stock `/model` or `/thinking`)
  are session-temporary and reverted on leave — the plan config never leaks
  into normal mode. The snapshot survives resume, so leaving plan mode after a
  resume still restores correctly.
- Thinking-level clamp/echo protection: a `thinking_level_select` fired by pi
  core because the model clamped or re-set a level is never persisted as config
  (previously a clamp could silently overwrite `/plan-thinking xhigh` with
  `max`).
- **Config moved to `settings.json`.** Non-secret pi-plan config now lives under the
  `pi-plan` key in Pi's global `settings.json` (per the repo config-placement rule) instead
  of `~/.pi/agent/pi-plan/preferences.json`. The legacy file is migrated automatically on
  first load and renamed to `preferences.json.migrated`; a `pi-plan` block already present in
  `settings.json` takes precedence and leaves the legacy file untouched. `goalModel` (the
  `/goal` evaluator model) is now loaded back on start — previously it was written but never
  restored.
- Legacy `normalModel` / `defaults.normalThinking` / `perModel` entries are dropped —
  normal mode follows stock Pi now (set your normal default with `Ctrl+S` in `/model`).
  The plan-side values (`planModel`, `defaults.planThinking`) carry over.

**Migration:** existing `~/.pi/agent/pi-plan/preferences.json` plan-side values are carried
  into `settings.json` automatically — no manual edit needed. Your normal-mode model default
  is now Pi's own startup default (`Ctrl+S` in `/model`), which stock Pi saves in
  `settings.json`.

## 0.12.0 (2026-09-09)

### Changed

Plan-mode Allow prompts cut by ~80% (analysis of 33 plan-mode sessions / 14 days:
~370 confirms, ~135 hard-blocks):

- Bash classifier additions (session-analysis-driven):
  - Env-assignment prefixes (`D=/path; ls $D`, `FOO=a BAR=b cmd`) are stripped
    before classification — each unique path no longer re-prompts (~68 confirms).
  - `cd dir && <read cmd>` chains auto-run (`cd` is read-classified, ~103 confirms).
  - Print-only `sed` auto-runs via a deny-probe gate: `-i`/`--in-place`/`w`/
    `e`/`-f`/`--file` forms stay behind confirmation or hard-block — including
    s-command flag tails (`s/x/y/ge` executes shell, `s/x/y/gw out` writes),
    `e;p` command separators, and glued `1wout`-style writes (GNU sed needs no
    space); word-interior w/e ("twelve") still read. Everything else is
    stdout-only (~87 confirms).
  - tar execute-class options always confirm: `--to-command=CMD` (runs CMD per
    extracted member) and `-I`/`--use-compress-program=CMD` (runs CMD as the
    compress/decompress program — `tar -tf a.tar -I sh` looks like a read).
  - `jq`, `strings`, `stat`, `file`, `du`, `tree`, `lsof`, `basename`,
    `dirname`, `realpath`, `read`, `diff`, `cmp` added to the read list.
  - `xargs` classifies its payload command (`… | xargs grep` reads;
    `… | xargs rm` still hard-blocks; `xargs sh -c` confirms).
  - `tar -t`/`--list` and stdout-extract (`-x…O`, `--to-stdout`) read; other
    tar forms confirm.
  - Flow keywords `while`/`until`/`do`/`done` are transparent — body segments
    still classify individually (`while read -r f; do rm -rf $f; done` blocks).
- Raw line breaks are command separators, not writes: quoted multi-line jq/awk
  programs no longer false-block; each line still classifies individually
  (`echo hi⏎rm -rf x` stays hard-blocked; heredocs/redirects untouched).
- `READ_ONLY_TOOLS` += `ux_audit`, `a2a_peers`, `a2a_list`, `a2a_discover`,
  `a2a_status`, `a2a_history`, `unfold`, `recall`.
- `BLOCKED_TOOLS` += `apply_patch` (diff-style file mutator — same treatment as
  `edit`/`write`; a plan-mode model should never patch files).
- Plan-mode guidance now names the auto-run shell forms and the prompt/block
  forms so models stop emitting dead commands.

## 0.11.4 (2026-09-05)

- Widen Pi SDK peer range to `>=0.85.0 <0.86.0` and bump devDep to `^0.85.0` for Pi 0.85.0 compatibility (no breaking changes; peer cap widening only).

## 0.11.3 (2026-08-30)

### Fixes

- Plan-mode bash gate no longer false-blocks read-only commands (analysis of
  449 live hard-blocks across 222 plan-mode sessions):
  - stderr discards (`2>/dev/null`, `2>>/dev/null`) and fd duplicates
    (`2>&1`, `2>&-`, `1>&2`, `>&2`) are read-safe and auto-allowed; real
    redirects (`> file`, `2> err.log`, `< in`, and lookalike targets like
    `>/dev/null2`) stay hard-blocked.
  - `git -C <path> <read-subcommand>` (quoted paths like `-C "my repo"`,
    `-c k=v`, `--no-pager`) now classifies as read — `git -C repo status` was
    blocked 35 times. Mutating subcommands after any prefix still block
    (`git -C "my repo" push`).
  - `command -v x` / `command -V x`, `type x`, `which x` are reads. Bare
    `command` stays a writer wrapper — `command NAME` executes NAME
    (`command rm x` hard-blocks; reviewer-found bypass, fixed before publish).
- `write_plan`: `title` is now optional — derived from the first `# Heading`
  in `content` (falls back to `"Plan"`). Fixes 3 live validation failures where
  models sent only `content`.

## 0.11.2 (2026-08-29)

### Added

- Slash-argument autocomplete: `/goal` offers `status|pause|resume|clear`,
  `/plan-approve` offers `current|new|flow`, `/goal-model` offers `off` +
  models, and `/plan-fallback` offers `set|clear` plus head-preserving model
  refs after `set ` (`set m1 ` completes to `set m1 m2`).

## 0.11.1 (2026-08-26)

### Fixes

- Model picker now matches Pi 0.84.3's `ModelSelectorComponent` constructor
  (the `settings` param was removed; default-model persistence is now via
  Ctrl+S and stays disabled here). Fixes a typecheck failure against
  `@earendil-works/pi-coding-agent@0.84.3`.
- Peer dependency range narrowed to `>=0.84.3 <0.85.0` (the adapted constructor call
  is only valid against the 0.84.3 SDK signature).
- DevDeps bumped to pi SDK/pi-tui 0.84.3 for CI parity.

## 0.11.0 (2026-08-25)

### Removed

- The `advisor` tool and `/advisor` command moved to the new
  **`@bacnh85/pi-advisor`** package, which adds OMP-style automatic turn-end
  reviewing (severity-routed notes with an emission guard) on top of the
  on-demand consult. Install `@bacnh85/pi-advisor` to keep the feature; your
  advisor model preference auto-migrates on first start. Remove this package's
  old advisor before installing pi-advisor to avoid a duplicate tool name.

## 0.10.6 (2026-08-21)

- Renamed the late-loading-provider signal listener `9router:models-loaded` →
  `router:models-loaded` to match the pi-router rename (was: pi-9router).
  Deferred per-mode model apply now retries on the new event; behavior
  otherwise unchanged.

## 0.10.5 (2026-08-17)

### Improvements

- Plan-mode approval prompts (unknown bash executables, non-read tools, mutating subagents) now use a single select — **Allow once / Allow for this session / Deny** — instead of repeating a yes/no confirm on every call. "Allow for this session" remembers per tool (custom tools) or per executable (bash first token) until plan mode toggles. Long commands are clipped to 120 chars in the prompt body. Dismissed dialogs fail closed.
- Session allows are cleared on `session_start` (session replacement reuses the extension process), not only on plan-mode toggle.
- Session-allow keys are hardened: interpreter executables (node, npx, python, bash, …) are keyed by the **full command** (one approval must not blanket-allow any later script), and `subagent` approvals are keyed by the **requested agent set** (approving one mutating agent doesn't whitelist others).

## 0.10.4 (2026-08-11)

### Improvements

- Allow `evolve_reflect` (pi-evolve) in plan mode — it reads the in-memory
  trajectory buffer (read-only). `evolve_save` (pi-evolve's learning store
  mutation) is hard-blocked like `munin_store`.

## 0.10.3 (2026-08-07)

### Improvements

- Widen peer dependency range to support Pi 0.84.0 (`>=0.80.8 <0.85.0`).
  No code changes — verified compatible against the 0.84.0 SDK types.

## 0.10.2 (2026-08-06)

### Fixes

- **Plan mode no longer strands the agent after a clarifying question.** The
  `write_plan` tool result previously told the model to "ask the user to
  approve, refine, execute in current session, execute in a new session, or
  keep planning" — steering it into offering approve/execute options via
  `ask_user_question`, a path with no execution trigger (session replacement
  requires a command context). The tool result now directs approval to the
  existing `/plan-approve` flow (prefilled after the plan is written), and the
  plan-mode system prompt explicitly scopes `ask_user_question` to unresolved
  clarifying questions. Approval and execution continue to work exactly as
  before via `/plan-approve` (current/fresh/reviewed).

## 0.10.1 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.10.0 (2026-08-05)

### Features

- **Fallback model chain on provider overload/rate-limit.** New `/plan-fallback set <provider/model> ...` / `clear` command (persisted in `~/.pi/agent/pi-plan/preferences.json` under `fallbackModels`). When an assistant turn ends with an overload-style error (`429`/`529`, rate limit, quota exhausted, overloaded, 503…), pi-plan switches to the next model in the chain and re-submits the user's prompt. The chain resets to the primary model on the next successful message or fresh turn, so the primary is always tried first. Non-overload errors (e.g. context overflow — handled by Pi's own compaction) never trigger a fallback. Mirrors Claude Code's `fallbackModel`; the overload patterns live in `extensions/lib/fallback.ts` (extend as providers surface new error shapes). `/doctor` now shows the configured chain.

### Notes

- Switch threshold is a constant `1` (switch on first overload); a config knob can be added if transient blips become a problem.
- The switch rides on Pi's own retry loop: after `setModel`, Pi's retry continuation (`agent.continue`) resumes the SAME turn against the new model. No explicit re-submission is sent (a re-submit would spawn a fresh `before_agent_start` turn and reset the chain, and could duplicate the run — review finding). `before_agent_start` only fires on genuine fresh user prompts (`prompt()` path), never on retry continuations (verified in SDK `agent-session.js`), so the chain advances across retries and resets on the next real turn.
- The primary model is restored via `setModel` on the first successful message after a fallback switch, AND on the next `before_agent_start` when a turn ended mid-chain (review finding — a turn can end on a fallback when the retry budget is consumed, stranding the user otherwise). Missing-registry fallbacks are skipped, not stalled (review finding). If the primary can't be restored (not in registry / no API key), the user is warned and the reference is kept for the next turn.
- Fallback `setModel` calls are wrapped in the `applyingStoredModel` guard so Pi's `model_select` event (if emitted) cannot overwrite the user's per-mode `planModel`/`normalModel` preferences (review finding). This includes the `before_agent_start` cross-turn restore.

## 0.9.3 (2026-08-05)

### Features

- **Configurable plans directory with optional monthly archiving.** The plan output directory is now configurable via the `pi-plan.plansDir` setting (global `~/.pi/agent/settings.json` or trusted project `.pi/settings.json`, loaded alongside `btw`/`goal`). Default stays `.agents/plans` — fully backward compatible. A `{yyyymm}` placeholder in the value (e.g. `.agents/plans/{yyyymm}`) expands to the current month at write time, so plans auto-archive into monthly subfolders with no user scripts. The path resolves against the workspace `cwd`, and the existing write-path containment guard is preserved (the `{yyyymm}` segment matches any month at any position, so draft refinements across months stay safe). The workspace-context latest-plan lookup now scans one level of subdirectories, so monthly archives are still discovered (an unreadable subfolder is skipped, and equal-mtime plans tie-break deterministically). `{yyyymm}` and the plan filename timestamp use the UTC month.

## 0.9.2 (2026-08-04)

### Fixes

- **Plan-mode bash gate now allows read-only pipelines and chains.** `classifyCommand` previously hard-blocked any command containing `;`, `&`, or `|` as a potential write. It now splits on separators **outside quotes** (`splitShellSegments`) and classifies each segment: all-read-only chains (e.g. `grep foo src | head`, `ls -la; echo done`, and quoted alternation patterns like `grep -rn "a\\|b" file | head`) auto-run in plan mode; any known writer segment (redirect, `tee`, `cp`, `sort -o`, etc.) still hard-blocks; mixed/unknown segments require confirmation.
- **`awk` no longer auto-allows in plan mode.** `awk` is a Turing-complete interpreter (`system()`, `| getline`, `print >` redirect) — it is now classified as `confirm` (same as python/node), closing a sandbox escape where `awk 'BEGIN{system("touch marker")}'` ran without confirmation.
- **`sort -o` detection covers combined short flags** (`sort -no out.txt`, `sort -on out.txt`) and path-prefixed read commands (`/bin/ls`, `/usr/bin/grep`) are auto-allowed.
- **Windows read-only tools auto-allowed in plan mode.** The 10 pure-read `windows_*` tools (`windows_shell_detect`, `windows_audit_log`, `windows_path_to_*`, `windows_path_quote`, `windows_safety_classify`, `windows_doctor`, `windows_tool_discover`, `windows_wsl_list_distros`) are in `READ_ONLY_TOOLS`, so they no longer trigger the "Allow … in plan mode?" prompt. `windows_shell_exec` remains confirmation-gated (it executes arbitrary commands).

All notable changes to `pi-plan` will be documented in this file.

## 0.9.1 (2026-08-04)

### Fixes

- **Per-mode model now applies after `/login` adds the API key.** Previously, when the configured code/plan model had no API key at startup (e.g. `deepseek/deepseek-v4-flash` before `/login deepseek`), pi-plan warned "No API key … model switch skipped" and never retried — the model stayed un-applied until a restart or manual `/model`. The skipped apply is now retried **once** on the next prompt (`before_agent_start`), so adding the key via `/login` activates the configured model in normal and plan modes without restarting. The retry is one-shot (armed at most once per session, awaited): it cannot loop on a provider whose auth never resolves, and it cannot override an in-session `/model` pick because it targets the current per-mode model (which `/model` updates as you select).

## 0.9.0 (2026-08-03)

### Features & Improvements

- **`ask_user_question` — clarifying questions in any mode with a recommended default.** Generalized the former plan-mode-only `ask_plan_question` into `ask_user_question`, now available in both normal and plan mode (parity with Claude Code's `AskUserQuestion`). Uses the built-in list dialog (`ctx.ui.select`) with the same UX as the original `ask_plan_question`:
  - Marks the recommended option with ★ when the model passes `recommended` (strictly validated against the option labels).
  - Keeps the simple "Other / type my answer" path via the built-in editor for free-form answers.
  - Adds an explicit `recommended` field (must match one option label; strictly validated).
- **`ask_plan_question` deprecated.** The old tool name still works as an alias and emits a deprecation warning; it will be removed in a future release.

### Fixes

- **No custom TUI overlay — uses the built-in select dialog.** The earlier custom `ctx.ui.custom` overlay picker (with Tab-on-Other inline editing) was reverted: it could intermittently fail to render the question in some TUI states. The built-in `ctx.ui.select` dialog is the same list style the original tool used and renders reliably in all modes (TUI and RPC).
- **Non-TUI (RPC/JSON/print) mode works via the select dialog.** Unlike `ctx.ui.custom()` (a no-op stub in RPC mode), `ctx.ui.select` sends an RPC dialog the host can handle.
- **Consistent result `details`.** All return paths now carry both `wasCustom` and `cancelled` fields.
- **0-based `selectedIndex`.** Now matches the 0-based options array and `recommended` field.

## 0.8.9 (2026-08-01)

### Fixes

- **`/rewind` no longer skips checkpoints on large changes.** Previously, any workspace patch exceeding 50 KB caused `captureRewindCheckpoint` to throw `workspace patch exceeds 50 KB`, silently breaking `/rewind` during real feature work. Checkpoint payloads (tracked patches + untracked snapshot) are now stored in external files under `~/.pi/agent/pi-plan/checkpoints/<sessionId>/` instead of inline in the session JSONL, eliminating the size limit entirely. The session entry stores only a slim reference (`patchFile` path). Legacy inline-format checkpoints from older sessions still restore via backward compatibility.

## 0.8.8 (2026-07-30)

### Fixes

- **Per-mode model now works with late-loading providers (9router).** Previously `applyModeModel` gave up permanently when the configured model wasn't in the registry at startup/mode-toggle time (9router registers models from a background HTTP fetch). It now schedules a deferred retry and applies the model the instant the `9router:models-loaded` event fires.
- **Honest no-auth reporting.** `pi.setModel()` returns `false` (not a throw) when no API key is configured; the previous code misreported this as a successful switch. Now it warns "No API key for …; switch skipped."
- **Tighter `model_select` guard.** Only genuine user-initiated selections (`source: "set"` or `"cycle"`) are recorded as the per-mode pick. Non-user sources (e.g. another extension re-selecting a model) are ignored, preventing preference corruption.

### Removed

- **Removed `/plan-model` command.** Per-mode model recording is now fully automatic via `/model` in each mode. The `/plan-model set|clear` subcommands are no longer needed. The doctor output still shows the current per-mode model status.

## 0.8.7 (2026-07-30)

### Features & Improvements

- Added `/plan-model set plan|normal <provider/model>` to explicitly configure per-mode models with
  registry validation and immediate application when the target mode is active.
- `applyModeModel` now notifies the user when it switches models on mode toggle, making the per-mode
  override visible (prevents confusion where `/model` changes appear to be reverted).
- `/plan-model` (no args) now shows usage hints alongside the current values.

## 0.8.6 (2026-07-30)

### Improvements

- Widen Pi peer dependency range to <0.84.0 for Pi 0.83.0 compatibility.

## 0.8.5 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.8.4 (2026-07-24)

### Features & Fixes

- Added `/plan-model clear` command and doctor visibility for per-mode model overrides.
- Fixed stale per-model thinking levels when switching models in plan mode.

## 0.8.0 (2026-07-16)

### Features

- Added advisor thinking-level inheritance and per-mode model selection.
- Added `/goal` autonomous loop command with evaluator model verdict checking.
- Raised untracked snapshot budget to 1 MB.

## 0.5.0 (2026-07-10)

### Features

- Initial release of `pi-plan` plan mode extension with read-only gating, plan → implement → verify → review workflow, `/specs`, `/btw`, and `/rewind` checkpoints.
