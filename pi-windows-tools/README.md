# pi-windows-tools

Pi extension for Windows-native tool manipulation — shell profiles, path conversion, command execution, WSL bridge, safety policy, and developer tool discovery.

## Installation

```bash
npm install @bacnh85/pi-windows-tools
```

## Configuration

```json
{
  "extensions": ["pi-windows-tools"],
  "windowsTools": {
    "enabled": true,
    "defaultShell": "pwsh",
    "allowShellFallback": true,
    "gitBashPath": null,
    "wslDistro": null,
    "preferWslFor": ["openwrt", "yocto", "linux-kernel", "embedded-linux"]
  }
}
```

Environment overrides:

```
PI_WINDOWS_TOOLS_ENABLED=true
PI_WINDOWS_SHELL=pwsh|powershell|cmd|git-bash|wsl
PI_GIT_BASH_PATH=C:\Program Files\Git\bin\bash.exe
PI_WSL_DISTRO=Ubuntu-24.04
```

## Commands

- `pi windows doctor` — detect installed developer tools and system state
- `pi windows shell [shell]` — set default shell (pwsh/powershell/cmd/git-bash/wsl)

## Shell priority

1. pwsh (PowerShell 7+)
2. powershell (Windows PowerShell 5.1)
3. Git Bash
4. cmd
5. WSL (only when explicitly requested or project config prefers it)
