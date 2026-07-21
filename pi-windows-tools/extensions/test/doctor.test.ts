import { describe, it } from "mocha";
import { expect } from "chai";
import { formatDoctorReport, parseWslDistros } from "../lib/doctor";
import type { DoctorReport } from "../lib/doctor";

describe("doctor", () => {

  const sampleReport: DoctorReport = {
    os: "Windows_NT",
    osVersion: "10.0.22631",
    architecture: "x64",
    defaultShell: "pwsh",
    tools: [
      { name: "pwsh", found: true, path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", version: "7.4.0" },
      { name: "powershell", found: true, path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", version: "5.1.22621" },
      { name: "cmd", found: true, path: "C:\\Windows\\System32\\cmd.exe" },
      { name: "git", found: true, path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.42.0.windows.2" },
      { name: "bash (Git Bash)", found: true, path: "C:\\Program Files\\Git\\bin\\bash.exe", version: "5.2.15" },
      { name: "wsl", found: true, path: "C:\\Windows\\System32\\wsl.exe" },
      { name: "node", found: true, path: "C:\\Program Files\\nodejs\\node.exe", version: "v22.0.0" },
      { name: "npm", found: true, path: "C:\\Program Files\\nodejs\\npm.cmd", version: "10.5.0" },
      { name: "pnpm", found: false },
      { name: "yarn", found: false },
      { name: "python", found: true, path: "C:\\Python312\\python.exe", version: "3.12.0" },
      { name: "py launcher", found: true, path: "C:\\Windows\\py.exe", version: "3.12" },
      { name: "dotnet", found: true, path: "C:\\Program Files\\dotnet\\dotnet.exe", version: "8.0.100" },
      { name: "cmake", found: false },
      { name: "ninja", found: false },
      { name: "winget", found: true, path: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe" },
      { name: "choco", found: false },
      { name: "scoop", found: false },
      { name: "ssh", found: true, path: "C:\\Windows\\System32\\OpenSSH\\ssh.exe" },
      { name: "msbuild", found: false },
      { name: "cl", found: false },
      { name: "devenv", found: false },
      { name: "reg", found: true, path: "C:\\Windows\\System32\\reg.exe" },
      { name: "sc", found: true, path: "C:\\Windows\\System32\\sc.exe" },
      { name: "netsh", found: true, path: "C:\\Windows\\System32\\netsh.exe" },
    ],
    wslDistros: ["Ubuntu-24.04", "Debian"],
    longPathsEnabled: true,
    developerMode: true,
  };

  it("formatDoctorReport produces expected header", () => {
    const output = formatDoctorReport(sampleReport);
    expect(output).to.include("Windows Tools Doctor");
    expect(output).to.include("OS: Windows_NT 10.0.22631");
    expect(output).to.include("Architecture: x64");
  });

  it("includes tool status with ✓ and ✗", () => {
    const output = formatDoctorReport(sampleReport);
    expect(output).to.include("✓ pwsh");
    expect(output).to.include("✗ pnpm");
  });

  it("includes WSL distros", () => {
    const output = formatDoctorReport(sampleReport);
    expect(output).to.include("Ubuntu-24.04");
    expect(output).to.include("Debian");
  });

  it("includes long paths and dev mode", () => {
    const output = formatDoctorReport(sampleReport);
    expect(output).to.include("Long paths: enabled");
    expect(output).to.include("Developer Mode: enabled");
  });

  it("handles empty tools list", () => {
    const empty: DoctorReport = {
      os: "Windows_NT",
      osVersion: "",
      architecture: "x64",
      defaultShell: "cmd",
      tools: [],
      wslDistros: [],
      longPathsEnabled: null,
      developerMode: null,
    };
    const output = formatDoctorReport(empty);
    expect(output).to.include("Long paths: unknown");
  });

  it("includes version when present", () => {
    const output = formatDoctorReport(sampleReport);
    expect(output).to.include("7.4.0");
  });

  it("parses UTF-16LE WSL output", () => {
    expect(parseWslDistros(Buffer.from("Ubuntu\r\nDebian\r\n", "utf16le"))).to.deep.equal(["Ubuntu", "Debian"]);
  });
});
