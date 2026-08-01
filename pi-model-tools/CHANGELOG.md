# Changelog

All notable changes to `pi-model-tools` will be documented in this file.

## 0.4.1 (2026-08-01)

### Fixes

- **`apply_patch`: bare blank lines in an added block no longer cause "Hunk context not found".**
  A bare (un-prefixed) blank line inside an Update `+`-block (common when models
  emit blank separators between paragraphs without the `+` marker) was parsed as a
  context line, which split the added block into two hunks and left the second
  with an empty/`[""]` match block → non-deterministic `Hunk context not found`.
  Blank lines inside an active payload are now treated as added empty lines.
  (ISSUE-apply_patch.md)
- **`apply_patch`: a pure-addition Update with no `@@` anchor now appends at EOF**
  instead of throwing an opaque "Hunk context not found".
- **`apply_patch` errors are now actionable.** `Hunk context not found` includes
  the anchor text plus the nearest matching file region (via `nearestBlock`);
  `ambiguous` lists the first matching line numbers.

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
