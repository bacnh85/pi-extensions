# Changelog

## 0.1.14 (2026-09-12)

### Fixed

- ponytail-help Update section now documents the Pi flow (reinstall via `pi install npm:@bacnh85/pi-ponytail`) instead of stale Claude Code /plugin marketplace and Codex instructions; dropped the stale Codex/Claude Code host note from the Skills section.
- ponytail skill: removed a stray hardware paragraph (PCA9685/clock drift) leaked from an unrelated project — it was injected into every system prompt.
- Fixed "What change" → "What changes" in both intensity tables (ponytail, ponytail-help).
- extensions: removed an unreachable fallthrough notify at the end of the `/ponytail` handler (all `parsePonytailCommand` result types already return).

## 0.1.13 (2026-09-04)

### Added

- Subagent injection (upstream #254/#522 equivalent): a `tool_call` hook prepends a compact ponytail block to the `subagent` tool's `instructions`, so built-in-only subagents (which don't load extensions) inherit the ladder. Applies to all subagent roles except `off` and `review` modes; plans/reviews/reports explicitly requested by the task are delivered in full. `PONYTAIL_SUBAGENT_SCOPE=off` disables. Safety: injection is skipped when it would push instructions past pi-subagent's 16KB cap (caller's contract is never truncated), and `before_agent_start` skips when the marker is already present (extension-loaded children self-inject — no double copy).

### Changed

- Bare `/ponytail` now reports the active level and persisted default (upstream #99) instead of silently resetting the mode. Use `/ponytail <mode>` to change level; README and help skill updated to match.
- Upstream sync reviewed through v4.9.0: all skills and pi-relevant extension fixes already present; post-v4.9.0 upstream is host-adapter work (Grok/Copilot/marketplace), N/A for Pi.

## 0.1.12 (2026-08-29)

### Added

- `/ponytail` argument completion offers runtime modes plus `status|default`.

## 0.1.11 (2026-08-14)

### Fixes

- `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain`, `/ponytail-help` now pass `{ expandPromptTemplates: true }` to `pi.sendUserMessage()` so the `/skill:` payload actually expands. Since pi 0.84.1, extension-originated `sendUserMessage()` skipped skill/command expansion; pi 0.84.2 added the opt-in flag that restores it.

## 0.1.10 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

All notable changes to `pi-ponytail` will be documented in this file.

## 0.1.9 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.1.6 (2026-07-20)

### Features

- Added `hideStatus`, `quietStartup`, and review mode support.
- Enhanced `/skill:ponytail-review` over-engineering diff review workflow.

## 0.1.4 (2026-07-10)

### Features

- Initial release of `@bacnh85/pi-ponytail` (fork of ponytail v4.8.4 adapted for Pi).
