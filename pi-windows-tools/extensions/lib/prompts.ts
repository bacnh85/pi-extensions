import type { WindowsShellKind } from "./shell-detect";

export interface ShellPrompt {
  kind: WindowsShellKind;
  guidance: string;
  syntaxNote: string;
  forbiddenPatterns: string[];
  preferredCommands: string[];
}

const pwshPrompt: ShellPrompt = {
  kind: "pwsh",
  guidance: "You are running on Windows using PowerShell 7+.",
  syntaxNote: `
Use PowerShell syntax:
- Environment variables: $env:NAME = "value"
- Filesystem: Get-ChildItem, Get-Content, Set-Content, Copy-Item, Move-Item, Remove-Item, New-Item
- Text search: Select-String -Path <file> -Pattern <regex>
- Command separator: ;
- \`&&\`/\`||\` work in pwsh 7+ but NOT Windows PowerShell 5.1; prefer \`;\` for portability across both
- Native exit codes: $LASTEXITCODE
- Quote paths with spaces
- Prefer Node.js internal file tools for editing files
`,
  forbiddenPatterns: [
    "rm -rf (use Remove-Item -Recurse -Force)",
    "cp (use Copy-Item)",
    "mv (use Move-Item)",
    "grep (use Select-String)",
    "export VAR=value (use $env:VAR = 'value')",
    "sed/awk (use PowerShell string operations or -replace)",
  ],
  preferredCommands: ["Get-ChildItem", "Get-Content", "Set-Content", "Copy-Item", "Move-Item", "Remove-Item", "New-Item", "Select-String"],
};

const cmdPrompt: ShellPrompt = {
  kind: "cmd",
  guidance: "You are running on Windows using cmd.exe.",
  syntaxNote: `
Use cmd.exe syntax:
- Environment variables: set NAME=value
- Filesystem: dir, type, copy, move, del, rmdir
- Prefer PowerShell if available for complex operations
- Command separator: &&
- Paths with spaces should be double-quoted
`,
  forbiddenPatterns: [
    "rm (use del or rmdir)",
    "ls (use dir)",
    "export (use set)",
  ],
  preferredCommands: ["dir", "type", "copy", "move", "del", "rmdir", "mkdir"],
};

const gitBashPrompt: ShellPrompt = {
  kind: "git-bash",
  guidance: "You are running on Windows using Git Bash.",
  syntaxNote: `
Use POSIX-style commands (bash syntax):
- Environment: export NAME=value
- Commands: ls, cp, mv, rm, grep, sed, awk
- Windows paths need conversion: C:\\Users\\... → /c/Users/...
- Be careful when passing paths to Windows-native tools
`,
  forbiddenPatterns: [],
  preferredCommands: ["ls", "cp", "mv", "rm", "grep", "find", "cat", "echo"],
};

const wslPrompt: ShellPrompt = {
  kind: "wsl",
  guidance: "You are running through WSL2 (Windows Subsystem for Linux).",
  syntaxNote: `
Use Linux shell syntax (bash):
- Environment: export NAME=value
- Commands: ls, cp, mv, rm, grep, sed, awk
- Workspace paths should use /mnt/c/... convention
- Do NOT call Windows-only tools unless explicitly routed through powershell.exe or cmd.exe
- Use WSL for Linux-native projects: OpenWrt, Yocto, kernel builds
`,
  forbiddenPatterns: [
    "C:\\ paths (convert to /mnt/c/...)",
  ],
  preferredCommands: ["ls", "cp", "mv", "rm", "grep", "find", "cat", "echo", "make", "gcc"],
};

export function getPromptForShell(kind: WindowsShellKind): ShellPrompt {
  switch (kind) {
    case "pwsh": return pwshPrompt;
    case "powershell": return pwshPrompt; // same guidance
    case "cmd": return cmdPrompt;
    case "git-bash": return gitBashPrompt;
    case "wsl": return wslPrompt;
  }
}

export function buildShellGuidance(kind: WindowsShellKind): string {
  const prompt = getPromptForShell(kind);
  const lines = [
    prompt.guidance,
    prompt.syntaxNote.trim(),
  ];

  if (prompt.forbiddenPatterns.length > 0) {
    lines.push("", "Avoid these commands (they don't work in this shell):");
    for (const p of prompt.forbiddenPatterns) {
      lines.push(`  • ${p}`);
    }
  }

  lines.push("", "Preferred commands:");
  for (const cmd of prompt.preferredCommands) {
    lines.push(`  • ${cmd}`);
  }

  lines.push("", commonWarnings(kind));

  return lines.join("\n");
}

/** Shell-specific gotchas that apply regardless of the command (path quoting,
 * null-device redirection, pipe-after-cd). Kept short — mirrors the proactive
 * guidance Claude Code's windows-shell plugin teaches. */
function commonWarnings(kind: WindowsShellKind): string {
  switch (kind) {
    case "pwsh":
    case "powershell":
      return "Common pitfalls:\n" +
        "  • Redirect to `nul` not `/dev/null` (e.g. `cmd >nul 2>&1`)\n" +
        "  • Quote any `C:\\...` path containing spaces\n" +
        "  • Avoid `| Select-String`/`findstr` immediately after `cd` (context loss)";
    case "cmd":
      return "Common pitfalls:\n" +
        "  • Redirect to `nul` not `/dev/null`\n" +
        "  • Quote paths with spaces using double quotes";
    case "git-bash":
    case "wsl":
      return "Common pitfalls:\n" +
        "  • `/dev/null` is correct here, but Windows-native tools invoked from bash need `nul`\n" +
        "  • Convert `C:\\...` paths to `/c/...` (git-bash) or `/mnt/c/...` (wsl) before cd";
  }
}
