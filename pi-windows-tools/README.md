# pi-windows-tools

Pi extension for Windows-native shell execution, paths, WSL, safety checks, and developer-tool discovery.

## Installation

```powershell
pi install npm:@bacnh85/pi-windows-tools
```

## Environment overrides

```text
PI_WINDOWS_TOOLS_ENABLED=false
PI_WINDOWS_SHELL=pwsh|powershell|cmd|git-bash|wsl
PI_GIT_BASH_PATH=C:\Program Files\Git\bin\bash.exe
PI_WSL_DISTRO=Ubuntu-24.04
```

## Commands

- `/windows-doctor` — detect installed developer tools and system state.
- `/windows-shell [shell]` — show or set the default shell.

## Shell priority

1. pwsh (PowerShell 7+)
2. powershell (Windows PowerShell 5.1)
3. Git Bash
4. cmd
5. WSL
