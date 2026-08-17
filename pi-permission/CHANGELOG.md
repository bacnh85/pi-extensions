# Changelog

## 0.2.0 - 2026-08-17

Ask-prompt redesign + session-allow bug fix.

### Added

- "ask" prompts now offer **Allow once / Allow for this session / Add to permanent allowlist / Deny** instead of a bare 3-way choice. "Add to permanent allowlist" writes the exact (tool, subject) `allow` rule into the settings.json that already carries the permission config (creates `<cwd>/.pi/settings.json` if none exists), notifies with the file path, and also covers the rest of the session.
- Long commands/paths in the prompt body are clipped to 120 chars.

### Fixed

- **Multiline commands bypassed every rule (pre-existing security hole).** `wildcardToRegex` built `^.*$` without the `s` flag, so `.` didn't match newlines — heredoc/multi-line bash commands matched NO rule and silently bypassed every ask/deny. `*` now crosses newlines like it crosses `/` (regression-tested).
- **Session promotions could override an explicit deny.** Promotions are now consulted only after deny resolution (tool rule or global `*`), so tightening rules mid-session (re-read from disk on every call) always wins; a promotion only suppresses the ask prompt.
- **Wildcard-bearing subjects are refused by the permanent allowlist.** `git add *` would have been stored as a glob far broader than what the user approved — persistAllowlistRule now returns an error and the call is blocked with the reason.
- **Unparseable settings.json is never overwritten.** The permanent-allowlist writer now aborts with an error instead of silently replacing a corrupt file, and writes atomically (temp file + rename).
- A persisted allow rule is re-appended last (delete+set) so it wins under last-match-wins even when the same key existed earlier.
- Dialog text flattens control characters (newlines/ANSI) from model-controlled commands so the prompt can't be reshaped by command content.
- `join()` is now variadic — the 2-arg version silently dropped the third segment, resolving `~/.pi/agent` to `~/.pi`.

### Changed

- Subject-less tools (no command/path to key on) get only **Allow once / Deny** — no session/permanent remember options, since there is nothing to discriminate between calls.
- `grep`/`find`/`ls` subjects are the `path` param (pattern-only searches are subject-less).

### Fixed (session promotions)

- **Session promotions were lost in production.** "Allow always this session" stored promotions on the rules object, but settings are re-read from disk on every `tool_call` — so each new read produced a fresh object and the promotion never applied (the unit tests passed only because the stub returned the same object). Promotions are now module state keyed by (tool, subject), cleared on `session_start`.
- Dismissing the ask dialog (Esc → `undefined`) now **fails closed** (block) instead of silently allowing. Only an explicit "Allow once"/"Allow for this session"/"Add to permanent allowlist" choice allows.
- A whole-tool string rule (e.g. `"read": "ask"`) is preserved as `"*"` when the permanent-allowlist writer merges a pattern rule into it.

## 0.1.2 - 2026-08-15

Stale-extension-ctx crash fix (same root cause as pi-notify 0.1.1).

### Fixed

- `--yolo`/`--auto` flags captured once at extension load instead of being read
  from the extension API inside the `tool_call` handler. After a session
  replacement or reload the old runner is invalidated and `pi.getFlag` throws;
  a handler firing during teardown crashed the extension. Flags are immutable
  after CLI parse, so the load-time capture is equivalent.

## 0.1.1

- **Fixed: settings.json config now actually works.** The SDK's ExtensionAPI has
  no `getSetting`/`config` (only `registerFlag`/`getFlag` for CLI flags), so the
  previous `pi.getSetting?.("permission")` silently returned undefined and every
  documented rule block was ignored in production. Config is now read directly
  from `.pi/settings.json` → `~/.pi/agent/settings.json` via `readSettingsKey`.
  Tests: 22 → 24.

## 0.1.0

- Initial release.
- Config-driven `allow`/`ask`/`deny` permission rules per tool, with wildcard pattern matching.
- `external_directory` deny-gate for paths outside the project working directory.
- Doom-loop guard (blocks 3rd identical tool call).
- `--yolo` / `--auto` flags to auto-approve `ask` prompts.
- Session-scoped "Allow always" promotion.
- Zero dependencies, plain JS.
