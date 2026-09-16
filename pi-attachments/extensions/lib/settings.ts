/**
 * Settings from the `attachments` key of Pi's settings.json
 * (~/.pi/agent/settings.json, or PI_CODING_AGENT_DIR). Non-secret only.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AttachmentsSettings {
  /**
   * When true, text-file attachments are inlined as <file> blocks (Claude Code
   * @file style — content dumped into context, re-read every turn).
   * When false (default), they resolve to a 📎 path the model reads on demand.
   */
  inlineTextFiles: boolean;
  /** Max bytes for text-file inlining (inlineTextFiles mode only). Default 100_000. */
  maxInlineBytes: number;
  /** Keybinding for paste-file-from-clipboard. Default "alt+shift+v". */
  pasteFileShortcut: string;
  /** Pastes with ≥ this many lines collapse to a paste file + token. 0 disables. Default 10. */
  pasteCollapseLines: number;
  /** Pastes with ≥ this many chars collapse even below the line threshold. 0 disables. Default 2000. */
  pasteCollapseChars: number;
}

export const DEFAULTS: AttachmentsSettings = {
  inlineTextFiles: false,
  maxInlineBytes: 100_000,
  pasteFileShortcut: "alt+shift+v",
  pasteCollapseLines: 10,
  pasteCollapseChars: 2000,
};

export function loadSettings(): AttachmentsSettings {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const p = join(dir, "settings.json");
  if (!existsSync(p)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"))?.attachments ?? {};
    return {
      inlineTextFiles: typeof raw.inlineTextFiles === "boolean" ? raw.inlineTextFiles : DEFAULTS.inlineTextFiles,
      maxInlineBytes: typeof raw.maxInlineBytes === "number" && raw.maxInlineBytes > 0 ? raw.maxInlineBytes : DEFAULTS.maxInlineBytes,
      pasteFileShortcut: typeof raw.pasteFileShortcut === "string" && raw.pasteFileShortcut ? raw.pasteFileShortcut : DEFAULTS.pasteFileShortcut,
      pasteCollapseLines: typeof raw.pasteCollapseLines === "number" && raw.pasteCollapseLines >= 0 ? raw.pasteCollapseLines : DEFAULTS.pasteCollapseLines,
      pasteCollapseChars: typeof raw.pasteCollapseChars === "number" && raw.pasteCollapseChars >= 0 ? raw.pasteCollapseChars : DEFAULTS.pasteCollapseChars,
    };
  } catch {
    return { ...DEFAULTS };
  }
}
