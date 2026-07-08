# pi-obsidian v0.2

Pi extension for **Obsidian vault tools** — 43 tools to read, search, create, edit, and manage notes via the official [Obsidian CLI](https://obsidian.md/cli).

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

**Zero env vars.** Just make sure `obsidian` is in your PATH. Vault targeting uses `vault=<name>` as a tool parameter when needed; the CLI defaults to the most recently focused vault.

## Tools (43)

### Note Operations (8)
| Tool | Description |
|---|---|
| `obsidian_read` | Read note content by wikilink name or exact path |
| `obsidian_write` | Write full content (creates or overwrites) |
| `obsidian_create` | Create a new note (supports templates, overwrite) |
| `obsidian_append` | Append content to an existing note |
| `obsidian_prepend` | Prepend content to an existing note |
| `obsidian_delete` | Delete a note (trash or permanent) |
| `obsidian_move` | Move or rename a file |
| `obsidian_rename` | Rename a file in its current folder |

### Search & Structure (8)
| Tool | Description |
|---|---|
| `obsidian_search` | Full-text search with Obsidian's search index |
| `obsidian_outline` | Show heading outline of a note |
| `obsidian_links` | List outgoing wikilinks from a note |
| `obsidian_backlinks` | List notes linking to a note |
| `obsidian_unresolved` | List broken wikilinks in vault |
| `obsidian_orphans` | List files with no incoming links |
| `obsidian_deadends` | List files with no outgoing links |
| `obsidian_file_info` | Show metadata: path, size, dates, word count |

### Daily Notes (4)
| Tool | Description |
|---|---|
| `obsidian_daily_read` | Read today's daily note |
| `obsidian_daily_append` | Append to today's daily note |
| `obsidian_daily_prepend` | Prepend to today's daily note |
| `obsidian_daily_path` | Get today's daily note file path |

### Tasks (2)
| Tool | Description |
|---|---|
| `obsidian_tasks` | List tasks (daily/all/file, todo/done) |
| `obsidian_task` | Toggle/done/todo individual tasks by line |

### Properties & Tags (6)
| Tool | Description |
|---|---|
| `obsidian_property_set` | Set a frontmatter property (text, date, number, checkbox, array) |
| `obsidian_property_read` | Read a frontmatter property |
| `obsidian_property_remove` | Remove a frontmatter property |
| `obsidian_properties` | List all properties vault-wide or per-file |
| `obsidian_aliases` | List aliases vault-wide or per-file |
| `obsidian_tags` | List tags with frequency counts |
| `obsidian_tag` | Get detailed tag info with file list |

### Vault Overview (8)
| Tool | Description |
|---|---|
| `obsidian_vault_info` | Show vault name, path, file count, size |
| `obsidian_vaults` | List known Obsidian vaults |
| `obsidian_files` | List files filtered by folder/extension |
| `obsidian_folders` | List folders in vault |
| `obsidian_version` | Show Obsidian app version |
| `obsidian_recents` | List recently opened files |
| `obsidian_random` | Read a random note |
| `obsidian_wordcount` | Count words/characters in a note |

### Templates (2)
| Tool | Description |
|---|---|
| `obsidian_template_read` | Read a template (with optional variable resolution) |
| `obsidian_templates_list` | List all available templates |

### History & Versioning (3)
| Tool | Description |
|---|---|
| `obsidian_history` | List or read version history for a file |
| `obsidian_diff` | Diff two versions of a file |
| `obsidian_history_restore` | Restore a previous version |

### Developer (1)
| Tool | Description |
|---|---|
| `obsidian_eval` | Execute JavaScript in Obsidian's app context |

## Example

```bash
# Read a note
obsidian_read file="Meeting Notes"

# Write/overwrite a note
obsidian_write path="folder/note.md" content="# New Content\n\n..."

# Search the vault
obsidian_search query="project roadmap" limit=5

# Prepend a status banner to any file
obsidian_prepend path="old-note.md" content="<!-- STALE: last reviewed 2026-01 -->"

# Toggle a task
obsidian_task file="todo.md" line=12 done=true

# Rename a file
obsidian_rename file="Old Name" name="New Name"

# Target a specific vault
obsidian_search query="notes" vault="Work Vault"
```

## License

MIT

## License

MIT
