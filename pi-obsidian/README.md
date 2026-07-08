# pi-obsidian v0.3

Pi extension for **Obsidian vault tools** — a single unified tool that runs any Obsidian CLI command: read, write, create, search, delete, move, rename, tasks, properties, history, daily notes, templates, and more.

**~6,500 fewer tokens per request** vs 43 separate tools (1.6K vs 8.1K).

## Requirements

- **Obsidian 1.12+** with CLI enabled in **Settings → General → Command line interface**
- **Obsidian desktop app must be running** — the CLI communicates via IPC
- The `obsidian` binary must be in your PATH (the installer handles this)

## Install

```bash
pi install npm:@bacnh85/pi-obsidian
```

From this repository:

```bash
pi install ./pi-obsidian
```

## Configuration

**Zero env vars.** Just make sure `obsidian` is in your PATH. Vault targeting uses `vault=<name>` as a parameter when needed; the CLI defaults to the most recently focused vault.

## Usage

One tool: `obsidian` with a `run` parameter containing the full CLI command.

```
obsidian run="read file=Meeting Notes" vault="My Vault"
```

### Common commands

| Category | Example |
|----------|---------|
| **Read** | `read file="Meeting Notes"` |
| **Create** | `create path=folder/note.md overwrite=true content="# Title\n\nBody"` |
| **Write** (create+overwrite) | Same as `create` with `overwrite=true` |
| **Append** | `append path=note.md content="More text"` |
| **Prepend** | `prepend path=note.md content="# Header"` |
| **Delete** | `delete path=old.md permanent=true` |
| **Move** | `move file=Note to="01 Projects/"` |
| **Rename** | `rename file=Note name="New Name"` |
| **Search** | `search query=roadmap limit=10` |
| **Tags** | `tags counts=true sort=count format=json` |
| **Tag** | `tag name="#type/reference" verbose` |
| **Tasks** | `tasks format=json` |
| **Task** | `task file=todo.md line=12 done` |
| **Properties** | `property:set file=Note name=status value=active` |
| **Daily note** | `daily:read`, `daily:append content="- [ ] Task"` |
| **Backlinks** | `backlinks file=Note format=json` |
| **Outline** | `outline file=Note format=json` |
| **History** | `history file=Note`, `diff file=Note from=1 to=3` |
| **Vault info** | `vault`, `vaults`, `files folder="01 Projects"` |

### Syntax rules

- **Quote values with spaces:** `file="My Note"`, `query="search phrase"`
- **Boolean flags:** `permanent`, `overwrite`, `total`, `silent`, `inline`, `verbose`
- **For JSON output:** add `format=json` flag
- **Target a vault:** add `vault="Vault Name"` to any command
- **Multiline content:** use `\n` for newlines, `\t` for tabs

## How it works

Previously this extension registered 43 separate tools (`obsidian_read`, `obsidian_create`, `obsidian_search`, etc.), consuming ~8,122 tokens per request. Now it registers a single `obsidian` tool that parses the `run` string and dispatches to the Obsidian CLI directly. All 23 tests pass.

## License

MIT
