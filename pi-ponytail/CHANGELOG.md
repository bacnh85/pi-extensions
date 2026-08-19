# Changelog

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
