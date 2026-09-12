# pi-hub

Interactive installer for [Pi coding agent](https://github.com/earendil-works/pi) packages — browse, search, and install pi extensions without typing `pi install ...`.

Inspired by [vercel-labs/skills](https://github.com/skills): one command, interactive multi-select, sensible defaults.

Current version: **0.1.4**

## Quick start

```bash
npx @bacnh85/pi-hub
```

That's it — you get the full catalog of `@bacnh85` extensions with descriptions, navigate with arrow keys, press `space` to select, `a` to select all, then `enter` to install. Each selection runs `pi install npm:<package>` for you.

Requirements: Node ≥ 20 and the [`pi` CLI](https://github.com/earendil-works/pi) on PATH (`pi --version` must work).

## Commands

### `pi-hub` (no arguments) — interactive browser

```bash
npx @bacnh85/pi-hub
```

- Lists all 30 curated `@bacnh85` packages with full-width descriptions
- `↑`/`↓` move · `space` toggle · `a` toggle all · `enter` confirm · `q` quit
- The detail line under the list shows the full npm name + description of the highlighted package
- Confirming the picker installs immediately — `pi install` runs per package (passes through pi's own output)
- `-y` installs quietly (suppresses the "Will install" list), `-l` installs project-local instead of user-scope

### `add` — install without browsing

```bash
npx @bacnh85/pi-hub add pi-plan              # curated shorthand → npm:@bacnh85/pi-plan
npx @bacnh85/pi-hub add pi-plan pi-munin     # multiple packages
npx @bacnh85/pi-hub add @bacnh85/pi-review   # scoped npm name
npx @bacnh85/pi-hub add user/repo            # any git repo → git:github.com/user/repo
npx @bacnh85/pi-hub add npm:@foo/pi-tools    # passthrough, exactly as pi install expects
npx @bacnh85/pi-hub add pi-plan -l           # -l = project-local (.pi/settings.json)
```

Unknown first arguments are treated as `add` too: `npx @bacnh85/pi-hub pi-plan` works.

| Input | Resolves to |
|---|---|
| `pi-plan` | `npm:@bacnh85/pi-plan` (curated catalog lookup) |
| `@scope/pkg` | `npm:@scope/pkg` |
| `owner/repo` | `git:github.com/owner/repo` |
| `npm:…`, `git:…`, `https://…`, `ssh://…` | passthrough to `pi install` |

### `find` — search

```bash
npx @bacnh85/pi-hub find memory              # curated matches first, then npm at large
npx @bacnh85/pi-hub find plan --json         # machine-readable output
```

Searches the curated catalog (name + description), then the npm registry for Pi's official `keywords:pi-package` convention. Offline or rate-limited? It gracefully falls back to the catalog only.

### `list` — what's installed

```bash
npx @bacnh85/pi-hub list
```

Reads `~/.pi/agent/settings.json` and shows installed package sources.

### `remove` — uninstall

```bash
npx @bacnh85/pi-hub remove pi-plan           # resolve shorthand → pi remove npm:@bacnh85/pi-plan
npx @bacnh85/pi-hub remove                   # no args: removes all user-scope npm: packages
```

### `update` — update installed packages

```bash
npx @bacnh85/pi-hub update                   # runs pi update --extensions
```

## Flags

| Flag | Description |
|---|---|
| `-l, --local` | project-local install (`.pi/settings.json`) instead of user scope |
| `-y, --yes` | skip confirmation |
| `--json` | machine-readable output (`find`) |
| `-h, --help` | help |

## Curated catalog (30 packages)

| Package | Description |
|---|---|
| `pi-a2a` | A2A Protocol v1.0 bidirectional — distribute tasks to remote agents, be called by them |
| `pi-advisor` | Automatic advisor: a second model reviews each settled turn and injects severity-routed notes |
| `pi-agy` | Google Antigravity CLI bridge — delegate bulk scaffolding, refactors, test generation |
| `pi-budget` | Spend cap enforcement — halts the agent when session cost exceeds `--budget` USD |
| `pi-chatgpt-web` | ChatGPT web-tier provider via self-hosted OpenAI-compatible bridge |
| `pi-checkpoint` | Git-backed undo/redo — `/undo` rolls back a message AND its file changes |
| `pi-commandcode` | Connect to Command Code's OpenAI-compatible Provider API |
| `pi-evolve` | Trajectory-based self-learning loop — captures tool calls, extracts and injects learnings |
| `pi-fff` | FFF-powered fuzzy file and content search |
| `pi-init` | Guided AGENTS.md generation — `/init` scans the repo and generates/updates AGENTS.md |
| `pi-kicad` | KiCad CAD-design extension — drive schematic capture and PCB layout |
| `pi-model-tools` | Unified tool-wrapping, argument repair, DeepSeek V4 guidance, apply_patch diff tool |
| `pi-munin` | Munin long-term memory as native Pi tools |
| `pi-notebooklm` | Google NotebookLM — notebooks, sources, chat, research, Studio artifacts |
| `pi-notify` | Desktop notifications and sounds on task completion, errors, questions |
| `pi-obsidian` | Obsidian vault integration — read, search, create notes via the Obsidian CLI |
| `pi-permission` | Granular permission system — config-driven allow/ask/deny rules per tool |
| `pi-plan` | Plan mode with read-only gating and plan → implement → verify → review workflow |
| `pi-ponytail` | Lazy senior dev mode — YAGNI/stdlib-first coding discipline |
| `pi-references` | External context roots — alias sibling dirs or git repos as `@docs`/`@sdk` |
| `pi-review` | Isolated read-only code review with corrected same-session fallback |
| `pi-router` | Connect to any OpenAI-compatible AI router via its /v1 API |
| `pi-rtk` | Bash command token rewriting through RTK |
| `pi-serena` | Serena semantic code tools (find/replace/rename symbols, LSP diagnostics) |
| `pi-sub` | Subscription usage footer for OpenAI Codex, OpenCode Go, Z.ai |
| `pi-subagent` | Isolated in-process subagents with parallel/chain modes and git worktree isolation |
| `pi-themes` | Ayu variants (dark, mirage, light) + Catppuccin Mocha |
| `pi-ux` | Anti-slop UI/UX design discipline — DESIGN.md anchoring + deterministic slop-audit gates |
| `pi-web` | Web search, page extraction, Firecrawl scraping/crawling, Crawl4AI headless browser crawling |
| `pi-windows-tools` | Windows-specific tools for Pi |

Install any of them by directory name: `npx @bacnh85/pi-hub add pi-munin`.

## How it works

pi-hub is a thin discovery + selection layer **on top of the `pi` CLI** — `pi install` / `pi remove` do the actual package management, pi-hub never reimplements it. Sources:

- **Curated catalog** — the `@bacnh85` monorepo packages, bundled as `catalog.json`.
- **General discovery** — npm registry search for `keywords:pi-package`, Pi's official package convention. Falls back to catalog-only when offline.

`@bacnh85/pi-hub` itself is not a pi package (nothing registers into the agent); it's a standalone zero-dependency CLI.

## Workflow examples

```bash
# Set up a new machine with the full @bacnh85 stack
npx @bacnh85/pi-hub          # press 'a', then 'enter'

# Just the essentials for coding
npx @bacnh85/pi-hub add pi-plan pi-serena pi-subagent pi-review pi-munin

# Explore what the community published
npx @bacnh85/pi-hub find obsidian
npx @bacnh85/pi-hub find memory --json | jq '.[].name'

# Project-local install (shared with your team via .pi/settings.json)
npx @bacnh85/pi-hub add pi-permission -l
```

## Troubleshooting

- **`pi` not found on PATH** — install Pi first: `npm install -g @earendil-works/pi-coding-agent` (see [pi's README](https://github.com/earendil-works/pi)). pi-hub checks `pi --version` before anything else.
- **Picker doesn't respond to keys** — stdin must be a TTY. If you're piping input, use `add` instead of the interactive browser.
- **npm search returns nothing** — you're offline or rate-limited; curated catalog still works.
- **Install succeeded but extension not loaded** — run `pi config` to enable it, and `pi list` to verify the install.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md). Versions: 0.1.0 initial, 0.1.1 redraw fix, 0.1.2 catalog self-reference fix, 0.1.3 hang fix + full-width descriptions, 0.1.4 Windows fixes + catalog cleanup.

## License

MIT
