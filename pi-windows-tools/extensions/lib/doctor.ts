import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import { join } from "node:path";
import { getDefaultShell } from "./shell-detect";

const execFileP = promisify(execFile);
// ponytail: single cap for every doctor probe; per-probe knobs if a tool hangs.
const PROBE_TIMEOUT_MS = 3000;

const systemExe = (name: string) => join(process.env.SystemRoot || "C:\\Windows", "System32", name);

export interface ToolInfo { name: string; found: boolean; path?: string; version?: string; }
export interface DoctorReport {
  os: string; osVersion: string; architecture: string; defaultShell: string;
  tools: ToolInfo[]; wslDistros: string[]; longPathsEnabled: boolean | null; developerMode: boolean | null;
}

async function firstLine(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP(cmd, args, { cwd: os.homedir(), encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    return stdout.split(/\r?\n/)[0]?.trim() || null;
  } catch { return null; }
}

async function checkTool(name: string, cmd: string, va: string[] = ["--version"]): Promise<ToolInfo> {
  const p = await firstLine(systemExe("where.exe"), [cmd]);
  const v = p ? await firstLine(p, va) : null;
  return { name, found: !!p, path: p || undefined, version: v || undefined };
}

export function parseWslDistros(output: Buffer | string): string[] {
  const buffer = typeof output === "string" ? Buffer.from(output) : output;
  const text = buffer[0] === 0xff && buffer[1] === 0xfe || buffer.subarray(1, 16).some(byte => byte === 0) ? buffer.toString("utf16le") : buffer.toString("utf8");
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.toLowerCase().includes("noinstall") && !s.startsWith("Windows"));
}
// wsl.exe emits UTF-16LE — execFile with encoding "utf8" mangles it, so read
// the raw Buffer (no encoding) and let parseWslDistros detect the BOM.
async function wslDistros(): Promise<string[]> {
  try {
    const { stdout } = await execFileP(systemExe("wsl.exe"), ["-l", "-q"], { cwd: os.homedir(), timeout: 5000, maxBuffer: 1024 * 1024 });
    return parseWslDistros(stdout);
  } catch { return []; }
}
async function regDword(key: string, val: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileP(systemExe("reg.exe"), ["query", key, "/v", val], { cwd: os.homedir(), encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    const m = stdout.match(new RegExp(`${val}\\s+REG_DWORD\\s+(0x[0-9a-f]+)`, "i"));
    return m ? parseInt(m[1], 16) === 1 : null;
  } catch { return null; }
}

const TOOL_PROBES: [string, string][] = [
  ["pwsh", "pwsh"], ["powershell", "powershell"], ["cmd", "cmd"],
  ["git", "git"], ["bash (Git Bash)", "bash"], ["wsl", "wsl"],
  ["node", "node"], ["npm", "npm"], ["pnpm", "pnpm"],
  ["yarn", "yarn"], ["python", "python"], ["py launcher", "py"],
  ["dotnet", "dotnet"], ["cmake", "cmake"], ["ninja", "ninja"],
  ["winget", "winget"], ["choco", "choco"], ["scoop", "scoop"],
  ["ssh", "ssh"], ["msbuild", "msbuild"], ["cl", "cl"],
  ["devenv", "devenv"], ["reg", "reg"], ["sc", "sc"], ["netsh", "netsh"],
  ["wt (Windows Terminal)", "wt"],
];

export async function runDoctor(): Promise<DoctorReport> {
  const osInfo = { os: os.type(), osVersion: os.release(), architecture: os.arch() };
  // ponytail: Promise.all — 26 where.exe/version probes in parallel beat a
  // sequential ~30s worst case; reg.exe handles are cheap.
  const tools = await Promise.all(TOOL_PROBES.map(([name, cmd]) => checkTool(name, cmd)));
  const wslTool = tools.find(t => t.name === "wsl");
  const [distros, longPathsEnabled, developerMode] = await Promise.all([
    wslTool?.found ? wslDistros() : Promise.resolve([] as string[]),
    regDword("HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "LongPathsEnabled"),
    regDword("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock", "AllowDevelopmentWithoutDevLicense"),
  ]);
  return { ...osInfo, defaultShell: getDefaultShell().kind, tools, wslDistros: distros, longPathsEnabled, developerMode };
}

export function formatDoctorReport(r: DoctorReport): string {
  const lines = [`Windows Tools Doctor`, `━━━━━━━━━━━━━━━━━━━`, `OS: ${r.os} ${r.osVersion}`, `Architecture: ${r.architecture}`, `Default shell: ${r.defaultShell}`, "", "── Tools ──"];
  for (const t of r.tools) lines.push(`  ${t.found ? "✓" : "✗"} ${t.name}${t.version ? ` ${t.version}` : ""}`);
  if (r.wslDistros.length) { lines.push("", "── WSL Distros ──"); for (const d of r.wslDistros) lines.push(`  • ${d}`); }
  lines.push("", "── System Features ──", `  Long paths: ${f3(r.longPathsEnabled)}`, `  Developer Mode: ${f3(r.developerMode)}`);
  return lines.join("\n");
}
function f3(v: boolean | null): string { return v === true ? "enabled" : v === false ? "disabled" : "unknown"; }
