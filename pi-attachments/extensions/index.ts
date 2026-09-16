/**
 * pi-attachments — real attachments from pasted/dropped file paths.
 *
 * Drag-drop / clipboard-paste flow:
 * 1. onTerminalInput intercepts path-only bracketed pastes BEFORE the editor:
 *    each existing regular file becomes an [[attach:name]] token and a 📎 chip
 *    list shows above the editor (widget); non-file paths (directories, typos)
 *    stay literal text, and an all-non-file payload passes through untouched.
 *    Large plain-text pastes (≥ pasteCollapseLines / pasteCollapseChars) are
 *    saved to <agentDir>/pastes/ and collapse to one [[attach:]] token.
 * 2. On submit, the input hook resolves tokens:
 *    - images → 📎 path text + real ImageContent parts
 *    - text files → 📎 path text (default; model reads on demand via read)
 *      or <file> content blocks (inlineTextFiles opt-in)
 * The user's chat line shows only the tidy 📎 chips.
 */

import type { ExtensionAPI, InputEvent, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { readClipboardFilePaths } from "./lib/clipboard-files";
import { absolutePathSpans, extractImagePaths, isFile } from "./lib/paths";
import { PASTE_NAME_RE, savePaste } from "./lib/pastes";
import { lookup, remember } from "./lib/registry";
import { loadSettings } from "./lib/settings";
import { AttachmentTray } from "./lib/tray";

const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*?)\x1b\[201~$/;

/** Split on whitespace NOT preceded by a backslash, so "/a/with\\ space.png" stays one token. */
function splitPathTokens(payload: string): string[] {
  return payload.trim().split(/(?<!\\)\s+/).filter(Boolean);
}

/** Paste payload is all path-like tokens (optionally escaped spaces)? */
function looksLikePathPayload(payload: string): boolean {
  const tokens = splitPathTokens(payload);
  return tokens.length > 0 && tokens.every((t) => t.replace(/\\ /g, " ").startsWith("/"));
}

export default function piAttachments(pi: ExtensionAPI): void {
  // Re-read on session_start so settings.json edits apply without a full restart.
  let settings = loadSettings();
  const tray = new AttachmentTray();
  let trayUi: { setWidget: (key: string, lines: string[]) => void } | undefined;

  const updateWidget = () => {
    trayUi?.setWidget("pi-attachments", tray.render());
  };

  // Captured at session_start — lets onPaste read the editor for prune-sync.
  let editorText: (() => string) | undefined;

  // 1. Intercept bracketed pastes BEFORE the editor:
  //    - path-only payloads → [[attach:]] tokens + chip widget (existing flow)
  //    - large plain-text payloads → paste file + one [[attach:]] token
  //    onTerminalInput fires for EVERY keystroke, so we also keep the chip
  //    list in sync for free: if the user deletes a [[attach:N]] token from
  //    the prompt, its chip disappears immediately (and the file is not sent).
  const onPaste: TerminalInputHandler = (data) => {
    if (tray.size > 0) {
      const before = tray.size;
      tray.prune(editorText?.() ?? "");
      if (tray.size !== before) updateWidget();
    }
    const m = data.match(BRACKETED_PASTE);
    if (!m) return undefined;
    if (!looksLikePathPayload(m[1])) return collapseTextPaste(m[1]);
    const tokens: string[] = [];
    for (const raw of splitPathTokens(m[1])) {
      const path = raw.replace(/\\ /g, " ");
      if (!isFile(path)) {
        // ponytail: directories/nonexistent paths stay literal text — the model
        // reads or lists them itself; upgrade to 📁 chips if dir drops matter
        tokens.push(raw);
        continue;
      }
      const item = tray.add(path);
      remember(item.name, item.path); // survive session restarts
      tokens.push(item.token);
    }
    if (tokens.every((t) => !t.startsWith("[[attach:"))) return undefined;
    updateWidget();
    return { data: tokens.join(" ") };
  };

  // Large plain-text paste → paste file + token (Hermes-style collapse). Unlike
  // Hermes, which re-inlines the full content at submit, the token resolves to
  // a 📎 path — the paste stays isolated from the chat text and is read on demand.
  const collapseTextPaste = (payload: string): { data: string } | undefined => {
    const text = payload.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
    const lines = text.split("\n").length;
    const linesHit = settings.pasteCollapseLines > 0 && lines >= settings.pasteCollapseLines;
    const charsHit = settings.pasteCollapseChars > 0 && text.length >= settings.pasteCollapseChars;
    if (!linesHit && !charsHit) return undefined;
    if (editorText?.()?.startsWith("/")) return undefined; // slash-command args pass through
    // pi-tui invokes onTerminalInput listeners without try/catch — a disk failure
    // here (EACCES/ENOSPC/ENOTDIR) would crash the agent. Degrade gracefully:
    // the paste passes through to the editor untouched.
    try {
      const pastePath = savePaste(text);
      const item = tray.add(pastePath, `pasted text, ${lines} lines`);
      remember(item.name, pastePath); // survive session restarts
      updateWidget();
      return { data: item.token };
    } catch {
      return undefined;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    settings = loadSettings();
    trayUi = ctx.ui;
    editorText = (ctx.ui as any).getEditorText?.bind(ctx.ui);
    ctx.ui.onTerminalInput?.(onPaste);
    updateWidget();
  });

  // 2. On submit: resolve [[attach:name]] tokens → real content.
  pi.on("input", async (event: InputEvent, ctx) => {
    if (event.source === "extension") return; // don't reprocess our own sends

    // Prune tray items whose tokens the user deleted from the editor.
    tray.prune(ctx?.ui?.getEditorText?.() ?? event.text ?? "");

    const raw = event.text ?? "";
    if (!raw.trim()) {
      updateWidget();
      return;
    }

    const images: Array<{ type: "image"; data: string; mimeType: string }> = [...(event.images ?? [])];
    const attachedImages = new Set<string>(); // paths already attached via tokens
    // All replacements are spans in `raw` coordinates (tokens + typed paths are
    // disjoint by construction), applied right-to-left at the end — so generated
    // blocks are never re-scanned (no nested <file> inlining).
    const replacements: Array<{ start: number; end: number; block: string }> = [];

    // a. Resolve [[attach:name]] tokens (tray first, then persistent registry).
    //    `]` in a basename is allowed when not followed by the closing `]]`
    //    (e.g. a dropped file named "we]ird.png").
    for (const m of raw.matchAll(/\[\[attach:((?:[^\]]|\](?!\]))+)\]\]/g)) {
      const token = m[0];
      const name = m[1];
      const start = m.index;
      const trayItem = tray.resolve(raw).find((i) => i.token === token);
      const path = trayItem?.path ?? lookup(name);
      if (!path) continue; // unknown token — leave as-is for the model

      const mimeType = await detectSupportedImageMimeTypeFromFile(path).catch(() => null);
      if (mimeType) {
        if (!attachedImages.has(path)) {
          // Distinct tokens may resolve to the same path (same file dropped twice) — attach once.
          try {
            const content = await readFile(path);
            images.push({ type: "image", data: content.toString("base64"), mimeType });
            attachedImages.add(path);
          } catch {
            /* unreadable → skip */
          }
        }
        replacements.push({ start, end: start + token.length, block: `📎 ${path}` });
        continue;
      }

      // Non-image: inline as <file> only when inlineTextFiles is on and size allows;
      // otherwise resolve to a 📎 path the model reads on demand.
      let block = `📎 ${path}`;
      if (trayItem?.hint) block += ` (${trayItem.hint})`;
      // Collapsed pastes keep read-on-demand even in inline mode — re-inlining
      // would defeat the whole point of the collapse.
      if (settings.inlineTextFiles && !trayItem?.hint && !PASTE_NAME_RE.test(basename(path))) {
        try {
          const s = await stat(path);
          if (s.size <= settings.maxInlineBytes) {
            const content = (await readFile(path, "utf-8")).replace(/^\uFEFF/, "").replace(/\n$/, "");
            block = `<file name="${path}">\n${content}\n</file>`;
          }
        } catch {
          /* keep 📎 path */
        }
      }
      replacements.push({ start, end: start + token.length, block });
    }

    // b. Existing image paths typed elsewhere in the message → attach too.
    for (const p of extractImagePaths(raw)) {
      if (attachedImages.has(p)) continue;
      try {
        const mimeType = await detectSupportedImageMimeTypeFromFile(p);
        if (!mimeType) continue;
        const content = await readFile(p);
        images.push({ type: "image", data: content.toString("base64"), mimeType });
      } catch {
        /* unreadable file → skip */
      }
    }

    // c. Text-path inlining (opt-in old behavior): absolute text-file paths in
    //    the message → <file> blocks. One greedy regex pass yields disjoint
    //    spans that never overlap the token spans above.
    if (settings.inlineTextFiles) {
      for (const span of absolutePathSpans(raw)) {
        try {
          const s = await stat(span.path);
          if (s.size > settings.maxInlineBytes) continue;
          const content = (await readFile(span.path, "utf-8")).replace(/^\uFEFF/, "").replace(/\n$/, ""); // stripBom + trailing newline
          replacements.push({ start: span.start, end: span.end, block: `<file name="${span.path}">\n${content}\n</file>` });
        } catch {
          /* unreadable file → skip */
        }
      }
    }

    let text = raw;
    if (replacements.length) {
      replacements.sort((a, b) => b.start - a.start);
      for (const r of replacements) {
        text = text.slice(0, r.start) + r.block + text.slice(r.end);
      }
    }

    // Message sent — the chip list is consumed; hide the widget.
    if (tray.size > 0 && tray.expand(raw) !== raw) tray.clear();
    updateWidget();

    if (text === raw && images.length === (event.images?.length ?? 0)) return;
    return { action: "transform", text, images };
  });

  // 3. Clipboard file paste shortcut → queue into the tray as tokens.
  // ponytail: settings string → KeyId cast; a bad key just never matches (pi's keybinding parser ignores unknown ids)
  pi.registerShortcut(settings.pasteFileShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
    description: "Paste file(s) from clipboard as attachments",
    handler: async (ctx) => {
      // only existing regular files are attachable — Finder/Explorer folder copies pass through
      const paths = (await readClipboardFilePaths()).filter(isFile);
      if (paths.length === 0) {
        ctx.ui.notify("No files in clipboard", "info");
        return;
      }
      const tokens = paths.map((p) => {
        const item = tray.add(p);
        remember(item.name, item.path); // survive session restarts
        return item.token;
      });
      ctx.ui.pasteToEditor(tokens.join(" "));
      updateWidget();
    },
  });
}
