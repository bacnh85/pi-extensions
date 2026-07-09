# pi-windows-tools

## Overview

`pi-windows-tools` is a Pi extension that gives the Pi Coding Agent excellent Windows-native tool manipulation capability — shell profiles, path conversion, command execution, WSL bridge, safety policy, and developer tool discovery.

## Installation

```bash
npm install @bacnh85/pi-windows-tools
```

Then add to your Pi configuration:

```json
{
  "extensions": ["pi-windows-tools"]
}
```

## Quick Start

After installation, Pi automatically detects your Windows shell environment and injects PowerShell syntax guidance. Run the doctor to see what's available:

```
pi windows doctor
```

## Configuration

```json
{
  "windowsTools": {
    "enabled": true,
    "defaultShell": "pwsh",
    "allowShellFallback": true,
    "gitBashPath": null,
    "wslDistro": null,
    "preferWslFor": [
      "openwrt",
      "yocto",
      "linux-kernel",
      "embedded-linux"
    ]
  }
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_WINDOWS_TOOLS_ENABLED` | Set to `false` to disable (`true` by default) |
| `PI_WINDOWS_SHELL` | Override default shell: `pwsh`, `powershell`, `cmd`, `git-bash`, `wsl` |
| `PI_GIT_BASH_PATH` | Explicit path to Git Bash executable |
| `PI_WSL_DISTRO` | Default WSL distro name |

## Shell Selection

### Priority Order

1. **pwsh** (PowerShell 7+) — preferred, best developer experience
2. **powershell** (Windows PowerShell 5.1) — built-in, widely available
3. **git-bash** (Git for Windows Bash) — POSIX commands on Windows
4. **cmd** (Command Prompt) — legacy, minimal capability
5. **wsl** (WSL2) — only when explicitly selected or project config prefers it

### Changing Shell

```
pi windows shell pwsh
pi windows shell git-bash
pi windows shell wsl
```

## Commands

### `pi windows doctor`

Detects installed developer tools and system configuration:

```
Windows Tools Doctor
━━━━━━━━━━━━━━━━━━━
OS: Windows_NT 10.0.22631
Architecture: x64
Default shell: pwsh

── Tools ──
  ✓ pwsh 7.4.0
  ✓ powershell 5.1.22621
  ✓ cmd
  ✓ git 2.42.0.windows.2
  ✓ bash (Git Bash) 5.2.15
  ✓ wsl
  ✓ node v22.0.0
  ✓ npm 10.5.0
  ✗ pnpm
  ...

── WSL Distros ──
  • Ubuntu-24.04
  • Debian

── System Features ──
  Long paths: enabled
  Developer Mode: enabled
```

### `pi windows shell [shell]`

Show or set the default Windows shell.

## Tools

The extension registers these tools:

| Tool | Description |
|------|-------------|
| `windows_shell_detect` | Detect available shells with versions |
| `windows_shell_exec` | Execute command through a shell |
| `windows_path_to_windows` | Convert POSIX/WSL path to Windows format |
| `windows_path_to_wsl` | Convert Windows path to WSL `/mnt/c/...` |
| `windows_path_to_gitbash` | Convert Windows path to Git Bash `/c/...` |
| `windows_path_quote` | Quote a path for a specific shell |
| `windows_safety_classify` | Check command for dangerous patterns |
| `windows_doctor` | Full doctor report |
| `windows_wsl_exec` | Execute command inside WSL |
| `windows_tool_discover` | Check if a tool is in PATH |
| `windows_wsl_list_distros` | List installed WSL distros |

## Safety Policy

Commands matching dangerous patterns (rm -rf, diskpart, format, git push --force, npm publish, etc.) are classified as requiring confirmation. Sensitive file paths (.env, .pem, .ssh, .aws, etc.) trigger the same behavior.

## Path Conversion Examples

| Windows | Git Bash | WSL |
|---------|----------|-----|
| `C:\Users\bacnh\project` | `/c/Users/bacnh/project` | `/mnt/c/Users/bacnh/project` |
| `D:\work\repo` | `/d/work/repo` | `/mnt/d/work/repo` |
| `C:\Program Files\Git` | `/c/Program Files/Git` | `/mnt/c/Program Files/Git` |

## Recommended Setup

1. Install [PowerShell 7](https://github.com/PowerShell/PowerShell) (recommended)
2. Install [Git for Windows](https://git-scm.com/download/win) (includes Git Bash)
3. Install [Windows Terminal](https://learn.microsoft.com/en-us/windows/terminal/install) (optional, better UX)
4. Optional: Install [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) with Ubuntu

## Project-Specific Config

For Linux-native projects (OpenWrt, Yocto, kernel builds):

```json
{
  "windowsTools": {
    "defaultShell": "wsl",
    "wslDistro": "Ubuntu-24.04",
    "preferWslFor": ["openwrt", "yocto", "linux-kernel"]
  }
}
```

## Common Syntax Mistakes

When using PowerShell (default), these commands **don't work**:

```
❌ NODE_ENV=test npm test     → ✅ $env:NODE_ENV = "test"; npm test
❌ rm -rf dist                → ✅ Remove-Item -Recurse -Force .\dist
❌ cp README.md dist/         → ✅ Copy-Item .\README.md .\dist\
❌ grep -R "abc" src/         → ✅ Select-String -Path .\src\* -Pattern "abc"
❌ export FOO=bar             → ✅ $env:FOO = "bar"
```

When using Git Bash, POSIX commands work but paths need conversion:

```
# Git Bash: use /c/... instead of C:\...
cd /c/Users/bacnh/project
ls -la
```

When using WSL, always use `/mnt/c/...` for Windows paths:

```
# WSL: Windows C: drive is at /mnt/c/
cd /mnt/c/Users/bacnh/project
make
```
