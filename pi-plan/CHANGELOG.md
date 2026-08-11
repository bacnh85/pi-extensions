# Changelog

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
