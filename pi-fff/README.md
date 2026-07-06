# @bacnh85/pi-fff

A maintained Pi package based on upstream [`@ff-labs/pi-fff`](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff). It replaces the built-in `find` and `grep` tools with [FFF](https://github.com/dmtrKovalenko/fff.nvim) — a Rust-native, SIMD-accelerated file finder with built-in memory.

## What it does

| Built-in tool | pi-fff replacement | Improvement |
|---|---|---|
| `find` (spawns `fd`) | `fffind` (FFF `fileSearch`) | Fuzzy matching, frecency ranking, git-aware, pre-indexed |
| `grep` (spawns `rg`) | `ffgrep` (FFF `grep`) | SIMD-accelerated, frecency-ordered, mmap-cached, no subprocess |
| `@` file autocomplete (fd-backed) | `@` file autocomplete (FFF-backed, default) | Fuzzy ranking from FFF index/frecency |

### Key advantages over built-in tools

- **No subprocess spawning** — FFF is a Rust native library called through the Node binding. No `fd`/`rg` process per call.
- **Pre-indexed** — files are indexed in the background at session start. Searches are instant.
- **Frecency ranking** — files you access often rank higher. Learns across sessions.
- **Query history** — remembers which files were selected for which queries. Combo boost.
- **Git-aware** — modified/staged/untracked files are boosted in results.
- **Smart case** — case-insensitive when query is all lowercase, case-sensitive otherwise.
- **Fuzzy file search** — `find` uses fuzzy matching, not glob-only. Typo-tolerant.
- **Cursor pagination** — grep results include a cursor for fetching the next page.

## Install

Requirements:
- pi

### Install as a pi package

**Via npm (recommended):**

```bash
pi install npm:@bacnh85/pi-fff
```

Project-local install:

```bash
pi install -l npm:@bacnh85/pi-fff
```

## Tools

### `ffgrep`

Search file contents. Smart-case, auto-detects regex vs literal, git-aware. Results ranked by frecency (most-accessed files first).

Parameters:
- `pattern` — search text or regex
- `path` — directory/file constraint (e.g. `src/`, `*.ts`)
- `exclude` — exclude paths (e.g. `test/,*.min.js`)
- `caseSensitive` — force case-sensitive (default: smart-case)
- `context` — context lines around matches
- `limit` — max matches (default: 20)
- `outputMode` — `"content"` (default), `"files_with_matches"` (one preview per file), or `"count"` (file match counts)
- `cursor` — pagination cursor from previous result

Definition lines (function/class/interface/enum declarations) are auto-expanded with 3 lines of context for scannability.

### `fffind`

Fuzzy file name search. Frecency-ranked, git-aware, multi-word AND narrowing.

Parameters:
- `pattern` — fuzzy query (e.g. `main.ts`, `src/ config`)
- `path` — directory constraint
- `exclude` — exclude paths
- `limit` — max results (default: 30)
- `cursor` — pagination cursor from previous result

When the top result strongly dominates (exact match or score > 2x runner-up), a `→ Read` hint is shown.

### `resolve_file`

Resolve a vague file reference to an exact path. Auto-resolves when the top FFF candidate strongly dominates; returns ranked candidates when ambiguous.

Parameters:
- `pattern` — fuzzy file query (e.g. `"auth middleware"`, `"Chart component"`)
- `limit` — max candidates when ambiguous (default: 8)

### `fff_multi_grep`

Search file contents for any of multiple literal patterns in one pass. Uses FFF multi-grep. Useful for renamed symbols, aliases, or spelling variants.

Parameters:
- `patterns` — array of literal patterns (1-10)
- `path` — directory/file constraint
- `exclude` — exclude paths
- `context` — context lines around matches
- `limit` — max matches (default: 20)
- `outputMode` — `"content"`, `"files_with_matches"`, or `"count"` (default: `"content"`)
- `cursor` — pagination cursor from previous result

### `related_files`

Find companion files sharing the same base name stem. Discovers test files, type definitions, styles, stories, and other companions.

Parameters:
- `path` — reference file path (fuzzy or exact)
- `limit` — max related files (default: 8)

Example: `related_files({ path: "src/Chart.tsx" })` → `Chart.test.tsx`, `Chart.module.css`, `Chart.types.ts`

## Commands

- `/fff-health` — show FFF status (indexed files, git info, frecency/history DB status)
- `/fff-rescan` — trigger a file rescan
- `/fff-mode <mode>` — switch mode (tool name change requires restart)

## Modes

- `tools-and-ui` (default): registers `fffind`, `ffgrep` as additional tools + FFF-backed `@` autocomplete
- `tools-only`: additional tools only; keep pi's default `@` autocomplete
- `override`: replaces pi's built-in `find` and `grep` + FFF-backed `@` autocomplete

Mode precedence:
1. `--fff-mode <mode>` CLI flag
2. `PI_FFF_MODE=<mode>` environment variable
3. default (`tools-and-ui`)

## Flags

- `--fff-mode <mode>` — set mode (see above)
- `--fff-frecency-db <path>` — path to frecency database (also: `FFF_FRECENCY_DB` env)
- `--fff-history-db <path>` — path to query history database (also: `FFF_HISTORY_DB` env)
- `--fff-enable-root-scan` — allow indexing when launched from `/` (also: `FFF_ENABLE_ROOT_SCAN=1` env). FFF refuses to init at the filesystem root by default. Home directory scanning is always enabled for pi.

## Data

When database paths are provided, FFF stores:
- frecency database — file access frequency/recency
- history database — query-to-file selection history

No project files are uploaded anywhere by this extension. It runs locally and only uses the configured LLM through pi itself.

## Security

- No shell execution
- No network calls in the extension code
- No telemetry
- No credential handling beyond whatever pi and your configured model provider already do
- Search state is stored locally under `~/.pi/agent/fff/`
