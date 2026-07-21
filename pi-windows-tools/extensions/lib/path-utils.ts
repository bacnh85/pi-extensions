import type { WindowsShellKind } from "./shell-detect";

/**
 * Convert a Windows path (C:\foo\bar) to a Unix-style path (/c/foo/bar).
 * Handles forward-slash Windows paths, UNC paths, and long-path prefixes.
 */
export function toPosixPath(windowsPath: string): string {
  let p = windowsPath.replace(/\\/g, "/");

  // Strip \\?\ long-path prefix
  p = p.replace(/^\/\/\?\/+/, "");

  // Handle \\?\UNC\server\share → //server/share
  if (p.startsWith("UNC/")) {
    p = "//" + p.slice(4);
  }

  // Handle device paths (\\.\COM1 → \\.\COM1, keep as-is)
  if (p.match(/^\/{2}\.\//)) return p;

  // Handle UNC paths (\\server\share → //server/share)
  if (p.startsWith("//") && !p.startsWith("//?/")) {
    return p.replace(/^\/\/([^/])/, "//$1");
  }

  // Handle absolute C:/foo → /c/foo; preserve drive-relative C:foo.
  if (/^[A-Za-z]:\//.test(p)) {
    return p.replace(/^([A-Za-z]):\/?/, (_, d) => `/${d.toLowerCase()}/`);
  }

  return p;
}

/**
 * Convert a POSIX path (/c/foo/bar) to a Windows path (C:\foo\bar).
 */
export function toWindowsPath(posixPath: string): string {
  if (/^[A-Za-z]:[\\/]/.test(posixPath)) return posixPath.replace(/\//g, "\\");
  const wsl = posixPath.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (wsl) return `${wsl[1].toUpperCase()}:\\${wsl[2]?.replace(/\//g, "\\") || ""}`;
  const gb = posixPath.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
  if (gb) return `${gb[1].toUpperCase()}:\\${gb[2]?.replace(/\//g, "\\") || ""}`;
  return posixPath;
}

/**
 * Convert a Windows path to WSL format (/mnt/c/Users/...).
 * Ignores input already in WSL or POSIX format.
 */
export function toWslPath(windowsPath: string): string {
  if (/^\/mnt\/[a-zA-Z](?:\/|$)/.test(windowsPath)) return windowsPath;
  const posix = toPosixPath(windowsPath);
  return /^\/[a-z](?:\/|$)/i.test(posix) ? `/mnt${posix}` : posix;
}

/**
 * Normalize a Windows path: backslashes, uppercase drive, resolve . and ..,
 * collapse repeated separators.
 */
export function normalizeWindowsPath(path: string): string {
  if (!path) return path;
  const isUnc = path.startsWith("\\\\") || path.startsWith("//");
  let n = path.replace(/\//g, "\\").replace(/^([a-z]):\\/, (_, d) => `${d.toUpperCase()}:\\`);
  if (isUnc) n = "\\\\" + n.slice(2).replace(/\\\\+/g, "\\");
  else n = n.replace(/\\\\+/g, "\\");
  const parts = n.split("\\");
  const r: string[] = [];
  const minLen = isUnc ? 2 : 1;
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") { if (r.length > minLen) r.pop(); continue; }
    r.push(p);
  }
  const joined = r.join("\\");
  if (isUnc) return "\\\\" + joined;
  return joined || (n.endsWith("\\") ? "\\" : "");
}

/**
 * Check if a path looks like a Windows absolute path
 * (C:\..., \\server\..., \\?\..., \\.\...).
 */
export function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]|^[\\/]{2}(?:[\\/]?[?.]|[^\\/]+[\\/])/.test(path);
}

/**
 * Quote a path for a specific Windows shell.
 */
export function quoteForShell(path: string, shell: WindowsShellKind): string {
  switch (shell) {
    case "pwsh":
    case "powershell": return `'${path.replace(/'/g, "''")}'`;
    case "cmd":
      if (path.includes("%")) throw new Error("cmd paths containing % cannot be safely quoted");
      return `"${path.replace(/"/g, '""')}"`;
    case "git-bash":
    case "wsl": return `'${path.replace(/'/g, "'\\''")}'`;
  }
}
