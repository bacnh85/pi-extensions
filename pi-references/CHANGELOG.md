# Changelog

## 0.1.0

- Initial release.
- `references` config: alias local directories or git repositories as `@alias`.
- Git refs clone lazily into `~/.pi/agent/refs/<alias>/` on first use.
- References with `description` injected into the system prompt every turn.
- `/refs` command lists configured references and resolved paths.
- String shorthand (`"../dir"` → path, `"owner/repo"` → repository).
- Alias validation (no `/`, whitespace, comma, backtick).
- Zero dependencies, plain JS.
