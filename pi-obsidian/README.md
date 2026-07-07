# pi-obsidian v0.1

Pi extension for **Obsidian vault tools** — read, search, create, and manage notes via the official [Obsidian CLI](https://obsidian.md/cli).

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
pi install ./extensions/pi-obsidian
```

## Configuration

**Zero env vars.** Just make sure `obsidian` is in your PATH. Vault targeting uses `vault=<name>` as a tool parameter when needed; the CLI defaults to the most recently focused vault.

## Tools

### Note Operations
| Tool | Description |
|---|---|
| `obsidian_read` | Read note content by wikilink name or exact path |
| `obsidian_create` | Create a new note (supports templates, silent, overwrite) |
| `obsidian_append` | Append content to an existing note |
| `obsidian_delete` | Delete a note (trash or permanent) |

### Search
| Tool | Description |
|---|---|
| `obsidian_search` | Full-text search with Obsidian's search index |

### Daily Notes
| Tool | Description |
|---|---|
| `obsidian_daily_read` | Read today's daily note |
| `obsidian_daily_append` | Append to today's daily note |

### Tasks
| Tool | Description |
|---|---|
| `obsidian_tasks` | List tasks (daily/all/file, todo/done) |

### Properties
| Tool | Description |
|---|---|
| `obsidian_property_set` | Set a frontmatter property (text, date, number, checkbox) |
| `obsidian_property_read` | Read a frontmatter property |

### Graph & Structure
| Tool | Description |
|---|---|
| `obsidian_backlinks` | List notes linking to a note |
| `obsidian_tags` | List tags with frequency counts |
| `obsidian_orphans` | List files with no incoming links |
| `obsidian_unresolved` | List broken wikilinks |

### Vault
| Tool | Description |
|---|---|
| `obsidian_vault_info` | Show vault name, path, file count, size |
| `obsidian_files` | List files filtered by folder/extension |

### History & Versioning
| Tool | Description |
|---|---|
| `obsidian_history` | List or read version history for a file |
| `obsidian_diff` | Diff between two versions of a file |
| `obsidian_history_restore` | Restore a previous version |

### Templates
| Tool | Description |
|---|---|
| `obsidian_template_read` | Read a template (with optional variable resolution) |

### Developer
| Tool | Description |
|---|---|
| `obsidian_eval` | Execute JavaScript in Obsidian's app context |

## Example

```bash
# Read a note
obsidian_read file="Meeting Notes"

# Search the vault
obsidian_search query="project roadmap" limit=5

# Create a note from template
obsidian_create name="Trip Report" template="Journal" content="# Trip Report\n\nNotes..."

# Append to daily note
obsidian_daily_append content="- [ ] Review pull requests"

# List backlinks
obsidian_backlinks file="Meeting Notes"

# List all tags
obsidian_tags counts=true sort=count

# Target a specific vault
obsidian_search query="notes" vault="Work Vault"
```

## License

MIT
