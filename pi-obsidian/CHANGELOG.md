# Changelog

## 0.8.13 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

All notable changes to `pi-obsidian` will be documented in this file.

## 0.8.12 (2026-08-01)

### Fixes

- `parseCliString` / `readQuotedContent` now support single quotes. Previously
  `eval code='...'` (single-quoted) always failed with `Unexpected identifier
  'Error'` because single quotes were treated as literal characters and split the
  value at whitespace. Single-quote mode is shell-faithful (literal, no escape
  decoding), which also avoids the `\n`-decode footgun in JS code passed to eval.

### Documentation

- Added "Quoting rules for eval" section to SKILL.md: single-quote the outer
  `code=`, double-quote all JS strings inside, use `eval file=NoteName` as the
  escape hatch for code needing both quote types.
- Updated api-examples.md header with the one-line quoting rule.

## 0.8.11 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.8.10 (2026-07-24)

### Fixes

- Hoisted `property:set` argument validation before vault detection.

## 0.8.9 (2026-07-22)

### Fixes

- Closed remaining write silent-failure gaps and hardened cross-vault guards.

## 0.8.8 (2026-07-20)

### Fixes

- Fixed overwrite hang during sync and open-editor lifecycle.

## 0.8.6 (2026-07-16)

### Features

- `vaultWrite` base64+eval for write operations — eliminates all content escaping issues and argv length ceilings.

## 0.8.0 (2026-07-10)

### Features

- Initial 0.8 release with vault-discipline skill, cross-vault guards, and unified `obsidian` tool.
