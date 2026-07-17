import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { join } from "node:path";
import { getDefaultShell } from "./shell-detect";

const systemExe = (name: string) => join(process.env.SystemRoot || "C:\\Windows", "System32", name);

export interface ToolInfo { name: string; found: boolean; path?: string; version?: string; }
export interface DoctorReport {
	os: string; osVersion: string; architecture: string; defaultShell: string;
	tools: ToolInfo[]; wslDistros: string[]; longPathsEnabled: boolean | null; developerMode: boolean | null;
}

function which(cmd: string): string | null {
	try { return execFileSync(systemExe("where.exe"), [cmd], { cwd: os.homedir(), encoding: "utf8", timeout: 3000 }).split(/\r?\n/)[0]?.trim() || null; } catch { return null; }
}
function checkTool(name: string, cmd: string, va: string[] = ["--version"]): ToolInfo {
	const p = which(cmd); let v: string | undefined;
	if (p) try { v = execFileSync(p, va, { encoding: "utf8", timeout: 3000 }).split(/\r?\n/)[0]?.trim(); } catch {}
	return { name, found: !!p, path: p || undefined, version: v };
}

export function parseWslDistros(output: Buffer | string): string[] {
	const buffer = typeof output === "string" ? Buffer.from(output) : output;
	const text = buffer[0] === 0xff && buffer[1] === 0xfe || buffer.subarray(1, 16).some(byte => byte === 0) ? buffer.toString("utf16le") : buffer.toString("utf8");
	return text.replace(/^\uFEFF/, "").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.toLowerCase().includes("noinstall") && !s.startsWith("Windows"));
}
function wslDistros(): string[] {
	try { return parseWslDistros(execFileSync(systemExe("wsl.exe"), ["-l", "-q"], { cwd: os.homedir(), timeout: 5000 })); } catch { return []; }
}
function regDword(key: string, val: string): boolean | null {
	try {
		const out = execFileSync(systemExe("reg.exe"), ["query", key, "/v", val], { cwd: os.homedir(), encoding: "utf8", timeout: 3000 });
		const m = out.match(new RegExp(`${val}\\s+REG_DWORD\\s+(0x[0-9a-f]+)`, "i"));
		return m ? parseInt(m[1], 16) === 1 : null;
	} catch { return null; }
}

export function runDoctor(): DoctorReport {
	const osInfo = { os: os.type(), osVersion: os.release(), architecture: os.arch() };
	const tools = [
		checkTool("pwsh", "pwsh"), checkTool("powershell", "powershell"), checkTool("cmd", "cmd"),
		checkTool("git", "git"), checkTool("bash (Git Bash)", "bash"), checkTool("wsl", "wsl"),
		checkTool("node", "node"), checkTool("npm", "npm"), checkTool("pnpm", "pnpm"),
		checkTool("yarn", "yarn"), checkTool("python", "python"), checkTool("py launcher", "py"),
		checkTool("dotnet", "dotnet"), checkTool("cmake", "cmake"), checkTool("ninja", "ninja"),
		checkTool("winget", "winget"), checkTool("choco", "choco"), checkTool("scoop", "scoop"),
		checkTool("ssh", "ssh"), checkTool("msbuild", "msbuild"), checkTool("cl", "cl"),
		checkTool("devenv", "devenv"), checkTool("reg", "reg"), checkTool("sc", "sc"), checkTool("netsh", "netsh"),
	];
	const wslTool = tools.find(t => t.name === "wsl");
	return { ...osInfo, defaultShell: getDefaultShell().kind, tools, wslDistros: wslTool?.found ? wslDistros() : [], longPathsEnabled: regDword("HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "LongPathsEnabled"), developerMode: regDword("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock", "AllowDevelopmentWithoutDevLicense") };
}

export function formatDoctorReport(r: DoctorReport): string {
	const lines = [`Windows Tools Doctor`, `━━━━━━━━━━━━━━━━━━━`, `OS: ${r.os} ${r.osVersion}`, `Architecture: ${r.architecture}`, `Default shell: ${r.defaultShell}`, "", "── Tools ──"];
	for (const t of r.tools) lines.push(`  ${t.found ? "✓" : "✗"} ${t.name}${t.version ? ` ${t.version}` : ""}`);
	if (r.wslDistros.length) { lines.push("", "── WSL Distros ──"); for (const d of r.wslDistros) lines.push(`  • ${d}`); }
	lines.push("", "── System Features ──", `  Long paths: ${f3(r.longPathsEnabled)}`, `  Developer Mode: ${f3(r.developerMode)}`);
	return lines.join("\n");
}
function f3(v: boolean | null): string { return v === true ? "enabled" : v === false ? "disabled" : "unknown"; }
