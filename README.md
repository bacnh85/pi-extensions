# pi-extensions

Pi-native extension packages for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), published under `@bacnh85/`.

Each package lives in its own directory and can be installed independently. This repository intentionally has no root Pi package.

## Packages

| Package | Version | What it adds |
| --- | ---: | --- |
| [`@bacnh85/pi-notebooklm`](./pi-notebooklm) | 0.1.0 | Google NotebookLM notebooks, sources, chat, research, and Studio artifacts via CLI bridge. |
| [`@bacnh85/pi-ponytail`](./pi-ponytail) | 0.1.2 | Lazy senior-dev mode: YAGNI, stdlib-first coding discipline, and ponytail skills. |
| [`@bacnh85/pi-serena`](./pi-serena) | 0.8.1 | Serena semantic code navigation, references, refactors, and diagnostics through a persistent worker. |
| [`@bacnh85/pi-web`](./pi-web) | 0.4.5 | Web search, page extraction, site mapping/crawling, screenshots, and PDFs. |
| [`@bacnh85/pi-munin`](./pi-munin) | 0.4.1 | Munin long-term memory tools and skill integration. |
| [`@bacnh85/pi-plan`](./pi-plan) | 0.5.0 | Read-only planning plus fresh implement → verify → independent review workflow. |
| [`@bacnh85/pi-subagent`](./pi-subagent) | 0.5.0 | Isolated in-process subagents, parallel/chain delegation, and inspectable threads. |
| [`@bacnh85/pi-review`](./pi-review) | 0.2.0 | Isolated read-only review with same-session fallback. |
| [`@bacnh85/pi-fff`](./pi-fff) | 0.6.0 | FFF-powered fuzzy file and content search for Pi. |
| [`@bacnh85/pi-rtk`](./pi-rtk) | 0.1.8 | Bash command rewriting through RTK for token savings. |
| [`@bacnh85/pi-sub`](./pi-sub) | 0.1.10 | Subscription usage footer for OpenAI Codex, OpenCode Go, and Z.ai. |

## Install

Install the published package you want:

```bash
pi install npm:@bacnh85/pi-notebooklm
pi install npm:@bacnh85/pi-web
pi install npm:@bacnh85/pi-serena
pi install npm:@bacnh85/pi-munin
pi install npm:@bacnh85/pi-plan
pi install npm:@bacnh85/pi-subagent
pi install npm:@bacnh85/pi-review
pi install npm:@bacnh85/pi-ponytail
pi install npm:@bacnh85/pi-fff
pi install npm:@bacnh85/pi-rtk
pi install npm:@bacnh85/pi-sub
```

Or install from a checkout:

```bash
pi install ./pi-web
pi install ./pi-serena
# etc.
```

For local development without installing:

```bash
pi -e ./pi-web
```

## Development

Packages are standalone npm packages. Most TypeScript packages use Mocha + `tsx`; `pi-ponytail` uses Node's built-in test runner; `pi-rtk` and `pi-sub` use packaging checks in CI.

```bash
# Package tests
npm test --prefix pi-web
npm test --prefix pi-serena
npm test --prefix pi-munin
npm test --prefix pi-notebooklm
npm test --prefix pi-plan
npm test --prefix pi-subagent
npm test --prefix pi-review
npm test --prefix pi-ponytail
npm test --prefix pi-fff
npm test --prefix pi-obsidian

# Packaging checks
npm pack --dry-run ./pi-rtk
npm pack --dry-run ./pi-sub
```

## Release

1. Bump the package version in its `package.json`.
2. Commit and push to `main`.
3. GitHub Actions tests the package matrix and publishes packages whose npm version differs.

## Repository layout

```text
pi-extensions/
  pi-ponytail/
  pi-serena/
  pi-web/
  pi-munin/
  pi-plan/
  pi-subagent/
  pi-review/
  pi-fff/
  pi-notebooklm/
  pi-obsidian/
  pi-rtk/
  pi-sub/
  pi-windows-tools/
  .github/workflows/
```
