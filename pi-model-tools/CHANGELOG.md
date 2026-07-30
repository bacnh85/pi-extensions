# Changelog

All notable changes to `pi-model-tools` will be documented in this file.

## 0.4.0 (2026-07-30)

### Fixes

- **Steering no longer fires for paths Serena cannot index** — `commandLooksLikeSemanticCodeSearch`
  and `grepLooksLikeSymbolSearch` now return `false` when the search target is in
  `node_modules/`, `dist/`, `build/`, or is a `.d.ts` file. Previously, bash
  `grep`/`find`/`awk` on these paths was hard-blocked with "use Serena" — but
  Serena does not index installed dependencies or generated declarations,
  creating a dead-end with no working tool.
- **Quoted grep patterns no longer treated as symbol lookups** — if the pattern
  starts with a quote character (`'`, `"`, `` ` ``), it's treated as a literal-text
  search rather than a symbol lookup, so `ffgrep`/`grep` on exact strings is no
  longer steered to Serena.

## 0.3.3 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.3.2 (2026-07-24)

### Improvements

- Added `applyPatchPreferenceGuidance` frontmatter/one-strike/3-line threshold steering.
- Added edit-vs-apply_patch evaluation harness and reviewer fixes.

## 0.3.1 (2026-07-20)

### Fixes

- `apply_patch` `@@` anchor deduplication — collapses redundant anchor lines restated as the first payload line.

## 0.3.0 (2026-07-16)

### Features

- Added edit-mismatch repair with whitespace-tolerant fallback matching.
- Added `apply_patch` Codex-style diff/patch tool for multi-line and multi-file code modifications.

## 0.2.0 (2026-07-10)

### Features

- Merged `pi-deepseek-tools` and `pi-glm` extensions into a single unified `pi-model-tools` package.
- Unified configuration under the `PI_MODEL_TOOLS_*` namespace.
