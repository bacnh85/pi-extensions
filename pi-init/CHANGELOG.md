# Changelog

## 0.1.1 (2026-09-12)

### Fixed

- **Handler no longer assumes `ctx`/`ctx.ui` always exist.** `ctx?.cwd ||
  process.cwd()` and optional-chained `ctx?.ui?.notify` — siblings guard, the
  command handler crashed when the context was missing.
- **Prompts used `npm run …` even for pnpm/yarn/bun projects.** The generated
  AGENTS.md now emits the detected package manager's run form
  (`pnpm run test`, `yarn run build`, …); npm stays `npm run …`.
- `/init check` reports WHICH context file was found (`AGENTS.md exists` vs
  `CLAUDE.md exists`) instead of always claiming AGENTS.md.
- Dropped the unused `resolve` import.

## 0.1.0

- Initial release.
- `/init` command: scans repo (package.json, build systems, CI, dirs) and generates or updates `AGENTS.md`.
- `/init force` regenerates from scratch; `/init check` reports without writing.
- Detects npm/pnpm/yarn/bun, make/cargo/go/python/maven/gradle/cmake/elixir, GitHub Actions/GitLab/CircleCI/Azure/Travis.
- Zero dependencies, plain JS.
