# Changelog

## 0.5.2 (2026-08-10)

### Fixes

- **Auto-recover from `ERR_STALE_PROTOCOL`:** when a write fails because the server requires the one-time `acknowledge_setup` handshake (freshly-provisioned Munin server v1.5.0+), pi-munin now performs the server-directed ack action (default `acknowledge_setup`, read from `remediation.acknowledge_after_reading.action`) with `{ ensureCapability: false }` and retries the original call exactly once. The retry is wrapped in `withRetry` so a transient network blip after a successful ack is tolerated. If ack is unavailable or fails, the tool result surfaces the server's remediation URL and required version instead of the bare `ERR_STALE_PROTOCOL` code. Previously the SDK's `err.details.remediation` was dropped on the floor, so every write tool failed opaquely.
- **Security: remediation strings sanitized.** Server-provided remediation fields (url, action, version) are validated/sanitized before reaching agent context: URLs must be `http(s)`, contain no control/bidi/format chars, and carry no embedded credentials (rejects `javascript:`/`file:`/injection/`user:pass@`); action/version tokens have ASCII + Unicode control chars stripped; the version clause is omitted when sanitized empty. Error-path tool results are now truncated like success paths, bounding a malicious server's ability to balloon agent context via oversized remediation fields. The ack result is inspected for non-throwing failures (`ok:false`/`acknowledged:false`) and treated as failure (no retry). Closes multiple prompt-injection/context-abuse vectors where a malicious or buggy server could inject directives, exfiltrate credentials, or bloat context via the remediation block.

## 0.5.1 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

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
