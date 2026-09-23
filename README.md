# pi-extensions

Pi-native extension packages for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), published under `@bacnh85/`.

Each package lives in its own directory and can be installed independently — easiest via **[pi-hub](./pi-hub)**, the interactive installer (`npx @bacnh85/pi-hub`). This repository intentionally has no root Pi package.

## Packages

| Package | Version | What it adds |
| --- | ---: | --- |
| [`@bacnh85/pi-router`](./pi-router) | 1.1.9 | Connect to any OpenAI-compatible AI router (9router, omniroute, …) — API key via built-in /login, URL in settings.json (`/router-config` panel), cached model discovery. |
| [`@bacnh85/pi-commandcode`](./pi-commandcode) | 0.2.4 | Connect to Command Code's OpenAI-compatible Provider API; API key via built-in `/login`, base URL in settings.json (`/commandcode-config` panel). |
| [`@bacnh85/pi-agy`](./pi-agy) | 0.3.6 | Google Antigravity CLI bridge for delegated implementation, scaffolding, refactors, and test generation. |
| [`@bacnh85/pi-budget`](./pi-budget) | 0.1.3 | Spend cap enforcement — `--budget <usd>` aborts the agent at the cap. |
| [`@bacnh85/pi-checkpoint`](./pi-checkpoint) | 0.1.4 | Git-backed undo/redo — snapshots file state per turn so `/undo` rolls back a message AND its file changes. |
| [`@bacnh85/pi-cron`](./pi-cron) | 0.3.4 | Scheduled jobs — cron-style jobs fire a prompt into the live session while pi is running, with past-due catch-up, per-job model/thinking pins (headless runs), and crontab export for 24/7 coverage. |
| [`@bacnh85/pi-evolve`](./pi-evolve) | 0.3.4 | Trajectory-based self-learning loop — captures tool-call trajectories, reflects to extract learnings, persists to Munin or local JSONL, injects recent learnings into future sessions. |
| [`@bacnh85/pi-selfskills`](./pi-selfskills) | 0.3.3 | Skill self-improvement — one `skill_manage` tool (list/read/patch/create/restore) to patch loaded skills and create new ones, with a writable-root allowlist, SDK validation, and content-addressed backups. |
| [`@bacnh85/pi-a2a`](./pi-a2a) | 0.7.11 | A2A Protocol v1.0 bidirectional — Pi distributes tasks to remote agents (Hermes, ADK, LangChain, any A2A peer), exposes itself as an A2A-callable agent, self-declares for local session discovery (file registry + enriched Agent Card + mDNS), registers with **multiple a2a-switchboard gateways** (`discovery.gateways`), shows inbound task activity in the host TUI, and has an interactive config panel. |
| [`@bacnh85/pi-config-panel`](./pi-config-panel) | 0.1.8 | Shared config-panel kernel (library) — arrow-key toggle/edit overlay panels for extensions; powers `/a2a-config`, `/commandcode-config`, `/router-config`. |
| [`@bacnh85/pi-hub`](./pi-hub) | 0.1.8 | Interactive installer CLI — `npx @bacnh85/pi-hub` browses the @bacnh85 catalog, searches npm `keywords:pi-package`, multi-selects, and installs via `pi install`. |
| [`@bacnh85/pi-attachments`](./pi-attachments) | 0.3.5 | Image and file attachments — drops/pastes become `[[attach:name]]` chips resolving to readable `📎` path references (images attach as real parts; text read on demand). Large text pastes collapse to a paste file + chip. |
| [`@bacnh85/pi-fff`](./pi-fff) | 0.8.2 | FFF-powered fuzzy file and content search for Pi. |
| [`@bacnh85/pi-init`](./pi-init) | 0.1.3 | Guided AGENTS.md generation — `/init` scans the repo and generates/updates AGENTS.md with build/test/lint commands, architecture, and conventions. |
| [`@bacnh85/pi-kicad`](./pi-kicad) | 0.1.7 | KiCad CAD-design extension — drive schematic capture and PCB layout via the Konnect binary over a local HTTP daemon. |
| [`@bacnh85/pi-model-tools`](./pi-model-tools) | 0.9.0 | Unified tool-wrapping, argument repair, reasoning management, DeepSeek V4 guidance + Super Power Mode, defensive leak-cleaning, edit mismatch repair, a Codex-style `apply_patch` diff tool, and bash auto-background with anti-poll guidance (OMP 18.2.8 parity). |
| [`@bacnh85/pi-munin`](./pi-munin) | 0.5.6 | Munin long-term memory as eight native Pi tools for search, retrieval, storage, listing, deletion, capabilities, and cross-project sharing. |
| [`@bacnh85/pi-notebooklm`](./pi-notebooklm) | 0.1.12 | Google NotebookLM — notebooks, sources, chat, research, and Studio artifacts via CLI bridge. |
| [`@bacnh85/pi-notify`](./pi-notify) | 0.1.4 | Desktop notifications and sounds — fires on task completion, errors, and questions; cross-platform (macOS/Linux/Windows + terminal OSC). |
| [`@bacnh85/pi-obsidian`](./pi-obsidian) | 0.8.17 | Obsidian vault integration for Pi. |
| [`@bacnh85/pi-permission`](./pi-permission) | 0.2.4 | Granular permission system — config-driven allow/ask/deny rules per tool with wildcard patterns, external-directory boundary, and a doom-loop guard. |
| [`@bacnh85/pi-plan`](./pi-plan) | 0.14.5 | Plan mode with read-only gating and plan → implement → verify → review workflow; global plan-mode model/thinking (`/plan-model`, `/plan-thinking` — normal mode stays stock Pi); fallback model chain on overload. |
| [`@bacnh85/pi-advisor`](./pi-advisor) | 0.3.4 | OMP-style automatic advisor — second model reviews each settled turn, injects severity-routed notes (nit card / concern steer with immune cooldown + emission guard); ordered multi-model fallback chain (`pi-advisor.models`, per-entry `:level` thinking pins, `/advisor models` panel editor); on-demand advisor consult. |
| [`@bacnh85/pi-ponytail`](./pi-ponytail) | 0.1.14 | Lazy senior dev mode — YAGNI/stdlib-first coding discipline. Fork of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail). |
| [`@bacnh85/pi-references`](./pi-references) | 0.1.4 | External context roots — alias sibling dirs or git repos as `@docs`/`@sdk`; auto-clones repos and injects descriptions into agent context. |
| [`@bacnh85/pi-review`](./pi-review) | 0.2.12 | Isolated read-only code review with corrected same-session fallback. |
| [`@bacnh85/pi-rtk`](./pi-rtk) | 0.2.4 | Bash command token rewriting through RTK. |
| [`@bacnh85/pi-serena`](./pi-serena) | 0.9.16 | Serena semantic code tools (find/replace/rename symbols, LSP diagnostics) through a persistent TypeScript worker with Python bridge. |
| [`@bacnh85/pi-sub`](./pi-sub) | 0.1.47 | Subscription usage footer for OpenAI Codex, OpenCode Go, and Z.ai. |
| [`@bacnh85/pi-subagent`](./pi-subagent) | 0.22.5 | Isolated in-process subagents with parallel/chain modes, inspectable threads, git worktree isolation (`sandbox: worktree`), opt-in auto-review, and herdr pane delegation (`runner: "herdr"` + `herdr` control tool) when pi runs inside herdr. |
| [`@bacnh85/pi-themes`](./pi-themes) | 0.2.0 | Pi TUI theme collection — Ayu variants (dark, mirage, light) + Catppuccin Mocha; pure-themes package (no extension code). |
| [`@bacnh85/pi-ux`](./pi-ux) | 0.6.2 | Anti-slop UI/UX design discipline — anchors a lintable DESIGN.md, derives a design direction (mood, type voice, color mood, signature element) with a positive Direction playbook (typography pairings, color-mood construction, composition anatomy), ships presets + style-direction starters (Editorial/Ledger/Warm consumer), runs deterministic slop-audit gates (APCA contrast + tokens + states + slop/taste tells + reduced-motion; accepts a file `path` so CSS is audited verbatim), vision render-inspect loop with LOOK checklist + interaction verify via pi-web `web_interact`, works with text-only models. |
| [`@bacnh85/pi-web`](./pi-web) | 0.17.4 | Unified web tools — search (SearXNG, Brave, Firecrawl), extraction (JSDOM, Firecrawl, Crawl4AI), site mapping/crawling, screenshots/PDFs with local headless-Chrome capture (inline PNGs for multimodal models; honest sub-500px device emulation + reduced-motion), real-browser interaction (`web_interact`: trusted click/type/evaluate/wait + scrollWidth probe via zero-dep CDP), Gemini web-tier research, image generation (ChatGPT web / Gemini web / Z.ai / custom), and one-off ChatGPT-web/gateway chat. |
| [`@bacnh85/pi-windows-tools`](./pi-windows-tools) | 0.5.7 | Windows-native tool manipulation — shell profiles, path conversion, command execution, WSL bridge, safety policy, audit log, and developer tool discovery. |

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
pi install npm:@bacnh85/pi-agy
```

…repeat per package — every extension row in the table above is installable as `pi install npm:@bacnh85/<package-name>` (all but **pi-hub**, a standalone CLI, and **pi-config-panel**, a library dependency). Project-local instead of user-scope: add `-l` (writes `.pi/settings.json`, shared with your team).

### Verify and manage

```bash
pi list        # installed packages
pi config      # enable/disable extensions, skills, prompts, themes
pi update --extensions   # update packages (or: npx @bacnh85/pi-hub update)
```

## Development

Packages are standalone npm packages. Most TypeScript packages use Mocha + `tsx`; `pi-ponytail` uses Node's built-in test runner; `pi-rtk` runs `npm test` plus a packaging check in CI.

## Release

1. Bump the package version in its `package.json`.
2. Commit and push to `main`.
3. GitHub Actions tests the package matrix and publishes packages whose npm version differs.

## Repository layout

```text
pi-extensions/
  pi-router/
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
npm test                 # or node --test (pi-ponytail) or npm test && npm pack --dry-run (pi-rtk)
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
