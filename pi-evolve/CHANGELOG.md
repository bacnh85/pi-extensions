# Changelog

## 0.2.1 (2026-08-11)

### Fixed

- **Munin writes now actually work.** `writeLearning` passed `tags` to the Munin
  SDK as a comma-joined string, but the SDK requires an **array** (it calls
  `tags.join()`), so every Munin store threw `(tags || []).join is not a
  function` and `evolve_save` silently fell back to local JSONL — even with
  Munin configured. Tags are now split into an array for the Munin path
  (local JSONL keeps the compact string).
- **Munin creds resolve from subdirectories.** `loadMuninEnv` now walks parent
  directories to find the project root's `.env.local` (session cwd inside a
  package dir previously missed root creds and fell back to local).
- New regression test: Munin store() rejects string tags (mimics the real SDK
  contract). Tests: 69 → 70.

## 0.2.0 (2026-08-11)

### Added (v0.2 — similarity-keyed injection + auto-reflect)

- **`injectMode` setting** (`"recent" | "similar" | "both"`, default `"both"`):
  learnings are now retrieved by **similarity to the user's prompt** (via
  `event.prompt` in `before_agent_start`) instead of always the recent tail.
  Munin uses the semantic `search` action; the local JSONL path uses
  keyword-overlap ranking (`searchLearnings` / `rankLocal`). Falls back to
  recent when similar returns nothing.
- **`autoReflect` setting** (default `true`): when `agent_end` seals a buffer
  showing a recovery pattern (error → later ok on the same tool), pi-evolve
  fires a best-effort UI nudge suggesting `evolve_reflect`.
- **New tests**: similarity ranking, injectMode=similar injection, similar→recent
  fallback, auto-reflect nudge on/off, Munin search path (68 total).

## 0.1.1 (2026-08-11)

### Fixed (review-hardening, 3 reviewer rounds → PASS)

- **CRITICAL: settings now actually work.** `readSettings` used non-existent
  `pi.getSetting`/`pi.config` (the SDK has neither — only `registerFlag`/`getFlag`
  for boolean/string CLI flags), so every documented config knob silently fell
  back to defaults. Settings are now read directly from `.pi/settings.json`
  → `~/.pi/agent/settings.json` via new `extensions/lib/config.ts`.
- **Correct tool-call pairing for parallel calls.** `markResult` now matches by
  `event.toolCallId` (present on tool_call/tool_result) before falling back to
  tool name — out-of-order results for parallel same-tool calls are no longer
  misattributed.
- **Secret redaction balanced.** Redacts key=value/header-style secrets only
  (JSON keys, `API_KEY=`, `Bearer`), including space-containing values and
  base64 Bearer tokens (`+`/`=`), without mangling prose mentions of
  "password"/"secret"/"token".
- **Prompt-injection defense on injected learnings.** Stored learnings are
  framed as reference data, collapsed to single lines, and stripped of markdown
  structural characters (heading-position `#`, line-start `>`, code fences) —
  including in `anchors`. Legitimate `C#`/`#123`/`x > y` text is preserved.
- **Lossless multi-line round-trip.** Internal newlines in trigger/lesson/
  anchors collapse to spaces at storage, so write→read→inject never truncates.
- **Munin write failures degrade gracefully.** `evolve_save` falls back to
  local JSONL on `auto` when Munin throws; forced `munin` returns a structured
  error instead of crashing the tool.
- **Cross-session isolation.** Buffer/seal/counters reset on `session_start`
  (new/resume/fork) so prior-session digests never leak.
- **Inject digest bounded even for tiny budgets** (returns empty rather than
  negative-slice garbage); surrogate pairs never split on truncation.
- **18 new tests** (60 total) incl. mocked-Munin write/read/shape/failure paths.

## 0.1.0 (2026-08-11)

### Added

- **Initial release of `@bacnh85/pi-evolve`.** Trajectory-based self-learning loop
  for the Pi coding agent — the active capture/reflect/consolidate/inject half of
  agent self-improvement, complementing pi-munin (passive storage).
- **Automatic trajectory capture** via Pi SDK hooks: `tool_call` records tool +
  redacted input digest; `tool_result` marks ok/error with a 6-bucket category;
  `turn_end` records usage; `agent_end` seals the snapshot.
- **`evolve_reflect` tool** — returns the sealed trajectory snapshot + a prompt
  skeleton for the model to extract 0-3 structured learnings
  (`strategy` / `recovery` / `optimization`).
- **`evolve_save` tool** — persists a learning to Munin (tag `type:learning`)
  or a local JSONL fallback at `.pi/evolve/learnings.jsonl` (capped at 500).
- **Automatic injection** — `before_agent_start` prepends a compact
  "Recent Learnings" digest (last N, bounded) + the pi-evolve usage header.
- **`/evolve` command** — status: buffer size, last seal, learnings written,
  active store backend.
- **Configurable** via the `evolve` settings.json key (`enabled`, `autoInject`,
  `maxInject`, `store`, `bufferCap`, `localCap`).
- **Secret redaction** in input digests (API keys, tokens, Bearer headers,
  long base64 blobs → `[REDACTED]`).

### Design

- Implements the *Trajectory-Informed Memory Generation* pattern
  (arXiv:2603.10600) within the *Scaffolding Improvement / Memory* axis of the
  self-improving-agents taxonomy (arXiv:2607.13104).
- Reuses pi-munin as its persistence layer (does not reimplement storage);
  degrades to a local JSONL store when Munin is not configured.
- No new runtime dependencies beyond the optional `@kalera/munin-sdk` peer.
