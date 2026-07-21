import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type WindowsShellKind = "pwsh" | "powershell" | "cmd" | "git-bash" | "wsl";
const shellKinds = ["pwsh", "powershell", "cmd", "git-bash", "wsl"] as const;
export const isWindowsShellKind = (value: string | undefined): value is WindowsShellKind => !!value && shellKinds.includes(value as WindowsShellKind);

export interface ShellInfo {
  kind: WindowsShellKind;
  displayName: string;
  executable: string;
  available: boolean;
  version?: string;
}

const systemExe = (name: string) => join(process.env.SystemRoot || "C:\\Windows", "System32", name);

function where(cmd: string): string | null {
  try {
    return execFileSync(systemExe("where.exe"), [cmd], { cwd: homedir(), encoding: "utf8", timeout: 3000 })
      .split(/\r?\n/)[0]?.trim() || null;
  } catch { return null; }
}

function getVersion(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 3000 })
      .split(/\r?\n/)[0]?.trim();
  } catch { return undefined; }
}

export function detectShell(kind: WindowsShellKind): ShellInfo {
  switch (kind) {
    case "pwsh": {
      const exe = where("pwsh");
      return { kind, displayName: "PowerShell 7+", executable: exe || "pwsh.exe", available: !!exe, version: exe ? getVersion(exe, ["--version"]) : undefined };
    }
    case "powershell": {
      const exe = where("powershell");
      return { kind, displayName: "Windows PowerShell", executable: exe || "powershell.exe", available: !!exe, version: exe ? getVersion(exe, ["-Command", "$PSVersionTable.PSVersion.ToString()"]) : undefined };
    }
    case "cmd": {
      const comspec = process.env.ComSpec || "cmd.exe";
      const exe = existsSync(comspec) ? comspec : where("cmd");
      return { kind, displayName: "Command Prompt", executable: exe || "cmd.exe", available: !!exe || process.platform === "win32" };
    }
    case "git-bash": {
      const candidates = [process.env.PI_GIT_BASH_PATH || "", "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].filter(Boolean);
      const fromPath = where("bash");
      const exe = candidates.find(c => existsSync(c)) || (fromPath ? fromPath : null);
      const configured = process.env.PI_GIT_BASH_PATH;
      const isGitBash = exe && (exe === configured || /(?:^|[\\/])git(?:[\\/]|$)/i.test(exe));
      return { kind, displayName: "Git Bash", executable: exe || "bash.exe", available: !!exe && !!isGitBash, version: exe ? getVersion(exe, ["--version"]) : undefined };
    }
    case "wsl": {
      const exe = where("wsl");
      return { kind, displayName: "WSL", executable: exe || systemExe("wsl.exe"), available: !!exe, version: exe ? getVersion(exe, ["--status"]) : undefined };
    }
  }
}

export function detectAllShells(): ShellInfo[] {
  return (["pwsh", "powershell", "cmd", "git-bash", "wsl"] as WindowsShellKind[]).map(detectShell);
}

export function getAvailableShells(): ShellInfo[] {
  return detectAllShells().filter(s => s.available);
}

export function getDefaultShell(): ShellInfo {
  const envShell = process.env.PI_WINDOWS_SHELL;
  if (isWindowsShellKind(envShell)) {
    const info = detectShell(envShell);
    if (info.available) return info;
  }
  for (const kind of ["pwsh", "powershell", "git-bash", "cmd", "wsl"] as WindowsShellKind[]) {
    const info = detectShell(kind);
    if (info.available) return info;
  }
  return detectShell("cmd");
}
