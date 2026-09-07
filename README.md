# pi-extensions

Pi-native extension packages for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), published under `@bacnh85/`.

Each package lives in its own directory and can be installed independently — easiest via **[pi-hub](./pi-hub)**, the interactive installer (`npx @bacnh85/pi-hub`). This repository intentionally has no root Pi package.

## Packages

| Package | Version | What it adds |
| --- | ---: | --- |
| [`@bacnh85/pi-router`](./pi-router) | 1.1.3 | Connect to any OpenAI-compatible AI router (9router, omniroute, …) — API key via built-in /login, URL in settings.json (`/router-config` panel), cached model discovery. |
| [`@bacnh85/pi-chatgpt-web`](./pi-chatgpt-web) | 0.2.0 | ChatGPT web-tier providers via self-hosted OpenAI-compatible bridges — chat-only `chatgpt-web` (chatgpt2api) + agentic `codex-web` (codex-proxy, tool-capable). No Plus subscription. |
| [`@bacnh85/pi-commandcode`](./pi-commandcode) | 0.2.0 | Connect to Command Code's OpenAI-compatible Provider API; API key via built-in `/login`, base URL in settings.json (`/commandcode-config` panel). |
| [`@bacnh85/pi-agy`](./pi-agy) | 0.3.2 | Google Antigravity CLI bridge for delegated implementation, scaffolding, refactors, and test generation. |
| [`@bacnh85/pi-budget`](./pi-budget) | 0.1.2 | Spend cap enforcement — `--budget <usd>` aborts the agent at the cap. |
| [`@bacnh85/pi-checkpoint`](./pi-checkpoint) | 0.1.0 | Git-backed undo/redo — snapshots file state per turn so `/undo` rolls back a message AND its file changes. |
| [`@bacnh85/pi-evolve`](./pi-evolve) | 0.3.2 | Trajectory-based self-learning loop — captures tool-call trajectories, reflects to extract learnings, persists to Munin or local JSONL, injects recent learnings into future sessions. |
| [`@bacnh85/pi-a2a`](./pi-a2a) | 0.7.6 | A2A Protocol v1.0 bidirectional — Pi distributes tasks to remote agents (Hermes, ADK, LangChain, any A2A peer), exposes itself as an A2A-callable agent, self-declares for local session discovery (file registry + enriched Agent Card + mDNS), registers with **multiple a2a-switchboard gateways** (`discovery.gateways`), shows inbound task activity in the host TUI, and has an interactive config panel. |
| [`@bacnh85/pi-config-panel`](./pi-config-panel) | 0.1.4 | Shared config-panel kernel (library) — arrow-key toggle/edit overlay panels for extensions; powers `/a2a-config`, `/commandcode-config`, `/router-config`. |
| [`@bacnh85/pi-hub`](./pi-hub) | 0.1.3 | Interactive installer CLI — `npx @bacnh85/pi-hub` browses the @bacnh85 catalog, searches npm `keywords:pi-package`, multi-selects, and installs via `pi install`. |
| [`@bacnh85/pi-attachments`](./pi-attachments) | 0.3.0 | Image and file attachments — drops/pastes become `[[attach:name]]` chips resolving to readable `📎` path references (images attach as real parts; text read on demand). Large text pastes collapse to a paste file + chip. |
| [`@bacnh85/pi-fff`](./pi-fff) | 0.8.0 | FFF-powered fuzzy file and content search for Pi. |
| [`@bacnh85/pi-init`](./pi-init) | 0.1.0 | Guided AGENTS.md generation — `/init` scans the repo and generates/updates AGENTS.md with build/test/lint commands, architecture, and conventions. |
| [`@bacnh85/pi-kicad`](./pi-kicad) | 0.1.3 | KiCad CAD-design extension — drive schematic capture and PCB layout via the Konnect binary over a local HTTP daemon. |
| [`@bacnh85/pi-model-tools`](./pi-model-tools) | 0.7.0 | Unified tool-wrapping, argument repair, reasoning management, DeepSeek V4 guidance + Super Power Mode, defensive leak-cleaning, edit mismatch repair, and a Codex-style `apply_patch` diff tool. |
| [`@bacnh85/pi-munin`](./pi-munin) | 0.5.3 | Munin long-term memory as eight native Pi tools for search, retrieval, storage, listing, deletion, capabilities, and cross-project sharing. |
| [`@bacnh85/pi-notebooklm`](./pi-notebooklm) | 0.1.8 | Google NotebookLM — notebooks, sources, chat, research, and Studio artifacts via CLI bridge. |
| [`@bacnh85/pi-notify`](./pi-notify) | 0.1.1 | Desktop notifications and sounds — fires on task completion, errors, and questions; cross-platform (macOS/Linux/Windows + terminal OSC). |
| [`@bacnh85/pi-obsidian`](./pi-obsidian) | 0.8.14 | Obsidian vault integration for Pi. |
| [`@bacnh85/pi-permission`](./pi-permission) | 0.2.0 | Granular permission system — config-driven allow/ask/deny rules per tool with wildcard patterns, external-directory boundary, and a doom-loop guard. |
| [`@bacnh85/pi-plan`](./pi-plan) | 0.11.4 | Plan mode with read-only gating and plan → implement → verify → review workflow; fallback model chain on overload. |
| [`@bacnh85/pi-advisor`](./pi-advisor) | 0.2.1 | OMP-style automatic advisor — second model reviews each settled turn, injects severity-routed notes (nit card / concern steer with immune cooldown + emission guard); ordered multi-model fallback chain (`pi-advisor.models`, `/advisor models` panel editor); on-demand advisor consult. |
| [`@bacnh85/pi-ponytail`](./pi-ponytail) | 0.1.11 | Lazy senior dev mode — YAGNI/stdlib-first coding discipline. Fork of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail). |
| [`@bacnh85/pi-references`](./pi-references) | 0.1.1 | External context roots — alias sibling dirs or git repos as `@docs`/`@sdk`; auto-clones repos and injects descriptions into agent context. |
| [`@bacnh85/pi-review`](./pi-review) | 0.2.9 | Isolated read-only code review with corrected same-session fallback. |
| [`@bacnh85/pi-rtk`](./pi-rtk) | 0.1.12 | Bash command token rewriting through RTK. |
| [`@bacnh85/pi-serena`](./pi-serena) | 0.9.13 | Serena semantic code tools (find/replace/rename symbols, LSP diagnostics) through a persistent TypeScript worker with Python bridge. |
| [`@bacnh85/pi-sub`](./pi-sub) | 0.1.35 | Subscription usage footer for OpenAI Codex, OpenCode Go, and Z.ai. |
| [`@bacnh85/pi-subagent`](./pi-subagent) | 0.20.0 | Isolated in-process subagents with parallel/chain modes, inspectable threads, git worktree isolation (`sandbox: worktree`), and opt-in auto-review after coding turns. |
| [`@bacnh85/pi-themes`](./pi-themes) | 0.1.1 | Ayu-based theme collection (dark, mirage, light) for the Pi TUI — pure-themes package (no extension code). |
| [`@bacnh85/pi-ux`](./pi-ux) | 0.4.6 | Anti-slop UI/UX design discipline — anchors a lintable DESIGN.md, ships medium-tuned presets (Web/Mobile), runs deterministic slop-audit gates (APCA contrast + tokens + states + slop/taste tells + reduced-motion), taste rules (named cliché clusters, typography/motion/copy), vision render-inspect loop for multimodal models, works with text-only models. |
| [`@bacnh85/pi-web`](./pi-web) | 0.6.2 | Unified web search (SearXNG, Brave, Firecrawl), content extraction (JSDOM, Firecrawl, Crawl4AI), site mapping/crawling, page screenshots (returned inline for multimodal models)/PDFs. |
| [`@bacnh85/pi-windows-tools`](./pi-windows-tools) | 0.5.3 | Windows-specific tools for Pi. |

## Install

### Easiest: pi-hub (interactive installer)

Browse the whole catalog, multi-select, and install in one command — no typing package names:

```bash
npx @bacnh85/pi-hub
```

Or install specific packages by shorthand (the full command reference lives in [pi-hub's README](./pi-hub/README.md)):

```bash
npx @bacnh85/pi-hub add pi-plan pi-serena pi-subagent   # curated shorthand
npx @bacnh85/pi-hub find memory                          # search catalog + npm community packages
npx @bacnh85/pi-hub list                                 # what's installed
npx @bacnh85/pi-hub remove pi-plan                       # uninstall
npx @bacnh85/pi-hub update                               # update all installed packages
```

### Manual: one `pi install` per package

If you prefer plain `pi` (or are scripting without Node ≥ 20):

```bash
pi install npm:@bacnh85/pi-router
pi install npm:@bacnh85/pi-chatgpt-web
pi install npm:@bacnh85/pi-agy
```

…repeat per package — every row in the table above is installable as `pi install npm:@bacnh85/<package-name>`. Project-local instead of user-scope: add `-l` (writes `.pi/settings.json`, shared with your team).

### Verify and manage

```bash
pi list        # installed packages
pi config      # enable/disable extensions, skills, prompts, themes
pi update --extensions   # update packages (or: npx @bacnh85/pi-hub update)
```

## Development

Packages are standalone npm packages. Most TypeScript packages use Mocha + `tsx`; `pi-ponytail` uses Node's built-in test runner; `pi-rtk` and `pi-sub` use packaging checks in CI.

## Release

1. Bump the package version in its `package.json`.
2. Commit and push to `main`.
3. GitHub Actions tests the package matrix and publishes packages whose npm version differs.

## Repository layout

```text
pi-extensions/
  pi-router/
  pi-chatgpt-web/
  pi-commandcode/
  pi-agy/
  pi-attachments/
  pi-budget/
  pi-checkpoint/
  pi-fff/
  pi-init/
  pi-kicad/
  pi-model-tools/
  pi-munin/
  pi-notebooklm/
  pi-notify/
  pi-obsidian/
  pi-permission/
  pi-plan/
  pi-advisor/
  pi-ponytail/
  pi-references/
  pi-review/
  pi-rtk/
  pi-serena/
  pi-sub/
  pi-subagent/
  pi-themes/
  pi-ux/
  pi-web/
  pi-windows-tools/
  .github/workflows/
```

## Contributing

### Prerequisites

- Node.js 22+ and npm.
- Pi 0.83.0+ installed globally.

### Development

Each package is standalone. To work on one:

```bash
cd pi-<name>
npm install
npm test                 # or node --test (pi-ponytail) or npm pack --dry-run (pi-rtk, pi-sub)
npm run typecheck        # TypeScript packages only
```

### Adding a new package

See [`AGENTS.md`](./AGENTS.md) for the canonical scaffold — every package follows the same layout with `extensions/index.ts`, `extensions/package.json`, co-located tests, and a `CHANGELOG.md`.

### Code style

This repo follows **ponytail** discipline: YAGNI, stdlib-first, shortest working diff. No speculative abstractions.

### Release

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit and push to `main`.
3. CI tests the changed package(s) and auto-publishes to npm if version differs.

### AI coding agents

[`AGENTS.md`](./AGENTS.md) is the authoritative context file — agents should read it before working on this repository.
