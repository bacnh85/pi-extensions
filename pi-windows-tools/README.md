# @bacnh85/pi-windows-tools

Pi extension for Windows-native shell execution, paths, WSL, safety checks, and developer-tool discovery.

## Install

```bash
pi install npm:@bacnh85/pi-windows-tools
```

## Environment overrides

```text
PI_WINDOWS_TOOLS_ENABLED=false
PI_WINDOWS_SHELL=pwsh|powershell|cmd|git-bash|wsl
PI_GIT_BASH_PATH=C:\Program Files\Git\bin\bash.exe
PI_WSL_DISTRO=Ubuntu-24.04
```

## Tools

| Tool | Description |
|---|---|
| `windows_shell_detect` | Detect available Windows shells (ignores `timeout_ms` — detection is synchronous). |
| `windows_shell_exec` | Execute a command through a Windows shell. |
| `windows_audit_log` | Show command history and exit codes (`clear: true` empties the log). |
| `windows_path_to_windows` | Convert POSIX/WSL path to `C:\...`. |
| `windows_path_to_wsl` | Convert Windows path to `/mnt/c/...`. |
| `windows_path_to_gitbash` | Convert Windows path to `/c/...`. |
| `windows_path_quote` | Quote a path for the target shell's quoting rules. |
| `windows_safety_classify` | Check whether a command is dangerous (`safe` / `confirm`). |
| `windows_doctor` | Detect installed developer tools (PATH, WSL, long paths, dev mode). |
| `windows_tool_discover` | Check if a tool is in PATH. |
| `windows_wsl_list_distros` | List installed WSL distros. |

## Commands

- `/windows-doctor` — detect installed developer tools and system state.
- `/windows-shell [shell]` — show or set the default shell.

## Shell priority

1. pwsh (PowerShell 7+)
2. powershell (Windows PowerShell 5.1)
3. Git Bash
4. cmd
5. WSL

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
