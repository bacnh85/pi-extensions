# pi-init

Guided `AGENTS.md` generation for [Pi](https://pi.dev).

`/init` scans your repo (package.json, build configs, CI, directory structure), detects what's there, and generates or updates `AGENTS.md` with concise project-specific guidance: build/test/lint commands, tech stack, repository structure, and conventions. Inspired by OpenCode's `/init`. Zero dependencies, plain JS.

## Install

```bash
pi install npm:@bacnh85/pi-init
```

## Commands

| Command | Description |
|---------|-------------|
| `/init` | Scan the repo and generate/update `AGENTS.md` (preserves existing content) |
| `/init force` | Regenerate `AGENTS.md` from scratch |
| `/init check` | Report detected commands and what's missing, without writing |

## What it does

1. **Repo introspection** — reads `package.json` (scripts, deps, workspaces), detects package managers (npm/pnpm/yarn/bun), build systems (make/cargo/go/python/maven/gradle/cmake/elixir), CI configs (GitHub Actions, GitLab, CircleCI, etc.), and top-level directories.
2. **Prompt construction** — builds a focused instruction covering the sections a context file needs, with real commands extracted from your scripts (never invented).
3. **Delegation** — sends the prompt to the current model via `pi.sendUserMessage()`. The model uses Pi's existing `read`/`write` tools to produce `AGENTS.md`.

The model does the writing; this package only owns the scan and the prompt.

## Why

Pi loads `AGENTS.md` at startup as project context. Starting a new project with a blank context file is friction — `/init` bootstraps it from what's actually in the repo.

## License

MIT
