# Changelog

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
