# Changelog

## 0.8.13 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

All notable changes to `pi-obsidian` will be documented in this file.

## 0.8.13 (2026-08-08)

### Fixes

- `vaultWrite` write operations no longer fail with "(no output)" on
  Obsidian 1.13.x. Root causes fixed (live-verified):
  - Adaptive base64 chunking now keeps chunk sizes a **multiple of 4** and
    splits on **UTF-8 character boundaries** — previously, non-multiple-of-4
    chunks silently dropped bytes on decode (e.g. 4998 of 5000 bytes), and
    multi-byte characters (emoji/CJK) split across chunks corrupted to U+FFFD.
  - Eval scripts are sized to stay under the Obsidian 1.13.x ~3100-char
    hang/corruption ceiling (path-length aware), with a 75ms spacing between
    successive evals to avoid payload corruption.
  - Write steps tolerate the empty-echo race (write succeeds but the CLI drops
    the result); the read-back djb2 verification is the single success gate.
    Verification now covers the full content for all modes (full-file hash for
    create/overwrite, tail-hash for append, prefix-hash for prepend).
  - Whole-write retry on verification failure applies to idempotent modes
    only (create→overwrite, overwrite); append/prepend throw instead of
    risking duplicated content.
  - Multi-chunk prepend inserts chunks at the correct offset (was: appended
    to the end, sandwiching old content between prepended chunks).
  - `createFromTemplate` tolerates the empty-echo race with a read-back
    existence check.
  - Removed dead `buildSuffixScript` / `buildPrefixScript`.

### Notes

- The original report's premise (async IIFE → pending Promise → empty stdout)
  was incorrect; `obsidian eval` does await Promises.

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
