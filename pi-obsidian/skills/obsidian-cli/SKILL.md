---
name: obsidian-cli
description: Read, search, create, and manage notes in an Obsidian vault using the unified obsidian tool for Pi. Use when the user asks about Obsidian, vault notes, daily notes, backlinks, tags, tasks, frontmatter, or wants to interact with their Obsidian vault programmatically.
platforms: [macos, linux, windows]
---

# Obsidian CLI

Use the `obsidian` Pi tool to run any Obsidian CLI command against a running Obsidian instance.

## Prerequisites

- Obsidian 1.12+ must be running (CLI communicates via IPC)
- CLI must be enabled in Settings → General → Command line interface
- The `obsidian` binary must be in PATH

## Usage

```
obsidian run="<command> <key=value> ... <flag>" [vault="Vault Name"]
```

- **Quote values with spaces:** `file="Meeting Notes"`, `query="search phrase"`
- **Boolean flags:** `permanent`, `overwrite`, `total`, `verbose`, `inline`, `silent`
- **JSON output:** add `format=json` for commands that support it (search, tasks, tags, backlinks, outline, properties)
- **Multiline content:** use `\n` for newlines, `\t` for tabs
- **Target vault:** add `vault="Vault Name"` to any command

## Command Reference

### Read, Create, Edit
| Command | Example |
|---------|---------|
| `read` | `read file="Meeting Notes"` |
| `read` (by path) | `read path="folder/note.md"` |
| `create` | `create path=inbox/note.md overwrite=true content="# Title\n\nBody"` |
| `create` (from template) | `create name=Note template=TemplateName content=...` |
| `append` | `append path=note.md content="More text"` |
| `prepend` | `prepend path=note.md content="Header"` |
| `delete` | `delete path=old.md permanent=true` |
| `move` | `move file=Note to="01 Projects/"` |
| `rename` | `rename file=Note name="New Name"` |

### Search & Structure
| Command | Example |
|---------|---------|
| `search` | `search query=roadmap limit=10` |
| `search` (with context) | `search query=notes path="01 Projects" matches=true` |
| `outline` | `outline file=Note format=json` |
| `links` | `links file=Note` |
| `backlinks` | `backlinks file=Note format=json` |
| `unresolved` | `unresolved` — list broken wikilinks |
| `orphans` | `orphans` — files with no incoming links |
| `deadends` | `deadends` — files with no outgoing links |
| `file` | `file file=Note` — show metadata |

### Properties & Tags
| Command | Example |
|---------|---------|
| `tags` | `tags counts=true sort=count format=json` |
| `tag` | `tag name="#type/reference" verbose` |
| `property:set` | `property:set file=Note name=status value=active` |
| `property:set` (array) | `property:set file=Note name=tags type=list value='["#tag1","#tag2"]'` |
| `property:read` | `property:read file=Note name=status` |
| `property:remove` | `property:remove file=Note name=old-field` |
| `properties` | `properties format=json` — vault-wide with counts |
| `aliases` | `aliases file=Note verbose` |

### Tasks
| Command | Example |
|---------|---------|
| `tasks` | `tasks format=json` — all tasks in vault |
| `tasks` (file) | `tasks file=todo.md format=json` |
| `tasks` (daily) | `tasks daily format=json` |
| `task` | `task file=todo.md line=12 done` |
| `task` (toggle) | `task file=todo.md line=8 toggle` |
| `task` (custom status) | `task file=todo.md line=3 status=">"` |

### Daily Notes
| Command | Example |
|---------|---------|
| `daily:read` | `daily:read` |
| `daily:append` | `daily:append content="- [ ] Do thing"` |
| `daily:prepend` | `daily:prepend content="# Morning"` |
| `daily:path` | `daily:path` |

### Vault Info
| Command | Example |
|---------|---------|
| `vault` | `vault` — name, path, files, size |
| `vaults` | `vaults` — list known vaults |
| `version` | `version` — Obsidian app version |
| `files` | `files folder="01 Projects"` |
| `files` (by ext) | `files ext=.png` |
| `folders` | `folders` |
| `recents` | `recents` |
| `random:read` | `random:read` |
| `wordcount` | `wordcount file=Note` |

### History
| Command | Example |
|---------|---------|
| `history` | `history file=Note` — list versions |
| `history:read` | `history:read file=Note version=3` |
| `diff` | `diff file=Note from=1 to=3` |
| `history:restore` | `history:restore file=Note version=3` |

### Templates
| Command | Example |
|---------|---------|
| `templates` | `templates` — list available |
| `template:read` | `template:read name=Template resolve` |
| `template:insert` | `template:insert name=Template` — into active file |

### Developer
| Command | Example |
|---------|---------|
| `eval` | `eval code="app.vault.getFiles().length"` |

## Multi-Vault

```
obsidian run="read file=Note" vault="Work Vault"
```

## Error Handling

- `obsidian CLI not found in PATH` → need to install/enable Obsidian CLI
- `Obsidian is not running` → start the Obsidian desktop app
- Commands default to the most recently focused vault
