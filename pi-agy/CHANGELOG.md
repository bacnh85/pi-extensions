# Changelog

All notable changes to `pi-agy` will be documented in this file.

## 0.3.0 (2026-08-02)

### Fixed

- **Write delegation was silently no-oping.** Headless `agy -p` auto-denies
  write/tool permissions; every `accept-edits` (and `sandbox`) call returned
  exit 0 with no edits applied. pi-agy now passes `--dangerously-skip-permissions`
  for the two write modes (`accept-edits`, `sandbox`); `plan` is read-only and
  never receives it.
- **Model names were stale and in the wrong format.** Aliases now map to agy's
  canonical machine names (`gemini-3.6-flash-medium`, `claude-sonnet-4-6`, …)
  from `agy models`, not display names that drift across versions. Added the
  Gemini 3.6 family (previously unmapped). Verified all 8 aliases against live
  `agy 1.1.8`.
- **Install instructions were factually wrong.** agy is a Go binary, not pipx.
  README, SKILL, and the 3 runtime ENOENT error strings now point to the
  official installer (`curl -fsSL https://antigravity.google/cli/install.sh | bash`).

### Added

- **Structured output for `plan`/`sandbox`.** These modes now run with
  `--output-format json`; pi-agy extracts the `.response` field so Pi receives
  the answer, not the raw JSON envelope (with a safe fallback to raw text on
  schema drift).
- **Verify-loop injection for `accept-edits`.** When the project's
  `package.json` has a `test` script, pi-agy appends
  `After editing, run \`npm test\` and fix failures until it passes.` —
  implementing Google's own CLI Best Practices.
- **Phase-aware prompt framing.** `plan` → explore-only prefix; `sandbox` →
  isolation note; `accept-edits` → verify line. Replaces the digest-only prefix.
- Non-mocked live model-name smoke test, gated by `AGY_LIVE=1` (CI stays hermetic).

## 0.2.2 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.2.1 (2026-07-24)

### Features

- Support Pi 0.82.0 with widened peer dependency ranges (`<0.83.0`).

## 0.2.0 (2026-07-16)

### Features

- Added multi-model routing across Gemini, Claude, and GPT-OSS model families.
- Added quota-aware cross-review guidelines and model alias mapping (`flash-low`, `flash-medium`, `flash-high`, `pro-low`, `pro-high`, `sonnet`, `opus`, `gpt-oss`).

## 0.1.0 (2026-07-10)

### Features

- Initial release of Antigravity CLI (`agy`) bridge extension for Pi.
