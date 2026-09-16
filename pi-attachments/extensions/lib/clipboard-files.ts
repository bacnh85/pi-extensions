/**
 * Read file paths (not bytes) from the OS clipboard.
 *
 * Each platform exposes copied files as file URLs / file lists:
 * - macOS:  «class furl» via osascript (Finder "Copy")
 * - Windows: FileDropList via PowerShell (Explorer "Copy")
 * - Linux:  text/uri-list (xclip / wl-paste), gnome-copied-files fallback
 *
 * Missing tools or an empty (file-less) clipboard yield [] — never throws.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function readClipboardFilePaths(): Promise<string[]> {
  try {
    if (process.platform === "darwin") return await readMac();
    if (process.platform === "win32") return await readWindows();
    return await readLinux();
  } catch {
    return [];
  }
}

async function readMac(): Promise<string[]> {
  // ponytail: single file only; AppleScript repeat-loop if multi-file copies matter
  const { stdout } = await run("osascript", ["-e", 'POSIX path of (the clipboard as «class furl»)'], { timeout: 3000 });
  return [stdout.trim()].filter(Boolean);
}

async function readWindows(): Promise<string[]> {
  const { stdout } = await run(
    "powershell",
    ["-NoProfile", "-STA", "-Command", "(Get-Clipboard -Format FileDropList) -join ';'"],
    { timeout: 5000 },
  );
  return stdout.split(";").map((p) => p.trim()).filter(Boolean);
}

async function readLinux(): Promise<string[]> {
  const isWayland = Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === "wayland";
  const targets: Array<{ cmd: string; args: string[] }> = isWayland
    ? [
        { cmd: "wl-paste", args: ["--type", "text/uri-list"] },
        { cmd: "wl-paste", args: ["--type", "x-special/gnome-copied-files"] },
      ]
    : [
        { cmd: "xclip", args: ["-selection", "clipboard", "-t", "text/uri-list", "-o"] },
        { cmd: "xclip", args: ["-selection", "clipboard", "-t", "x-special/gnome-copied-files", "-o"] },
      ];
  for (const t of targets) {
    try {
      const { stdout } = await run(t.cmd, t.args, { timeout: 2000 });
      const paths = parseUriList(stdout);
      if (paths.length) return paths;
    } catch {
      /* try next target */
    }
  }
  return [];
}

/** Parse `file:///a%20b` lines (uri-list) or `copy\nfile:///...` (gnome-copied-files). */
export function parseUriList(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("file:///") && !trimmed.startsWith("file://localhost/")) continue;
    try {
      out.push(fileURLToPath(trimmed));
    } catch {
      /* skip malformed uri */
    }
  }
  return out;
}
