# Changelog

## 0.1.1 - 2026-08-15

Stale-extension-ctx crash fix.

### Fixed

- **Crash after session replacement/reload:** `agent_settled`/`tool_result`
  handlers called `pi.getFlag("no-notify")` at event time. After
  `/new-session`, fork, switch, or reload, the SDK invalidates the old
  extension runner; teardown still emits `agent_settled`, and calling
  `pi.getFlag` on the stale runtime threw "This extension ctx is stale...".
  The flag is now captured once at extension load (CLI flags are immutable
  after parse) and handlers never touch the extension API.
- **Settings now actually load:** the `notify` config is read from
  `.pi/settings.json` → `~/.pi/agent/settings.json` (stdlib), refreshed on
  `session_start` with the fresh ctx.cwd. The previous `pi.getSetting?.(...)`
  path is not part of the public SDK API and always fell back to defaults in
  production.
- Every handler body is wrapped best-effort so a stale/missing API can never
  throw out of an event handler.

## 0.1.0

- Initial release.
- Desktop notifications on task completion (`agent_settled`) and errors (`tool_result` with `isError`).
- Cross-platform: macOS (`osascript`), Linux (`notify-send`), Windows (PowerShell toast), terminal OSC 777/99 fallback.
- Optional sounds per platform (`afplay`/`paplay`/`beep`/bell).
- `notify` settings object (`onComplete`, `onError`, `onQuestion`, `sound`, `volume`).
- `--no-notify` flag to disable for one run.
- Per-turn error dedupe.
- Zero dependencies, plain JS.
