# Changelog

## 0.2.2

- **Directories are not attachments.** Pasting/dropping a path that is not an
  existing regular file (a directory, a typo) no longer becomes an
  `[[attach:...]]` token + 📎 chip — it stays plain text in the prompt. The
  model still sees the path and can `ls`/`read` it. The clipboard shortcut
  (alt+shift+v) likewise skips folder copies; a folder-only clipboard reports
  "No files in clipboard".
- Fixed: a dropped/pasted file whose name contains `]` (e.g. `we]ird.png`) now
  attaches on submit instead of silently leaking a dead `[[attach:...]]` token;
  inline mode no longer nests `<file>` blocks when a dropped token and typed
  paths are combined.

## 0.2.1 (2026-09-05)

- Widen Pi SDK peer range to `>=0.85.0 <0.86.0` and bump devDep to `^0.85.0` for Pi 0.85.0 compatibility (no breaking changes; peer cap widening only).

## 0.2.0

- **Readable path references by default (read on demand).** `[[attach:name]]`
  tokens now resolve to `📎 /abs/path` chips — text files are no longer dumped
  into the message as `<file>` content blocks. The model reads the referenced
  file on demand via its `read` tool (works for absolute paths + images
  natively), keeping the transcript tidy and eliminating per-turn token
  re-reads of large content.
- Images keep attaching a real `ImageContent` part alongside the 📎 chip.
- `inlineTextFiles` now defaults to `false`; set `true` to restore the old
  `<file>`-block inlining (Claude Code `@file` style).

## 0.1.0

Initial release.

- **Attachment chips for drag-drop / clipboard paste**: dropping file(s) into the
  terminal (or `alt+shift+v` for Finder/Explorer-copied files) no longer dumps
  raw paths into your prompt. Path-only pastes are intercepted before the
  editor and shown as a tidy 📎 chip list above the input; on submit the chips
  become real attachments.
- **Image path → real attachment**: the `input` hook finds existing image file paths
  (png/jpg/jpeg/webp/gif) in submitted text — including the `/tmp/pi-clipboard-*.png`
  paths Pi's Ctrl+V paste writes and the paths terminals paste on file drag-drop —
  and converts them into real `ImageContent` parts, so the model sees the image
  instead of just a path string.
- **Text-file inlining**: existing absolute text-file paths under
  `attachments.maxInlineBytes` (default 100KB) are replaced with
  `<file name="...">…</file>` blocks (same convention as pi's `@file` CLI args).
- **Paste files from clipboard**: `alt+shift+v` (configurable via
  `attachments.pasteFileShortcut`) reads file references from the OS clipboard
  (macOS Finder, Windows Explorer, Linux X11/Wayland file managers) and pastes
  their paths into the editor.
- Settings under the `attachments` key in `~/.pi/agent/settings.json`:
  `inlineTextFiles` (bool, default true), `maxInlineBytes` (default 100000),
  `pasteFileShortcut` (default `"alt+shift+v"`).
