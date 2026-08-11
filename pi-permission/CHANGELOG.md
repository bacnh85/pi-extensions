# Changelog

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
