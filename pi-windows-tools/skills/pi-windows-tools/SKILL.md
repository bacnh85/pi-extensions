---
name: pi-windows-tools
description: "Provides Windows-native tool manipulation: shell profiles, path conversion, command execution, WSL bridge, safety policy, and developer tool discovery. Enables Pi to work correctly with PowerShell, cmd, Git Bash, and WSL."
---

# pi-windows-tools

Provides Windows-native tool manipulation: shell profiles, path conversion, command execution, WSL bridge, safety policy, and developer tool discovery. Enables Pi to work correctly with PowerShell, cmd, Git Bash, and WSL.

## When to use

- You are working on Windows and Pi needs to execute shell commands
- You need to convert paths between Windows, Git Bash, and WSL formats
- You need to know what developer tools are installed (doctor)
- You want safety checks on dangerous Windows commands
- You need to run commands inside WSL

## Configuration

```json
{
  "extensions": ["pi-windows-tools"],
  "windowsTools": {
    "enabled": true,
    "defaultShell": "pwsh"
  }
}
```

## Tools

| Tool | What it does |
|------|-------------|
| `windows_shell_detect` | List available shells with versions |
| `windows_shell_exec` | Execute a command through a specific shell |
| `windows_path_to_windows` | Convert `/c/` or `/mnt/c/` to `C:\` |
| `windows_path_to_wsl` | Convert `C:\` to `/mnt/c/` |
| `windows_path_to_gitbash` | Convert `C:\` to `/c/` |
| `windows_path_quote` | Quote a path for a specific shell |
| `windows_doctor` | Detect installed developer tools |
| `windows_safety_classify` | Check command for dangerous operations |
| `windows_tool_discover` | Check if a tool exists in PATH |
| `windows_wsl_list_distros` | Show installed WSL distros |

## Commands

- `pi windows doctor` — full system health report
- `pi windows shell [name]` — show or set default shell

## Prompt guidance

On Windows, Pi automatically injects shell-specific syntax guidance (PowerShell by default) so it doesn't generate Bash-only commands.
