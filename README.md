# pi-extensions

Pi-native extension packages for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), published under `@bacnh85/`.

Each package lives in its own directory and can be installed independently. This repository intentionally has no root Pi package.

## Packages

| Package | Version | What it adds |
| --- | ---: | --- |
| [`@bacnh85/pi-9router`](./pi-9router) | 0.1.7 | Connect to 9router AI routing proxy instance via OpenAI-compatible API. |
| [`@bacnh85/pi-budget`](./pi-budget) | 0.1.1 | Spend cap enforcement — aborts the agent at a `--budget <usd>` limit. |
| [`@bacnh85/pi-agy`](./pi-agy) | 0.3.1 | Google Antigravity CLI bridge for bulk implementation, scaffolding, and test generation. |
| [`@bacnh85/pi-fff`](./pi-fff) | 0.7.9 | FFF-powered fuzzy file and content search for Pi. |
| [`@bacnh85/pi-kicad`](./pi-kicad) | 0.1.3 | KiCad CAD-design extension driving schematic capture and PCB layout via Konnect daemon. |
| [`@bacnh85/pi-model-tools`](./pi-model-tools) | 0.5.5 | Unified tool-wrapping, argument repair, DeepSeek V4 guidance, Super Power Mode, and `apply_patch` diff tool. |
| [`@bacnh85/pi-munin`](./pi-munin) | 0.5.1 | Munin long-term memory tools and skill integration. |
| [`@bacnh85/pi-notebooklm`](./pi-notebooklm) | 0.1.8 | Google NotebookLM notebooks, sources, chat, research, and Studio artifacts via CLI bridge. |
| [`@bacnh85/pi-obsidian`](./pi-obsidian) | 0.8.13 | Obsidian vault integration for Pi. |
| [`@bacnh85/pi-plan`](./pi-plan) | 0.10.3 | Read-only planning plus fresh implement → verify → independent review workflow; fallback model chain on overload. |
| [`@bacnh85/pi-ponytail`](./pi-ponytail) | 0.1.10 | Lazy senior-dev mode: YAGNI, stdlib-first coding discipline, and ponytail skills. |
| [`@bacnh85/pi-review`](./pi-review) | 0.2.8 | Isolated read-only review with same-session fallback. |
| [`@bacnh85/pi-rtk`](./pi-rtk) | 0.1.12 | Bash command rewriting through RTK for token savings. |
| [`@bacnh85/pi-serena`](./pi-serena) | 0.9.6 | Serena semantic code navigation, references, refactors, and diagnostics through a persistent worker. |
| [`@bacnh85/pi-sub`](./pi-sub) | 0.1.25 | Subscription usage footer for OpenAI Codex, OpenCode Go, and Z.ai. |
| [`@bacnh85/pi-subagent`](./pi-subagent) | 0.14.1 | Isolated in-process subagents, parallel/chain delegation, inspectable threads, and git worktree isolation (`sandbox: worktree`). |
| [`@bacnh85/pi-ux`](./pi-ux) | 0.4.4 | Anti-slop UI/UX design discipline — anchors a lintable DESIGN.md, ships medium-tuned presets (Web/Mobile) so the agent stays unblocked when DESIGN.md is missing, runs deterministic slop-audit gates (APCA contrast/tokens/states/slop tells), works with text-only models. |
| [`@bacnh85/pi-web`](./pi-web) | 0.5.7 | Web search, page extraction, site mapping/crawling, screenshots, and PDFs. |
| [`@bacnh85/pi-windows-tools`](./pi-windows-tools) | 0.5.2 | Windows-specific developer tools, shell configuration, and WSL integration. |

## Install

Install the published package you want:

```bash
pi install npm:@bacnh85/pi-9router
pi install npm:@bacnh85/pi-agy
pi install npm:@bacnh85/pi-budget
pi install npm:@bacnh85/pi-fff
pi install npm:@bacnh85/pi-kicad
pi install npm:@bacnh85/pi-model-tools
pi install npm:@bacnh85/pi-munin
pi install npm:@bacnh85/pi-notebooklm
pi install npm:@bacnh85/pi-obsidian
pi install npm:@bacnh85/pi-plan
pi install npm:@bacnh85/pi-ponytail
pi install npm:@bacnh85/pi-review
pi install npm:@bacnh85/pi-rtk
pi install npm:@bacnh85/pi-serena
pi install npm:@bacnh85/pi-sub
pi install npm:@bacnh85/pi-subagent
pi install npm:@bacnh85/pi-ux
pi install npm:@bacnh85/pi-web
pi install npm:@bacnh85/pi-windows-tools
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
  pi-9router/
  pi-agy/
  pi-budget/
  pi-fff/
  pi-kicad/
  pi-model-tools/
  pi-munin/
  pi-notebooklm/
  pi-obsidian/
  pi-plan/
  pi-ponytail/
  pi-review/
  pi-rtk/
  pi-serena/
  pi-sub/
  pi-subagent/
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
