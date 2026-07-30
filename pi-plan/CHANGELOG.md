# Changelog

All notable changes to `pi-plan` will be documented in this file.

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
