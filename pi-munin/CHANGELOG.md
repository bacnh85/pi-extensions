# Changelog

All notable changes to `pi-munin` will be documented in this file.

## 0.5.0 (2026-08-01)

### Features

- **Portable instructions:** the condensed always-on Munin Memory Protocol (Before acting / What to store / Memory shape / Lifecycle and safety) now self-injects via the existing `before_agent_start` hook, replacing the prior 2-line header. This protocol previously lived in the global `~/.pi/agent/AGENTS.md`; moving it here makes it travel with the package and carry zero overhead when pi-munin is absent. The full deep reference remains in `skills/munin/SKILL.md`. Per-tool `promptGuidelines` are unchanged.

## 0.4.9 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.4.8 (2026-07-24)

### Fixes

- Fixed lockfile resolution and dependency handling for `dotenv`.

## 0.4.7 (2026-07-20)

### Security & Reliability

- Hardened credential security, URL parsing validation, and typed error handling.
- Enhanced transient failure retry logic with exponential backoff (3 retries).

## 0.4.0 (2026-07-10)

### Features

- Added `munin_share` tool for confirmed cross-project memory sharing.
- Updated to `@kalera/munin-sdk@1.5.0`.
