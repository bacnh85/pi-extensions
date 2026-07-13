# pi-obsidian v0.7

Pi extension for **Obsidian vault tools** — a single unified tool that runs any Obsidian CLI command: read, write, create, search, delete, move, rename, append, prepend, tasks, properties, history, daily notes, templates, and more. Plus **enhanced operations** like recursive file listing, task creation, task filtering/grouping, and template-based note creation.

**~6,500 fewer tokens per request** vs 43 separate tools (1.6K vs 8.1K).

## v0.5 Fixes

| Bug | Fix |
|-----|-----|
| **B1**: `create` content with bare `"` truncates | Auto-escapes bare quotes in `content=`; add `content_from=SourceNote` to read content from a vault note |
| **B2**: `property:set` with array values | Auto-normalizes spaces in array values; rejoin split tokens |
| **B3**: `create` doesn't create subdirectories | `ensureFolderExists()` creates parent path before writing |
| **B4**: `files folder="/"` returns nothing | Handles root folder `/` and empty folder string |
| **B5**: No batch tag rename | New `tag-rename from=X to=Y` command scans all files and renames |
| **B6**: `eval` fragile with complex JS | New `eval file=ScriptNoteName` reads JS from vault note; auto-escapes bare quotes in `code=` |

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

### Standard CLI commands

| Category | Example |
|----------|---------|
| **Read** | `read file="Meeting Notes"` |
| **Create** | `create path=folder/note.md overwrite=true content="# Title\n\nBody"` |
| **Create (from note)** | `create path=note.md content_from=SourceNoteName` | Reads content from an existing vault note (bypasses CLI escaping) |
| **Append** | `append path=note.md content="More text"` |
| **Prepend** | `prepend path=note.md content="# Header"` |
| **Delete** | `delete path=old.md permanent=true` |
| **Move** | `move file=Note to="01 Projects/"` |
| **Rename** | `rename file=Note name="New Name"` |
| **Search** | `search query=roadmap limit=10` |
| **Search grouped** | `search query=roadmap group=file` | Results grouped by file |
| **Tags** | `tags counts=true sort=count format=json` |
| **Tag** | `tag name="#type/reference" verbose` |
| **Tag rename** | `tag-rename from="#moc" to="#type/moc"` | Renames a tag across all files |
| **Eval (inline)** | `eval code="app.vault.getFiles().length"` | Run JS inline |
| **Eval (file)** | `eval file=ScriptNoteName` | Run JS from a vault note (avoids escaping issues) |
| **Properties** | `property:set file=Note name=status value=active` |
| **Daily note** | `daily:read`, `daily:append content="- [ ] Task"` | Note: `daily:read`/`append`/`prepend` are CLI-native. `daily:today`/`daily:open` require the Obsidian desktop app and are not available via CLI.
| **Backlinks** | `backlinks file=Note format=json` |
| **Outline** | `outline file=Note` |
| **History** | `history file=Note`, `diff file=Note from=1 to=3` |
| **Vault info** | `vault` |
| **Files** | `files folder="01 Projects"` | Direct children |
| **Files (root)** | `files folder="/"` | Root-level files |
| **Files (recursive)** | `files folder="01 Projects" recursive` | Recursive listing |

### Enhanced commands

These are post-processed by the extension for richer output:

| Command | Example | What it does |
|---------|---------|-------------|
| **Recursive files** | `files folder="01 Projects" recursive` | Recursively list all files under a folder by traversing subfolders |
| **Tasks grouped** | `tasks format=json group=file` | Lists all tasks grouped by source file |
| **Tasks filtered** | `tasks format=json status=open` | Lists only open (`[ ]`) or done (`[x]`) tasks |
| **Tasks filtered+grouped** | `tasks format=json group=file status=done` | Done tasks grouped by file |
| **Search grouped** | `search query=roadmap group=file` | Search results grouped by file with line numbers |
| **Task creation** | `task-create path=note.md heading="Tasks" text="Buy milk"` | Adds a task line under the specified heading; creates the heading if missing |
| **Create from template** | `create-from-template template="Project Brief" name="My Project" folder="01 Projects" title="..."` | Reads a template, fills `{{placeholder}}` values, writes a new note |

### Syntax rules

- **Quote values with spaces:** `file="My Note"`, `query="search phrase"`
- **Boolean flags:** `permanent`, `overwrite`, `total`, `silent`, `inline`, `verbose`, `recursive`
- **For JSON output:** add `format=json` flag
- **Target a vault:** add `vault="Vault Name"` to any command
- **Multiline content:** use `\n` for newlines, `\t` for tabs

## How it works

Previously this extension registered 43 separate tools (`obsidian_read`, `obsidian_create`, `obsidian_search`, etc.), consuming ~8,122 tokens per request. v0.3 consolidated to a single `obsidian` tool that parses the `run` string and dispatches to the Obsidian CLI. v0.4 adds post-processing for recursive file listing, task filtering/grouping, task creation, and template-based note creation — all through the same unified tool.

## License

MIT
