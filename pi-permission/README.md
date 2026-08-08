# pi-permission

Granular permission system for [Pi](https://pi.dev) — an opt-in companion to Pi's container-first philosophy for users who can't always containerize.

Config-driven `allow` / `ask` / `deny` rules per tool, with wildcard pattern matching, an external-directory boundary, and a doom-loop guard. Inspired by OpenCode's `permission` config.

> Pi's default stance is *"No permission popups. Run in a container, or build your own."* This package is the middle ground: a config-driven policy for users who run Pi without a container but still want guardrails.

## Install

```bash
pi install npm:@bacnh85/pi-permission
```

## Configuration

Add a `permission` object to `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global):

```json
{
  "permission": {
    "*": "ask",
    "bash": { "*": "ask", "git *": "allow", "npm *": "allow", "rm *": "deny" },
    "edit": { "*": "deny", "src/*.ts": "allow" },
    "write": { "*": "deny", "src/*": "allow" },
    "read": { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
    "external_directory": { "~/projects/personal/*": "allow" }
  }
}
```

### Actions

| Action | Behavior |
|--------|----------|
| `allow` | Runs silently, no prompt |
| `ask` | Prompts via the Pi UI (Allow once / Allow always this session / Deny) |
| `deny` | Blocks immediately |

### Patterns

- `*` matches zero or more of any character (including `/`)
- `?` matches exactly one character
- Everything else is literal
- **Last matching rule wins** (OpenCode semantics)
- `~` and `$HOME` expand at the start of path patterns

### Rule keys

| Key | Matches |
|------|---------|
| `bash` | the shell command |
| `read` / `write` / `edit` | the file path |
| `grep` / `find` / `ls` | the path/glob/pattern |
| `external_directory` | deny-gate for paths outside the project cwd |
| `*` | global default |

## Flags

| Flag | Description |
|------|-------------|
| `--yolo` | Auto-approve all `ask` prompts (explicit `deny` rules still enforced) |
| `--auto` | Alias for `--yolo` |

## Doom-loop guard

Blocks the 3rd identical tool call in a row. Cheap insurance against model loops. Always on when `pi-permission` is configured.

## Default security

By design, when no rule matches, `pi-permission` has **no opinion** (allows). This honors Pi's philosophy — the extension only acts when you've opted into rules. To lock down, set a `"*": "ask"` or `"*": "deny"` default.

The `.env` deny pattern (OpenCode's default) is a good baseline:

```json
{ "read": { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" } }
```

## Why

Pi's *"no permission popups"* philosophy is clean but binary: containerize, or trust everything. Many users run Pi locally without a container and still want to prevent `rm -rf`, protect `.env`, or restrict writes to `src/`. This package provides that middle ground, opt-in.

## License

MIT
