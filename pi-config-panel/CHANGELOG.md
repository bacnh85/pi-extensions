# Changelog

## 0.1.5 (2026-09-11)

### Changed

- Dropped the `pi-package` npm keyword: pi-config-panel is a library dependency
  of other extensions (no `pi` field), not a user-installable pi package, and
  should not surface in pi-hub / `keywords:pi-package` discovery.

## 0.1.4 (2026-08-29)

### Changed

- The inline picker is now cursor-aware: it edits whichever comma-separated
  entry the cursor sits in, not just the last one. Arrow left/right into an
  earlier entry retargets the list live (full list on a pure cursor move;
  typing filters as usual), Tab replaces that entry and PRESERVES the other
  segments, and the cursor parks at the end of the replaced segment.
  filterSuggestions/joinCompletion take an optional cursor (legacy two-arg
  calls keep last-segment behavior). Tests: helper cases + component flow
  (30 total).

## 0.1.3 (2026-08-29)

### Changed

- Editing a string row with an existing value now PREFILLS the input (cursor
  at the end) so entries are edited in place instead of retyped — backspace
  trims, `,` re-offers the picker, Tab appends, Enter commits. Blank submit
  still resets (callers define blank = default). Masked (secret) rows keep
  empty-start (never render the secret) and number rows keep type-to-replace.
  Non-masked rows drop the redundant `(was: …)` hint; editing hint lines now
  include `ctrl+u clear` (verified: pi-tui Input implements deleteToLineStart).
  Regression tests: prefill+edit flow, masked-stays-empty, empty-value path
  (28 tests total).

## 0.1.2 (2026-08-29)

### Fixed

- Inline suggestion list never rendered in the live TUI: `renderRow` returned
  the editing row as one joined string and `truncateToWidth` collapsed the
  ANSI-styled multi-line blob to its first line, so the popup was invisible
  and Tab always picked the first (alphabetical) item. `renderRow` now returns
  an array of lines — suggestions render as their own rows, `↑/↓` navigate,
  Tab picks the highlighted one. Regression test renders with a styled theme
  and asserts the suggestion row survives truncation.

## 0.1.1 (2026-08-29)

### Added

- Panel rows accept optional `completions` (inline suggestion list while
  editing): `filterSuggestions` filters by the segment after the last comma,
  `joinCompletion` implements segment replacement, `Tab` picks the highlighted
  suggestion and `Enter` always submits the typed text (custom values never
  get trapped).

## 0.1.0

- Initial release — kernel extracted from pi-a2a's `/a2a-config` panel (design unchanged since a2a 0.3.0).
- Exports: `openConfigPanel`, `ConfigPanelModel`, `makeOnAction`, `row`, `toInt`, `applyRows`, `kindValue`, row-model types.
- `BuildRows<T>` generic row builder replaces pi-a2a's hardcoded `buildRows`; `title` option replaces the hardcoded "A2A Configuration" header.
- Kernel tests ported from pi-a2a against a generic fixture config.

<!-- published 2026-08-22 -->
