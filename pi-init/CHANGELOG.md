# Changelog

## 0.1.0

- Initial release.
- `/init` command: scans repo (package.json, build systems, CI, dirs) and generates or updates `AGENTS.md`.
- `/init force` regenerates from scratch; `/init check` reports without writing.
- Detects npm/pnpm/yarn/bun, make/cargo/go/python/maven/gradle/cmake/elixir, GitHub Actions/GitLab/CircleCI/Azure/Travis.
- Zero dependencies, plain JS.
