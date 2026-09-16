# Changelog

## 0.1.2 (2026-09-12)

### Fixed

- **Removed the false header claim that resolved roots are "added to the
  permission allowlist for path tools."** No such code exists — references
  only inject into the system prompt; path access still follows whatever
  permission rules the user has configured.
- README: hidden refs with a description are **not** advertised — the snippet
  builder filters `description && !hidden`, so `hidden` wins. The table row
  previously claimed the opposite.
- `~`-prefixed local paths now expand via `os.homedir()` (previously kept
  literally, so the agent's path tools could never resolve them).
- `/refs` guards a missing `ctx.ui` instead of crashing.

## 0.1.1

- **Fixed: settings.json config now actually works.** The SDK's ExtensionAPI has
  no `getSetting`/`config` (only `registerFlag`/`getFlag` for CLI flags), so the
  previous `pi.getSetting?.("references")` silently returned undefined and every
  documented reference block was ignored in production. Config is now read
  directly from `.pi/settings.json` → `~/.pi/agent/settings.json` via
  `readSettingsKey`. Tests: 22 → 24.

## 0.1.0

- Initial release.
- `references` config: alias local directories or git repositories as `@alias`.
- Git refs clone lazily into `~/.pi/agent/refs/<alias>/` on first use.
- References with `description` injected into the system prompt every turn.
- `/refs` command lists configured references and resolved paths.
- String shorthand (`"../dir"` → path, `"owner/repo"` → repository).
- Alias validation (no `/`, whitespace, comma, backtick).
- Zero dependencies, plain JS.
