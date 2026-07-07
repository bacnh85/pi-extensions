---
name: obsidian-cli
description: Read, search, create, and manage notes in an Obsidian vault using the official Obsidian CLI. Use when the user asks about Obsidian, vault notes, daily notes, backlinks, tags, tasks, frontmatter, or wants to interact with their Obsidian vault programmatically.
platforms: [macos, linux, windows]
---

# Obsidian CLI

Use the `obsidian` CLI to interact with a running Obsidian instance for all vault operations.

## Prerequisites

- Obsidian 1.12+ must be running (CLI communicates via IPC)
- CLI must be enabled in Settings → General → Command line interface
- The `obsidian` binary must be in PATH (installer handles this)

## Tool Reference

Use these pi-obsidian tools for vault automation:

### Read Notes
- `obsidian_read file="Note Name"` — read by wikilink name
- `obsidian_read path="folder/note.md"` — read by exact path

### Create Notes
- `obsidian_create name="Note Name" content="Content"` — create a note
- `obsidian_create name="Note" template="TemplateName"` — create from template
- Use `silent=true` to avoid opening in Obsidian, `overwrite=true` to replace

### Append
- `obsidian_append file="Note" content="New text"` — append to a note
- `obsidian_append file="Note" content="inline text" inline=true` — append without newline

### Search
- `obsidian_search query="search terms"` — full-text search
- `obsidian_search query="terms" path="folder" limit=20` — scoped search
- Use `case_sensitive=true` for exact case, `matches=true` for context lines

### Daily Notes
- `obsidian_daily_read` — read today's daily note
- `obsidian_daily_append content="- [ ] Task"` — append to daily note

### Tasks
- `obsidian_tasks scope=daily` — tasks from today's daily note
- `obsidian_tasks scope=all status=todo` — all incomplete tasks
- `obsidian_tasks scope=file file="Note"` — tasks in a specific file

### Properties (Frontmatter)
- `obsidian_property_set name="status" value="done" file="Note"` — set property
- `obsidian_property_set name="due" value="2026-07-07" type=date file="Note"` — typed property
- `obsidian_property_read name="status" file="Note"` — read property

### Graph & Structure
- `obsidian_backlinks file="Note"` — files linking here
- `obsidian_tags counts=true sort=count` — tags with frequency
- `obsidian_orphans` — files with no incoming links
- `obsidian_unresolved` — broken wikilinks

### Vault Info
- `obsidian_vault_info` — show vault name, path, file count
- `obsidian_files` — list files (filter by folder and extension)

### File History & Versioning
- `obsidian_history file="Note"` — list all versions for a file
- `obsidian_history file="Note" version=3` — read a specific version
- `obsidian_diff file="Note" from=1 to=3` — diff between versions
- `obsidian_history_restore file="Note" version=3` — restore a version

### Developer
- `obsidian_eval code="app.vault.getFiles().length"` — run JS in Obsidian

## Multi-Vault

Pass `vault=<name>` as a parameter to target a specific vault:
- `obsidian_search query="notes" vault="Work Vault"`

## Error Handling

- `obsidian CLI not found in PATH` → need to install/enable Obsidian CLI
- `Obsidian is not running` → start the Obsidian desktop app
- Commands default to the most recently focused vault

## Vault Path Resolution

This skill uses the CLI exclusively and does not need `OBSIDIAN_VAULT_PATH`. The CLI handles vault resolution internally via the running Obsidian instance.

For filesystem-level operations when Obsidian is not running, use the general Obsidian skill at `bacnh85/obsidian` which resolves the vault path via `find-vault.mjs`.
