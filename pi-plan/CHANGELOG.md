# Changelog

All notable changes to `pi-plan` will be documented in this file.

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
