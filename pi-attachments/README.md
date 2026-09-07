# @bacnh85/pi-attachments

Image and file attachments for [Pi](https://github.com/earendil-works/pi) — make
pasted and drag-dropped files reach the model as real content, not dead path text.

## The problem

Pi's Ctrl+V image paste writes the clipboard image to a temp file and inserts
the **path as text** into the editor. Terminals' file drag-drop (iTerm2,
Terminal.app, WezTerm, kitty, …) pastes the dropped file's path as text too.
Nothing converts that path into an attachment — the model receives only the
path string and must spend a turn calling `read` (and often doesn't). Pasting
files copied in Finder/Explorer does nothing at all.

## Install

```bash
pi install @bacnh85/pi-attachments
```

## What it does

1. **Attachment chips (drag-drop / clipboard paste).** Dropping file(s) into
   the terminal — or pressing `alt+shift+v` with files copied in Finder /
   Explorer / a Linux file manager — inserts filename tokens into your prompt
   and shows a chip list above the editor instead of dumping raw paths:
   ```
   📎 demo.jpeg · C601079.pdf
   [[attach:demo.jpeg]] what's wrong in this screenshot?
   ```
   On submit the tokens resolve to real, readable references. Remove one by
   deleting its `[[attach:...]]` token from the prompt — the chip disappears
   immediately and the file is not sent.
2. **Readable path references (default).** A dropped/pasted file resolves to
   a `📎 /abs/path` chip — never a content dump. The transcript stays tidy
   and the model reads the file on demand with its `read` tool (pi's read
   handles absolute paths and images natively). Zero per-turn token cost.
   - text files → `📎 /path/to/file.ts`
   - images → `📎 /path/to/img.png` **plus** a real `ImageContent` attachment
     (requires a vision-capable model; pi shows "(image omitted: model does
     not support images)" otherwise)
3. **Text-file inlining (opt-in).** With `inlineTextFiles: true`, absolute
   text-file paths are inlined as `<file name="...">…</file>` content blocks
   (pi's `@file` CLI convention) instead of 📎 path chips. Claude Code `@file`
   style — convenient, but the content is re-read on every turn, so it is
   off by default.
4. **Paste files from the clipboard.** `alt+shift+v` reads file references
   copied in Finder / Explorer / a Linux file manager and queues them as
   chips; the input hook does the rest.
5. **Large text-paste collapse.** Pasting a wall of text (logs, stack traces,
   minified JSON — ≥ 10 lines or ≥ 2000 chars) no longer wrecks the prompt:
   the payload is saved to `~/.pi/agent/pastes/paste_<n>_<time>.txt` and your
   prompt gets one tidy `[[attach:paste_….txt]]` token + chip instead. On
   submit the model sees `📎 /path (pasted text, N lines)` and reads the file
   on demand — your chat text stays isolated from the pasted bulk. Below the
   thresholds pastes pass through untouched; set either threshold to `0` to
   disable (pi's built-in `[paste #N]` marker may still apply to pass-through
   pastes >1000 chars / >10 lines). Only the newest 50 paste files are kept.

## Configuration

`~/.pi/agent/settings.json`:

```json
{
  "attachments": {
    "inlineTextFiles": false,
    "maxInlineBytes": 100000,
    "pasteFileShortcut": "alt+shift+v",
    "pasteCollapseLines": 10,
    "pasteCollapseChars": 2000
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `inlineTextFiles` | `false` | Inline text files as `<file>` blocks instead of 📎 path chips |
| `maxInlineBytes` | `100000` | Max file size for text inlining (`inlineTextFiles` mode) |
| `pasteFileShortcut` | `"alt+shift+v"` | Keybinding for paste-file-from-clipboard |
| `pasteCollapseLines` | `10` | Pastes with ≥ this many lines collapse to a paste file + token (`0` disables) |
| `pasteCollapseChars` | `2000` | Pastes with ≥ this many chars collapse even below the line threshold (`0` disables) |

## Notes

- **Removing an attachment**: delete its `[[attach:filename]]` token from the
  prompt — the chip disappears immediately and the file is not sent. Clickable
  (x) chips aren't possible: the editor owns keyboard focus and extension
  widgets don't receive mouse events, so token-editing is the removal path.
  Same-basename files get unique names (`demo.jpeg`, `demo-2.jpeg`).
- **Tokens survive restarts**: each drop is remembered in
  `~/.pi/agent/pi-attachments.json` (name → absolute path, newest 200 kept),
  so referencing `[[attach:foo.ts]]` in a later session still resolves to the
  dropped file — no dead tokens.
- **Pasted text persists on disk**: collapsed paste files live under
  `~/.pi/agent/pastes/` (newest 50 kept). Don't paste secrets you don't want
  on disk — or delete the file after submit. Collapsed pastes are not scanned
  for image/file paths (only your typed message is), so a path inside a
  collapsed paste won't attach — paste file paths separately.
- Conservative matching: prose like "see main.rs" or "the .jpg extension" never
  triggers anything — images require an existing file with an image extension,
  text inlining requires an absolute existing path. Pasted/dropped paths that
  are not existing regular files (directories, typos) pass through as plain
  text — no chip, no token.
- pi core auto-resizes attached images (see the `images.autoResize` setting).
- kitty's OSC 72 drag-drop protocol is not supported (requires raw stdin access
  that extensions don't have); kitty <0.47 drops paths, which work.

## Development

```bash
cd pi-attachments
npm install
npm test          # mocha + tsx
npm run typecheck
```
