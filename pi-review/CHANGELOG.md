# Changelog

## 0.2.8 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.2.7 (2026-08-04)

### Fixes

- **`sort -o` detection covers combined short flags.** `DESTRUCTIVE_BASH_PATTERNS` now matches `sort -no out.txt` / `sort -on out.txt` (not just standalone `-o`), closing a review-mode gate escape where `sort` with an embedded output flag was treated as read-only.
- **`serena_check_onboarding_performed` added to `SAFE_REVIEW_TOOLS`** (mirrors `READ_ONLY_TOOLS`), so the read-only onboarding check is available during review.

All notable changes to `pi-review` will be documented in this file.

## 0.2.6 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.2.5 (2026-07-24)

### Features

- Support Pi 0.81.0+ and 0.82.0 plugin API.

## 0.2.0 (2026-07-16)

### Features

- Added actionable issue handoffs with reproduction evidence, expected behavior, suggested fix, and acceptance criteria.
- Added activity-aware review inactivity timeouts (3-minute inactivity window, 20-minute cap).
- Blocked `awk` and dangerous commands in read-only fallback mode.

## 0.1.0 (2026-07-10)

### Features

- Initial release of `pi-review` isolated read-only code review extension.
