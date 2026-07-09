import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export type WindowsShellKind = "pwsh" | "powershell" | "cmd" | "git-bash" | "wsl";

export interface ShellInfo {
	kind: WindowsShellKind;
	displayName: string;
	executable: string;
	available: boolean;
	version?: string;
}

function where(cmd: string): string | null {
	try {
		return execFileSync("where", [cmd], { encoding: "utf8", timeout: 3000 })
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
			const candidates = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe", process.env.PI_GIT_BASH_PATH || ""].filter(Boolean);
			const fromPath = where("bash");
			const exe = candidates.find(c => existsSync(c)) || (fromPath ? fromPath : null);
			const isGitBash = exe && (exe.toLowerCase().includes("git") || exe.toLowerCase().includes("program files") || exe.toLowerCase().includes("scoop") || exe.toLowerCase().includes("chocolatey") || getVersion(exe, ["--version"])?.toLowerCase().includes("gnu bash") === true);
			return { kind, displayName: "Git Bash", executable: exe || "bash.exe", available: !!exe && !!isGitBash, version: exe ? getVersion(exe, ["--version"]) : undefined };
		}
		case "wsl": {
			const exe = where("wsl");
			return { kind, displayName: "WSL", executable: "wsl.exe", available: !!exe, version: exe ? getVersion("wsl.exe", ["--status"]) : undefined };
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
	const envShell = process.env.PI_WINDOWS_SHELL as WindowsShellKind | undefined;
	if (envShell && detectShell(envShell).available) return detectShell(envShell);
	for (const kind of ["pwsh", "powershell", "git-bash", "cmd", "wsl"] as WindowsShellKind[]) {
		const info = detectShell(kind);
		if (info.available) return info;
	}
	return detectShell("cmd");
}
