# Obsidian JS API — Bulk Operation Patterns

Reference for common bulk operations via `eval` in the Obsidian CLI.
All examples run inside `eval code='...'` through the `obsidian` tool.

## File operations

### Move files matching a pattern

```javascript
const files = app.vault.getFiles().filter(f =>
  f.path.startsWith("source/folder/") && f.name.includes("2026-06")
);
let n = 0;
for (const f of files) {
  const dest = "dest/folder/" + f.name;
  const dir = dest.split("/").slice(0, -1).join("/");
  if (dir && !app.vault.getAbstractFileByPath(dir))
    await app.vault.createFolder(dir, true);
  await app.vault.rename(f, dest);
  n++;
}
return "Moved " + n + " files.";
```

### Delete files matching a pattern

```javascript
const files = app.vault.getFiles().filter(f =>
  f.name.startsWith("__test") || f.name.startsWith("Untitled")
);
let n = 0;
for (const f of files) {
  await app.vault.delete(f, true);
  n++;
}
return "Deleted " + n + " files.";
```

### Copy files (duplicate)

Obsidian API doesn't have a native copy. Read + create under new path:

```javascript
const files = app.vault.getFiles().filter(f =>
  f.path.startsWith("source/folder/")
);
let n = 0;
for (const f of files) {
  const c = await app.vault.read(f);
  const dest = "backup/folder/" + f.name;
  const dir = dest.split("/").slice(0, -1).join("/");
  if (dir && !app.vault.getAbstractFileByPath(dir))
    await app.vault.createFolder(dir, true);
  await app.vault.create(dest, c);
  n++;
}
return "Copied " + n + " files.";
```

### List files by criteria

```javascript
return app.vault.getFiles()
  .filter(f => f.stat.size > 100000)
  .map(f => f.path + " (" + f.stat.size + " bytes)")
  .join("\n");
```

### Count files in a folder

```javascript
return app.vault.getFiles()
  .filter(f => f.path.startsWith("90 Hermes/Project Logs/"))
  .length + " files";
```

## Frontmatter / content operations

### Batch update a property value

```javascript
const files = app.vault.getFiles().filter(f =>
  f.path.startsWith("folder/")
);
let n = 0;
for (const f of files) {
  let c = await app.vault.read(f);
  let m = c.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) continue;
  if (m[1].includes("status: archived")) continue;
  c = c.replace(/^(status: )active$/m, "$1archived");
  await app.vault.modify(f, c);
  n++;
}
return "Archived " + n + " files.";
```

### Add a property to files missing it

```javascript
const files = app.vault.getFiles().filter(f =>
  f.path.startsWith("folder/")
);
let n = 0;
for (const f of files) {
  let c = await app.vault.read(f);
  let m = c.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m || m[1].includes("author:")) continue;
  c = c.replace(/^---\n/, "---\nauthor: \n");
  await app.vault.modify(f, c);
  n++;
}
return "Updated " + n + " files.";
```

### Bulk search and replace in content

```javascript
const files = app.vault.getFiles().filter(f =>
  f.path.startsWith("folder/")
);
let n = 0;
for (const f of files) {
  let c = await app.vault.read(f);
  let nc = c.replace(/old text/g, "new text");
  if (nc !== c) {
    await app.vault.modify(f, nc);
    n++;
  }
}
return "Updated " + n + " files.";
```

### Find files without frontmatter

```javascript
const missing = app.vault.getMarkdownFiles()
  .filter(f => {
    const c = await app.vault.read(f);
    return !c.startsWith("---");
  })
  .map(f => f.path);
return missing.length + " files without frontmatter:\n" + missing.join("\n");
```

## Folder operations

### Create nested folder (Obsidian creates parents automatically)

```javascript
// createFolder with second param = true creates parents
if (!app.vault.getAbstractFileByPath("a/b/c"))
  await app.vault.createFolder("a/b/c", true);
return "Created.";
```

### List empty folders

```javascript
const allFiles = app.vault.getFiles();
const folders = new Set();
for (const f of allFiles) {
  let dir = f.path.split("/").slice(0, -1).join("/");
  while (dir) {
    folders.add(dir);
    dir = dir.includes("/") ? dir.split("/").slice(0, -1).join("/") : "";
  }
}
// This is approximate — Obsidian API doesn't directly list empty folders
return "All folders tracked in vault index.";
```

## Error handling patterns

### Skip files that would cause errors

```javascript
for (const f of files) {
  try {
    await app.vault.rename(f, "dest/" + f.name);
  } catch (e) {
    // log and continue
  }
}
```

### Check existence before operation

```javascript
const dest = "target/note.md";
if (!app.vault.getAbstractFileByPath(dest)) {
  await app.vault.create(dest, content);
} else {
  return "File already exists: " + dest;
}
```
