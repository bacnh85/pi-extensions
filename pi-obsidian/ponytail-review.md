---
name: ponytail-review
description: Focused code review for over-engineering
mode: full
---

# ponytail-review: pi-obsidian extension

## cli.ts

L2-5: delete: `buildArgs` function (30 lines + 7 tests). Unused — single tool uses `parseCliString` + direct `execObsidian` calls. Zero callers since the 43→1 consolidation.

L69-72: shrink: `sleepSync` busy-wait for retry. `spawnSync("ping", ["-n", "2", "127.0.0.1"])` would yield the CPU instead of pegging it for 500ms.

## index.ts

L25-89: shrink: duplicate escape logic in `parseCliString`. The `\"`/`\\` unescape (`if (s[i] === "\\" && ...)`) is identical in both the `fully-quoted` (L33-35) and `inline-quoted` (L52-54) branches. Extract to a helper or fold the quoted + inline branches into one — both read until `"` with the same escape rules, only the entry point differs.

L109-112: delete: `formatSearchContext` routing in `formatObsidianOutput`. `formatSearchResults` already handles `search:context` JSON output — it has a `matches` branch for `{ file, matches: [...] }` objects. The `search:context` prefix check routes to a function that does the same thing less robustly. `formatSearchResults` handles the format. One fewer formatter to maintain.

L130-198: shrink: `promptGuidelines` is 70 lines of examples (~5K chars, ~1.25K tokens). The model knows Obsidian CLI syntax from training data. Cut to 30 essential examples — one per command category. Saves ~700 tokens.

## format.ts

L50-80: shrink: `formatSearchContext` (20 lines) is a less-featureful subset of `formatSearchResults`. Delete and let `formatSearchResults` handle it — it already parses `{ file, matches }` objects. Nobody calls `formatSearchContext` directly except `formatObsidianOutput` which we already route away.

## test/cli.test.ts

L1-43: delete: 7 tests for `buildArgs`. `buildArgs` is dead code since the 43→1 consolidation. The tests pass but test nothing reachable.

net: **-131 lines possible** (38 format.ts + 30 cli.ts + 38 index.ts + 25 test file)
