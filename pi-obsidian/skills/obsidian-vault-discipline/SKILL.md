---
name: obsidian-vault-discipline
description: >-
  Enforce using the Obsidian tool (not bash) for all vault file operations.
  Trigger whenever the user mentions Obsidian, vault, notes, moving files in the vault,
  archiving notes, or any file operation inside an Obsidian vault path.
  Also trigger when the agent is about to use bash mv/cp/rm/rename on paths 
  containing "obsidian", "hermes", "vault", ".obsidian", or similar vault indicators.
  Agents commonly default to bash for file operations — this skill prevents that mistake.
  Use BEFORE any file operation when vault paths are involved.
---

# Obsidian Vault Discipline

## Why this exists

The Obsidian CLI maintains its own file index separate from the filesystem.
Using `bash mv`, `bash cp`, or `bash rm` on vault files **bypasses this index**:
the file moves on disk but Obsidian can't find it. Search, backlinks, graph view,
and all vault-aware operations break silently.

This skill ensures every vault file operation goes through Obsidian's API.

## Rules

### ALWAYS use the `obsidian` tool for vault file operations

| Operation | Command |
|-----------|---------|
| Read | `read file="Note Name"` |
| Create | `create path="folder/note.md" content="..."` |
| Write/overwrite | `write file="note.md" content="..." overwrite=true` |
| Move/rename | `move file="Note" to="New Path"` |
| Rename in place | `rename file="Note" name="New Name"` |
| Delete | `delete path="old.md" permanent=true` |
| Append | `append file="Note.md" content="\nMore text"` |
| Prepend | `prepend file="Note.md" content="# Header\n"` |

### For bulk operations, use eval with Obsidian's JS API

The `eval` command runs JavaScript inside the Obsidian app with full access to
`app.vault` API. This is the right tool for batch operations.

**Move files matching a pattern:**
```
eval code='
const files = app.vault.getFiles().filter(f =>
  f.path.startsWith("source/folder/") && f.name.includes("keyword")
);
let n = 0;
for (const f of files) {
  const dest = "dest/folder/" + f.name;
  const folder = dest.split("/").slice(0, -1).join("/");
  if (!app.vault.getAbstractFileByPath(folder))
    await app.vault.createFolder(folder, true);
  await app.vault.rename(f, dest);
  n++;
}
return "Moved " + n + " files.";
'
```

**Delete test/temp files:**
```
eval code='
const files = app.vault.getFiles().filter(f =>
  f.name.startsWith("__test") || f.name.startsWith("Untitled")
);
let n = 0;
for (const f of files) { await app.vault.delete(f, true); n++; }
return "Deleted " + n + " files.";
'
```

**Rename a property in frontmatter (scoped to one file):**
```
eval code='
const f = app.vault.getAbstractFileByPath("path/to/note.md");
let c = await app.vault.read(f);
c = c.replace(/^old_property:/m, "new_property:");
await app.vault.modify(f, c);
return "Renamed.";
'
```

**List files by criteria:**
```
eval code='
return app.vault.getFiles()
  .filter(f => f.stat.size > 100000)
  .map(f => f.path + " (" + f.stat.size + " bytes)")
  .join("\n");
'
```

**Batch update frontmatter across many files:**
```
eval code='
const files = app.vault.getFiles().filter(f =>
  f.path.startsWith("folder/")
);
let n = 0;
for (const f of files) {
  let c = await app.vault.read(f);
  let m = c.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m || m[1].includes("status: archived")) continue;
  c = c.replace(/^status: active/m, "status: archived");
  await app.vault.modify(f, c);
  n++;
}
return "Updated " + n + " files.";
'
```

(See `references/api-examples.md` for more patterns.)

### NEVER use bash for vault operations

These commands **bypass Obsidian's index** and must not be used on vault paths:

| ❌ Wrong | ✅ Right |
|----------|---------|
| `bash mv file.md Archive/` | `move file="file" to="Archive/file.md"` |
| `bash rm *.md` | `delete path="file.md" permanent=true` |
| `bash cp note.md backup/` | `eval code="..."` with `app.vault.copy()` |
| `bash find vault -exec mv {} dest/ \;` | `eval code="..."` with `app.vault.rename()` |
| `bash cat > file.md <<EOF` | `create path="file.md" content="..."` |
| `bash sed -i 's/old/new/' file.md` | `eval code="..."` with `app.vault.modify()` |

### Detecting vault paths

A path belongs to an Obsidian vault if any of these are true:
- Running `vault` shows a vault whose path is a prefix of the target path
- The path or any parent directory contains `.obsidian/`
- The user explicitly says "vault", "obsidian", "my notes", "my vault"
- The target directory is known from a previous vault operation in the session

**When in doubt, check first:** run `vault` to confirm the vault root,
then check if your target path falls under it.

## Verification checklist

Before submitting any change involving vault files, confirm:
- [ ] No `bash` commands (mv, cp, rm, rename, sed, cat, find) were used on vault paths
- [ ] All file operations used the `obsidian` tool or `eval` with Obsidian JS API
- [ ] For bulk ops, the `eval` script handles folders that don't exist yet
- [ ] Test files created during the session were cleaned up via the `obsidian` tool

## Common pitfalls

- **`bash mv` is fast, but wrong.** One `mv` command saves 2 seconds but breaks the vault.
  If you need to move many files, use one `eval` call with a loop instead of 26 `move` calls.
- **"But I already used bash and it looks fine."** The file is on disk but Obsidian's index
  is stale. Run `obsidian search query="filename"` — if it returns nothing, the index is broken.
  Fix by using `eval` with `app.vault.rename()` to move it back through Obsidian's API, then
  move it properly.
- **`cat > file.md` in bash.** This creates a file on disk that Obsidian doesn't know about.
  Use `create path="..." content="..."` instead.
