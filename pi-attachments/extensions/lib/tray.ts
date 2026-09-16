/**
 * Pending-attachment tray: holds files queued by drag-drop paste / clipboard
 * paste until submit. The tray renders as a single chip line above the editor;
 * on submit the input hook swaps the [[attach:name]] tokens for real content.
 */

import { basename } from "node:path";

export interface PendingAttachment {
  /** [[attach:name]] token inserted into the editor text (filename-based). */
  token: string;
  path: string;
  /** Display name used inside the token (unique across the tray). */
  name: string;
  /** Optional detail appended to the 📎 chip at submit (e.g. paste line count). */
  hint?: string;
}

export class AttachmentTray {
  private items: PendingAttachment[] = [];

  add(path: string, hint?: string): PendingAttachment {
    const name = this.uniqueName(basename(path));
    const item: PendingAttachment = { token: `[[attach:${name}]]`, path, name };
    if (hint) item.hint = hint;
    this.items.push(item);
    return item;
  }

  /** Resolve tokens still present in submitted text; returns kept items in order. */
  resolve(text: string): PendingAttachment[] {
    return this.items.filter((i) => text.includes(i.token));
  }

  /** Replace every live [[attach:name]] token in text with the real path (for the input hook). */
  expand(text: string): string {
    let out = text;
    for (const i of this.items) {
      if (out.includes(i.token)) out = out.split(i.token).join(i.path);
    }
    return out;
  }

  /** Drop items whose tokens are gone from the editor (user deleted them). */
  prune(editorText: string): void {
    this.items = this.items.filter((i) => editorText.includes(i.token));
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }

  /** Single chip line: 📎 demo.jpeg · C601079.pdf */
  render(): string[] {
    if (this.items.length === 0) return [];
    return [`📎 ${this.items.map((i) => i.name).join(" · ")}`];
  }

  /** First basename is used as-is; duplicates get -2, -3… before the extension. */
  private uniqueName(base: string): string {
    if (!this.items.some((i) => i.name === base)) return base;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    for (let n = 2; ; n++) {
      const candidate = `${stem}-${n}${ext}`;
      if (!this.items.some((i) => i.name === candidate)) return candidate;
    }
  }
}
